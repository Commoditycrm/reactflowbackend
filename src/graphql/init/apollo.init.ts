import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { ApolloServerPluginLandingPageLocalDefault } from "@apollo/server/plugin/landingPage/default";
import { Neo4JConnection } from "../../database/connection";
import { isProduction } from "../../env/detector";
import { NeoConnection } from "./neo.init";
import { OGMConnection } from "./ogm.init";
import errorHandling from "../error/error.formatter";
import logger from "../../logger";
import typeDefs from "../schema/schema";

export const initializeApolloServer = async () => {
  try {
    const PORT = Number(process.env.PORT || 4000);

    const neo4jInstance = await Neo4JConnection.getInstance();

    const neoInstance = new NeoConnection(
      typeDefs,
      neo4jInstance.driver,
      NeoConnection.getFeatures(),
      NeoConnection.getResolvers()
    );
    const schema = await neoInstance.init();

    await OGMConnection.init(
      typeDefs,
      neo4jInstance.driver,
      NeoConnection.getFeatures()
    );

    const server = new ApolloServer({
      schema,
      introspection: !isProduction(),
      persistedQueries: false,
      formatError: (formattedError, error) => {
        logger?.error(`[GraphQL Error]: ${formattedError.message}`);
        return errorHandling(formattedError, error);
      },
      plugins: isProduction()
        ? []
        : [ApolloServerPluginLandingPageLocalDefault({ embed: true })],
    });

    // Start server with CORS
    const { url } = await startStandaloneServer(server, {
      listen: { port: PORT, path: "/api/graphql" },
      context: async ({ req }) => {
        return await NeoConnection.authorizeUserOnContext(req as any);
      },
      // Use built-in CORS (no need for express middleware)
      // cors: {
      //   origin: '*', // Or restrict to specific domains
      //   credentials: true,
      // },
    });
    logger?.info(`🚀 Apollo Server ready at ${url}`);
  } catch (err) {
    logger?.error("❌ Failed to initialize Apollo Server:", err);
    process.exit(1);
  }
};
