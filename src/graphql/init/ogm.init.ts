import { OGM, generate } from "@neo4j/graphql-ogm";
import { DocumentNode } from "graphql";
import { Driver } from "neo4j-driver";
import { Neo4JConnection } from "../../database/connection";
import { isDevelopment, isProduction } from "../../env/detector";
import { NeoConnection } from "./neo.init";
import typeDefs from "../schema/schema";
import { EnvLoader } from "../../util/EnvLoader";
import path from "path";

export class OGMConnection {
  private static ogm: OGM;
  private constructor() {}

  static async getInstance(): Promise<OGM> {
    if (this.ogm) return this.ogm;

    const driver = (await Neo4JConnection.getInstance()).driver;

    return this.init(typeDefs, driver, NeoConnection.getFeatures());
  }

  static async init(
    typeDefs: DocumentNode,
    driver: Driver,
    features: Record<string, any>
  ): Promise<OGM> {
    this.ogm = new OGM({
      typeDefs,
      driver,
      features: features,
      debug: !isProduction(),
    });

    await this.ogm.init();

    if (isDevelopment() && EnvLoader.get("GENERATE_OGM_TYPES")) {
      await generate({
        ogm: this.ogm,
        outFile: path.resolve(__dirname,'../../interfaces/ogm.types.ts'),
      });
    }

    return this.ogm;
  }
}
