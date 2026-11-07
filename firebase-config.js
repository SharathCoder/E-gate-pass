import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyD39mdP5GSQIGOhgdXUptHNrI1p0htj1xk",
  authDomain: "smart-gate-pass-v2.firebaseapp.com",
  projectId: "smart-gate-pass-v2",
  storageBucket: "smart-gate-pass-v2.firebasestorage.app",
  messagingSenderId: "848075013170",
  appId: "1:848075013170:web:9ee9dda8b5ff67500ad02b",
  measurementId: "G-GHN6HWY4JZ"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
// 2. ADD THIS CODE BLOCK IMMEDIATELY AFTER INITIALIZING db
enableIndexedDbPersistence(db).catch((err) => {
    if (err.code == 'failed-precondition') {
        console.warn("Persistence failed: Multiple tabs open.");
    } else if (err.code == 'unimplemented') {
        console.warn("Persistence not supported in this browser.");
    }
});
export const auth = getAuth(app);
export const storage = getStorage(app); // NEW: Export Storage