import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginLandingPageLocalDefault } from "@apollo/server/plugin/landingPage/default";
import { Neo4JConnection } from "../../database/connection";
import { isProduction } from "../../env/detector";
import { NeoConnection } from "./neo.init";
import { OGMConnection } from "./ogm.init";
import errorHandling from "../error/error.formatter";
import logger from "../../logger";
import typeDefs from "../schema/schema";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { expressMiddleware } from "@apollo/server/express4";
import { applyCorsMiddleware } from "../middleware/cors";
import cors from "cors";
import expressJson from 'express'
import { ApolloServerPluginLandingPageDisabled } from "@apollo/server/plugin/disabled";

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


    const app = express();
    const httpServer = createServer(app);
    const wsSerever = new WebSocketServer({
      server: httpServer,
      path: "/api/graphql",
    });

    //todo:cors allow origin middleware

    const serverCleanUp = useServer(
      {
        schema,
        context: async (ctx) => {
          const authorization =
            ctx.connectionParams?.authorization ||
            ctx.connectionParams?.Authorization ||
            "";
          const mockReq = {
            headers: {
              authorization: authorization as string,
            },
          } as any;
          return await NeoConnection.authorizeUserOnContext(mockReq);
        },
        onError(ctx, message, errors) {
          logger?.error(
            `[GraphQL Subscription Error]: ${message}, Errors: ${errors}`
          );
        },
      },
      wsSerever
    );
    const server = new ApolloServer({
      schema,
      introspection: !isProduction(),
      persistedQueries: false,
      plugins: [
        ApolloServerPluginDrainHttpServer({
          httpServer,
        }),
        {
          async serverWillStart() {
            return Promise.resolve({
              async drainServer() {
                await serverCleanUp.dispose();
              },
            });
          },
        },
        isProduction()
          ? ApolloServerPluginLandingPageDisabled()
          : ApolloServerPluginLandingPageLocalDefault()
      ],
      formatError: (formattedError, error) => {
        logger?.error(`[GraphQL Error]: ${formattedError.message}`);
        return errorHandling(formattedError, error);
      },
    });
    await server.start();
    app.use(
      "/api/graphql",
      cors(),
      expressJson.json(),
      expressMiddleware(server, {
        context: async ({ req }) => {
          return await NeoConnection.authorizeUserOnContext(req as any);
        },
      })
    );
    httpServer.listen(PORT, () => {
      logger?.info(
        `🚀 Apollo Server ready at http://localhost:${PORT}/api/graphql`
      );
    });
  } catch (err) {
    logger?.error("❌ Failed to initialize Apollo Server:", err);
    process.exit(1);
  }
};
