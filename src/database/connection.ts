import neo4j, { Driver } from "neo4j-driver";
import logger from "../logger";

export class Neo4JConnection {
  private static instance: Neo4JConnection;

  public driver!: Driver;

  neo4jUri = process.env.NEO4J_URI!;

  neo4jUser = process.env.NEO4J_USERNAME!;

  neo4jPassword = process.env.NEO4J_PASSWORD!;

  private constructor() {}

  public static async getInstance(): Promise<Neo4JConnection> {
    if (!Neo4JConnection.instance) {
      const conn = new Neo4JConnection();

      conn.driver = neo4j.driver(
        conn.neo4jUri,
        neo4j.auth.basic(conn.neo4jUser, conn.neo4jPassword),
        {
          maxConnectionLifetime: 30 * 60 * 1000,
          maxConnectionPoolSize: 30, // good for 1 vCPU
          connectionAcquisitionTimeout: 30_000,
          fetchSize: 1000,
          disableLosslessIntegers: true,
        } as any
      );

      // Prefer this — checks auth + connectivity and returns server info
      const info = await conn.driver.getServerInfo();
      logger?.info("Neo4j connected:", info);

      const close = async () => {
        try {
          await conn.driver.close();
          logger?.info("Neo4j driver closed");
        } catch (e) {
          logger?.error("Error closing Neo4j driver", e);
        } finally {
          process.exit(0);
        }
      };
      process.on("SIGINT", close);
      process.on("SIGTERM", close);

      Neo4JConnection.instance = conn;
    }

    return Neo4JConnection.instance;
  }
}
