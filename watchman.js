import { db } from './firebase-config.js';
import { enforceRBAC, logoutUser, currentUserProfile } from './auth.js'; 
import { 
    collection, query, where, getDocs, updateDoc, doc, addDoc, serverTimestamp, getDoc, onSnapshot 
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

// ENFORCE SECURITY
enforceRBAC('watchman');

// ==========================================
// 1. VISITOR MANAGEMENT (Cloud Write)
// ==========================================
async function createVisitorRecord(visitorData) {
    try {
        const visitorRef = collection(db, "visitors");
        await addDoc(visitorRef, {
            ...visitorData,
            entryTime: serverTimestamp(), // Let Google's atomic clock stamp the exact time
            status: "INSIDE",
            watchmanId: currentUserProfile.uid // Audit Logging: Track WHICH watchman let them in!
        });
        showToast("Visitor recorded successfully!", "success");
    } catch (error) {
        console.error("Database Error:", error);
        showToast("Failed to record visitor.", "error");
    }
}

// ==========================================
// 2. REAL-TIME DASHBOARD (Cloud Listen)
// ==========================================
// This replaces old local storage. It opens a live socket to Firebase.
function listenToLivePasses() {
    const passesRef = collection(db, "gate_passes");
    
    // We only want the watchman to see passes that are currently ACTIVE
    const q = query(passesRef, where("status", "==", "ACTIVE"));
    
    console.log("Connecting to live Firebase socket...");

    // onSnapshot triggers instantly the exact millisecond a student gets an approved pass
    onSnapshot(q, (snapshot) => {
        const livePasses = [];
        snapshot.forEach((docSnap) => {
            let passData = docSnap.data();
            passData.docId = docSnap.id; // Save the hidden Firebase ID
            livePasses.push(passData);
        });
        
        console.log(`Live Update: There are ${livePasses.length} active passes right now.`);
        
        // ---> Call whatever function you use to draw the HTML list on the screen here!
        // e.g., renderLivePassesToScreen(livePasses);
    });
}

// Start the live listener as soon as the Watchman logs in
listenToLivePasses();

//--STAGE 8: LOGOUT & UI SETUP
document.getElementById('btnLogout').addEventListener('click', logoutUser);
document.addEventListener('authReady', () => {
    // Added fallback checks in case Admin manually registered the watchman without a 'name' field
    const operatorName = currentUserProfile.name || currentUserProfile.fullName || "Operator";
    document.getElementById('navUserName').innerText = `Gate Control: ${operatorName}`;
});

// --- DOM References ---
const watchmanAuth = document.getElementById('watchmanAuth');
const scannerConsole = document.getElementById('scannerConsole');
const btnLoginSecurity = document.getElementById('btnLoginSecurity');
const watchmanIdInput = document.getElementById('watchmanIdInput');
const activeWatchmanDisplay = document.getElementById('activeWatchmanDisplay');

const resultCard = document.getElementById('resultCard');
const resultHeader = document.getElementById('resultHeader');
const resStatusText = document.getElementById('resultStatusText');

const resPhoto = document.getElementById('resPhoto');
const resPassId = document.getElementById('resPassId');
const resName = document.getElementById('resName');
const resUsn = document.getElementById('resUsn');
const resDeptRoom = document.getElementById('resDeptRoom');
const resReason = document.getElementById('resReason');
const resReturn = document.getElementById('resReturn');
const resCurrentStatus = document.getElementById('resCurrentStatus');

const btnActionApprove = document.getElementById('btnActionApprove');
const btnActionReturn = document.getElementById('btnActionReturn');
const btnDismissResult = document.getElementById('btnDismissResult');
const logTableBody = document.getElementById('logTableBody');

let html5QrcodeScanner;
let activeWatchmanId = "";
let currentActiveDocId = null; 
let currentActivePassData = null;

// --- STAGE 5 AUDIT LOGGING ---
async function logSecurityEvent(action, usn, passId, status) {
    try {
        await addDoc(collection(db, "audit_logs"), {
            action: action,
            usn: usn,
            passId: passId,
            status: status,
            watchmanId: activeWatchmanId,
            timestamp: serverTimestamp(),
            userAgent: navigator.userAgent
        });
    } catch (e) { console.error("Audit log failed", e); }
}

btnLoginSecurity.addEventListener('click', () => {
    const idVal = watchmanIdInput.value.trim().toUpperCase();
    if (!idVal) {
        alert("Please assign a valid Watchman ID or Gate Number.");
        return;
    }
    activeWatchmanId = idVal;
    activeWatchmanDisplay.textContent = `Operator: ${activeWatchmanId}`;
    
    watchmanAuth.classList.add('hidden');
    scannerConsole.classList.remove('hidden');
    
    if (window.location.protocol === 'file:') {
        alert("SECURITY ERROR: Camera cannot start on file:// protocol. Please use VS Code Live Server.");
    } else {
        initScanner();
    }
});

// --- Initialize Scanner Camera ---
function initScanner() {
    html5QrcodeScanner = new Html5QrcodeScanner("reader", { 
        fps: 10, 
        qrbox: { width: 250, height: 250 },
        rememberLastUsedCamera: true
    });
    html5QrcodeScanner.render(onScanSuccess, onScanFailure);
}

function onScanFailure(error) {}

// --- WATCHMAN SECURE EXIT LOGGING ---
// --- NEW EXIT LOGIC (PHASE 4) ---
async function processStudentExit(passData, docId) {
    const now = new Date(); 
    const hours = now.getHours();
    
    // Normal: 7 AM to 5:59 PM. Abnormal: 6 PM to 6:59 AM.
    const exitType = (hours >= 7 && hours < 18) ? "DAY" : "NIGHT";
    
    // Fallbacks included just in case a field is mysteriously blank
    const exitLog = {
        studentName: passData.name || "Unknown",
        usn: passData.usn || "Unknown",
        department: passData.department || "Unknown",
        roomNumber: passData.roomNumber || "Unknown",
        reason: passData.reason || "None",
        exitDate: now.toLocaleDateString('en-GB'),
        exitTime: now.toLocaleTimeString('en-US', {hour12: true}),
        exitType: exitType,
        passId: passData.passId,
        scannedBy: activeWatchmanId || "Watchman", 
        timestamp: serverTimestamp()
    };
    
    try {
        // 1. Create the permanent Exit Log
        await addDoc(collection(db, "exitLogs"), exitLog);
        
        // 2. Update the original pass status to SCANNED_OUT
        await updateDoc(doc(db, "gate_passes", docId), { status: "SCANNED_OUT" });
        
        showToast(`Exit Logged: ${exitType} Exit`, exitType === "DAY" ? "success" : "warning");
    } catch (error) {
        console.error("Error logging exit:", error);
        
        // THIS WILL POP UP IF FIREBASE BLOCKS IT SO IT DOESN'T SILENTLY CRASH!
        alert("CRITICAL DATABASE ERROR: " + error.message + "\n\nPlease ensure your firestore.rules for exitLogs are published.");
        
        // Rethrow the error so the scanner doesn't pretend it worked
        throw error; 
    }
}

// --- Core QR Processing Pipeline ---
async function onScanSuccess(decodedText) {
    html5QrcodeScanner.clear();
    resetResultUI();
    resultCard.classList.remove('hidden');

    try {
        const parsedData = JSON.parse(decodedText);
        if (!parsedData.id || !parsedData.usn || !parsedData.token) throw new Error("Malformed JSON schema");

        showProcessingState("Querying Cloud Datastore...");

        const passesRef = collection(db, "gate_passes");
        const q = query(passesRef, where("passId", "==", parsedData.id), where("usn", "==", parsedData.usn));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            displayRejection("PASS NOT FOUND", "No record matches this digital token reference.");
            return;
        }

        const docSnap = querySnapshot.docs[0];
        currentActiveDocId = docSnap.id;
        const passData = docSnap.data();
        currentActivePassData = passData;

        resPassId.textContent = passData.passId;
        resName.textContent = passData.name;
        resUsn.textContent = passData.usn;
        resDeptRoom.textContent = `${passData.department} | Room: ${passData.roomNumber}`;
        resReason.textContent = passData.reason;
        resReturn.textContent = formatTo12Hour(passData.returnTime);
        resCurrentStatus.textContent = passData.status;
        resCurrentStatus.className = `status-badge status-${passData.status}`;
                      
        const studentDoc = await getDoc(doc(db, "students", passData.usn));
        if (!studentDoc.exists()) {
            displayRejection("INVALID USER", "Student does not exist in Master Database.");
            logSecurityEvent("SCAN_REJECTED", passData.usn, passData.passId, "NONEXISTENT_STUDENT");
            return;
        }

         const studentProfile = studentDoc.data();
      
          // Inject Student Photo
          if (studentProfile.photoURL) {
           resPhoto.src = studentProfile.photoURL;
           resPhoto.style.display = "block";
          } else {
           resPhoto.style.display = "none";
          }

      if (studentProfile.blocked) {
            displayRejection("BLOCKED USER", "This student's campus access has been revoked.");
            logSecurityEvent("SECURITY_ALERT", passData.usn, passData.passId, "BLOCKED_USER_ATTEMPT");
            return;
        }

        document.getElementById('resName').innerHTML = `${passData.name} <br><span style="color:#10b981; font-size: 0.8em;">Verified Room: ${studentProfile.hostelRoom}</span>`;        

        if (passData.status === "RETURNED" || passData.status === "EXPIRED") {
            displayRejection("INVALID QR", "This QR code has already been used or is expired.");
            logSecurityEvent("REPLAY_ATTACK_PREVENTED", passData.usn, passData.passId, passData.status);
            return;
        }

        if (passData.securityToken !== parsedData.token) {
            displayRejection("INVALID TOKEN", "Security token mismatch. Cloning detected.");
            return;
        }

        if (passData.status === "BLOCKED") {
            displayRejection("STUDENT BLOCKED", "This account has campus restriction active.");
            return;
        }

        // NEW: Bypass the 1-hour expiry check if the student is already SCANNED_OUT
        if (passData.status !== "SCANNED_OUT" && (Date.now() > passData.expiryTimestamp || passData.status === "EXPIRED")) {
           displayRejection("PASS EXPIRED", "The 1-hour active authorization window has closed.");
           if(passData.status === "ACTIVE") await updateDoc(doc(db, "gate_passes", currentActiveDocId), {status: "EXPIRED" });
           return;
        }

        if (passData.status === "ACTIVE") {
            displayApproval("VALID PASS - EXIT ALLOWED", "success-banner");
            btnActionApprove.classList.remove('hidden');
        } else if (passData.status === "SCANNED_OUT") {
            displayApproval("STUDENT OUTSIDE - AWAITING RETURN", "warning-banner");
            btnActionReturn.classList.remove('hidden');
        } else if (passData.status === "RETURNED") {
            displayRejection("PASS ALREADY USED", "This token was completely utilized and closed.");
        }

    } catch (e) {
        console.error(e);
        displayRejection("READ ERROR", "Invalid QR cryptographic format structure.");
    }
}

