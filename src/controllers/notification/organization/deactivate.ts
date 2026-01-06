import { Request, Response } from "express";
import logger from "../../../logger";
import { EmailService } from "../../../services";
import { EnvLoader } from "../../../util/EnvLoader";

const emailServices = EmailService.getInstance();
const addProjectTemplateId = EnvLoader.getOrThrow("ASSIGN_PROJECT_TEMPLATE_ID");

const orgDeactivate = async (req: Request, res: Response) => {
  const { orgName, userName, userEmail } = req.body;

  // Validation check
  if (!orgName || !userName || !userEmail) {
    logger.warn(
      "Organization Deactivation: Validation failed. Missing required fields.",
      {
        body: req.body,
        missingFields: { orgName, userName, userEmail },
      }
    );
    return res.status(400).json({
      error: "Validation Error",
      message: "Input fields are required.",
    });
  }

  logger.info(
    "Organization Deactivation: Request received for deactivating organization.",
    {
      orgName,
      userName,
      userEmail,
    }
  );

  try {
    const baseUrl = EnvLoader.getOrThrow("CLIENT_URL");

    logger.info(
      "Organization Deactivation: Sending deactivation notification email to user.",
      {
        toEmail: userEmail,
        templateId: addProjectTemplateId,
      }
    );

    // Sending the email
    await emailServices.sendTemplate({
      to: userEmail,
      templateId: addProjectTemplateId,
      dynamicTemplateData: {
        orgName,
        userName,
        dashboardLink: baseUrl,
      },
    });

    logger.info(
      "Organization Deactivation: Deactivation email sent successfully.",
      {
        userEmail,
        orgName,
        userName,
      }
    );

    return res.status(200).json({
      message: "Organization deactivation email sent successfully.",
      status: true,
    });
  } catch (error: any) {
    logger.error(
      "Organization Deactivation: Failed to send deactivation email.",
      {
        userEmail,
        error: error.message,
        stack: error.stack,
        orgName,
        userName,
      }
    );

    return res.status(500).json({
      status: false,
      error: error.message,
    });
  }
};

export default orgDeactivate;
