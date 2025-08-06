import cors from "cors";
import { Request, Response } from "express";

export const applyCorsMiddleware = (req: Request, res: Response) => {
  const allowOrigins = [
    process.env.CLIENT_URL,
    process.env.ADMIN_PANEL_API,
  ].filter(Boolean);


  const corsOptions = {
    origin: (origin: string | undefined, callback: Function) => {
      try {
        if (!origin || allowOrigins.includes(origin)) {
          return callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      } catch (error) {
        callback(new Error("Internal CORS check error"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  };

  return new Promise((resolve, reject) => {
    cors(corsOptions)(req, res, (result: unknown) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
};