// --- Status Management Transitions ---
btnActionApprove.addEventListener('click', async () => {
    if (!currentActiveDocId) return;
    try {
        // 🔥 TRIGGER THE NEW EXIT DATA PIPELINE
        // This handles writing the Exit Log, updating the pass, and calculating Normal/Abnormal time
        await processStudentExit(currentActivePassData, currentActiveDocId);
        
        // Keep your excellent audit logging and UI resets!
        await logSecurityEvent("EXIT_GRANTED", currentActivePassData.usn, currentActivePassData.passId, "SUCCESS");
        appendVerificationLog(currentActivePassData.usn, "EXIT APPROVED");
        
        closeAndRecycleScanner();
    } catch (err) {
        alert("State synchronization error. Check connection.");
    }
});

         btnActionReturn.addEventListener('click', async () => {
    if (!currentActiveDocId) return;
    try {
        const docRef = doc(db, "gate_passes", currentActiveDocId);
        await updateDoc(docRef, {
            status: "RETURNED",
            returnTimestamp: serverTimestamp(),
            returnedGateOperatorId: activeWatchmanId
        });

        // --- NEW: UPDATE EXIT LOG WITH REAL-TIME RETURN DATA ---
        const exitLogsRef = collection(db, "exitLogs");
        const q = query(exitLogsRef, where("passId", "==", currentActivePassData.passId));
        const exitLogSnap = await getDocs(q);
        
        if (!exitLogSnap.empty) {
               const exitLogId = exitLogSnap.docs[0].id;
               const now = new Date();
               await updateDoc(doc(db, "exitLogs", exitLogId), {
                 returnDate: now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }),
                 returnTime: now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', 
                  hour12: true 
              }),
               returnTimestamp: serverTimestamp()
           });
         }
        // -------------------------------------------------------
        await logSecurityEvent("RETURN_GRANTED", currentActivePassData.usn, currentActivePassData.passId, "SUCCESS");      

        appendVerificationLog(currentActivePassData.usn, "RETURN LOGGED");
        alert("Return checklist completed.");
        closeAndRecycleScanner();
    } catch (err) {
        alert("State synchronization error.");
    }
});

