import { auth, db } from './firebase-config.js';
import { enforceRBAC, logoutUser, currentUserProfile } from './auth.js';
import { 
    collection, addDoc, query, where, getDocs, onSnapshot, 
    updateDoc, doc, serverTimestamp, getDoc, orderBy 
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

// =========================================================================
// NEW CODE: SECURE TIME FETCHER (Prevents local device clock spoofing)
// =========================================================================
async function getSecureTime() {
    try {
        const response = await fetch('https://worldtimeapi.org/api/timezone/Asia/Kolkata');
        if (!response.ok) throw new Error('Time API failed');
        const data = await response.json();
        return new Date(data.datetime); 
    } catch (error) {
        console.warn("Secure time API unreachable. Falling back to strict device time.", error);
        return new Date(); // Fallback if offline
    }
}

// --- 1. SETUP: Disable UI immediately ---
const submitBtn = document.getElementById('gatePassForm')?.querySelector('button[type="submit"]');

if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = "Syncing Profile...";
}

// --- NEW CODE: Real-time listener for the student's pass ---
let studentPassUnsubscribe = null;

function startStudentPassListener(uid) {
    const passesRef = collection(db, "gate_passes");
    
    // --- UPDATED CODE: Expanded query and rejection handling ---
    const q = query(
        passesRef,
        where("userId", "==", uid),
        // Added "APPROVED", "REJECTED", and "DECLINED" to prevent silent query drops
        where("status", "in", ["ACTIVE", "APPROVED", "PENDING", "PENDING_APPROVAL", "AUTO_APPROVED", "SCANNED_OUT", "REJECTED", "DECLINED"])
    );

    if (studentPassUnsubscribe) studentPassUnsubscribe();

    studentPassUnsubscribe = onSnapshot(q, (snapshot) => {
        if (!snapshot.empty) {
            // Sort by timestamp if multiple exist, to ensure we get the latest one
            const docs = snapshot.docs.map(doc => ({ docId: doc.id, ...doc.data() }));
            docs.sort((a, b) => {
                const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
                const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
                return timeB - timeA;
            });

           let passData = docs[0];
            console.log("Real-time pass update received. New Status:", passData.status);

            // FIX 1: Break the infinite flicker loop by trapping expired passes here
            if ((passData.status === "ACTIVE" || passData.status === "AUTO_APPROVED") && passData.expiryTimestamp && Date.now() > passData.expiryTimestamp) {
                // Attempt cleanup quietly. The catch() absorbs the permission error.
                updateDoc(doc(db, "gate_passes", passData.docId), { status: "EXPIRED" }).catch(() => {});
                
                const passSection = document.getElementById('passSection');
                const formSection = document.getElementById('formSection');
                if (passSection) passSection.classList.add('hidden');
                if (formSection) formSection.classList.remove('hidden');
                
                return; // CRITICAL: Stop execution here so renderPass() is never called
            }
              
            // Handle Admin Rejection
            if (passData.status === "REJECTED" || passData.status === "DECLINED") {
                
                // 1. Prevent infinite loops by checking if we already alerted the user for this specific pass
                const alertKey = "alerted_rejection_" + passData.docId;
                
                if (!sessionStorage.getItem(alertKey)) {
                    alert("Your gate pass request was rejected by the admin.");
                    sessionStorage.setItem(alertKey, "true"); // Mark as alerted
                }
                
                // 2. Clear the pass UI so the student sees the form and can apply again
                const passContainer = document.getElementById('passContainer'); 
                if (passContainer) {
                    passContainer.innerHTML = ''; 
                    passContainer.style.display = 'none'; // Hide the container if it has styling
                }

                // 3. Ensure the request form is visible
                const requestForm = document.getElementById('requestForm'); // Replace with your actual form ID if different
                if (requestForm) {
                    requestForm.style.display = 'block';
                }
            }
            // Handle Admin Approval
            else {
                if (typeof renderPass === 'function') {
                    // Force the UI to clear before re-rendering to prevent overlap bugs
                    const passContainer = document.getElementById('passContainer'); // Change ID if yours is different
                    if (passContainer) passContainer.innerHTML = ''; 
                    
                    renderPass(passData);
                } else {
                    console.error("renderPass function is not defined globally.");
                }
            }
        } else {
            console.log("No active/pending passes found (Snapshot empty). Returning to Form.");
            
            // 1. Force the UI to show the Pass Generation Form and hide the QR Section
            const passSection = document.getElementById('passSection');
            const formSection = document.getElementById('formSection');
            if (passSection) passSection.classList.add('hidden');
            if (formSection) formSection.classList.remove('hidden');
            
            // 2. Ensure Profile Details are re-populated safely if they were wiped
            if (typeof currentUserProfile !== 'undefined' && currentUserProfile && currentUserProfile.usn) {
                // Temporarily unlock the button to prevent it getting stuck in a loading state
                const submitBtn = document.getElementById('submitBtn');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerText = "Create New Pass";
                }
                
                
            }
        }
    }, (error) => {
        console.error("Firestore Listener Error:", error);
    });
    // -----------------------------------------------------------
}
// -----------------------------------------------------------

// --- 2. INTEGRATION: Improved Retry Loop ---
async function initializeApp() {
    let attempts = 0;
    const maxAttempts = 10; // Try for 5 seconds total (10 attempts * 500ms)

    while (attempts < maxAttempts) {
        // Check if the auth module has populated your global profile
        if (typeof currentUserProfile !== 'undefined' && currentUserProfile && currentUserProfile.usn) {
            console.log("Profile loaded successfully.");
            // --- INJECTED CODE: Start listening to Admin approvals immediately ---
            startStudentPassListener(currentUserProfile.uid);
            // Unlock the form
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = "Create New Pass";
            }
            
            // Auto-fill fields
            const usnField = document.getElementById('usn');
            if (usnField) usnField.value = currentUserProfile.usn;
            
            return; // Exit the loop and function early on success
        }
        
        // Wait 500ms before checking again
        await new Promise(resolve => setTimeout(resolve, 500));
        attempts++;
    }

    // If we reach here, it failed after 5 seconds
    console.error("Initialization failed: Profile data not found.");
    if (submitBtn) {
        submitBtn.innerText = "Profile Sync Failed";
    }
    showToast("Error loading profile. Please refresh.", "error");
}

