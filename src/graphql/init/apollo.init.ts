import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginLandingPageLocalDefault } from "@apollo/server/plugin/landingPage/default";
import { Neo4JConnection } from "../../database/connection";
import { isProduction } from "../../env/detector";
import { NeoConnection } from "./neo.init";
import { OGMConnection } from "./ogm.init";
import errorHandling from "../error/error.formatter";
import logger from "../../logger";
import typeDefs from "../schema/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { expressMiddleware } from "@apollo/server/express4";
import cors from "cors";
import { Router } from 'express'
import { ApolloServerPluginLandingPageDisabled } from "@apollo/server/plugin/disabled";
import bodyParser from 'body-parser'


export const initializeApolloServer = async (httpServer: ReturnType<typeof import("http").createServer>) => {

  const router = Router();
  const neo4jInstance = await Neo4JConnection.getInstance();

  const neoInstance = new NeoConnection(
    typeDefs,
    neo4jInstance.driver,
    NeoConnection.getFeatures(),
    NeoConnection.getResolvers(),
  );

  const schema = await neoInstance.init();
  await OGMConnection.init(typeDefs, neo4jInstance.driver, NeoConnection.getFeatures());

  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/api/graphql",
  });

  const serverCleanup = useServer(
    {
      schema,
      context: async (ctx) => {
        const authorization = ctx.connectionParams?.authorization || ctx.connectionParams?.Authorization || "";
        const mockReq = { headers: { authorization: authorization as string } } as any;
        return await NeoConnection.authorizeUserOnContext(mockReq);
      },
      onError(ctx, message, errors) {
        logger?.error(`[GraphQL Subscription Error]: ${message}, Errors: ${errors}`);
      },
    },
    wsServer
  );

  //apollo server
  const server = new ApolloServer({
    schema,
    introspection: !isProduction(),
    persistedQueries: false,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
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

  router.use(
    "/graphql",
    cors(),
    bodyParser.json(),
    expressMiddleware(server, {
      context: async ({ req }) => await NeoConnection.authorizeUserOnContext(req as any),
    })
  );
  return router;
};
