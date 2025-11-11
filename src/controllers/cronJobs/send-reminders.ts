import { Request, Response } from "express";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";
import { Integer } from "neo4j-driver";
import pLimit from "p-limit";
import { EnvLoader } from "../../util/EnvLoader";
import { User } from "../../@types/ogm.types";

const CONCURRENCY_LIMIT = 10;

const sendReminder = async (user: User, taskCount: Integer) => {
  const REMINDER_URL = EnvLoader.getOrThrow("REMINDER_URL");
  try {
    const res = await fetch(REMINDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userEmail: user.email,
        userName: user.name,
        taskCount: taskCount.toNumber(),
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      logger?.error(
        `Failed to send reminder to ${user.email}. Status: ${res.status}. Body: ${errorText}`
      );
    } else {
      logger?.info(`Reminder sent to ${user.email}`);
    }
  } catch (err) {
    logger?.error(`Error sending reminder to ${user.email}: ${err}`);
  }
};

const sendReminders = async (_req: Request, res: Response) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();

  try {
    const result = await session.run(`
          MATCH (task:BacklogItem)-[:HAS_ASSIGNED_USER]->(user:User),
          (task)-[:HAS_STATUS]->(status:Status)
          WHERE date(task.endDate) = date() AND toLower(status.name) <> "completed"
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

    res.status(200).send({ success: true });
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
