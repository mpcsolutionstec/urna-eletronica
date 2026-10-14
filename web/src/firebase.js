import { getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Firebase Web config: identifica o app, mas não concede privilégios por si só.
const firebaseConfig = {
  apiKey: 'AIzaSyCDko07MYgJRew_tQYJ5WeTOZFtl7_v3SE',
  authDomain: 'urna-eletronica-f0d3f.firebaseapp.com',
  projectId: 'urna-eletronica-f0d3f',
  storageBucket: 'urna-eletronica-f0d3f.firebasestorage.app',
  messagingSenderId: '586281877442',
  appId: '1:586281877442:web:5626ac951bfdda7e05605b',
};

const app = getApps()[0] ?? initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
