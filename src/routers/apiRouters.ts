import express from "express";
import { createServer } from "http";
import { initializeApolloServer } from "../graphql/init/apollo.init";
import cronRouter from "./cronRouters";
import authRouter from "./authRouters";
import notificationRouter from "./notificationRouter";

import multer from "multer";
import { readEpicSheet } from "../controllers/xlsheet/readSheet";

const upload = multer({ storage: multer.memoryStorage() });

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
  router.use("/auth", authRouter);
  router.use("/notification", notificationRouter);
  router.post("/sheet/read", upload.single("file"), readEpicSheet);

  return router;
};

export default apiRouter;
