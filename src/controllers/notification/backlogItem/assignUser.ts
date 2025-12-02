import { Request, Response } from "express";
import logger from "../../../logger";
import { EnvLoader } from "../../../util/EnvLoader";
import { EmailService } from "../../../services";

const emailServices = EmailService.getInstance();
const templateId = EnvLoader.getOrThrow("ASSIGN_WORK_ITEM_TEMPLATE_ID");

const assignUserToItem = async (req: Request, res: Response) => {
  const {
    workItemName,
    uid,
    path,
    toName,
    toEmail,
    assignedByName,
    projectName,
  } = req.body;
  const workItemType = req.params?.backlogItemType;
  if (
    !workItemName ||
    !uid ||
    !toName ||
    !path ||
    !toEmail ||
    !assignedByName ||
    !projectName
  ) {
    logger.warn(`Assign ${workItemType} Email: Validation failed.`, {
      body: req.body,
    });
    return res.status(400).json({
      error: "Validation Error",
      message:
        "orgName, toName, projectName, toEmail,ownerEmail, addedByName and path are required.",
    });
  }
  const baseUrl = EnvLoader.getOrThrow("CLIENT_URL");
  const link = `${baseUrl}/path?redirect=true`;
  const templateData = {
    link,
    appLink: baseUrl,
    workItemType,
    ...req.body,
  };
  logger.info(`Assign ${workItemType} Email: Processing request.`, {
    toEmail,
    projectName,
    templateId,
    workItemName,
  });
  try {
    await emailServices.sendTemplate({
      to: toEmail,
      templateId,
      dynamicTemplateData: {
        ...templateData,
      },
    });
    logger.info(`Assign ${workItemType} Email: Successfully sent.`, {
      toEmail,
      projectLink: link,
    });

    return res.status(202).json({
      message: `Assign ${workItemType} email sent successfully.`,
      status: true,
    });
  } catch (error) {
    logger.error(`Assign ${workItemType} Email: Failed to send.`, {
      toEmail,
      error,
      projectName,
      workItemName,
      workItemType,
    });
    return res.status(500).json(error);
  }
};

export default assignUserToItem;
