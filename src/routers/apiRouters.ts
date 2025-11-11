import express from "express";
import { createServer } from "http";
import { initializeApolloServer } from "../graphql/init/apollo.init";
import cronRouter from "./cronRouters";
import orgRouter from "./organizationRouters";
import authRouter from "./authRouter";
import login from "../controllers/auth/login";

const apiRouter = async (
  httpServer: ReturnType<typeof createServer>
): Promise<express.Router> => {
  const router = express.Router();

  const graphqlRouter = await initializeApolloServer(httpServer);
  router.use("/", graphqlRouter);

  router.get("/health", (_, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.use("/cron", cronRouter);
  router.use("/notification", orgRouter);
  router.use("/auth", authRouter);

  return router;
};

export default apiRouter;
