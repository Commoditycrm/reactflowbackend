import { Router } from "express";
import assignUserToItem from "../controllers/notification/backlogItem/assignUser";

const backlogItemRouter = Router();

backlogItemRouter.post("/:backlogItemType", assignUserToItem);

export default backlogItemRouter;
