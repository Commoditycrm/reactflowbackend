import { Request, Response } from "express";
import logger from "../../logger";
import { FirebaseFunctions } from "../../graphql/firebase/firebaseFunctions";
import { EmailService } from "../../services";
import { EnvLoader } from "../../util/EnvLoader";

const firebaseFunction = FirebaseFunctions.getInstance();
const emailServices = EmailService.getInstance();
const verifyLinkTemplateId = EnvLoader.getOrThrow(
  "FIREBASE_VERIFY_TEMPLATE_ID"
);

const resendEmailVerifictionLink = async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({
      error: "Validation Error",
      message: "Invalid or incomplete request data.",
    });
  }
  try {
    logger.info("processing email verification link.", { email });
    const link = await firebaseFunction.generateVerificationLink(email);
    await emailServices.sendTemplate({
      templateId: verifyLinkTemplateId,
      dynamicTemplateData: {
        verifyLink: link,
      },
      to: email,
    });
    logger.info("Successfully sent email verification link to:", {
      email,
      link,
    });
    return res.status(200).json({
      status: true,
      messag: "Successfully sent email verification link",
    });
  } catch (error) {
    logger.error("Field to send email verification link.", { error });
    return res.status(500).json(error);
  }
};

export default resendEmailVerifictionLink;