btnDismissResult.addEventListener('click', () => closeAndRecycleScanner());

function resetResultUI() {
    btnActionApprove.classList.add('hidden');
    btnActionReturn.classList.add('hidden');
    resultHeader.className = "result-banner";
    resultStatusText.textContent = "VALIDATING...";
}

function showProcessingState(msg) { resultStatusText.textContent = msg; }
function displayApproval(title, cssClass) {
    resultHeader.className = `result-banner ${cssClass}`;
    resultStatusText.textContent = title;
}

function displayRejection(title, explanation) {
      resultHeader.className = "result-banner error-banner";
      resultStatusText.textContent = title;
      resReason.textContent = explanation;
      resPhoto.style.display = "none";
      resName.textContent = "DENIED";
      resUsn.textContent = "DENIED";
}

function closeAndRecycleScanner() {
    resultCard.classList.add('hidden');
    currentActiveDocId = null;
    currentActivePassData = null;
    initScanner(); 
}

function appendVerificationLog(usn, action) {
    const tr = document.createElement('tr');
    // Force en-US locale to guarantee 12-hour AM/PM format
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    
    tr.innerHTML = `<td>${usn}</td><td><strong>${action}</strong></td><td>${timeStr}</td>`;
    logTableBody.insertBefore(tr, logTableBody.firstChild);
}

// --- TIME FORMAT HELPER ---
function formatTo12Hour(time24) {
    if (!time24) return "Not specified";
    
    // Split the time into hours and minutes
    const [hourString, minuteString] = time24.split(':');
    let hour = parseInt(hourString, 10);
    
    // Determine AM or PM
    const ampm = hour >= 12 ? 'PM' : 'AM';
    
    // Convert 13-23 down to 1-11, and convert 0 (midnight) to 12
    hour = hour % 12;
    hour = hour ? hour : 12; 
    
    return `${hour}:${minuteString} ${ampm}`;
}
// ==========================================
// UTILITY FUNCTIONS
// Toast Notifications for Watchman
function showToast(message, type = 'success') {
    const notificationArea = document.getElementById('notificationArea');
    if (!notificationArea) return; // Safety check
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    notificationArea.appendChild(toast);
    
    // Remove after 3 seconds
    setTimeout(() => toast.remove(), 3000);
}