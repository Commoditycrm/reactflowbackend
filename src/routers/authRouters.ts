import { Router } from "express";
import login from "../controllers/auth/login";
import createOwner from "../controllers/auth/createOrgOwner";
import resendEmailVerifictionLink from "../controllers/auth/resendEmailVerificationLink";

const authRouter = Router();

authRouter.post("/createOwner", createOwner);
authRouter.post("/resend_email_verification", resendEmailVerifictionLink);
// authRouter.post("/reset_password", generateResetPassword);
authRouter.get("/login", login);

export default authRouter;
