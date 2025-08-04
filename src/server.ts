import dotenv from "dotenv";
import { initializeApolloServer } from "./graphql/init/apollo.init";
import logger from "./logger";

dotenv.config();

(async () => {
  try {
    await initializeApolloServer();
  } catch (err) {
    logger?.error("❌ Server failed to start:", err);
    process.exit(1);
  }
})();
