import { Request, Response } from "express";
import logger from "../../logger";
import { EmailService } from "../../services";
import { EnvLoader } from "../../util/EnvLoader";
import { FirebaseFunctions } from "../../graphql/firebase/firebaseFunctions";

const firebaseFunctions = FirebaseFunctions.getInstance();
const emailService = EmailService.getInstance();
const verifyLinkTemplateId = EnvLoader.getOrThrow(
  "FIREBASE_VERIFY_TEMPLATE_ID"
);

const createOwner = async (req: Request, res: Response) => {
  const { email, password, name, phoneNumber } = req.body;
  //   const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (!email || !password) {
    logger.warn("Validation Error", { email, password, name });
    return res.status(400).json({
      error: "Validation Error",
      message: "Invalid or incomplete request data.",
    });
  }
  logger.info("Start creating firebase user", { email, password, phoneNumber });
  const payload = {
    email,
    password,
    ...(phoneNumber && { phoneNumber: `+${phoneNumber}` }),
    name,
  };

  try {
    const response = await firebaseFunctions.createUser(payload);
    logger.info("Firebase user created successfully.", { email });
    await emailService.sendTemplate({
      templateId: verifyLinkTemplateId,
      dynamicTemplateData: {
        verifyLink: response.verifyLink,
      },
      to: email,
    });
    logger.info("Verification email sent.", { email });
    return res
      .status(201)
      .json({ ...response, message: "User created successfully." });
  } catch (error) {
    logger.error("Field to create user for the email:", {
      email,
      phoneNumber,
      error,
    });
    res.status(500).json(error);
  }
};

export default createOwner;
