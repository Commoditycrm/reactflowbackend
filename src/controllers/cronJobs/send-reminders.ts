import { Request, Response } from "express";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import { Integer } from "neo4j-driver";
import pLimit from "p-limit";
import { EnvLoader } from "../../util/EnvLoader";
import { EmailService } from "../../services";
import { User } from "../../interfaces";

const CONCURRENCY_LIMIT = 10;
const emailService = EmailService.getInstance();

const reminderHtml = (userName: string, count: number, appLink: string) => {
  const plural = count === 1 ? "" : "s";
  const verb = count === 1 ? "is" : "are";
  return `
  <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6;">
    <p>Hi ${userName || "there"},</p>
    <p>You have <strong>${count}</strong> pending task${plural} that ${verb} due or overdue.</p>
    <p style="margin: 20px 0;">
      <a href="${appLink}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#ffffff;border-radius:6px;text-decoration:none;">
        View my tasks
      </a>
    </p>
    <p style="color:#6b7280;font-size:13px;">You're receiving this because task${plural} assigned to you ${verb} due or overdue and still incomplete.</p>
  </div>`;
};

const sendReminder = async (user: User, taskCount: Integer) => {
  const appLink = EnvLoader.getOrThrow("CLIENT_URL");
  const fromEmail = EnvLoader.getOrThrow("EMAIL_FROM");
  const count = taskCount.toNumber();
  try {
    await emailService.send({
      from: fromEmail,
      to: user.email,
      subject: `You have ${count} pending task${count === 1 ? "" : "s"} to complete`,
      html: reminderHtml(user.name, count, appLink),
    });
    logger?.info(`Reminder sent to ${user.email} (${count} pending task(s))`);
  } catch (err) {
    // EmailService.send already logs SendGrid detail; keep the cron resilient so
    // one bad recipient doesn't abort the whole batch.
    logger?.error(`Error sending reminder to ${user.email}: ${err}`);
  }
};

const sendReminders = async (_req: Request, res: Response) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();

  try {
    const result = await session.run(`
          MATCH (task:BacklogItem)-[:HAS_ASSIGNED_USER]->(user:User),
          (task)-[:HAS_STATUS]->(status:Status)
          WHERE task.endDate IS NOT NULL
            AND date(task.endDate) <= date()
            AND toLower(status.name) <> "completed"
            AND task.deletedAt IS NULL
          WITH user, COUNT(task) AS taskCount
          WHERE taskCount > 0
          RETURN collect({
            user: user { .id, .name, .email },
            taskCount: taskCount
         }) AS reminders
       `);
    const reminders: { user: User; taskCount: Integer }[] =
      result?.records?.[0]?.get("reminders") || [];

    const limit = pLimit(CONCURRENCY_LIMIT);
    const tasks = reminders.map(({ user, taskCount }) =>
      limit(() => sendReminder(user, taskCount))
    );

    await Promise.all(tasks);

    logger?.info(`Pending-task reminders processed: ${reminders.length}`);
    res.status(200).send({ success: true, notified: reminders.length });
  } catch (error) {
    logger?.error(`General failure in reminder handler: ${error}`);
    res
      .status(500)
      .send({ success: false, message: "Failed to send reminders" });
  } finally {
    await session.close();
  }
};

export default sendReminders;
