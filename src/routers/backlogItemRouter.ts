import { Router } from "express";
import assignUserToItem from "../controllers/notification/backlogItem/assignUser";
import tagUsers from "../controllers/notification/backlogItem/tagUsers";

const backlogItemRouter = Router();

backlogItemRouter.post("/tagUser", tagUsers);
backlogItemRouter.post("/:backlogItemType", assignUserToItem);

export default backlogItemRouter;
