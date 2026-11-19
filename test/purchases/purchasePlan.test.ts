import { test } from "node:test";
import assert from "node:assert/strict";
import { itemDescription, planPurchaseFlow } from "../../src/purchases/purchasePlan";

const sections = [
  {
    name: "Tools",
    items: [
      { no: "1", item: "Bench power supply", vendor: "Wanptek", partNumber: "KPS6020D", totalQty: 1, alternatives: [{ vendor: "Riden", partNumber: "RD6018" }] },
      { no: "2", item: "  ", vendor: "ignored (no item name)" },
    ],
  },
  { name: "Empty", items: [] },
  {
    name: "P60 components",
    items: [
      { no: "1", item: "Frameless motor", vendor: "Leadshine", partNumber: "FM2-08523", qtyPer: 1, totalQty: 2 },
      { no: "9", item: "Ground gear sets", vendor: "Pragati", totalQty: 2, buyLater: true },
    ],
  },
];

test("purchase flow: node per non-empty section, three linked steps per item", () => {
  let n = 0;
  const plan = planPurchaseFlow(sections as any, () => `t${++n}`);
  assert.deepEqual(plan.flowNodes.map((x) => x.label), ["1. Tools", "2. P60 components"]);
  assert.equal(plan.flowNodes[1]!.description, "2 items to buy, 1 later.");
  assert.deepEqual(plan.flowEdges.map((e) => `${e.source}>${e.target}`), ["s1>s2"]);
  assert.equal(plan.itemCount, 3);
  assert.equal(plan.buyLaterCount, 1);
  assert.equal(plan.tasks.length, 9);
  assert.deepEqual(plan.tasks.slice(0, 3).map((t) => t.label), [
    "Get quote: Bench power supply",
    "Place order: Bench power supply",
    "Receive & inspect: Bench power supply",
  ]);
  assert.ok(plan.tasks.some((t) => t.label === "(Later) Get quote: Ground gear sets"));
  assert.equal(plan.taskLinks.length, 6);
  assert.deepEqual(plan.taskLinks[0], { before: "t1", after: "t2" });
  assert.ok(plan.tasks.filter((t) => t.nodeSeed === "s2").length === 6);
});

test("purchase flow: item description carries vendor, quantity and alternatives", () => {
  const d = itemDescription({ item: "Motor", vendor: "Leadshine", partNumber: "FM2-08523", qtyPer: 1, totalQty: 2, alternatives: [{ vendor: "CubeMars", partNumber: "RI100", country: "China" }] });
  assert.match(d, /<strong>Vendor:<\/strong> Leadshine/);
  assert.match(d, /Quantity:<\/strong> 2 \(1 per unit\)/);
  assert.match(d, /Alternatives:<\/strong> CubeMars · RI100 · China/);
  const evil = itemDescription({ item: "x", vendor: '<img src=x onerror="alert(1)">' });
  assert.ok(!evil.includes("<img"), "spreadsheet text is escaped");
});

test("purchase flow: rejects empty lists", () => {
  assert.throws(() => planPurchaseFlow([{ name: "x", items: [] }]), /no items/);
});
