import { Router } from "express";
import addProject from "../controllers/notification/projects/addProject";

const projectRouter = Router();
projectRouter.post("/assignUser", addProject);

export default projectRouter;
