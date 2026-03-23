import { Request, Response } from "express";
import logger from "../../../logger";
import { EmailService } from "../../../services";
import { EnvLoader } from "../../../util/EnvLoader";

const emailServices = EmailService.getInstance();
const templateId = EnvLoader.getOrThrow("DELETE_EVENT");

const deleteEvent = async (req: Request, res: Response) => {
  const {
    creator,
    projectOwner,
    orgOwner,
    title,
    projectName,
    orgName,
    eventDate,
  } = req.body;

  if (!creator || typeof creator !== "object") {
    return res.status(400).json({
      status: false,
      message: "creator is required",
    });
  }

  if (!projectOwner || typeof projectOwner !== "object") {
    return res.status(400).json({
      status: false,
      message: "projectOwner is required",
    });
  }

  if (!orgOwner || typeof orgOwner !== "object") {
    return res.status(400).json({
      status: false,
      message: "orgOwner is required",
    });
  }

  if (!creator.id || !creator.name) {
    return res.status(400).json({
      status: false,
      message: "creator.id and creator.name are required",
    });
  }

  if (!projectOwner.id || !projectOwner.name || !projectOwner.email) {
    return res.status(400).json({
      status: false,
      message:
        "projectOwner.id, projectOwner.name and projectOwner.email are required",
    });
  }

  if (!orgOwner.id || !orgOwner.name || !orgOwner.email) {
    return res.status(400).json({
      status: false,
      message: "orgOwner.id, orgOwner.name and orgOwner.email are required",
    });
  }

  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({
      status: false,
      message: "title is required",
    });
  }

  if (!projectName || typeof projectName !== "string" || !projectName.trim()) {
    return res.status(400).json({
      status: false,
      message: "projectName is required",
    });
  }

  if (!orgName || typeof orgName !== "string" || !orgName.trim()) {
    return res.status(400).json({
      status: false,
      message: "orgName is required",
    });
  }

  const isProjectOwner = creator.id === projectOwner.id;
  const isOrgOwner = creator.id === orgOwner.id;
  const sameOwners = projectOwner.id === orgOwner.id;

  let toEmail = "";
  let toUserName = "";
  let ccEmail: string | undefined;

  if (sameOwners && isProjectOwner && isOrgOwner) {
    return res.status(400).json({
      status: false,
      message:
        "No notification needed because org owner and project owner are the same as creator",
    });
  }

  if (isOrgOwner) {
    toEmail = projectOwner.email;
    toUserName = projectOwner.name;
  } else if (isProjectOwner) {
    toEmail = orgOwner.email;
    toUserName = orgOwner.name;
  } else {
    toEmail = projectOwner.email;
    toUserName = projectOwner.name;

    if (!sameOwners) {
      ccEmail = orgOwner.email;
    }
  }

  if (!toEmail || !toUserName) {
    return res.status(400).json({
      status: false,
      message: "Recipient could not be determined",
    });
  }

  try {
    await emailServices.sendTemplate({
      to: toEmail,
      ...(ccEmail ? { cc: ccEmail } : {}),
      templateId,
      dynamicTemplateData: {
        userName: toUserName,
        eventName: title.trim(),
        projectName: projectName.trim(),
        eventDate:
          typeof eventDate === "string" && eventDate.trim()
            ? eventDate.trim()
            : new Date().toDateString(),
        cancelledBy: creator.name.trim(),
        organizationName: orgName.trim(),
      },
    });

    return res.status(202).json({
      status: true,
      message: "Notifications sent successfully",
    });
  } catch (error) {
    logger.error("Notification failed", { error, body: req.body });
    return res.status(500).json({
      status: false,
      message: "Failed to send notification",
    });
  }
};

export default deleteEvent;
