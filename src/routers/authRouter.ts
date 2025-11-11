import { Router } from "express";
import createOwner from "../controllers/auth/createOwner";
import resendEmailVerifictionLink from "../controllers/auth/resendEmailVerificationLink";
import generateResetPassword from "../controllers/auth/generateResetPassword";
import login from "../controllers/auth/login";

const authRouter = Router();

authRouter.post("/createOwner", createOwner);
authRouter.post("/resend_email_verification", resendEmailVerifictionLink);
authRouter.post("/reset_password", generateResetPassword);
authRouter.get("/login", login);

export default authRouter;
