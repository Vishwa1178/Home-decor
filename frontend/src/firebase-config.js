// Firebase config sourced from Vite environment variables.
// Values are injected at build time from `.env` (see .env.example).
// Never hardcode credentials in this file.

const env = import.meta.env;

function required(name) {
  const value = env[name];
  if (!value) {
    // eslint-disable-next-line no-console
    console.warn(`[firebase-config] Missing environment variable: ${name}`);
  }
  return value ?? "";
}

export const firebaseConfig = {
  apiKey: required("VITE_FIREBASE_API_KEY"),
  authDomain: required("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: required("VITE_FIREBASE_PROJECT_ID"),
  storageBucket: required("VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: required("VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: required("VITE_FIREBASE_APP_ID"),
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || undefined,
};

// Base URL for the backend REST API (Express service on Render), no trailing slash.
// Admin authorization is decided by this API (verified ID token + `admin` custom
// claim), not by anything in the browser. There is intentionally no admin email here.
export const API_BASE_URL = (env.VITE_API_URL || "").replace(/\/+$/, "");
