import { Router } from "express";
import assignUser from "../controllers/notification/projects/assignUser";
import removeUser from "../controllers/notification/projects/removeUser";

const projectRouter = Router();
projectRouter.post("/assign_user", assignUser);
projectRouter.post("/remove_user", removeUser);

export default projectRouter;
