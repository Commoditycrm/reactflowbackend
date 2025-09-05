import { Response, Request } from "express";
import { Neo4JConnection } from "../../database/connection";
import logger from "../../logger";

const resetMessageCounter = async (req: Request, res: Response) => {
  const session = (await Neo4JConnection.getInstance()).driver.session();
  try {
    const result = await session.executeWrite(async (tx) => {
      return tx.run(`
        MATCH (n:Organization)
        WHERE n.messageCounter > 0
        SET n.messageCounter = 0
        RETURN COUNT(n) AS totalResetOrg
     `);
    });
    const total = result.records[0]?.get("totalResetOrg");
    logger?.info(`Message countes reset successful:${total}`);
    res.status(200).send({ message: "Message counters reset", total });
  } catch (error) {
    logger?.error(`Failed to reset WhatsApp message counter: ${error}`);
    res
      .status(500)
      .send({ message: "Failed to reset WhatsApp message counter." });
  } finally {
    await session.close();
  }
};

export default resetMessageCounter;
