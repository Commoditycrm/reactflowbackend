import * as admin from "firebase-admin";
import logger from "../../logger";
import { EnvLoader } from "../../util/EnvLoader";

export const getFirebaseAdminAuth = (): admin.app.App => {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        clientEmail: EnvLoader.getOrThrow("FIREBASE_CLIENT_EMAIL"),
        privateKey: EnvLoader.getFirebasePrivateKey(),
        projectId: EnvLoader.getOrThrow("FIREBASE_PROJECT_ID"),
      }),
      storageBucket: EnvLoader.getOrThrow("FIREBASE_STORAGE_BUCKET"),
    });
    logger?.info("Firebase Admin SDK initialized successfully.");
  }
  return admin.app();
};
