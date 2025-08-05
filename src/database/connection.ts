import neo4j, { Driver } from "neo4j-driver";

export class Neo4JConnection {
  private static instance: Neo4JConnection;

  public driver!: Driver;

  neo4jUri = process.env.NEO4J_URI;

  neo4jUser = process.env.NEO4J_USERNAME;

  neo4jPassword = process.env.NEO4J_PASSWORD;

  private constructor() { }

  public static async getInstance(): Promise<Neo4JConnection> {
    if (!Neo4JConnection.instance) {
      Neo4JConnection.instance = new Neo4JConnection();

      Neo4JConnection.instance.driver = neo4j.driver(
        Neo4JConnection.instance.neo4jUri as string,
        neo4j.auth.basic(
          Neo4JConnection.instance.neo4jUser as string,
          Neo4JConnection.instance.neo4jPassword as string
        ),
        {
          maxConnectionLifetime: 30 * 60 * 1000,
          maxConnectionPoolSize: 100,
          connectionAcquisitionTimeout: 60 * 1000,
        }
      );

      Neo4JConnection.instance.driver.verifyAuthentication();
    }

    return Neo4JConnection.instance;
  }
}
