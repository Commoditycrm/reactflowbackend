import { Request, Response } from "express";
import logger from "../../../logger";
import { EmailService } from "../../../services";
import { EnvLoader } from "../../../util/EnvLoader";
const emailServices = EmailService.getInstance();
const addProjectTemplateId = EnvLoader.getOrThrow("ASSIGN_PROJECT_TEMPLATE_ID");
const addProject = async (req: Request, res: Response) => {
  const { orgName, toName, projectName, toEmail, addedByName, path } = req.body;
  if (
    !orgName ||
    !toName ||
    !projectName ||
    !toEmail ||
    !addedByName ||
    !path
  ) {
    logger.warn("Validation error", { ...req.body });
    return res.status(400).json({
      error: "Validation Error",
      message: "Invalid or incomplete request data.",
    });
  }
  logger.info("processing assing user into the project email", { toEmail });
  try {
    const link = `${EnvLoader.getOrThrow("CLIENT_URL")}/${path}?redirect=true`;
    await emailServices.sendTemplate({
      to: toEmail,
      templateId: addProjectTemplateId,
      dynamicTemplateData: {
        orgName,
        addedByName,
        projectName,
        toName,
        projectLink: link,
      },
    });
    logger.info("Successfully sent assign user into project email to:", {
      toEmail,
      link,
    });
    return res.status(200).json({
      message: "Sent assig user into the project email",
      status: true,
    });
  } catch (error) {
    logger.error("Field to add user into the project:", { toEmail, error });
    return res.status(500).json({ status: false, error });
  }
};

export default addProject;
