import { Logger } from "winston";
import developmentLogger from "./developmentLogger";
import productionLogger from "./productionLogger";

let logger: Logger | null = null;
if (process.env.NODE_ENV === "production") {
  logger = productionLogger();
}
if (process.env.NODE_ENV !== "production") {
  logger = developmentLogger();
}
export default logger;
