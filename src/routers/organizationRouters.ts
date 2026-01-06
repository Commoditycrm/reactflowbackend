import { Router } from "express";
import inviteWorkForce from "../controllers/notification/organization/invite-work-force";
import inviteUserToOrg from "../controllers/notification/organization/invite-user";
import orgDeactivate from "../controllers/notification/organization/deactivate";
import activateOrg from "../controllers/notification/organization/activate";

const orgRouter = Router();

orgRouter.post("/invite_workforce", inviteWorkForce);
orgRouter.post("/invite_user", inviteUserToOrg);
orgRouter.post("/deactivate", orgDeactivate);
orgRouter.post("/active", activateOrg);

export default orgRouter;
