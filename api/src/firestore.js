import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = getApps()[0] ?? initializeApp({
  credential: applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
});

export const db = getFirestore(app);
export const FieldValue = (await import('firebase-admin/firestore')).FieldValue;