// Run the initialization
initializeApp();

// --- DOM Elements ---
const formSection = document.getElementById('formSection');
const passSection = document.getElementById('passSection');
const gatePassForm = document.getElementById('gatePassForm');
const currentDateTimeEl = document.getElementById('currentDateTime');

// Constants
const PASS_DURATION_MS = 60 * 60 * 1000; // 1 Hour
let countdownInterval;

// 1. ENFORCE SECURITY - Only 'student' role allowed here
enforceRBAC('student');

// Logout Listener
document.getElementById('btnLogout').addEventListener('click', logoutUser);

// 2. Wait for auth verification, then autofill forms
document.addEventListener('authReady', () => {
    // 1. Fix the Header so it doesn't say "undefined"
    const displayUsn = currentUserProfile.usn ? `(${currentUserProfile.usn})` : "";
    document.getElementById('navUserName').innerText = `${currentUserProfile.name} ${displayUsn}`;
    
    // DOM References
    const nameInput = document.getElementById('studentName');
    const usnInput = document.getElementById('usn');
    const deptInput = document.getElementById('department');
    const roomInput = document.getElementById('roomNumber');

    // 2. Smart Routing: Is this a returning student or a new Google login?
    if (currentUserProfile.usn) {
        // RETURNING STUDENT: They already have a USN. Lock everything down.
        nameInput.value = currentUserProfile.name || ""; 
        nameInput.readOnly = true;
        usnInput.value = currentUserProfile.usn; 
        usnInput.readOnly = true;
        
        if (currentUserProfile.department) {
            deptInput.value = currentUserProfile.department; 
            deptInput.disabled = true;
        }
        if (currentUserProfile.roomNumber) {
            roomInput.value = currentUserProfile.roomNumber; 
            roomInput.readOnly = true;
        }

        // AUTO-SEARCH: Securely fetch the rest of the details from Firestore ONLY if USN exists
        setTimeout(() => {
            const searchBtn = document.getElementById('btnSearchUsn');
            if (searchBtn) searchBtn.click();
        }, 500); 

    } else {
        // NEW STUDENT: Leave USN blank and UNLOCKED so they can type it!
        usnInput.value = ""; 
        usnInput.readOnly = false; // Waiting for them to type their USN

        // Lock the rest of the boxes (The Master DB check will fill them in later)
        nameInput.value = ""; 
        nameInput.readOnly = true;
        nameInput.placeholder = "Waiting for valid USN...";
        
        if (deptInput) deptInput.disabled = false;
        
        if (roomInput) {
            roomInput.value = "";
            roomInput.readOnly = true;
            roomInput.placeholder = "Auto-filled from DB";
        }
    }
});


// --- STAGE 6: GLOBAL CAMPUS STATE & CUTOFF ---
let campusLocked = false;
let approvalCutoff = null; // Stores "16:00" or "18:00"

onSnapshot(doc(db, "system_config", "campus_state"), (docSnap) => {
    if (docSnap.exists()) {
        const data = docSnap.data();
        campusLocked = data.lockdown;
        approvalCutoff = data.approvalCutoff || null; 
        
        const form = document.getElementById('gatePassForm');
        if (campusLocked) form.style.opacity = "0.7";
        else form.style.opacity = "1";
    }
});

// --- Utility Functions ---
// Live Clock (Forced to 12-hour format on all devices)
setInterval(() => { 
    currentDateTimeEl.textContent = new Date().toLocaleString('en-IN', { 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit', 
        hour12: true 
    }).toUpperCase(); 
}, 1000);

// Generate Custom ID (e.g., PASS-2026-8392)
function generatePassId() {
    const year = new Date().getFullYear();
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    return `PASS-${year}-${randomNum}`;
}

// Generate Security Token
function generateToken() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Toast Notifications
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    document.getElementById('notificationArea').appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// --- STAGE 7: MASTER DB VERIFICATION (Upgraded with Fallbacks) ---
const usnInput = document.getElementById('usn');
let verifiedStudentData = null; // Store data to prevent tampering

