import express from "express";
import { createServer } from "http";
import apiRouter from "./apiRouters";

const initRoutes = async (
  httpServer: ReturnType<typeof createServer>
): Promise<express.Router> => {
  const router = express.Router();

  const api = await apiRouter(httpServer);
  router.use("/v1", api);

  return router;
};

export default initRoutes
