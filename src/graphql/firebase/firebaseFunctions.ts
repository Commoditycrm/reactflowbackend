import { UserRecord } from "firebase-admin/auth";
import { ActionCodeSettings } from "firebase/auth";
import logger from "../../logger";
import { EnvLoader } from "../../util/EnvLoader";
import { getFirebaseAdminAuth } from "./admin";
import { UserRole } from "../../@types/ogm.types";

export class FirebaseFunctions {
  admin = getFirebaseAdminAuth();

  static instance: FirebaseFunctions;

  private constructor() {
    this.admin = getFirebaseAdminAuth();
  }

  static getInstance() {
    if (!FirebaseFunctions.instance) {
      FirebaseFunctions.instance = new FirebaseFunctions();
    }
    return FirebaseFunctions.instance;
  }

  async createUser(userInput: {
    email: string;
    password: string;
    name: string;
    phoneNumber: string;
  }) {
    const user = await this.admin.auth().createUser({
      email: userInput?.email,
      password: userInput?.password,
      displayName: userInput?.name,
      ...(userInput.phoneNumber && { phoneNumber: userInput.phoneNumber }),
    });

    await this.setUserClaims(
      user.uid,
      user.email,
      UserRole.CompanyAdmin,
      false
    );
    logger.info(`User claim set to:${userInput.email}`);

    const verifyLink = await this.generateVerificationLink(userInput.email);

    logger?.debug(`sent verification link`, { verifyLink });

    return { status: true, verifyLink };
  }

  async generateVerificationLink(email: string) {
    const url = `${EnvLoader.getOrThrow("CLIENT_URL")}/login`;
    const actionCodeSettings: ActionCodeSettings = {
      url,
      handleCodeInApp: true,
    };
    return await this.admin
      .auth()
      .generateEmailVerificationLink(email, actionCodeSettings);
  }
// kaedan80@dotoctuvo.com
  async resetPassword(email: string, actionCodeSettings: ActionCodeSettings) {
    const passwordResetLink = await this.admin
      .auth()
      .generatePasswordResetLink(email, actionCodeSettings);
    logger?.debug(`Password-Reset Link: ${passwordResetLink}`);
    return passwordResetLink;
  }

  async setUserClaims(
    userId: string | undefined,
    email: string | undefined,
    accessRole: string,
    orgCreated: boolean
  ): Promise<string[]> {
    if (!userId || !email || !accessRole)
      throw new Error("Invalid userId or Email or accessRole");

    await this.admin
      .auth()
      .setCustomUserClaims(userId, { roles: [accessRole], orgCreated });
    return [accessRole];
  }

  async getUserByEmail(email: string): Promise<UserRecord> {
    if (!email) throw new Error("Invalid userId or Email");

    const user = await this.admin.auth().getUserByEmail(email);

    return user;
  }

  async createInvitedUser(userInput: {
    email: string;
    password: string;
    name: string;
    phoneNumber: string;
    role: string;
  }): Promise<{ user: UserRecord }> {
    const user = await this.admin.auth().createUser({
      email: userInput?.email,
      password: userInput?.password,
      displayName: userInput?.name,
      emailVerified: true,
      ...(userInput.phoneNumber && { phoneNumber: userInput.phoneNumber }),
    });
    await this.setUserClaims(user.uid, user.email, userInput?.role, true);
    return { user };
  }
}
