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

      // Production-optimized configuration
      conn.driver = neo4j.driver(
        conn.neo4jUri,
        neo4j.auth.basic(conn.neo4jUser, conn.neo4jPassword),
        {
          // Increase connection pool for production
          maxConnectionPoolSize: 100,
          
          // Longer connection lifetime for stability
          maxConnectionLifetime: 60 * 60 * 1000, // 1 hour
          
          // Increased acquisition timeout for high load
          connectionAcquisitionTimeout: 60_000, // 60 seconds
          
          // Larger fetch size for better performance
          fetchSize: 2000,
          
          // Disable lossless integers for better performance
          disableLosslessIntegers: true,
          
          // Enable connection pooling optimizations
          connectionTimeout: 30_000, // 30 seconds
        }
      );

      try {
        const session = conn.driver.session();
        await session.run('RETURN 1 as test', {}, { timeout: 10000 });
        await session.close();
        
        const info = await conn.driver.getServerInfo();
        logger?.info("Neo4j connected successfully:", {
          address: info.address,
          version: info.protocolVersion,
          edition: info.agent
        });
      } catch (error) {
        logger?.error("Neo4j connection failed:", error);
        throw error;
      }

      const gracefulShutdown = async () => {
        try {
          await conn.driver.close();
          logger?.info("Neo4j driver closed gracefully");
        } catch (e) {
          logger?.error("Error closing Neo4j driver", e);
        } finally {
          process.exit(0);
        }
      };

      process.on("SIGINT", gracefulShutdown);
      process.on("SIGTERM", gracefulShutdown);

      Neo4JConnection.instance = conn;
    }

    return Neo4JConnection.instance;
  }
}