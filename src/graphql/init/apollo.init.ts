import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { ApolloServerPluginLandingPageLocalDefault } from "apollo-server-core";
import { Neo4JConnection } from "../../database/connection";
import { isProduction } from "../../env/detector";
import typeDefs from "../schema/schema.gql";
import { OGMConnection } from "./ogm.init";
import { NeoConnection } from "./neo.init";
import errorHandling from "../error/error.formatter";

export const initializeApolloServer = async () => {
  // Get Neo4j Driver
  const neo4jInstance = await Neo4JConnection.getInstance();

  // Initialize Neo4jGraphQL schema
  const neoInstance = new NeoConnection(
    typeDefs,
    neo4jInstance.driver,
    NeoConnection.getFeatures(),
    NeoConnection.getResolvers()
  );

  const schema = await neoInstance.init();

  // OGM setup
  await OGMConnection.init(
    typeDefs,
    neo4jInstance.driver,
    NeoConnection.getFeatures()
  );

  // Initialize Apollo Server
  const server = new ApolloServer({
    schema,
    introspection: !isProduction(),
    persistedQueries: false,
    formatError: (error) => errorHandling(error),
    plugins: isProduction()
      ? []
      : [ApolloServerPluginLandingPageLocalDefault({ embed: true })],
  });

  // Start server
  const { url } = await startStandaloneServer(server, {
    listen: { port: 4000 },
    context: async ({ req }) => NeoConnection.authorizeUserOnContext(req),
  });

  console.log(`🚀 Apollo Server running at ${url}`);
};
