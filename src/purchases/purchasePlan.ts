import { randomUUID } from "node:crypto";
import { escapeHtml } from "../util/escapeHtml";

/**
 * Turns a purchase list (sections → items → alternatives) into a purchase
 * flow: one flow node per section, linked in order, and for every item the
 * tasks Get quote → Place order → Receive & inspect, linked as predecessors.
 */

export interface PurchaseAlternative {
  vendor?: string | null;
  partNumber?: string | null;
  country?: string | null;
  website?: string | null;
  contact?: string | null;
  notes?: string | null;
}

export interface PurchaseItem extends PurchaseAlternative {
  no?: string | null;
  item: string;
  qtyPer?: number | null;
  totalQty?: number | null;
  buyLater?: boolean | null;
  /** Procurement origin used by splitByCountry (e.g. "Local"); defaults to the country. */
  origin?: string | null;
  alternatives?: PurchaseAlternative[] | null;
}

export interface PurchaseSection {
  name: string;
  items: PurchaseItem[];
}

export const PURCHASE_STEPS = [
  { key: "quote", label: "Get quote" },
  { key: "order", label: "Place order" },
  { key: "receive", label: "Receive & inspect" },
] as const;

export interface PurchasePlan {
  flowNodes: { id: string; label: string; kind: "process"; shape: "rectangle"; description: string }[];
  flowEdges: { id: string; source: string; target: string; label: string }[];
  tasks: { id: string; nodeSeed: string; label: string; description: string }[];
  taskLinks: { before: string; after: string }[];
  itemCount: number;
  buyLaterCount: number;
}

export class PurchaseListError extends Error {}

const MAX_SECTIONS = 50;
const MAX_ITEMS = 500;

