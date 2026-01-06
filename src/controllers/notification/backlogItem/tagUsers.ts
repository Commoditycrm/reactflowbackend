import { Request, Response } from "express";
import logger from "../../../logger";
import { EnvLoader } from "../../../util/EnvLoader";
import { EmailService } from "../../../services";
import { WhatsAppService } from "../../../services/WhatsAppServices";

const emailServices = EmailService.getInstance();
const waService = WhatsAppService.getInstance();
const templateId = EnvLoader.getOrThrow("TAG_USER_TEMPLATE_ID");
const contentSid = EnvLoader.getOrThrow("TWILIO_WA_TAG_USER");

const tagUsers = async (req: Request, res: Response) => {
  const {
    mentionedByName,
    itemType,
    itemTitle,
    commentHtml,
    path,
    projectName,
    recipients,
  } = req.body as {
    mentionedByName: string;
    itemType: string;
    itemTitle: string;
    commentHtml: string;
    path: string;
    projectName: string;
    recipients: { email: string; name: string; phoneNumber: string }[];
  };

  if (
    !path ||
    !projectName ||
    !itemTitle ||
    !itemType ||
    !mentionedByName ||
    !commentHtml ||
    !Array.isArray(recipients) ||
    recipients.length === 0
  ) {
    logger.warn(`Tag users ${itemType} Email: Validation failed.`, {
      body: req.body,
    });
    return res.status(400).json({
      error: "Validation Error",
      message: "Input validation failed.",
    });
  }

  const baseUrl = EnvLoader.getOrThrow("CLIENT_URL");
  const link = `${baseUrl}/${path}?redirect=true`;
  const wsUrl = `${path}?redirect=true`;

  const uniqueRecipients = Array.from(
    new Map(recipients.map((r) => [r.email.toLowerCase(), r])).values()
  );

  try {
    await Promise.allSettled(
      uniqueRecipients.map((r) =>
        emailServices.sendTemplate({
          to: r.email,
          templateId,
          dynamicTemplateData: {
            mentionedUserName: r.name,
            mentionedByName,
            itemType,
            itemTitle,
            projectName,
            commentHtml,
            commentUrl: link,
          },
        })
      )
    );

    await Promise.allSettled(
      uniqueRecipients.map((r) =>
        waService.sendTemplate({
          to: r.phoneNumber,
          contentSid,
          variables: {
            "1": r.name,
            "2": mentionedByName,
            "3": projectName,
            "4": itemTitle,
            "5": commentHtml,
            "6": wsUrl,
          },
        })
      )
    );

    logger.info(`Tag users ${itemType} Email: Successfully processed.`, {
      count: uniqueRecipients.length,
      projectLink: link,
    });

    return res.status(202).json({
      message: `Tag users ${itemType} email sent successfully.`,
      status: true,
      recipients: uniqueRecipients.length,
    });
  } catch (error) {
    logger.error(`Failed tagging users ${itemType} Email:`, { error });
    return res.status(500).json(error);
  }
};

export default tagUsers;
