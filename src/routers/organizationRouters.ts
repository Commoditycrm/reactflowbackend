import { Router } from "express";
import inviteWorkForce from "../controllers/notification/organization/invite-work-force";
import inviteUserToOrg from "../controllers/notification/organization/invite-user";

const orgRouter = Router();

orgRouter.post("/invite_workforce", inviteWorkForce);
orgRouter.post("/invite_user", inviteUserToOrg);

export default orgRouter;
