import { Router } from "express";
import warmupcontroller from "../controllers/cronJobs/warmup";
import sendReminders from "../controllers/cronJobs/send-reminders";
import resetMessageCounter from "../controllers/cronJobs/resetMessageCounter";
import createReccuringTask from "../controllers/cronJobs/recurringTask";

const cronRouter = Router();

cronRouter.get("/warmup", warmupcontroller);
cronRouter.post("/send-reminders", sendReminders);
cronRouter.post("/reset-whatsapp-counter", resetMessageCounter);
cronRouter.post("/create-recurring-task", createReccuringTask);

export default cronRouter;
