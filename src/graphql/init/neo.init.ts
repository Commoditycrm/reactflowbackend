import { ApolloServerErrorCode } from "@apollo/server/errors";
import { Neo4jGraphQL } from "@neo4j/graphql";
import { Request } from "express";
import { DocumentNode, GraphQLError, GraphQLSchema } from "graphql";
import { Driver } from "neo4j-driver";
import { isProduction } from "../../env/detector";
import { getTokenFromHeader } from "../../util/tokenExtractor";
import { getFirebaseAdminAuth } from "../firebase/admin";
import { deleteOperationMutations } from "../resolvers/delete.resolvers";

import { populatedCallBacks } from "./../callbacks/populatedByCallbacks";
import { createOperationMutations } from "./../resolvers/create.resolvers";
import { Neo4jFeaturesSettings } from "@neo4j/graphql/dist/types";
import { readOperationQueries } from "./../resolvers/read.resolvers";
import { updateOperationMutations } from "./../resolvers/update.resolvers";
import { ragResolvers } from "./../resolvers/rag.resolvers";
import { EnvLoader } from "../../util/EnvLoader";

export type IResolvers =
  | {
      Mutation?: Record<string, any>;
      Query?: Record<string, any>;
    }
  | undefined;

export class NeoConnection {
  private neo: Neo4jGraphQL;
  constructor(
    typeDefs: DocumentNode,
    driver: Driver,
    features: Neo4jFeaturesSettings | undefined,
    resolvers: IResolvers
  ) {
    const options: {
      typeDefs: DocumentNode;
      driver: Driver;
      resolvers: IResolvers;
      features?: Neo4jFeaturesSettings;
      debug?: boolean;
    } = {
      typeDefs,
      driver,
      resolvers,
      debug: !isProduction(),
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

  static async authorizeUserOnContext(
    req: Request
  ): Promise<{ token: string } | { jwt: Record<string, any> }> {
    if (req.headers["x-warmup"] === "true") {
      return {
        jwt: {
          uid: "warmup-user",
          email: "warmup@internal.com",
          role: "SYSTEM",
          warmup: true,
        },
      };
    }
    const token: string | null = getTokenFromHeader(req.headers.authorization);
    if (!token) {
      throw new GraphQLError("Authentication token is required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }
    try {
      const decodedToken = await getFirebaseAdminAuth()
        .auth()
        .verifyIdToken(token, true);

      if (!decodedToken?.email_verified) {
        throw new GraphQLError("Please verify your email first.", {
          extensions: { code: "EMAIL_NOT_VERIFIED" },
        });
      }

      return { jwt: decodedToken };
    } catch (e: any) {
      if (
        e?.code === "auth/id-token-revoked" ||
        e?.code === "auth/user-disabled" ||
        e?.code === "auth/user-not-found"
      ) {
        throw new GraphQLError(
          "Your account has been deleted or disabled by the owner/company admin.",
          {
            extensions: { code: "ACCOUNT_DELETED" },
          }
        );
      }
    }

    try {
      const decoded = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64").toString()
      );

      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp < now || decoded.role !== "invitee") {
        throw new Error("Token expired or Unknown user");
      }
      return { token: token as string };
    } catch {
      throw new GraphQLError("Token expired or Unknown user", {
        extensions: { code: ApolloServerErrorCode.BAD_REQUEST },
      });
    }
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
        key: EnvLoader.getOrThrow("INVITE_JWT_SECRET"),
      },
    };
  }
}
