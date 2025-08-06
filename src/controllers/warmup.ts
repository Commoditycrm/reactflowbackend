import { Request, Response } from "express";
import logger from "../logger";

const warmupcontroller = async (req: Request, res: Response) => {
    const PORT = process.env.PORT;
    try {
        const response = await fetch(`http://localhost:${PORT}/api/graphql`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-warmup": "true",
            },
            body: JSON.stringify({ query: "{ __typename }" }),
        });

        if (!response?.ok) {
            return res.status(response.status).json({ message: response.statusText })
        }

        const { data } = await response.json();

        logger?.info("🔥 Warm-up complete");
        return res.status(200).json({ status: "ok", data });
    } catch (error) {
        logger?.error(`Warm-up failed: ${error}`);
        return res.status(500).json({ error: "Warm-up failed", details: (error as any).message });
    }
};

export default warmupcontroller;
