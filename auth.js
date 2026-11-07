import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

// Global variable to hold user profile data
export let currentUserProfile = null;

// Route Guard Function
export function enforceRBAC(requiredRole) {
    const loader = document.createElement('div');
    loader.innerHTML = `<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#0f172a;z-index:9999;display:flex;align-items:center;justify-content:center;color:white;font-size:1.5rem;">Authenticating Secure Session...</div>`;
    document.body.appendChild(loader);

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = "login.html";
            return;
        }

        try {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (!userDoc.exists()) {
                await signOut(auth);
                alert("Profile missing. Contact Admin.");
                window.location.href = "login.html";
                return;
            }

            currentUserProfile = userDoc.data();
            currentUserProfile.uid = user.uid;

            if (currentUserProfile.status === "BLOCKED") {
                await signOut(auth);
                alert("Your account has been restricted.");
                window.location.href = "login.html";
                return;
            }

            if (requiredRole && currentUserProfile.role !== requiredRole) {
                if (currentUserProfile.role === 'admin') window.location.href = "admin.html";
                else if (currentUserProfile.role === 'watchman') window.location.href = "watchman.html";
                else window.location.href = "index.html";
                return;
            }

            loader.remove();
            document.dispatchEvent(new CustomEvent('authReady'));

        } catch (error) {
            console.error("Auth Error:", error);
            window.location.href = "login.html";
        }
    });
}

// Global Logout Handler (Enhanced Security)
export async function logoutUser() {
    try {
        // 1. Wipe all local and session data to prevent token extraction
        localStorage.clear();
        sessionStorage.clear();
        
        // 2. Firebase SignOut
        await signOut(auth);
        
        // 3. Redirect with replacement to break the browser "Back" button history
        window.location.replace("login.html");
    } catch (error) {
        console.error("Logout Error:", error);
    }
}