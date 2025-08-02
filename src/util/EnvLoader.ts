import logger from "../logger";

export class EnvLoader {
  /**
   * Get an environment variable or throw an error if not set
   * @param key - The environment variable key
   * @returns The environment variable value
   */
  static getOrThrow(key: string): string {
    const value = process.env[key];
    if (!value) {
      logger?.info(key);
      throw new Error(`Environment variable "${key}" is missing.`);
    }
    return value;
  }
  /**
   * Get and format the Firebase private key
   * @returns The formatted private key
   */
  static getFirebasePrivateKey(): string {
    const privateKey = EnvLoader.getOrThrow("FIREBASE_PRIVATE_KEY");
    return privateKey.replace(/\\n/g, "\n"); // Replace escaped newlines with actual newlines
  }
}
