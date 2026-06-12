import express from "express";
import { createServer } from "http";
import { initializeApolloServer } from "../graphql/init/apollo.init";
import cronRouter from "./cronRouters";
import authRouter from "./authRouters";
import notificationRouter from "./notificationRouter";
import ragRouter from "./ragRouter";

import multer from "multer";
import { readEpicSheet } from "../controllers/xlsheet/readSheet";
import { readContactSheet } from "../controllers/xlsheet/readContactSheet";
import { restRateLimiter } from "../graphql/middleware/rateLimiting";

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

  // Rate-limit the REST endpoints (GraphQL has its own limiter in apollo.init).
  router.use("/cron", restRateLimiter, cronRouter);
  router.use("/auth", restRateLimiter, authRouter);
  router.use("/notification", restRateLimiter, notificationRouter);
  router.use("/rag", restRateLimiter, ragRouter);
  router.post("/sheet/read", restRateLimiter, upload.single("file"), readEpicSheet);
  router.post(
    "/sheet/readContact",
    restRateLimiter,
    upload.single("file"),
    readContactSheet,
  );


  return router;
};

export default apiRouter;
