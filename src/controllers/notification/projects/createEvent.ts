import { Request, Response } from "express";
import logger from "../../../logger";
import { EnvLoader } from "../../../util/EnvLoader";
import { EmailService } from "../../../services";
import { WhatsAppService } from "../../../services/WhatsAppServices";

const emailServices = EmailService.getInstance();
const waService = WhatsAppService.getInstance();
const templateId = EnvLoader.getOrThrow("CREATE_EVENT_TEMPLATE_ID");
const contentSid = EnvLoader.getOrThrow("TWILIO_WA_CREATE_EVENT");

const createEventNotification = async (req: Request, res: Response) => {
  const {
    userName,
    title,
    projectName,
    description,
    orgName,
    startLocal,
    endLocal,
    resourceName,
    duration,
    createdAt,
    orgOwnerEmail,
    projectOwnerEmail,
    path,
    phoneNumber,
  } = req.body;

  // Validation
  if (
    !userName ||
    !title ||
    !projectName ||
    !orgName ||
    !startLocal ||
    !endLocal ||
    !resourceName ||
    !createdAt ||
    !path
  ) {
    logger.warn(`Event Email: Validation failed.`, { body: req.body });
    return res.status(400).json({
      error: "Validation Error",
      message: "Required fields are missing.",
    });
  }

  const baseUrl = EnvLoader.getOrThrow("CLIENT_URL");
  const link = `${baseUrl}/${path}?redirect=true`;
  const wsUrl = `${path}?redirect=true`;

  const templateData = {
    userName,
    title,
    projectName,
    description,
    orgName,
    startLocal,
    endLocal,
    resourceName,
    duration,
    createdAt,
    viewUrl: link,
    orgOwnerEmail,
    projectOwnerEmail,
  };

  logger.info(`Event Email: Processing request for ${userName}`, {
    toEmail: orgOwnerEmail,
    projectName,
    title,
    path,
  });

  try {
    // Send Email
    await emailServices.sendTemplate({
      to: orgOwnerEmail,
      templateId,
      dynamicTemplateData: {
        ...templateData,
      },
    });

    logger.info(`Event Email: Successfully sent to ${orgOwnerEmail}.`, {
      projectLink: path,
    });

    if (phoneNumber) {
      await waService.sendTemplate({
        to: phoneNumber,
        contentSid,
        variables: {
          "1": userName,
          "2": title,
          "3": projectName,
          "4": endLocal,
          "5": startLocal,
          "6": wsUrl,
        },
      });
    }

    return res.status(202).json({
      message: `Event notification email and WhatsApp sent successfully.`,
      status: true,
    });
  } catch (error) {
    logger.error(`Event Email: Failed to send notification.`, { error });
    return res.status(500).json(error);
  }
};

export default createEventNotification;