// --- UTILITY: SHA-256 Hashing for Secure PIN Storage ---
async function hashPin(pin) {
    const msgBuffer = new TextEncoder().encode(pin);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Ensure the Submit button starts disabled
document.getElementById('submitBtn').disabled = true;

// Immediately disable Submit button if the user alters the USN field after verification
usnInput.addEventListener('input', () => {
    document.getElementById('submitBtn').disabled = true;
});

// Search functionality bound to the new Search button
document.getElementById('btnSearchUsn').addEventListener('click', async () => {
    const usnValue = usnInput.value.trim().toUpperCase();

    // Validation: Empty check
    if (!usnValue) {
        showToast("Please enter a valid USN.", "error");
        return;
    }

    const searchBtn = document.getElementById('btnSearchUsn');
    searchBtn.disabled = true; // Prevent spamming the search to save Firebase reads

    try {
        const studentDoc = await getDoc(doc(db, "students", usnValue));
        if (studentDoc.exists()) {
            verifiedStudentData = studentDoc.data();
            
            if (verifiedStudentData.blocked) {
                showToast("SECURITY ALERT: Your account is BLOCKED.", "error");
                document.getElementById('submitBtn').disabled = true;
                return;
            }

            // --- THE "UNDEFINED" FIX: Using Fallbacks ( || ) ---
            const nameField = document.getElementById('studentName');
            nameField.value = verifiedStudentData.name || verifiedStudentData.fullName || verifiedStudentData.studentName || "";
            nameField.readOnly = true;
            nameField.style.backgroundColor = "#f1f5f9"; // Visually lock it

            const deptField = document.getElementById('department');
            if (deptField) {
                deptField.value = verifiedStudentData.department || verifiedStudentData.dept || "";
                deptField.readOnly = true;
                deptField.style.backgroundColor = "#f1f5f9";
            }

            const roomField = document.getElementById('roomNumber');
            if (roomField) { 
                roomField.value = verifiedStudentData.hostelRoom || verifiedStudentData.roomNumber || verifiedStudentData.room || "";
                roomField.readOnly = true;
                roomField.style.backgroundColor = "#f1f5f9";
            }
            
            // --- AUTO-FILL THE STATUS ---
            const statusField = document.getElementById('status');
            if (statusField) {
                statusField.value = verifiedStudentData.studentStatus || verifiedStudentData.status || verifiedStudentData.type || "Hosteler"; 
                statusField.readOnly = true;
                statusField.style.backgroundColor = "#f1f5f9";
            }
            
            // Check PIN Status dynamically
            if (!verifiedStudentData.pinCreated || verifiedStudentData.pinResetRequired) {
                showToast("Security Setup Required. Please create your PIN.", "warning");
                
                // Ensure the button is visible and says "Set New PIN"
                const btn = document.getElementById('btnChangePin');
                btn.innerText = "Set New PIN";
                btn.style.display = 'block';
                
                await triggerPinSetupMode(usnValue);
            } else {
                const btn = document.getElementById('btnChangePin');
                btn.innerText = "Change PIN";
                btn.style.display = 'block';
                document.getElementById('submitBtn').disabled = false;
                showToast("Student details loaded successfully.", "success");
            } 
        } else {
            // If they type a fake USN, lock the form and clear the boxes
            showToast("USN not registered or Invalid USN.", "error");
            document.getElementById('studentName').value = "";
            if (document.getElementById('department')) document.getElementById('department').value = "";
            if (document.getElementById('roomNumber')) document.getElementById('roomNumber').value = "";
            if (document.getElementById('status')) document.getElementById('status').value = "";
            document.getElementById('submitBtn').disabled = true;
        }
    } catch (e) {
        console.error("Verification Error:", e);
        showToast("Error connecting to database.", "error");
    } finally {
        searchBtn.disabled = false; // Re-enable the search button
    }
});

// --- Form Submission Logic ---
gatePassForm.addEventListener('submit', async function(e) {
    e.preventDefault();

    // HARD GUARD: Do not allow submission if vital data is empty
    if (!currentUserProfile.usn || !currentUserProfile.name) {
        showToast("System is still loading your details. Please wait...", "warning");
        return; // Stop execution
    }

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.innerText = "Processing...";
    submitBtn.disabled = true;

    try {
            // --- 1. STAGE 6: FAST LOCKDOWN CHECK ---
            if (campusLocked) {
                // Show the requested exact popup message
                alert("Campus exit is currently restricted during this time period. Please wait until the restriction is lifted or seek approval from the administration if your request is urgent.");
                
                submitBtn.innerText = "Create New Pass"; // Reset button text
                submitBtn.disabled = false;
                return;
            }

            // --- 2. BASIC TIME VALIDATION ---
            const usnVal = document.getElementById('usn').value.toUpperCase();
            const returnTime = document.getElementById('returnTime').value;

            // Ensure user actually selected a return time
            if (!returnTime) {
                showToast("Please specify an expected return time.", "error");
                submitBtn.innerText = "Submit to Admin";
                submitBtn.disabled = false;
                return;
            }
            // leaveTime comparison REMOVED securely.
            
            //---3. STAGE 6: GPS GEOFENCING (With SRE Dev Bypass)
        submitBtn.innerText = "Verifying GPS Location...";
        submitBtn.disabled = true;

        // FIXED: Moved constants to the very top so they are initialized BEFORE any checks run!
        const COLLEGE_LAT = 13.399580381770692; // VIAT Mess area
        const COLLEGE_LNG = 77.68022105258116;
        const MAX_RADIUS_METERS = 850; // Must be within 500 meters, --> Upadted to 850 meters

        let userLocation;
        
        // DEV BYPASS: Skip real GPS if testing on a local laptop
        if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
            console.warn("DEV MODE: Bypassing GPS Location Check");
            userLocation = {
                coords: {
                    latitude: COLLEGE_LAT, // Now perfectly safe to use here!
                    longitude: COLLEGE_LNG // Now perfectly safe to use here!
                }
            };
        } else {
            // REAL GPS CHECK (With Smart Fallback)
        userLocation = await new Promise((resolve, reject) => {
            if (!navigator.geolocation) reject({ code: 0, message: "GPS not supported" });
            
            // OPTIMIZED: Give the mobile GPS chip 15 seconds to establish a true satellite lock. 
            // Allow a 10-second cache so recent accurate pings can be reused.
            const highAccOpts = { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 };
            const lowAccOpts = { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 };

            // ATTEMPT 1: Try High Accuracy first
            navigator.geolocation.getCurrentPosition(resolve, (err) => {
                console.warn("High accuracy GPS timeout/failed. Falling back to Network location...", err);
                // ATTEMPT 2: Try Low Accuracy (Cell Tower/Wi-Fi)
                navigator.geolocation.getCurrentPosition(resolve, reject, lowAccOpts);
            }, highAccOpts);

           }).catch(err => {
            console.error("Location Error Detailed:", err);
            if (err.code === 1) throw new Error("Location Permission Denied. Please allow location access in your browser settings.");
            if (err.code === 2) throw new Error("Location Unavailable. Make sure your device GPS/Location is turned on.");
            if (err.code === 3) throw new Error("GPS Timeout. Please step outside for a clear view of the sky and try again.");
            throw new Error("An unknown location error occurred.");
          });
         } // Closing bracket for the DEV BYPASS else block

         const distance = calculateHaversineDistance(
            userLocation.coords.latitude, userLocation.coords.longitude,
            COLLEGE_LAT, COLLEGE_LNG
         );

            // THE BOUNCER: Kick them out if they are too far away
             if (distance > MAX_RADIUS_METERS) {
              throw new Error(`Geofence Alert: You are ${Math.round(distance)} meters away from the campus center. If you are currently inside the campus, please step outside for a better GPS signal, ensure 'Precise Location' is enabled in your phone settings, and turn off Wi-Fi.`);
            }
               
             // --- 4. STAGE 5: DATABASE SECURITY CHECKS ---
             submitBtn.innerText = "Processing Security Checks...";
             const passesRef = collection(db, "gate_passes");

             // Prevent Duplicate Active/Pending Passes
             const q = query(passesRef, 
                where("userId", "==", currentUserProfile.uid), 
                where("status", "in", ["ACTIVE", "PENDING", "PENDING_APPROVAL", "AUTO_APPROVED", "SCANNED_OUT"])
             );
             
            const duplicateCheck = await getDocs(q);
            let hasBlockingPass = false;

            // NEW FIX: Iterate through found passes to forcefully expire "Ghost" passes
            for (const docSnap of duplicateCheck.docs) {
                const passData = docSnap.data();
                
                // If it's waiting for approval or they are currently outside campus, block them.
                if (passData.status === "PENDING" || passData.status === "PENDING_APPROVAL" || passData.status === "SCANNED_OUT") {
                    hasBlockingPass = true;
                    break;
                }
                
                // If it is ACTIVE or AUTO_APPROVED, we must verify the actual timestamp
                if (passData.status === "ACTIVE" || passData.status === "AUTO_APPROVED") {
                    if (Date.now() > passData.expiryTimestamp) {
                        // The pass is dead! Forcefully update Firebase so it gets out of the way
                        await updateDoc(doc(db, "gate_passes", docSnap.id), { status: "EXPIRED" });
                        console.log(`Auto-expired ghost pass: ${docSnap.id}`);
                    } else {
                        // It is a valid, ongoing pass
                        hasBlockingPass = true;
                        break;
                    }
                }
            }

            if (hasBlockingPass) {
                showToast("You already have an Active, Pending, or unreturned pass!", "error");
                submitBtn.innerText = "Submit to Admin";
                submitBtn.disabled = false;
                return;
            }
            

             // Anti-Spam (5 Mins) & Daily Limit (24 Hours)
// FIX: Track passes by USN to prevent Google Account swapping bypasses
const targetUsn = verifiedStudentData ? verifiedStudentData.usn : document.getElementById('usn').value.toUpperCase();
console.log("CHECKPOINT 3");
const allUserPasses = await getDocs(
    query(
        passesRef,
        where("userId", "==", auth.currentUser.uid),
        where("usn", "==", targetUsn)
    )
);
console.log("CHECKPOINT 4");
             const fiveMinsAgo = Date.now() - (5 * 60 * 1000);
             const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        
             let isSpamming = false;
             let passesInLast24Hours = 0;

             allUserPasses.forEach((docSnap) => {
             const pass = docSnap.data();
             // 1. Check for spam (passes generated within the last 5 minutes)
             if (pass.expiryTimestamp && (pass.expiryTimestamp - 3600000) > fiveMinsAgo) {
                isSpamming = true;
              }
              // 2. Count passes in the last 24 hours
              // Fallback to expiry minus 1 hour if createdAt is missing
               const passTimeMs = pass.createdAt ? pass.createdAt.toMillis() : (pass.expiryTimestamp - 3600000);
              if (passTimeMs > twentyFourHoursAgo) {
                 passesInLast24Hours++;
               }
             });

             console.log(`[SECURITY ENGINE] Checking USN: ${targetUsn}`);
             console.log(`[SECURITY ENGINE] Total passes in last 24 hours: ${passesInLast24Hours}`);

             if (isSpamming) {
                showToast("Rate Limit Exceeded. Please wait 5 minutes.", "error");
                submitBtn.innerText = "Submit to Admin";
                submitBtn.disabled = false;
                return;
             }

              //-- STAGE 6.5: TWO-FACTOR AUTHENTICATION (SECURE PIN MODAL) --
              submitBtn.innerText = "Verifying Identity...";

               // FAILSAFE: Fetch latest student data if it wasn't loaded on page load
             if (!verifiedStudentData) {
               const studentDoc = await getDoc(doc(db, "students", document.getElementById('usn').value.toUpperCase()));
                verifiedStudentData = studentDoc.data();
              }

                // FAILSAFE: If PIN is wiped or not created, force them to set it up right now!
                if (!verifiedStudentData.pinCreated || verifiedStudentData.pinResetRequired) {
                 submitBtn.innerText = "Setting up Security PIN...";
                 await triggerPinSetupMode(verifiedStudentData.usn);
          
                 // Stop here if they closed the setup window without creating a PIN
                 if (!verifiedStudentData.pinCreated) {
                  throw new Error("Pass generation cancelled. PIN setup is required.");
                }
              }

      const enteredPin = await promptPinModal("VERIFY");
      if (!enteredPin) {
        throw new Error("Pass generation cancelled. PIN is required.");
      }
      const hashedEntry = await hashPin(enteredPin);
      if (hashedEntry !== verifiedStudentData.pin) {
        throw new Error("SECURITY ALERT: Incorrect Secret PIN. Pass Denied.");
      }


            // =========================================================
            // STAGE 7: STREAMLINED AUTO-APPROVAL ENGINE (SECURE IST EDITION)
            // =========================================================
            submitBtn.innerText = "Evaluating Security Rules...";
            
            //--HOSTEL CONFIGURATION RULES
            const RULES = {
              CURFEW_END_FLOAT: 5.5,    // 5:30 AM
              MAX_DAILY_OUTINGS: 3
            };
            
            let dynamicCurfewStart = null;
            if (approvalCutoff === "16:00") dynamicCurfewStart = 16.0;
            else if (approvalCutoff === "18:00") dynamicCurfewStart = 18.0;

            showToast("Evaluating security rules...", "info");

            // 1. SECURE GENERATION TIME & TIMEZONE NORMALIZATION (Forces IST)
            let rawNow = new Date();
            try {
              const currentRealTime = await getSecureTime();
              if(currentRealTime && !isNaN(currentRealTime.getTime())) {
                   rawNow = currentRealTime;
              }
            } catch(e) {
              console.warn("Secure time fallback active.");
            }

            // Convert to explicit IST string, then parse to ensure .getHours() is accurate globally
            const istString = rawNow.toLocaleString("en-US", {timeZone: "Asia/Kolkata"});
            const istNow = new Date(istString);
            
            // The generation curfew is strictly based on the exact moment in India
            let currentHourFloat = istNow.getHours() + (istNow.getMinutes() / 60);

            //--- THE EVALUATION ---
            let finalStatus = "AUTO_APPROVED";
            let flagReason = "";

            // Rule 1: Generation Curfew Check (Are they trying to leave during night curfew?)
            if (dynamicCurfewStart === null) {
                // Fail safely if config is missing, network failed, or data is stale
                finalStatus = "PENDING_APPROVAL";
                flagReason = "System settings sync pending. Defaulting to Admin Approval.";
            } else if (currentHourFloat >= dynamicCurfewStart || currentHourFloat < RULES.CURFEW_END_FLOAT) {
                finalStatus = "PENDING_APPROVAL";
                const timeStr = dynamicCurfewStart === 16.0 ? "4 PM" : "6 PM";
                flagReason = `Pass generated during night curfew (${timeStr} - 5:30 AM).`;
            }
            
            // Rule 2: Active Penalty Check (From Master DB)
            else if (verifiedStudentData.hasPenalty === true) {
              finalStatus = "PENDING_APPROVAL";
              flagReason = "Student has active penalties.";
            }
            // Rule 3: Daily Limit Check
            else if (passesInLast24Hours >= RULES.MAX_DAILY_OUTINGS) {
              finalStatus = "PENDING_APPROVAL";
              flagReason = `Exceeded daily limit of ${RULES.MAX_DAILY_OUTINGS} passes.`;
            }

            // Visual Feedback
            if (finalStatus === "PENDING_APPROVAL") {
               showToast("Sent to Admin: " + flagReason, "warning");
            }

        //-FINAL GENERATION (CLOUD WRITE)
        submitBtn.innerText = "Generating Secure Pass...";

        // DEV BYPASS: 1 Minute expiry for localhost, 1 Hour for Production
        const isDevMode = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
        const passDuration = isDevMode ? (60 * 1000) : (60 * 60 * 1000);

        //-SECURE CLOUD PAYLOAD
        const passData = {
          passId: generatePassId(),
          userId: currentUserProfile.uid,
          securityToken: generateToken(),
          name: document.getElementById('studentName').value,
          usn: document.getElementById('usn').value.toUpperCase(),
          department: document.getElementById('department').value,
          studentStatus: document.getElementById('status') ? document.getElementById('status').value : "Hosteler",
          roomNumber: document.getElementById('roomNumber') ? document.getElementById('roomNumber').value : "Unknown",
          
          leaveDate: document.getElementById('leaveDate') ? document.getElementById('leaveDate').value : "Tracked at Gate",
          returnTime: document.getElementById('returnTime') ? document.getElementById('returnTime').value : "Tracked at Gate",
          reason: document.getElementById('reason') ? document.getElementById('reason').value : "Not provided",
          
          status: finalStatus === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "ACTIVE",
          flagReason: flagReason, 

          createdAt: serverTimestamp(),
          expiryTimestamp: Date.now() + passDuration // Applies the dynamic duration here
        };

        // --- ADD THE LOGGING LINE RIGHT HERE ---
         console.log("DEBUG: Attempting to save passData:", passData);

             // 1. Save to Firebase
            console.log("DEBUGGING PERMISSIONS:");
            console.log("Current User UID:", currentUserProfile ? currentUserProfile.uid : "UNDEFINED");
            console.log("Target USN:", typeof targetUsn !== 'undefined' ? targetUsn : "UNDEFINED");
            console.log("Payload:", JSON.stringify(passData, null, 2)); // See exactly what you're sending
            // 1. Save to Firebase
            console.log("CHECKPOINT 5");
            await addDoc(passesRef, passData);
            console.log("CHECKPOINT 6");
            
            // 2. Prepare data for the UI (Swapping the server timestamp for a local one just for rendering)
            const nowMs = Date.now();
            const uiPassData = { ...passData, createdAt: nowMs }; 

            // 3. Update the UI (Instant Success)
            showToast("Pass Generated Successfully! QR Code Ready.", "success");
            renderPass(uiPassData);

        } catch (error) {
            console.error("SYSTEM ERROR:", error);
            showToast(error.message || "An unexpected error occurred.", "error");
        } finally {
            submitBtn.innerText = "Create New Pass"; // Reset button text
            submitBtn.disabled = false;
        }
    });
