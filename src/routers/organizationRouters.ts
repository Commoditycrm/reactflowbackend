import { Router } from "express";
import inviteWorkForce from "../controllers/notification/organization/invite-work-force";

const orgRouter = Router();

orgRouter.post("/invite_workforce", inviteWorkForce);

export default orgRouter;
