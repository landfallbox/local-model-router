import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageStore, readUsageSummary } from "../src/usage-store.js";
import { estimateUsageCost, getCatalogPriceView, normalizeUsage, resolveModelPricing } from "../src/usage.js";

const chatUsage = normalizeUsage({
  usage: {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 25 },
    completion_tokens_details: { reasoning_tokens: 20 },
  },
}, "chat-completions");
assert.deepEqual(chatUsage, {
  inputTokens: 100,
  cachedInputTokens: 25,
  outputTokens: 50,
  reasoningTokens: 20,
  totalTokens: 150,
});

assert.deepEqual(normalizeUsage({
  usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
}, "responses"), {
  inputTokens: 80,
  cachedInputTokens: 0,
  outputTokens: 20,
  reasoningTokens: 0,
  totalTokens: 100,
});
assert.equal(normalizeUsage({}, "chat-completions"), null);

const defaultPricing = resolveModelPricing("gpt-5-mini-2025-08-07");
assert.equal(defaultPricing.source, "openai");
assert.equal(defaultPricing.sourceModel, "gpt-5-mini");
assert.equal(resolveModelPricing("gpt-5-future-variant"), null);
assert.deepEqual(estimateUsageCost(chatUsage, defaultPricing), {
  amount: 0.000119375,
  currency: "USD",
  pricing: defaultPricing,
});

const customPricing = resolveModelPricing("private-model", {
  mode: "custom",
  currency: "cny",
  inputPerMillion: 1,
  cachedInputPerMillion: 0.1,
  outputPerMillion: 2,
});
assert.equal(customPricing.source, "custom");
assert.deepEqual(estimateUsageCost(chatUsage, customPricing), {
  amount: 0.0001775,
  currency: "CNY",
  pricing: customPricing,
});
assert.equal(resolveModelPricing("private-model"), null);

const deepseekPeakPricing = resolveModelPricing("deepseek-v4-flash", { mode: "deepseek" }, new Date("2026-08-16T02:00:00Z"));
assert.equal(deepseekPeakPricing.source, "deepseek");
assert.equal(deepseekPeakPricing.sourceModel, "deepseek-v4-flash");
assert.equal(deepseekPeakPricing.card, "peak");
assert.equal(deepseekPeakPricing.inputPerMillion, 0.44);
assert.equal(deepseekPeakPricing.cachedInputPerMillion, 0.014);
assert.equal(deepseekPeakPricing.outputPerMillion, 1.32);
assert.equal(deepseekPeakPricing.currency, "CNY");
assert.deepEqual(estimateUsageCost(chatUsage, deepseekPeakPricing), {
  amount: 0.00009935,
  currency: "CNY",
  pricing: deepseekPeakPricing,
});

const deepseekOffPeakPricing = resolveModelPricing("deepseek-v4-pro", { mode: "deepseek" }, new Date("2026-08-16T12:00:00Z"));
assert.equal(deepseekOffPeakPricing.card, "off-peak");
assert.equal(deepseekOffPeakPricing.inputPerMillion, 0.66);
assert.equal(deepseekOffPeakPricing.cachedInputPerMillion, 0.022);
assert.equal(deepseekOffPeakPricing.outputPerMillion, 1.98);
assert.equal(deepseekOffPeakPricing.currency, "CNY");
assert.deepEqual(estimateUsageCost(chatUsage, deepseekOffPeakPricing), {
  amount: 0.00014905,
  currency: "CNY",
  pricing: deepseekOffPeakPricing,
});

assert.equal(resolveModelPricing("deepseek-v4-future", { mode: "deepseek" }), null);
assert.equal(resolveModelPricing("deepseek-chat", { mode: "deepseek" }), null);
assert.equal(resolveModelPricing("deepseek-reasoner", { mode: "deepseek" }), null);
assert.equal(
  resolveModelPricing("deepseek-v4-flash", { mode: "deepseek" }, new Date("2026-08-16T04:00:00Z")).card,
  "off-peak",
);
assert.equal(
  resolveModelPricing("deepseek-v4-flash", { mode: "deepseek" }, new Date("2026-08-16T06:00:00Z")).card,
  "peak",
);
assert.equal(
  resolveModelPricing("deepseek-v4-flash", { mode: "deepseek" }, new Date("2026-08-16T10:00:00Z")).card,
  "off-peak",
);

