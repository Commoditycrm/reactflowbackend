import { Request, Response } from "express";
import { Neo4JConnection } from "../../database/connection";
import { CLEANUP_SOFT_DELETE_ITEMS } from "../../database/constants";
import logger from "../../logger";

const softDeleteCleanUp = async (req: Request, res: Response) => {
  const windowDays = 30

  const params = {
    window: `P${windowDays}D`,
  };

  const session = (await Neo4JConnection.getInstance()).driver.session();
  try {
    const result = await session.executeWrite((tx) =>
      tx.run(CLEANUP_SOFT_DELETE_ITEMS, params)
    );

    const row = result.records[0];
    const deletedNodes = row?.get("deletedNodes") ?? 0;
    const batches = row?.get("batches") ?? 0;
    const failedBatches = row?.get("failedBatches") ?? 0;
    const errorMessages = row?.get("errorMessages") ?? [];

    logger?.info(`Soft-deleted items cleanup completed:${deletedNodes}`)

    res.status(200).json({
      message: "Soft-deleted items cleanup completed",
      windowDays,
      stats: {
        deletedNodes,
        batches,
        failedBatches,
        errorMessages,
      },
    });
  } catch (error: any) {
    logger?.error(`Cleanup failed: ${error?.message || error}`);
     res.status(500).json({
      message: "Failed to cleanup soft-deleted items.",
      error: error?.message || String(error),
    });
  } finally {
    await session.close();
  }
};

export default softDeleteCleanUp;
