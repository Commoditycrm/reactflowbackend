import { Request, Response } from "express";
import { getFirebaseAdminAuth } from "../../../graphql/firebase/admin";
import { OrganizationEmailService } from "../../../services";
import jwt from "jsonwebtoken";
import { EnvLoader } from "../../../util/EnvLoader";
import { performance } from "node:perf_hooks";
import logger from "../../../logger";
import crypto from "crypto";
import { InviteUserProps } from "../../../interfaces/types";

const auth = getFirebaseAdminAuth().auth();
const jwtSecret = EnvLoader.getOrThrow("INVITE_JWT_SECRET");
const clientUrl = EnvLoader.getOrThrow("CLIENT_URL");
const sendEmail = new OrganizationEmailService();

const inviteUserToOrg = async (req: Request, res: Response) => {
  const t0 = performance.now();

  // Extract + normalize
  let { email, orgId, orgName, inviterName, inviterEmail } = req.body;

  email = String(email || "")
    .trim()
    .toLowerCase();

  // Basic validation
  if (!email || !orgId || !orgName || !inviterName || !inviterEmail) {
    logger.warn("Validation Error", { ...req.body });
    return res.status(400).json({
      error: "Validation Error",
      message: "Invalid or incomplete request data.",
    });
  }

  // Pre-generate token & link
  const token = jwt.sign(
    { email, sub: email, role: "invitee", orgId },
    jwtSecret,
    {
      expiresIn: "1d",
    }
  );
  const invitationLink = `${clientUrl}/invite?token=${token}`;
  const hashToken = crypto
    .createHash("sha256")
    .update(token + jwtSecret)
    .digest("hex");

  let userExists = false;
  try {
    await auth.getUserByEmail(email);
    userExists = true;
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

  if (userExists) {
    logger.info("Invite skipped: user already exists", {
      email,
    });
    return res.status(409).json({ message: "User already exists." });
  }

  // ----- Send invite email (synchronous 201) -----
  const mailData: InviteUserProps = {
    inviteLink: invitationLink,
    orgName,
    inviterName,
    to: email,
    type: "INVITE_USER",
  };

  try {
    const ok = await sendEmail.inviteUser(mailData);

    logger.info("Invitation email attempted", {
      email,
      org: {
        id: orgId,
        name: orgName,
      },
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

    return res
      .status(201)
      .json({ success: true, link: invitationLink, token: hashToken });
  } catch (error: any) {
    const tEnd = performance.now();
    logger.error("Invite user to org crashed sending email", {
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

export default inviteUserToOrg;