const deepseekView = getCatalogPriceView("deepseek", "deepseek-v4-flash");
assert.equal(deepseekView.source, "deepseek");
assert.equal(deepseekView.sourceModel, "deepseek-v4-flash");
assert.equal(deepseekView.pricing.inputPerMillion, 0.44);
assert.equal(deepseekView.pricing.cachedInputPerMillion, 0.014);
assert.equal(deepseekView.pricing.outputPerMillion, 1.32);
assert.equal(deepseekView.offPeakPricing.inputPerMillion, 0.22);
assert.equal(deepseekView.offPeakPricing.cachedInputPerMillion, 0.007);
assert.equal(deepseekView.offPeakPricing.outputPerMillion, 0.66);
assert.deepEqual(deepseekView.peakHours, [[1, 4], [6, 10]]);
assert.equal(getCatalogPriceView("deepseek", "not-a-deepseek-model"), null);
assert.equal(getCatalogPriceView("deepseek", "deepseek-chat"), null);
assert.equal(getCatalogPriceView("unknown-catalog", "anything"), null);
const openAIPricingView = getCatalogPriceView("openai", "gpt-5-mini-2025-08-07");
assert.equal(openAIPricingView.sourceModel, "gpt-5-mini");
assert.equal(openAIPricingView.pricing.inputPerMillion, 0.25);
assert.equal(openAIPricingView.offPeakPricing, null);
assert.equal(openAIPricingView.peakHours, null);

const tempDirectory = mkdtempSync(join(tmpdir(), "local-router-usage-test-"));
try {
  const store = createUsageStore(tempDirectory);
  const records = [
    { time: new Date(2026, 7, 15, 8), vendor: "vendor-a", model: "gpt-5-mini", usage: chatUsage, cost: estimateUsageCost(chatUsage, defaultPricing) },
    { time: new Date(2026, 7, 15, 9), vendor: "vendor-a", model: "unknown", usage: null, cost: null, stream: true },
    { time: new Date(2026, 7, 11, 8), vendor: "vendor-b", model: "private-model", usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 }, cost: { amount: 0.3, currency: "CNY" } },
    { time: new Date(2026, 7, 2, 8), vendor: "vendor-a", model: "gpt-5-mini", usage: { inputTokens: 300, outputTokens: 100, totalTokens: 400 }, cost: { amount: 0.4, currency: "USD" } },
    { time: new Date(2026, 6, 20, 8), vendor: "vendor-a", model: "gpt-5-mini", usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 }, cost: { amount: 0.5, currency: "USD" } },
  ];
  await Promise.all(records.map((record, index) => store.record({ requestId: `request-${index}`, ...record })));
  await store.close();
  await fs.appendFile(join(store.directory, "2026-08.jsonl"), "not-json\n", "utf8");

  const summary = await readUsageSummary(tempDirectory, { now: new Date(2026, 7, 15, 12) });
  assert.equal(summary.ignoredLines, 1);
  assert.equal(summary.periods.day.requestCount, 2);
  assert.equal(summary.periods.day.usageKnownCount, 1);
  assert.equal(summary.periods.day.totalTokens, 150);
  assert.equal(summary.periods.day.usageCoverage, 0.5);
  assert.equal(summary.periods.week.requestCount, 3);
  assert.equal(summary.periods.week.totalTokens, 450);
  assert.equal(summary.periods.month.requestCount, 4);
  assert.equal(summary.periods.month.totalTokens, 850);
  assert.equal(summary.daily.length, 30);
  assert.equal(summary.daily.at(-1).date, "2026-08-15");
  assert.deepEqual(summary.daily.at(-1).models.map(({ name, totalTokens }) => ({ name, totalTokens })), [
    { name: "gpt-5-mini", totalTokens: 150 },
    { name: "unknown", totalTokens: 0 },
  ]);
  assert.deepEqual(summary.periods.month.costs, [
    { currency: "CNY", amount: 0.3 },
    { currency: "USD", amount: 0.400119375 },
  ]);
  assert.equal(summary.vendors[0].name, "vendor-a");
  assert.equal(summary.vendors[0].totalTokens, 550);
  assert.deepEqual(summary.filters.vendors, ["vendor-a", "vendor-b"]);
  assert.deepEqual(summary.filters.models, ["gpt-5-mini", "private-model", "unknown"]);

  const vendorSummary = await readUsageSummary(tempDirectory, {
    now: new Date(2026, 7, 15, 12),
    vendor: "vendor-b",
  });
  assert.equal(vendorSummary.periods.day.requestCount, 0);
  assert.equal(vendorSummary.periods.week.requestCount, 1);
  assert.equal(vendorSummary.periods.month.totalTokens, 300);
  assert.deepEqual(vendorSummary.filters, {
    vendor: "vendor-b",
    model: "",
    vendors: ["vendor-a", "vendor-b"],
    models: ["gpt-5-mini", "private-model", "unknown"],
  });

  const intersectionSummary = await readUsageSummary(tempDirectory, {
    now: new Date(2026, 7, 15, 12),
    vendor: "vendor-a",
    model: "gpt-5-mini",
  });
  assert.equal(intersectionSummary.periods.day.totalTokens, 150);
  assert.equal(intersectionSummary.periods.month.requestCount, 2);
  assert.equal(intersectionSummary.periods.month.totalTokens, 550);
  assert.deepEqual(intersectionSummary.models.map((item) => item.name), ["gpt-5-mini"]);
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

console.log("usage tests passed");