import { performance } from "node:perf_hooks";
import { createVault, maskOccupied, matcherFor, parseRule } from "../dist/index.js";

function measure(label, run) {
  const start = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;
  const result = run();
  const elapsed = performance.now() - start;
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  console.log(
    JSON.stringify({
      label,
      ms: Number(elapsed.toFixed(2)),
      heapDeltaKb: Math.round(heapDelta / 1024),
      result,
    }),
  );
}

const text = `${"a".repeat(1_000_000)}tail`;
const many = Array.from({ length: 200 }, (_, index) => ({
  start: index * 4_000,
  end: index * 4_000 + 20,
  value: "",
  label: "",
  stage: "blacklist",
}));
function maskPerCharacter(value, occupied) {
  if (occupied.length === 0) return value;
  const chars = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) chars[index] = value[index] ?? "";
  for (const span of occupied) {
    const end = Math.min(span.end, value.length);
    for (let index = Math.max(span.start, 0); index < end; index += 1) chars[index] = " ";
  }
  return chars.join("");
}

measure("mask-old-many", () => maskPerCharacter(text, many).length);
measure("mask-new-empty", () => maskOccupied(text, []).length);
measure("mask-new-one", () => maskOccupied(text, [many[0]]).length);
measure("mask-new-many", () => maskOccupied(text, many).length);

const rules = Array.from({ length: 40 }, (_, index) =>
  parseRule(
    {
      id: `rule_${index}`,
      label: `rule_${index}`,
      regex: `token-${index}-[a-z]{8}`,
      flags: "",
      captureGroup: 0,
    },
    index,
  ),
);
const sample = `${rules.map((rule) => `token-${rule.id.split("_")[1]}-abcdefgh`).join(" ")} `;
measure("rules-recompile", () => {
  let hits = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    for (const rule of rules) {
      const regex = new RegExp(rule.regex, "gd");
      hits += regex.exec(sample) ? 1 : 0;
    }
  }
  return hits;
});
measure("rules-cached", () => {
  let hits = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    for (const rule of rules) {
      const regex = matcherFor(rule);
      regex.lastIndex = 0;
      hits += regex.exec(sample) ? 1 : 0;
    }
  }
  return hits;
});

const vault = createVault(10_000);
for (let index = 0; index < 9_000; index += 1) {
  vault.store("long", `long-secret-${"x".repeat(80)}-${index}`);
}
for (let index = 0; index < 1_000; index += 1) vault.store("short", `short-${index}-secret-value`);
const shortText = "short-1-secret-value";
measure("vault-index-all", () => {
  let hits = 0;
  for (const [value] of vault.entries()) if (shortText.includes(value)) hits += 1;
  return hits;
});
measure("vault-index-bounded", () => {
  let hits = 0;
  for (const [value] of vault.valuesUpTo(shortText.length)) {
    if (shortText.includes(value)) hits += 1;
  }
  return hits;
});
