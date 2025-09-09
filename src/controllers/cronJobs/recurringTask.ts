import { Request, Response } from "express";
import logger from "../../logger";
import { Neo4JConnection } from "../../database/connection";
import {
  CREATE_RECURRING_PARENT_TASK,
  CREATE_RECURRING_SUB_TASK,
} from "../../database/constants";

const createReccuringTask = async (req: Request, res: Response) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  try {
    const result1 = await session.executeWrite((tx) =>
      tx.run(CREATE_RECURRING_PARENT_TASK)
    );

    const result2 = await session.executeWrite((tx) =>
      tx.run(CREATE_RECURRING_SUB_TASK)
    );

    const parentCounter = result1.summary.counters.updates();
    const subCounter = result2.summary.counters.updates();

    logger?.info(
      `Recurring parent tasks created: nodes=${parentCounter.nodesCreated}, rels=${parentCounter.relationshipsCreated}`
    );
    logger?.info(
      `Recurring sub tasks created: nodes=${subCounter.nodesCreated}, rels=${subCounter.relationshipsCreated}`
    );

    res.status(200).json({
      ok: true,
      message: "Recurring tasks created successfully",
      parentCounter,
      subCounter,
    });
  } catch (error: any) {
    logger?.error(
      `Failed to create recurring tasks: ${error?.message || error}`
    );
    res
      .status(500)
      .json({ ok: false, message: "Failed to create recurring tasks" });
  } finally {
    await session.close();
  }
};

export default createReccuringTask;
