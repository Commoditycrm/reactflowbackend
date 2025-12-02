import { Router } from "express";
import orgRouter from "./organizationRouters";
import projectRouter from "./projectRouter";
import backlogItemRouter from "./backlogItemRouter";

const notificationRouter = Router();

notificationRouter.use("/organization", orgRouter);
notificationRouter.use("/projects", projectRouter);
notificationRouter.use("/",backlogItemRouter)
export default notificationRouter;
