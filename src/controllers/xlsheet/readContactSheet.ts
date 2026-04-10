import { Request, Response } from "express";
import { readContactSheetAsJson } from "./readContact";

export function readContactSheet(req: Request, res: Response) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Upload .xlsx file as 'file'" });
    }

    const organizationId = String(req.body.organizationId || "").trim();
    if (!organizationId) {
      return res.status(400).json({ error: "organizationId is required" });
    }

    const data = readContactSheetAsJson({
      buffer: req.file.buffer,
      organizationId,
    });

    return res.json(data.rows);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}