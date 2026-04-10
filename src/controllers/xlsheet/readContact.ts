import * as XLSX from "xlsx";

type ReadAllArgs = {
  buffer: Buffer;
  organizationId: string;
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
  lastName?: string | null
) {
  return [firstName, middleName, lastName].filter(Boolean).join(" ").trim();
}

function pick(row: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  return "";
}

export function readContactSheetAsJson({ buffer, organizationId }: ReadAllArgs) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];

 
  
  if (!sheetName) {
    throw new Error(`No sheet found. Available: ${wb.SheetNames.join(", ")}`);
  }

  const ws = wb.Sheets[sheetName];

  if (!ws) {
    throw new Error(`Sheet "${sheetName}" not found or is empty`);
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: "" });

  const result = rows.map((row, index) => {
    const firstName = clean(pick(row, ["firstName", "First Name", "FirstName"])) || "";
    const lastName = clean(pick(row, ["lastName", "Last Name", "LastName"])) || "";
    const middleName = clean(pick(row, ["middleName", "Middle Name", "MiddleName"]));

    const city = clean(pick(row, ["city", "City"]));
    const country = clean(pick(row, ["country", "Country"]));
    const postalCode = clean(pick(row, ["postalCode", "Postal Code", "Zip", "Zip Code"]));
    const state = clean(pick(row, ["state", "State"]));
    const street = clean(pick(row, ["street", "Street", "Address"]));

    const hasAddress = city || country || postalCode || state || street;

    return {
      rowNumber: index + 2,
      organizationId,

      resourceType: clean(pick(row, ["resourceType", "Resource Type"])) || "CONTACTS",
      firstName,
      lastName,
      middleName,
      name: makeName(firstName, middleName, lastName),

      email: clean(pick(row, ["email", "Email"])),
      phone: clean(pick(row, ["phone", "Phone"])),
      role: clean(pick(row, ["role", "Role"])),
      linkedin: clean(pick(row, ["linkedin", "LinkedIn", "Linkedin"])),

      address: hasAddress
        ? {
            city,
            country,
            postalCode,
            state,
            street,
          }
        : null,

      extraFields: {
        employees: cleanNumber(pick(row, ["Employees", "employees"])),
        category: clean(pick(row, ["Category", "category"])),
        companyName: clean(pick(row, ["Company Name", "companyName", "Company"])),
        website: clean(pick(row, ["Website", "website"])),
        companyPhone: clean(pick(row, ["Company Phone", "companyPhone"])),
        emailStatus: clean(pick(row, ["Email Status", "emailStatus"])),
        industry: clean(pick(row, ["Industry", "industry"])),
      },
    };
  });

  return {
    usedSheet: sheetName,
    totalRows: result.length,
    rows: result,
  };
}