import * as XLSX from "xlsx";

type ColumnMapping = Record<string, string>;
type ExtraFieldMapping = Record<string, string>;

type ReadAllArgs = {
  buffer: Buffer;
  organizationId: string;
  columnMapping: ColumnMapping;
  extraFieldMapping?: ExtraFieldMapping;
  requiredFields?: string[];
};

function clean(value: any): string | null {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str ? str : null;
}

function cleanNumber(value: any): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function makeName(
  firstName?: string | null,
  middleName?: string | null,
  lastName?: string | null,
) {
  return [firstName, middleName, lastName].filter(Boolean).join(" ").trim();
}

function getMappedValue(
  row: Record<string, any>,
  mapping: Record<string, string>,
  field: string,
) {
  const columnName = mapping[field];
  if (!columnName) return null;
  return row[columnName];
}

export function readContactSheetAsJson({
  buffer,
  organizationId,
  columnMapping,
  extraFieldMapping = {},
  requiredFields = ["firstName"],
}: ReadAllArgs) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];

  if (!sheetName) {
    throw new Error(`No sheet found. Available: ${wb.SheetNames.join(", ")}`);
  }

  const ws = wb.Sheets[sheetName];

  if (!ws) {
    throw new Error(`Sheet "${sheetName}" not found or is empty`);
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, {
    defval: "",
  });

  const mappedColumns = new Set<string>([
    ...Object.values(columnMapping || {}),
    ...Object.values(extraFieldMapping || {}),
  ]);

  const validationErrors: Array<{
    rowNumber: number;
    errors: string[];
  }> = [];

  const result = rows.map((row, index) => {
    const rowNumber = index + 2;

    const firstName =
      clean(getMappedValue(row, columnMapping, "firstName")) || "";
    const lastName =
      clean(getMappedValue(row, columnMapping, "lastName")) || "";
    const middleName = clean(getMappedValue(row, columnMapping, "middleName"));

    const city = clean(getMappedValue(row, columnMapping, "city"));
    const country = clean(getMappedValue(row, columnMapping, "country"));
    const postalCode = clean(getMappedValue(row, columnMapping, "postalCode"));
    const state = clean(getMappedValue(row, columnMapping, "state"));
    const street = clean(getMappedValue(row, columnMapping, "street"));

    const hasAddress = !!(city || country || postalCode || state || street);

    const extraFields: Record<string, any> = {};

    // mapped extra fields from UI
    for (const [extraKey, columnName] of Object.entries(extraFieldMapping)) {
      const rawValue = row[columnName];

      if (extraKey === "employees") {
        const num = cleanNumber(rawValue);
        if (num !== null) {
          extraFields[extraKey] = num;
        }
      } else {
        const value = clean(rawValue);
        if (value !== null) {
          extraFields[extraKey] = value;
        }
      }
    }

    // any column not mapped in columnMapping or extraFieldMapping => extraFields
    for (const [excelColumn, rawValue] of Object.entries(row)) {
      if (mappedColumns.has(excelColumn)) continue;

      const value = clean(rawValue);
      if (value !== null) {
        extraFields[excelColumn] = value;
      }
    }

    const parsedRow = {
      rowNumber,
      organizationId,
      resourceType:
        clean(getMappedValue(row, columnMapping, "resourceType")) || "CONTACTS",
      firstName,
      lastName,
      middleName,
      name: makeName(firstName, middleName, lastName),

      email: clean(getMappedValue(row, columnMapping, "email")),
      phone: clean(getMappedValue(row, columnMapping, "phone")),
      role: clean(getMappedValue(row, columnMapping, "role")),
      linkedin: clean(getMappedValue(row, columnMapping, "linkedin")),

      address: hasAddress
        ? {
            city,
            country,
            postalCode,
            state,
            street,
          }
        : null,

      extraFields,
    };

    const errors: string[] = [];

    for (const field of requiredFields) {
      const value =
        field === "firstName"
          ? parsedRow.firstName
          : field === "lastName"
          ? parsedRow.lastName
          : field === "middleName"
          ? parsedRow.middleName
          : field === "email"
          ? parsedRow.email
          : field === "phone"
          ? parsedRow.phone
          : field === "role"
          ? parsedRow.role
          : field === "linkedin"
          ? parsedRow.linkedin
          : field === "resourceType"
          ? parsedRow.resourceType
          : field === "city"
          ? parsedRow.address?.city
          : field === "country"
          ? parsedRow.address?.country
          : field === "postalCode"
          ? parsedRow.address?.postalCode
          : field === "state"
          ? parsedRow.address?.state
          : field === "street"
          ? parsedRow.address?.street
          : null;

      if (!value || String(value).trim() === "") {
        errors.push(`${field} is required`);
      }
    }

    if (errors.length) {
      validationErrors.push({
        rowNumber,
        errors,
      });
    }

    return parsedRow;
  });

  return {
    usedSheet: sheetName,
    totalRows: result.length,
    validRows: result.length - validationErrors.length,
    invalidRows: validationErrors.length,
    validationErrors,
    rows: result,
  };
}
