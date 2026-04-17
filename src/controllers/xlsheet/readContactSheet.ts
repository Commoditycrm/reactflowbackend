import { Request, Response } from "express";
import { readContactSheetAsJson } from "../../util/readContactSheet";

export function readContactSheet(req: Request, res: Response) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Upload .xlsx file as 'file'" });
    }

    const organizationId = String(req.body.organizationId || "").trim();
    if (!organizationId) {
      return res.status(400).json({ error: "organizationId is required" });
    }

    let columnMapping: Record<string, string> = {};
    let extraFieldMapping: Record<string, string> = {};
    let requiredFields: string[] = ["firstName"];

    try {
      columnMapping = req.body.columnMapping
        ? JSON.parse(req.body.columnMapping)
        : {};

      extraFieldMapping = req.body.extraFieldMapping
        ? JSON.parse(req.body.extraFieldMapping)
        : {};

      requiredFields = req.body.requiredFields
        ? JSON.parse(req.body.requiredFields)
        : ["firstName"];
    } catch {
      return res.status(400).json({
        error:
          "columnMapping, extraFieldMapping, and requiredFields must be valid JSON",
      });
    }

    const data = readContactSheetAsJson({
      buffer: req.file.buffer,
      organizationId,
      columnMapping,
      extraFieldMapping,
      requiredFields,
    });

    return res.json(data);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
