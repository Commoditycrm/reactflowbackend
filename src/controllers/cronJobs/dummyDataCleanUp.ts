import { Request, Response } from "express";
import logger from "../../logger";
import { Neo4JConnection } from "../../database/connection";
import {
  CLEANUP_DUMMY_PROJECTS_CQL,
  CLEANUP_DUMMY_FOLDERS_CQL,
  CLEANUP_DUMMY_FILES_CQL,
  CLEANUP_DUMMY_NODES_CQL,
  CLEANUP_DUMMY_ITEMS_CQL,
  CLEANUP_DUMMY_COMMENTS_CQL,
} from "../../database/constants";

type CleanupStats = {
  batches: number;
  total: number;
};

const toNum = (v: any) => (v?.toNumber ? v.toNumber() : Number(v));

const readStats = (result: any): CleanupStats => {
  const r = result.records[0];
  return {
    batches: toNum(r?.get("batches")),
    total: toNum(r?.get("total")),
  };
};

const dummyDataCleanUp = async (req: Request, res: Response) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  const tx = await session.beginTransaction();

  logger.info("Processing clean-up database dummy data");

  try {
    const projectsRes = await tx.run(CLEANUP_DUMMY_PROJECTS_CQL);
    logger.info("cleaned-up dummy projects data");
    const foldersRes = await tx.run(CLEANUP_DUMMY_FOLDERS_CQL);
    logger.info("cleaned-up dummy folders data");
    const filesRes = await tx.run(CLEANUP_DUMMY_FILES_CQL);
    logger.info("cleaned-up dummy files data");
    const nodesRes = await tx.run(CLEANUP_DUMMY_NODES_CQL);
    logger.info("cleaned-up dummy flownodes data");
    const itemsRes = await tx.run(CLEANUP_DUMMY_ITEMS_CQL);
    logger.info("cleaned-up dummy backlogItems data");
    const commentsRes = await tx.run(CLEANUP_DUMMY_COMMENTS_CQL);
    logger.info("cleaned-up dummy comments data");

    await tx.commit();

    const results = {
      projects: readStats(projectsRes),
      folders: readStats(foldersRes),
      files: readStats(filesRes),
      flowNodes: readStats(nodesRes),
      backlogItems: readStats(itemsRes),
      comments: readStats(commentsRes),
    };

    const totals = Object.values(results).reduce(
      (acc, cur) => {
        acc.batches += cur.batches;
        acc.total += cur.total;
        return acc;
      },
      { batches: 0, total: 0 }
    );

    return res.status(200).json({
      message: "Cleanup completed",
      results,
      totals,
    });
  } catch (error) {
    await tx.rollback();
    logger.error("Failed to clean-up database dummy data", { error });
    return res.status(500).json({ message: "Failed to clean-up data" });
  } finally {
    await session.close();
  }
};

export default dummyDataCleanUp;