const clean = (v: unknown, n: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** One HTML paragraph per field: descriptions are rendered as HTML, so values are escaped. */
const line = (label: string, v: unknown, n = 300) => {
  const s = clean(v, n);
  return s ? `<p><strong>${label}:</strong> ${escapeHtml(s)}</p>` : null;
};

const describeSource = (a: PurchaseAlternative) =>
  [clean(a.vendor, 120), clean(a.partNumber, 120), clean(a.country, 60)].filter(Boolean).join(" · ");

export const itemDescription = (it: PurchaseItem): string => {
  const qty =
    it.totalQty != null && Number.isFinite(Number(it.totalQty))
      ? `${Number(it.totalQty)}${it.qtyPer != null && Number.isFinite(Number(it.qtyPer)) ? ` (${Number(it.qtyPer)} per unit)` : ""}`
      : null;
  const alts = (it.alternatives ?? []).map(describeSource).filter(Boolean).slice(0, 8);
  return [
    line("Vendor", it.vendor),
    line("Part number", it.partNumber),
    line("Quantity", qty),
    line("Country", it.country),
    line("Website", it.website),
    line("Contact", it.contact),
    line("Spec / notes", it.notes, 1200),
    alts.length ? `<p><strong>Alternatives:</strong> ${escapeHtml(alts.join("; "))}</p>` : null,
    it.buyLater ? "<p><em>Buy later: not needed for the first build.</em></p>" : null,
  ]
    .filter(Boolean)
    .join("")
    .slice(0, 4000);
};

export const planPurchaseFlow = (
  sections: PurchaseSection[],
  newId: () => string = randomUUID,
): PurchasePlan => {
  const secs = (sections ?? [])
    .map((s) => ({ name: clean(s?.name, 80) || "Purchases", items: (s?.items ?? []).filter((i) => clean(i?.item, 200)) }))
    .filter((s) => s.items.length);
  if (!secs.length) throw new PurchaseListError("The purchase list has no items.");
  if (secs.length > MAX_SECTIONS) throw new PurchaseListError(`Too many sections (limit ${MAX_SECTIONS}).`);
  const itemCount = secs.reduce((n, s) => n + s.items.length, 0);
  if (itemCount > MAX_ITEMS) throw new PurchaseListError(`Too many items (limit ${MAX_ITEMS}).`);

  const flowNodes = secs.map((s, i) => {
    const later = s.items.filter((it) => it.buyLater).length;
    return {
      id: `s${i + 1}`,
      label: `${i + 1}. ${s.name}`.slice(0, 80),
      kind: "process" as const,
      shape: "rectangle" as const,
      description: escapeHtml(`${s.items.length} item${s.items.length === 1 ? "" : "s"} to buy${later ? `, ${later} later` : ""}.`),
    };
  });
  const flowEdges = flowNodes.slice(1).map((n, i) => ({ id: `e-${i + 1}`, source: flowNodes[i]!.id, target: n.id, label: "" }));

  const tasks: PurchasePlan["tasks"] = [];
  const taskLinks: PurchasePlan["taskLinks"] = [];
  let buyLaterCount = 0;
  secs.forEach((s, si) => {
    for (const it of s.items) {
      if (it.buyLater) buyLaterCount++;
      const name = clean(it.item, 90);
      const prefix = it.buyLater ? "(Later) " : "";
      const description = itemDescription(it);
      let prev: string | null = null;
      for (const step of PURCHASE_STEPS) {
        const id = newId();
        tasks.push({ id, nodeSeed: `s${si + 1}`, label: `${prefix}${step.label}: ${name}`.slice(0, 120), description });
        if (prev) taskLinks.push({ before: prev, after: id });
        prev = id;
      }
    }
  });

  return { flowNodes, flowEdges, tasks, taskLinks, itemCount, buyLaterCount };
};

export const UNSPECIFIED_COUNTRY = "Unspecified";

const PLACEHOLDER_COUNTRY = /^(?:[-\u2013\u2014_.?*]+|n\/?a|none|unknown|tbd|tba|nil)$/i;
const COUNTRY_ACRONYMS = new Set(["usa", "us", "uk", "uae", "prc", "eu"]);

/**
 * The procurement origin of a sheet's country cell:
 * "China (Sold in India)" → "China", "India (Distributor) / Japan Make" → "India",
 * " CHINA " → "China", "usa" → "USA", "—" or blank → "Unspecified".
 * Brackets are notes, and with several countries the first one is used.
 */
export const countryKey = (v: unknown): string => {
  const raw = clean(v, 120);
  if (PLACEHOLDER_COUNTRY.test(raw)) return UNSPECIFIED_COUNTRY;
  const first =
    raw
      .replace(/\([^)]*\)?/g, " ")
      .split(/\s*[/,;&|]\s*|\s+or\s+|\s+and\s+/i)[0] ?? "";
  const s = first
    .replace(/\b(?:make|made|origin|brand)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  if (!s || PLACEHOLDER_COUNTRY.test(s)) return UNSPECIFIED_COUNTRY;
  return s
    .split(/([\s-]+)/)
    .map((w) =>
      COUNTRY_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
};

/** Group of an item when splitting: an explicit origin (set in the dialog) wins over its country. */
export const originOf = (it: Pick<PurchaseItem, "origin" | "country">): string =>
  countryKey(clean(it.origin, 60) || it.country);

export interface CountryGroup {
  country: string;
  sections: PurchaseSection[];
  itemCount: number;
}

/**
 * Splits a purchase list by the country of each item's main vendor, keeping the
 * sheet's sections inside each country. Countries appear in the order they
 * first show up in the sheet; "Unspecified" always goes last.
 */
export const splitSectionsByCountry = (sections: PurchaseSection[]): CountryGroup[] => {
  const groups = new Map<string, Map<string, PurchaseItem[]>>();
  for (const s of sections ?? []) {
    const secName = clean(s?.name, 80) || "Purchases";
    for (const it of s?.items ?? []) {
      if (!clean(it?.item, 200)) continue;
      const c = originOf(it);
      if (!groups.has(c)) groups.set(c, new Map());
      const secs = groups.get(c)!;
      if (!secs.has(secName)) secs.set(secName, []);
      secs.get(secName)!.push(it);
    }
  }
  const out = [...groups.entries()].map(([country, secs]) => {
    const list = [...secs.entries()].map(([name, items]) => ({ name, items }));
    return { country, sections: list, itemCount: list.reduce((n, x) => n + x.items.length, 0) };
  });
  return [
    ...out.filter((g) => g.country !== UNSPECIFIED_COUNTRY),
    ...out.filter((g) => g.country === UNSPECIFIED_COUNTRY),
  ];
};

/** Total-size checks for a whole import, however many files it is split into. */
export const assertPurchaseListSize = (sections: PurchaseSection[]) => {
  const items = (sections ?? []).reduce((n, s) => n + (s?.items ?? []).filter((i) => clean(i?.item, 200)).length, 0);
  if (!items) throw new PurchaseListError("The purchase list has no items.");
  if (items > MAX_ITEMS) throw new PurchaseListError(`Too many items (limit ${MAX_ITEMS}).`);
  if ((sections ?? []).length > MAX_SECTIONS) throw new PurchaseListError(`Too many sections (limit ${MAX_SECTIONS}).`);
};
