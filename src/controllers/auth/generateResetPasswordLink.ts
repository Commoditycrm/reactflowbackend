import { Request, Response } from "express";
import logger from "../../logger";
import { EmailService } from "../../services";
import { FirebaseFunctions } from "../../graphql/firebase/firebaseFunctions";
import { EnvLoader } from "../../util/EnvLoader";
import { ActionCodeSettings } from "firebase/auth";
const emailServices = EmailService.getInstance();
const firebaseFunctions = FirebaseFunctions.getInstance();
const templateId = EnvLoader.getOrThrow("PASSWORD_RESET_TEMPLATE_ID");

const generateResetPasswordLink = async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({
      error: "Validation Error",
      message: "Invalid or incomplete request data.",
    });
  }
  const actionCodeSettings: ActionCodeSettings = {
    url: `${EnvLoader.getOrThrow("CLIENT_URL")}/login`,
    handleCodeInApp: true,
  };
  try {
    logger.info("processing email verification link.", { email });
    const link = await firebaseFunctions.resetPassword(
      email,
      actionCodeSettings
    );
    await emailServices.sendTemplate({
      to: email,
      templateId,
      dynamicTemplateData: {
        resetPasswordLink: link,
      },
    });
    logger.info("reset password link sent.", { email, link });
    return res.status(200).json({
      status: true,
      message: "Reset password link sent successfully.",
    });
  } catch (error) {
    logger.error("Field to send reset password link", { email, error });
    return res.status(500).json(error);
  }
};

export default generateResetPasswordLink;