// END OF EVENT LISTENER

// --- Render Pass UI ---
function renderPass(data) {
    formSection.classList.add('hidden');
    passSection.classList.remove('hidden');

    document.getElementById('passIdDisplay').textContent = data.passId;
    document.getElementById('displayName').textContent = data.name;
    document.getElementById('displayUsn').textContent = data.usn;
    
    // Update the Status Badge
    const statusEl = document.getElementById('displayPassStatus');
    statusEl.textContent = data.status.replace("_", " "); // Makes 'AUTO_APPROVED' look like 'AUTO APPROVED'
    statusEl.className = `status-badge status-${data.status}`;

    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = ""; // Clear previous QR

    // Grab the instruction text AND timer to hide/modify them
    const qrInstructionText = document.getElementById('qrInstructionText') || document.querySelector('.qr-instruction');
    const timerContainer = document.getElementById('timerDisplay') || document.querySelector('.timer-container');

    //  CRITICAL: Always clear any running timer from memory first before loading a new pass state
    if (typeof countdownInterval !== 'undefined') {
        clearInterval(countdownInterval);
    }

    // ZERO-TRUST LOGIC: Keep the QR visible if they are walking to the gate (ACTIVE) or outside campus (SCANNED_OUT)!
    if (data.status === "AUTO_APPROVED" || data.status === "APPROVED" || data.status === "ACTIVE" || data.status === "SCANNED_OUT") {
        
        // Show instructions and timer container
        if (qrInstructionText) qrInstructionText.style.display = 'block'; 
        if (timerContainer) timerContainer.style.display = 'block';

        // Secure QR Code Output
        const qrContent = JSON.stringify({
            id: data.passId, usn: data.usn, token: data.securityToken
        });    
        
        new QRCode(qrContainer, {
            text: qrContent, width: 150, height: 150,
            colorDark : "#1e293b", colorLight : "#ffffff", correctLevel : QRCode.CorrectLevel.H
        });
        
        //  Check if the Watchman just scanned it
        if (data.status === "SCANNED_OUT") {
            // Stop the timer visually and replace it with the download message
            if (timerContainer) {
                timerContainer.innerHTML = `<div style="padding: 12px; color: #10b981; font-weight: bold; font-size: 1.1rem; text-align: center; border: 2px solid #10b981; border-radius: 8px; background: #ecfdf5; margin-top: 15px;">
                    Please download the QR.
                </div>`;
            }
        } else {
          // NEW: Pass the status to the timer so it knows when to freeze
            startTimer(data.expiryTimestamp, data.docId, data.status);
        }
        
    } else {
        // Hide misleading text AND hide the timer
        if (qrInstructionText) qrInstructionText.style.display = 'none'; 
        if (timerContainer) timerContainer.style.display = 'none';

        // This handles EXPIRED, RETURNED, PENDING_APPROVAL, or BLOCKED states
        qrContainer.innerHTML = `<div style="text-align:center; padding: 20px; color: #ef4444; border: 2px dashed #ef4444; border-radius: 8px; background: #fef2f2;">
                                    <strong style="font-size: 1.1rem;">❌ Pass ${data.status.replace("_", " ")}</strong><br>
                                    <div style="color: #64748b; font-size: 0.9rem; font-weight: 600; margin-top: 12px; padding-top: 12px; border-top: 1px solid #fca5a5;">
                                        Reason: <span style="color: #1e293b;">${data.flagReason || "Manual Admin Approval Required"}</span>
                                    </div>
                                 </div>`;
    }
}

