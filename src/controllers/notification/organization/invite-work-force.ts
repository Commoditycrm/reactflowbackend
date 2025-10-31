import { Request, Response } from "express";
import { getFirebaseAdminAuth } from "../../../graphql/firebase/admin";
import { OrganizationEmailService } from "../../../services";
import jwt from "jsonwebtoken";
import { EnvLoader } from "../../../util/EnvLoader";
import { InviteWorkForceProps } from "../../../interfaces";
import { performance } from "node:perf_hooks";
import logger from "../../../logger";

// ---- SINGLETONS (hoisted) ----
const auth = getFirebaseAdminAuth().auth();
const jwtSecret = EnvLoader.getOrThrow("INVITE_JWT_SECRET");
const clientUrl = EnvLoader.getOrThrow("CLIENT_URL");
const sendEmail = new OrganizationEmailService();

const inviteWorkForce = async (req: Request, res: Response) => {
  const t0 = performance.now();

  // Extract + normalize
  let {
    firstName,
    lastName,
    role,
    email,
    phoneNumber,
    orgId,
    organizationName,
    senderName,
  } = req.body;

  email = String(email || "")
    .trim()
    .toLowerCase();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  // Basic validation
  if (
    !role ||
    !email ||
    !phoneNumber ||
    !orgId ||
    !organizationName ||
    !senderName
  ) {
    return res.status(400).json({
      error: "Validation Error",
      message: "Invalid or incomplete request data.",
    });
  }

  // Pre-generate token & link
  const token = jwt.sign(
    { email, sub: email, role, name: fullName, orgId },
    jwtSecret,
    { expiresIn: "1d" }
  );
  const invitationLink = `${clientUrl}/invite?token=${token}`;
  const t1 = performance.now();

  // ----- STRICT user-exists check (no timeouts, no optimistic fallback) -----
  let userExists = false;
  const tExistsStart = performance.now();
  try {
    await auth.getUserByEmail(email);
    userExists = true; // if we got here, user exists
  } catch (e: any) {
    if (e?.code === "auth/user-not-found") {
      userExists = false;
    } else {
      // Unknown Firebase error -> log and fail (don’t send email)
      logger.error("Firebase getUserByEmail failed", {
        email,
        code: e?.code,
        message: e?.message || String(e),
      });
      return res.status(500).json({
        message: "Server error while checking user.",
        error: { code: e?.code || "unknown", message: e?.message || String(e) },
      });
    }
  }
  const tExistsEnd = performance.now();

  if (userExists) {
    logger.info("Invite skipped: user already exists", {
      email,
      dtJwtMs: Math.round(t1 - t0),
      dtExistsMs: Math.round(tExistsEnd - tExistsStart),
    });
    return res.status(409).json({ message: "User already exists." });
  }

  // ----- Send invite email (synchronous 201) -----
  const mailData: InviteWorkForceProps = {
    inviteLink: invitationLink,
    name: fullName,
    role,
    organizationName,
    senderName,
    to: email,
    type: "INVITE_WORKFORCE",
  };

  const tSendStart = performance.now();
  try {
    const ok = await sendEmail.inviteWorkForce(mailData);

    const tEnd = performance.now();
    logger.info("Invitation email attempted", {
      email,
      org: organizationName,
      sent: ok,
      dtJwtMs: Math.round(t1 - t0),
      dtExistsMs: Math.round(tExistsEnd - tExistsStart),
      dtSendMs: Math.round(tEnd - tSendStart),
      dtTotalMs: Math.round(tEnd - t0),
    });

    if (!ok) {
      // SendGrid returned false; surface a 502 to caller if you want strictness.
      return res.status(502).json({
        success: false,
        message: "Failed to send invite email.",
        link: invitationLink,
        token,
      });
    }

    return res.status(201).json({ success: true, link: invitationLink, token });
  } catch (error: any) {
    const tEnd = performance.now();
    logger.error("InviteWorkForce crashed sending email", {
      email,
      code: error?.code || "unknown",
      message: error?.message || String(error),
      dtTotalMs: Math.round(tEnd - t0),
    });
    return res.status(500).json({
      message: "An error occurred while inviting the user. Please try again.",
      error: {
        code: error?.code || "unknown",
        message: error?.message || String(error),
      },
    });
  }
};

export default inviteWorkForce;
