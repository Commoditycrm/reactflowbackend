import { Router } from "express";
import warmupcontroller from "../controllers/cronJobs/warmup";
import sendReminders from "../controllers/cronJobs/send-reminders";
import resetMessageCounter from "../controllers/cronJobs/resetMessageCounter";

const cronRouter = Router();

cronRouter.get("/warmup", warmupcontroller);
cronRouter.get("/send-reminders", sendReminders);
cronRouter.get("/reset-whatsapp-counter", resetMessageCounter);

export default cronRouter;