// --- Timer & Auto Expiry ---
// NEW: Receive status parameter
// FIX 3B: Update the parameters to accept docId instead of passId
function startTimer(expiryTime, docId, status) {
    clearInterval(countdownInterval);
    const timerDisplay = document.getElementById('timerDisplay');
    const qrOverlay = document.getElementById('qrOverlay');
    
    // Clear any previous inline styles
    timerDisplay.style.color = ""; 
    qrOverlay.classList.add('hidden');

    if (status === "SCANNED_OUT") {
        timerDisplay.textContent = "AWAITING RETURN";
        timerDisplay.style.color = "#f59e0b"; 
        return; 
    }

    countdownInterval = setInterval(() => {
        const distance = expiryTime - Date.now();

        if (distance <= 0) {
            clearInterval(countdownInterval);
            timerDisplay.textContent = "00:00:00";
            qrOverlay.classList.remove('hidden');
            localStorage.removeItem('activePass');
            
            document.getElementById('displayPassStatus').textContent = "EXPIRED";
            document.getElementById('displayPassStatus').className = "status-badge status-EXPIRED";

            // FIX 3C: Push the EXPIRED status back to Firestore permanently
            if (docId) {
                updateDoc(doc(db, "gate_passes", docId), { status: "EXPIRED" }).catch(err => console.error(err));
            }
            
            setTimeout(() => {
                const newPassBtn = document.getElementById('newPassBtn');
                if (newPassBtn) newPassBtn.click();
            }, 3000);
            return;
        }

        const h = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const m = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const s = Math.floor((distance % (1000 * 60)) / 1000);
        timerDisplay.textContent = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    }, 1000);
}

