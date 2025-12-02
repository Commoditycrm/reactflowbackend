import { Request, Response } from "express";
import logger from "../../../logger";
import { EmailService } from "../../../services";
import { EnvLoader } from "../../../util/EnvLoader";

const emailServices = EmailService.getInstance();
const removeUserTemplateId = EnvLoader.getOrThrow(
  "REMOVE_USER_FROM_PROJECT_TEMPLATE_ID"
);

const removeUser = async (req: Request, res: Response) => {
  const { orgName, toName, projectName, toEmail, ownerEmail } = req.body;

  if (!orgName || !toName || !projectName || !toEmail || !ownerEmail) {
    logger.warn("Remove Project Email: Validation failed.", { body: req.body });
    return res.status(400).json({
      error: "Validation Error",
      message:
        "orgName, toName, projectName,ownerEmail and toEmail are required.",
    });
  }

  logger.info("Remove Project Email: Processing request.", {
    toEmail,
    orgName,
    projectName,
    ownerEmail
  });
  if (toEmail === ownerEmail) {
    logger.info("CC skipped because recipient and owner are the same.", { ownerEmail, toEmail });
  }

  try {
    const baseUrl = EnvLoader.getOrThrow("CLIENT_URL");
    const link = `${baseUrl}/my_projects?redirect=true`;

    await emailServices.sendTemplate({
      to: toEmail,
    //   cc: toEmail !== ownerEmail ? [ownerEmail] : [],
      templateId: removeUserTemplateId,

      dynamicTemplateData: {
        orgName,
        projectName,
        toName,
        link,
      },
    });

    logger.info("Remove Project Email: Successfully sent.", {
      toEmail,
      link,
    });

    return res.status(200).json({
      message: "Remove Project email sent successfully.",
      status: true,
    });
  } catch (error) {
    logger.error("Remove Project Email: Failed to send.", {
      toEmail,
      error,
    });

    return res.status(500).json({ status: false, error });
  }
};

export default removeUser;
