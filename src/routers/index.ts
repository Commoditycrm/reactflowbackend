import express from "express";
import { createServer } from "http";
import { initializeApolloServer } from "../graphql/init/apollo.init";
import warmupcontroller from "../controllers/warmup";

export const apiRouter = async (
    httpServer: ReturnType<typeof createServer>
): Promise<express.Router> => {
    const router = express.Router();

    const graphqlRouter = await initializeApolloServer(httpServer);
    router.use("/", graphqlRouter);

    router.get("/health", (_, res) => {
        res.status(200).json({ status: "ok" });
    });

    router.get('/warmup',warmupcontroller)

    return router;
};