// --- Button Actions ---
document.getElementById('downloadBtn').addEventListener('click', () => window.print());
document.getElementById('newPassBtn').addEventListener('click', () => {
    localStorage.removeItem('activePass');
    clearInterval(countdownInterval);
    
    // 1. PRESERVE STUDENT PROFILE DATA BEFORE RESET
    const usnVal = document.getElementById('usn').value;
    const nameVal = document.getElementById('studentName').value;
    const deptVal = document.getElementById('department') ? document.getElementById('department').value : "";
    const roomVal = document.getElementById('roomNumber') ? document.getElementById('roomNumber').value : "";
    const statusVal = document.getElementById('status') ? document.getElementById('status').value : "";

    // 2. Clear user-inputted fields (Dates, Times, Reasons) safely
    gatePassForm.reset();

    // 3. RESTORE STUDENT PROFILE DATA IMMEDIATELY
    document.getElementById('usn').value = usnVal;
    document.getElementById('studentName').value = nameVal;
    if (document.getElementById('department')) document.getElementById('department').value = deptVal;
    if (document.getElementById('roomNumber')) document.getElementById('roomNumber').value = roomVal;
    if (document.getElementById('status')) document.getElementById('status').value = statusVal;

    // 4. Switch UI Views
    passSection.classList.add('hidden');
    formSection.classList.remove('hidden');
});

