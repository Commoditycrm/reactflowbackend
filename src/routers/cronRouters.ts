import { Router } from "express";
import warmupcontroller from "../controllers/cronJobs/warmup";
import sendReminders from "../controllers/cronJobs/send-reminders";
import resetMessageCounter from "../controllers/cronJobs/resetMessageCounter";
import createReccuringTask from "../controllers/cronJobs/recurringTask";
import softDeleteCleanUp from "../controllers/cronJobs/softDeleteCleanUp";
import dummyDataCleanUp from "../controllers/cronJobs/dummyDataCleanUp";

const cronRouter = Router();

cronRouter.get("/warmup", warmupcontroller);
cronRouter.post("/send-reminders", sendReminders);
cronRouter.post("/reset-whatsapp-counter", resetMessageCounter);
cronRouter.post("/create-recurring-task", createReccuringTask);
cronRouter.post("/soft-delete-data-clean-up", softDeleteCleanUp);
cronRouter.post('/cleanup-database-data',dummyDataCleanUp)

export default cronRouter;
