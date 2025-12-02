import { Router } from "express";
import assignUser from "../controllers/notification/projects/assignUser";

const projectRouter = Router();
projectRouter.post("/assign_user", assignUser);

export default projectRouter;