// --- ADMIN DASHBOARD LOGIC ---
let unsubscribe = null; // Store listener to detach if needed

 function loadAdminDashboard() {
    const adminTableBody = document.getElementById('adminTableBody');
    const searchInput = document.getElementById('searchInput');
    const filterStatus = document.getElementById('filterStatus');
    
    // Real-time listener
    const passesRef = collection(db, "gate_passes");
    
    if (unsubscribe) unsubscribe(); // clear previous listeners
    const q = query(
        passesRef,
        orderBy("createdAt", "desc")
    );
    unsubscribe = onSnapshot(q, (snapshot) => {
        console.log("Listener updated with", snapshot.size, "passes");
        adminTableBody.innerHTML = '';
        let allPasses = [];
        let activeCount = 0;

        snapshot.forEach((docSnap) => {
            let data = docSnap.data();
            data.docId = docSnap.id; 
            
            // Frontend Auto-Expiry Check
            if (data.status === 'ACTIVE' && Date.now() > data.expiryTimestamp) {
                // Background update to Firebase
                updateDoc(doc(db, "gate_passes", data.docId), { status: "EXPIRED" });
                data.status = "EXPIRED"; 
            }

            // --- RENDER LOGIC ---
            // Example: Append a row to your table
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${data.name || 'N/A'}</td>
                <td>${data.usn || 'N/A'}</td>
                <td>${data.status}</td>
            `;
            adminTableBody.appendChild(row);

            // FIX: Count 'SCANNED_OUT' and 'PENDING_APPROVAL' so the form stays completely hidden until they RETURN!
            if (data.status === 'ACTIVE' || data.status === 'SCANNED_OUT' || data.status === 'PENDING_APPROVAL' || data.status === 'AUTO_APPROVED') {
                activeCount++;
            }
            allPasses.push(data);
        });

        // Update Stats
        document.getElementById('activeCount').innerText = activeCount;
        document.getElementById('totalCount').innerText = allPasses.length;

        // Render Table Function
        const renderTable = () => {
            adminTableBody.innerHTML = '';
            const searchTerm = searchInput.value.toUpperCase();
            const statusFilter = filterStatus.value;

            const filtered = allPasses.filter(p => {
                const matchSearch = p.usn.includes(searchTerm) || p.passId.includes(searchTerm);
                const matchStatus = statusFilter === 'ALL' || p.status === statusFilter;
                return matchSearch && matchStatus;
            });

            filtered.sort((a, b) => b.expiryTimestamp - a.expiryTimestamp).forEach(pass => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${pass.passId}</strong></td>
                    <td>${pass.name}</td>
                    <td>${pass.usn}</td>
                    <td><span class="status-badge status-${pass.status}">${pass.status}</span></td>
                    <td>
                        ${pass.status === 'ACTIVE' ? `<button class="btn-small mark-returned" data-id="${pass.docId}">Mark Return</button>` : '-'}
                    </td>
                `;
                adminTableBody.appendChild(tr);
            });

            // Attach event listeners to new dynamic buttons
            document.querySelectorAll('.mark-returned').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const docId = e.target.getAttribute('data-id');
                    await updateDoc(doc(db, "gate_passes", docId), { status: "RETURNED" });
                    showToast("Pass marked as RETURNED");
                });
            });
        };

        renderTable();
        // Re-render when filters change
        searchInput.addEventListener('input', renderTable);
        filterStatus.addEventListener('change', renderTable);
    });
}

// --- STAGE 6 UTILITY: Calculate GPS Distance ---
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in meters
}

