import { Router } from "express";
import orgRouter from "./organizationRouters";
import projectRouter from "./projectRouter";

const notificationRouter = Router();

notificationRouter.use("/organization", orgRouter);
notificationRouter.use("/projects", projectRouter);

export default notificationRouter;
