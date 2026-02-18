import * as XLSX from "xlsx";

type ReadAllArgs = {
  buffer: Buffer;
  projectId: string;
};

const pick = (row: Record<string, any>, keys: string[]) => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
};

const mapStatus = (raw: string) => {
  const s = (raw || "").trim().toLowerCase();
  if (s === "active") return "In progress";
  if (s === "new") return "Not started";
  if (s === "closed") return "Completed"; // optional but useful
  return "Not started";
};

const parseList = (raw: string) =>
  raw
    .split(/[;,]/)
    .map((v) => v.trim())
    .filter(Boolean);

export function readAllSheetAsJson({ buffer, projectId }: ReadAllArgs) {
  const wb = XLSX.read(buffer, { type: "buffer" });

  const sheetName = "Copy of Main Tracker";
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw new Error(`Sheet "${sheetName}" not found. Available: ${wb.SheetNames.join(", ")}`);
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: "" });

  const result = rows.map((row, index) => {
    const workItemType = pick(row, ["Work item Type", "Work Item Type", "Type"]);

    const id = pick(row, ["Unique ID", "ID", "Id"]); // your sheet shows "Unique ID"
    const parentId = pick(row, ["Parent", "Parent id", "Parent ID"]); // your sheet shows "Parent"

    const statusRaw = pick(row, ["State", "Status", "status"]); // your sheet shows "State"

    const label =
      pick(row, ["Title 1"]) || // if exists
      pick(row, ["Title 2"]) ||
      pick(row, ["Title 3"]) ||
      pick(row, ["Title 4"]) ||
      pick(row, ["Label"]);

    // if you have Tags/Sprints columns, map them into `sprints`
    const sprintRaw = pick(row, ["Sprints", "Tags"]) || "";

    return {
      rowNumber: index + 1, // header is row 1 in Excel
      workItemType,
      id,
      label,
      statusLabel: mapStatus(statusRaw),
      parentIdResolved: parentId || projectId,
      sprints: sprintRaw ? parseList(sprintRaw) : [],
    };
  });

  return {
    usedSheet: sheetName,
    totalRows: result.length,
    rows: result,
  };
}
