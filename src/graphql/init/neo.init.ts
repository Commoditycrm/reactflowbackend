import { ApolloServerErrorCode } from "@apollo/server/errors";
import { Neo4jGraphQL } from "@neo4j/graphql";
import { Request } from "express";
import { DocumentNode, GraphQLError, GraphQLSchema } from "graphql";
import { Driver } from "neo4j-driver";
import { isProduction } from "../../env/detector";
import { getFirebaseAdminAuth } from "../firebase/admin";
import { deleteOperationMutations } from "../resolvers/delete.resolvers";

import { populatedCallBacks } from "./../callbacks/populatedByCallbacks";
import { createOperationMutations } from "./../resolvers/create.resolvers";
import { readOperationQueries } from "./../resolvers/read.resolvers";
import { updateOperationMutations } from "./../resolvers/update.resolvers";
import { ragResolvers } from "./../resolvers/rag.resolvers";
import { EnvLoader } from "../../util/EnvLoader";
import { jwtVerify as joseJwtVerify } from "jose";
import { Neo4JConnection } from "../../database/connection";
import { getAuthTokens } from "../../util/authToken";
import jwt from "jsonwebtoken";

export type IResolvers =
  | {
      Mutation?: Record<string, any>;
      Query?: Record<string, any>;
    }
  | undefined;

type Neo4jFeaturesSettings = ConstructorParameters<
  typeof Neo4jGraphQL
>[0]["features"];

export class NeoConnection {
  private neo: Neo4jGraphQL;
  constructor(
    typeDefs: DocumentNode,
    driver: Driver,
    features: Neo4jFeaturesSettings | undefined,
    resolvers: IResolvers,
  ) {
    const options: ConstructorParameters<typeof Neo4jGraphQL>[0] = {
      typeDefs,
      driver,
      resolvers,
      // debug: !isProduction(),
    };
    if (features) {
      options.features = features;
    }
    this.neo = new Neo4jGraphQL(options);
  }
  async init(): Promise<GraphQLSchema> {
    const neoSchema = await this.neo.getSchema();
    if (!isProduction() && EnvLoader.get("INIT_SCHEMA") === "true") {
      await this.neo.checkNeo4jCompat();
      await this.neo.assertIndexesAndConstraints({ options: { create: true } });
    }

    return neoSchema;
  }

  static async authorizeUserOnContext(req: Request): Promise<{
    jwt: Record<string, any>;
    authorization?: { jwt: Record<string, any> };
  }> {
    if (req.headers["x-warmup"] === "true") {
      const warmupJwt = {
        uid: "warmup-user",
        sub: "warmup-user",
        email: "warmup@internal.com",
        role: "SYSTEM",
        warmup: true,
      };

      return { jwt: warmupJwt, authorization: { jwt: warmupJwt } };
    }

    const { sessionToken, headerToken } = getAuthTokens(req);

    // 1. Normal logged-in user
    if (sessionToken) {
      try {
        const SESSION_SECRET = EnvLoader.getOrThrow("SESSION_SECRET");

        const secret = new TextEncoder().encode(SESSION_SECRET);
        const { payload } = await jwtVerify(sessionToken, secret);

        if (!payload?.email_verified) {
          throw new GraphQLError("Please verify your email first.", {
            extensions: { code: "EMAIL_NOT_VERIFIED" },
          });
        }

        const sessionId = payload.sessionId as string | undefined;

        if (!sessionId) {
          throw new GraphQLError("Session id missing", {
            extensions: { code: "UNAUTHENTICATED" },
          });
        }

        const neo4jSession = (
          await Neo4JConnection.getInstance()
        ).driver.session();

        try {
          const result = await neo4jSession.run(
            `
          MATCH (s:UserSession {id: $sessionId, isActive: true})
          RETURN s.id AS id
          LIMIT 1
          `,
            { sessionId },
          );

          if (result.records.length === 0) {
            throw new GraphQLError("Session expired or logged out", {
              extensions: { code: "UNAUTHENTICATED" },
            });
          }
        } finally {
          await neo4jSession.close();
        }

        const appJwt = {
          sub: payload.sub,
          uid: payload.uid,
          email: payload.email,
          email_verified: payload.email_verified,
          roles: payload.roles || [],
          orgCreated: payload.orgCreated || false,
          sessionId,
        };

        return { jwt: appJwt, authorization: { jwt: appJwt } };
      } catch (e: any) {
        if (e instanceof GraphQLError) throw e;

        throw new GraphQLError("Invalid or expired session", {
          extensions: { code: "UNAUTHENTICATED" },
        });
      }
    }

    // 2. Invite user
    if (headerToken) {
      try {
        const INVITE_JWT_SECRET = EnvLoader.getOrThrow("INVITE_JWT_SECRET");

        const decoded = jwt.verify(headerToken, INVITE_JWT_SECRET) as Record<
          string,
          any
        >;

        if (decoded.role !== "invitee") {
          throw new Error("Invalid invite role");
        }

        const inviteJwt = {
          ...decoded,
          token: headerToken,
        };

        return { jwt: inviteJwt, authorization: { jwt: inviteJwt } };
      } catch {
        throw new GraphQLError("Token expired or Unknown user", {
          extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
        });
      }
    }

    throw new GraphQLError("Authentication token is required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }

  static getResolvers(): IResolvers | undefined {
    return {
      Mutation: {
        ...createOperationMutations,
        ...updateOperationMutations,
        ...deleteOperationMutations,
      },
      Query: {
        ...readOperationQueries,
        ...ragResolvers.Query,
      },
    };
  }

  static getFeatures(): Neo4jFeaturesSettings {
    return {
      populatedBy: {
        callbacks: {
          ...populatedCallBacks,
        },
      },
      subscriptions: true,
      authorization: {
        key: EnvLoader.getOrThrow("SESSION_SECRET"),
      },
    };
  }
}
async function jwtVerify(
  token: string,
  secret: Uint8Array<ArrayBuffer>,
): Promise<{ payload: any }> {
  const { payload } = await joseJwtVerify(token, secret);
  return { payload };
}
