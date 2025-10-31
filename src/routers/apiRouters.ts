import express from "express";
import { createServer } from "http";
import { initializeApolloServer } from "../graphql/init/apollo.init";
import login from "../controllers/auth/login";
import cronRouter from "./cronRouters";
import orgRouter from "./organizationRouters";

const apiRouter = async (
  httpServer: ReturnType<typeof createServer>
): Promise<express.Router> => {
  const router = express.Router();

  const graphqlRouter = await initializeApolloServer(httpServer);
  router.use("/", graphqlRouter);

  router.get("/health", (_, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/login", login);

  router.use("/cron", cronRouter);
  router.use('/notification',orgRouter)

  return router;
};

export default apiRouter;
