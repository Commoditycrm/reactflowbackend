import admin from "firebase-admin";
import logger from "../../logger";
import { EnvLoader } from "../../util/EnvLoader";

export const getFirebaseAdminAuth = () => {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        clientEmail: EnvLoader.getOrThrow("NEXT_PUBLIC_FIREBASE_CLIENT_EMAIL"),
        privateKey: EnvLoader.getFirebasePrivateKey(),
        projectId: EnvLoader.getOrThrow("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
      }),
      storageBucket: EnvLoader.getOrThrow(
        "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"
      ),
    });
    logger?.info("Firebase Admin SDK initialized successfully.");
  }
  return admin.app();
};