// --- NEW: ASYNC PIN MODAL ENGINE ---
  const pinModal = document.getElementById('pinModalOverlay');
  const pinCurrent = document.getElementById('modalPinCurrent');
  const pinNew = document.getElementById('modalPinNew');
  const pinConfirm = document.getElementById('modalPinConfirm');
  let pinResolve = null;

  async function triggerPinSetupMode(usn) {
  const newPin = await promptPinModal("SETUP");
  if(!newPin) return;

  const hashedPin = await hashPin(newPin);
  
  // 1. Update the Master Database
  await updateDoc(doc(db, "students", usn), {
    pin: hashedPin,
    pinCreated: true,
    pinResetRequired: false,
    lastPinChanged: serverTimestamp()
  });

  // 2. CRITICAL SECURITY FIX: Permanently lock this USN to the student's Google Profile
  await updateDoc(doc(db, "users", currentUserProfile.uid), { 
    usn: usn 
  });
  currentUserProfile.usn = usn; // Lock the local session immediately

  verifiedStudentData.pin = hashedPin;
  verifiedStudentData.pinCreated = true;
  
  // 3. Lock the UI inputs so they can't change it
  document.getElementById('usn').readOnly = true;
  document.getElementById('btnChangePin').style.display = 'block';
  document.getElementById('submitBtn').disabled = false;
  showToast("Identity Locked & PIN created securely!", "success");
}

  function promptPinModal(mode) {
    return new Promise((resolve) => {
      pinResolve = resolve;
      pinModal.classList.remove('hidden');
      pinCurrent.value = ''; pinNew.value = ''; pinConfirm.value = '';
      
      const grpCurrent = document.getElementById('pinInputGroupCurrent');
      const grpNew = document.getElementById('pinInputGroupNew');
      const grpConfirm = document.getElementById('pinInputGroupConfirm');
      const btnForgot = document.getElementById('btnForgotPin');
      const btnCancel = document.getElementById('btnCancelPinModal');
      const title = document.getElementById('pinModalTitle');
      const desc = document.getElementById('pinModalDesc');

      grpCurrent.classList.add('hidden');
      btnForgot.classList.add('hidden');
      btnCancel.classList.add('hidden');

      if (mode === "VERIFY") {
        title.innerText = "Verify Identity";
        desc.innerText = "Enter your 4-digit security PIN.";
        grpNew.classList.remove('hidden');
        grpConfirm.classList.add('hidden');
        btnForgot.classList.remove('hidden');
        btnCancel.classList.remove('hidden');
        document.getElementById('lblModalPinNew').innerText = "Security PIN";
      } else if (mode === "SETUP") {
        title.innerText = "Create Your Security PIN";
        desc.innerText = "Set a 4-digit PIN for future passes.";
        grpNew.classList.remove('hidden');
        grpConfirm.classList.remove('hidden');
        document.getElementById('lblModalPinNew').innerText = "New PIN";
      } else if (mode === "CHANGE") {
        title.innerText = "Change Security PIN";
        desc.innerText = "Enter your current PIN to set a new one.";
        grpCurrent.classList.remove('hidden');
        grpNew.classList.remove('hidden');
        grpConfirm.classList.remove('hidden');
        btnCancel.classList.remove('hidden');
        btnForgot.classList.remove('hidden'); // FIX 3: Unhide the "Forgot PIN" button so they can actually request Admin help!
        document.getElementById('lblModalPinNew').innerText = "New PIN";
      }
      
      pinModal.setAttribute('data-mode', mode);
    });
  }

  document.getElementById('btnSubmitPinModal').addEventListener('click', async () => {
    const mode = pinModal.getAttribute('data-mode');
    const vNew = pinNew.value;
    const vConfirm = pinConfirm.value;
    const vCurrent = pinCurrent.value;

    if (mode === "VERIFY") {
      if(vNew.length !== 4) return showToast("PIN must be 4 digits", "error");
      closePinModal(vNew);
    } else if (mode === "SETUP") {
      if(vNew.length !== 4 || !/^\d+$/.test(vNew)) return showToast("PIN must be exactly 4 numbers", "error");
      if(vNew !== vConfirm) return showToast("PINs do not match!", "error");
      closePinModal(vNew);
    } else if (mode === "CHANGE") {
      if(vNew.length !== 4 || !/^\d+$/.test(vNew)) return showToast("New PIN must be exactly 4 numbers", "error");
      if(vNew !== vConfirm) return showToast("New PINs do not match!", "error");
      
      const hashedCurrent = await hashPin(vCurrent);
      if (hashedCurrent !== verifiedStudentData.pin) return showToast("Current PIN is incorrect!", "error");
      
      closePinModal(vNew);
    }
  });

  document.getElementById('btnCancelPinModal').addEventListener('click', () => closePinModal(null));
  
  function closePinModal(result) {
    pinModal.classList.add('hidden');
    if (pinResolve) pinResolve(result);
  }

  // Handle Forgot PIN
  document.getElementById('btnForgotPin').addEventListener('click', async () => {
    closePinModal(null);
    if(confirm("Submit a formal PIN reset request to the Admin?")) {

        
       // ADD LOGS HERE
console.log("DEBUGGING PIN RESET:");
console.log("UID:", auth.currentUser ? auth.currentUser.uid : "UNDEFINED");
console.log("USN being sent:", verifiedStudentData.usn || currentUserProfile.usn);
console.log("Student Name:", verifiedStudentData.name || currentUserProfile.name);
console.log("Department:", verifiedStudentData.department || "");

 const resetRequest = {
    usn: verifiedStudentData.usn || currentUserProfile.usn,
    studentName: verifiedStudentData.name || currentUserProfile.name,
    department: verifiedStudentData.department || "",
    requestDate: serverTimestamp(),
    status: "PENDING"
};

console.log("Reset Request:", resetRequest);
      await addDoc(collection(db, "pinResetRequests"), resetRequest);
      showToast("Reset request sent to admin. Please wait for approval.", "success");
    }
  });

     // Handle Change PIN click
  document.getElementById('btnChangePin').addEventListener('click', async () => {
    // FIX 2: If admin approved a reset, launch SETUP mode instead of CHANGE mode!
    const mode = verifiedStudentData.pinResetRequired ? "SETUP" : "CHANGE";
    const newPin = await promptPinModal(mode);
    
    if(!newPin) return;
    
    const hashedPin = await hashPin(newPin);
    await updateDoc(doc(db, "students", verifiedStudentData.usn), {
      pin: hashedPin,
      pinResetRequired: false, // CRITICAL: Clear the reset flag!
      lastPinChanged: serverTimestamp()
    });
    
    verifiedStudentData.pin = hashedPin;
    verifiedStudentData.pinResetRequired = false;
    
    // Reset button text back to normal and unlock form
    document.getElementById('btnChangePin').innerText = "Change PIN";
    document.getElementById('submitBtn').disabled = false;
    
    showToast(mode === "SETUP" ? "New PIN set successfully!" : "PIN changed successfully!", "success");
  });

  // --- NEW: INSTRUCTIONS MODAL LOGIC ---
const instructionsModal = document.getElementById('instructionsModalOverlay');
const btnAcknowledge = document.getElementById('btnAcknowledgeInstructions');
const showInstructionsLink = document.getElementById('showInstructionsLink'); // NEW LINK TARGET

if (instructionsModal && btnAcknowledge) {
  // Only show the instructions once per session to avoid annoying the student
  if (!sessionStorage.getItem('instructionsSeen')) {
    instructionsModal.classList.remove('hidden');
  }

  // Hide the modal when they click "I Understand"
  btnAcknowledge.addEventListener('click', () => {
    instructionsModal.classList.add('hidden');
    sessionStorage.setItem('instructionsSeen', 'true');
  });

  // NEW: Show the modal again if they click the tiny link above the form
  if (showInstructionsLink) {
    showInstructionsLink.addEventListener('click', (e) => {
      e.preventDefault(); // Prevents the page from scrolling to the top
      instructionsModal.classList.remove('hidden');
    });
  }
}