import { Request, Response } from "express";
import logger from "../../../logger";
import { EmailService } from "../../../services";
import { EnvLoader } from "../../../util/EnvLoader";

const emailServices = EmailService.getInstance();
const addProjectTemplateId = EnvLoader.getOrThrow("ASSIGN_PROJECT_TEMPLATE_ID");

const assignUser = async (req: Request, res: Response) => {
  const { orgName, toName, projectName, toEmail, addedByName, path } = req.body;

  if (
    !orgName ||
    !toName ||
    !projectName ||
    !toEmail ||
    !addedByName ||
    !path
  ) {
    logger.warn("Assign Project Email: Validation failed.", { body: req.body });
    return res.status(400).json({
      error: "Validation Error",
      message:
        "orgName, toName, projectName, toEmail, addedByName and path are required.",
    });
  }

  logger.info("Assign Project Email: Processing request.", {
    toEmail,
    orgName,
    projectName,
  });

  try {
    const baseUrl = EnvLoader.getOrThrow("CLIENT_URL");
    const link = `${baseUrl}/${path}?redirect=true`;

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

    logger.info("Assign Project Email: Successfully sent.", {
      toEmail,
      projectLink: link,
    });

    return res.status(200).json({
      message: "Assign Project email sent successfully.",
      status: true,
    });
  } catch (error) {
    logger.error("Assign Project Email: Failed to send.", {
      toEmail,
      error,
    });

    return res.status(500).json({ status: false, error });
  }
};

export default assignUser;
