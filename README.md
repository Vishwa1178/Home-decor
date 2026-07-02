# Home Decor Booking Site — Setup Guide

## The Problem You're Seeing

> "Email/Password sign-in is not enabled. Enable it in Firebase Console > Authentication > Sign-in method."

This error means Firebase is connected but **Email/Password authentication is turned off** in your Firebase project. Fix it with these steps.

---

## Step 1 — Enable Email/Password Authentication

1. Open [Firebase Console](https://console.firebase.google.com)
2. Select your project: **home-decor-74a7c**
3. Left sidebar → **Authentication**
4. Click the **Sign-in method** tab
5. Click **Email/Password**
6. Toggle **Enable** → **Save**

---

## Step 2 — Create the Admin User

After enabling Email/Password, create the account the admin will log in with:

1. In Firebase Console → **Authentication** → **Users** tab
2. Click **Add user**
3. Email: `awonderonesurprise7@gmail.com`
4. Password: `Admin@1234` (change this to something secure!)
5. Click **Add user**

---

## Step 3 — Set Firestore Rules

1. Firebase Console → **Firestore Database** → **Rules** tab
2. Replace the rules with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /bookings/{bookingId} {
      // Anyone can create a booking (customers submitting forms)
      allow create: if true;
      // Only the admin can read, update, or delete bookings
      allow read, update, delete: if request.auth != null
        && request.auth.token.email == "awonderonesurprise7@gmail.com";
    }
  }
}
```

3. Click **Publish**

---

## Step 4 — Allow Localhost (for local testing)

1. Firebase Console → **Authentication** → **Settings** tab
2. Under **Authorized domains**, make sure `localhost` and `127.0.0.1` are listed
3. If not, click **Add domain** and add them

---

## Run Locally

```powershell
npm run dev
```

- Site: `http://127.0.0.1:5173`
- Admin: `http://127.0.0.1:5173/admin`

---

## How It Works

- **Customer books** → data saved to Firestore `bookings` collection
- **Admin logs in** → Firebase Email/Password auth verifies credentials
- **Admin dashboard** → shows all bookings in real-time (live updates via Firestore `onSnapshot`)
- **Status column** → shows Pending / Confirmed / Cancelled per booking

---

## Firebase Config (already set in firebase-config.js)

```js
apiKey: "AIzaSyBGmV1VR8igcmnCEzoI5-3a9dfOUnUYEW0"
authDomain: "home-decor-74a7c.firebaseapp.com"
projectId: "home-decor-74a7c"
storageBucket: "home-decor-74a7c.firebasestorage.app"
messagingSenderId: "1054389592963"
appId: "1:1054389592963:web:f520a1f526819fce184cb6"
```
