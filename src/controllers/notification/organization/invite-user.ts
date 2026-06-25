import { Request, Response } from "express";
import { getFirebaseAdminAuth } from "../../../graphql/firebase/admin";
import { OrganizationEmailService } from "../../../services";
import jwt from "jsonwebtoken";
import { EnvLoader } from "../../../util/EnvLoader";
import { performance } from "node:perf_hooks";
import logger from "../../../logger";
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

  // Basic validation. Log only which fields are missing -- never the body, which
  // carries PII (emails, names).
  if (!email || !orgId || !orgName || !inviterName || !inviterEmail) {
    const missing = Object.entries({
      email,
      orgId,
      orgName,
      inviterName,
      inviterEmail,
    })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    logger.warn("Validation Error", { missing });
    return res.status(400).json({
      error: "Validation Error",
      message: "Invalid or incomplete request data.",
    });
  }
  // Pre-generate token & link (email is already normalized above)
  const token = jwt.sign(
    { email, sub: email, role: "invitee", orgId },
    jwtSecret,
    {
      expiresIn: "7d",
    },
  );
  const invitationLink = `${clientUrl}/invite?token=${token}`;
  logger.info("Generated invite for user", { email, orgId });

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
      // SendGrid returned false. Don't leak the live invite token/link in the
      // error payload (it can land in client logs / error trackers).
      return res.status(502).json({
        success: false,
        message: "Failed to send invite email.",
      });
    }

    return res
      .status(201)
      .json({ success: true, link: invitationLink, token });
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
