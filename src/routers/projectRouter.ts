import { Router } from "express";
import assignUser from "../controllers/notification/projects/assignUser";
import removeUser from "../controllers/notification/projects/removeUser";
import createEventNotification from "../controllers/notification/projects/createEvent";
import deleteEvent from "../controllers/notification/projects/deleteEvent";

const projectRouter = Router();
projectRouter.post("/assign_user", assignUser);
projectRouter.post("/remove_user", removeUser);
projectRouter.post("/create_event", createEventNotification);
projectRouter.post("/delete_event", deleteEvent);

export default projectRouter;
