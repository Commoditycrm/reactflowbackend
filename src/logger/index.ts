import { Logger } from "winston";
import developmentLogger from "./developmentLogger";
import productionLogger from "./productionLogger";
import { NODE_ENV, isProduction } from "../env/detector";

// Always create a logger (never null)
let logger: Logger;

if (isProduction()) {
  logger = productionLogger();
} else {
  logger = developmentLogger();
}

// Optional: log once which logger is active
logger.info(`Logger initialized for environment: ${NODE_ENV}`);

export default logger;
