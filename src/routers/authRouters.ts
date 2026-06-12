import { Router } from "express";
import createOwner from "../controllers/auth/createOrgOwner";
import resendEmailVerifictionLink from "../controllers/auth/resendEmailVerificationLink";
import generateResetPasswordLink from "../controllers/auth/generateResetPasswordLink";

const authRouter = Router();

authRouter.post("/createOwner", createOwner);
authRouter.post("/resend_email_verification", resendEmailVerifictionLink);
authRouter.post("/reset_password_link", generateResetPasswordLink);

export default authRouter;
