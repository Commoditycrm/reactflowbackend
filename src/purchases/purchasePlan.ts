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
