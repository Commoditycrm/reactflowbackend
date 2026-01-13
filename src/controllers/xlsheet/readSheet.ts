import { Request, Response } from "express";
import { readAllSheetAsJson } from "../../services/sheet.service";

export function readEpicSheet(req: Request, res: Response) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Upload .xlsx file as 'file'" });
    }

    const projectId = String(req.body.projectId || "").trim();
    if (!projectId) {
      return res.status(400).json({ error: "projectId is required" });
    }

    const data = readAllSheetAsJson({
      buffer: req.file.buffer,
      projectId,
    });

    return res.json(data.rows);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
