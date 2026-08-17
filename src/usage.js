export const OPENAI_PRICING_UPDATED_AT = "2026-08-15";
export const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const DEEPSEEK_PRICING_UPDATED_AT = "2026-08-16";
export const DEEPSEEK_PRICING_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing";
export const DEEPSEEK_PEAK_HOURS = [[1, 4], [6, 10]];

const OPENAI_STANDARD_PRICING = Object.freeze({
  "gpt-5.6-sol": price(5, 0.5, 30),
  "gpt-5.6-terra": price(2, 0.2, 12),
  "gpt-5.6-luna": price(0.2, 0.02, 1.2),
  "gpt-5.5": price(5, 0.5, 30),
  "gpt-5.5-pro": price(30, null, 180),
  "gpt-5.4": price(2.5, 0.25, 15),
  "gpt-5.4-mini": price(0.75, 0.075, 4.5),
  "gpt-5.4-nano": price(0.2, 0.02, 1.25),
  "gpt-5.4-pro": price(30, null, 180),
  "gpt-5.3-codex": price(1.75, 0.175, 14),
  "gpt-5.2": price(1.75, 0.175, 14),
  "gpt-5.2-pro": price(21, null, 168),
  "gpt-5.1": price(1.25, 0.125, 10),
  "gpt-5": price(1.25, 0.125, 10),
  "gpt-5-mini": price(0.25, 0.025, 2),
  "gpt-5-nano": price(0.05, 0.005, 0.4),
  "gpt-5-pro": price(15, null, 120),
  "gpt-5-search-api": price(1.25, 0.125, 10),
  "gpt-4.1": price(2, 0.5, 8),
  "gpt-4.1-mini": price(0.4, 0.1, 1.6),
  "gpt-4.1-nano": price(0.1, 0.025, 0.4),
  "gpt-4o": price(2.5, 1.25, 10),
  "gpt-4o-2024-05-13": price(5, null, 15),
  "gpt-4o-mini": price(0.15, 0.075, 0.6),
  "o1": price(15, 7.5, 60),
  "o1-pro": price(150, null, 600),
  "o3": price(2, 0.5, 8),
  "o3-pro": price(20, null, 80),
  "o3-mini": price(1.1, 0.55, 4.4),
  "o4-mini": price(1.1, 0.275, 4.4),
  "gpt-4-turbo-2024-04-09": price(10, null, 30),
  "gpt-4-0613": price(30, null, 60),
  "gpt-3.5-turbo": price(0.5, null, 1.5),
  "gpt-3.5-turbo-0125": price(0.5, null, 1.5),
  "gpt-3.5-turbo-1106": price(1, null, 2),
  "gpt-3.5-turbo-instruct": price(1.5, null, 2),
  "davinci-002": price(2, null, 2),
  "babbage-002": price(0.4, null, 0.4),
  "chat-latest": price(5, 0.5, 30),
});

const DEEPSEEK_STANDARD_PRICING = Object.freeze({
  "deepseek-v4-flash": rateCards(price(0.44, 0.014, 1.32, "CNY"), price(0.22, 0.007, 0.66, "CNY")),
  "deepseek-v4-pro": rateCards(price(1.32, 0.044, 3.96, "CNY"), price(0.66, 0.022, 1.98, "CNY")),
});

export const PRICING_CATALOGS = Object.freeze({
  openai: {
    sourceUrl: OPENAI_PRICING_SOURCE,
    updatedAt: OPENAI_PRICING_UPDATED_AT,
    peakHours: null,
    models: OPENAI_STANDARD_PRICING,
  },
  deepseek: {
    sourceUrl: DEEPSEEK_PRICING_SOURCE,
    updatedAt: DEEPSEEK_PRICING_UPDATED_AT,
    peakHours: DEEPSEEK_PEAK_HOURS,
    models: DEEPSEEK_STANDARD_PRICING,
  },
});

export function normalizeUsage(body, format) {
  const usage = body?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const responsesFormat = format === "responses";
  const inputTokens = tokenCount(responsesFormat ? usage.input_tokens : usage.prompt_tokens);
  const outputTokens = tokenCount(responsesFormat ? usage.output_tokens : usage.completion_tokens);
  const reportedTotal = tokenCount(usage.total_tokens);
  const totalTokens = reportedTotal ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  if (totalTokens === null) {
    return null;
  }

  const inputDetails = responsesFormat ? usage.input_tokens_details : usage.prompt_tokens_details;
  const outputDetails = responsesFormat ? usage.output_tokens_details : usage.completion_tokens_details;
  const cachedInputTokens = Math.min(tokenCount(inputDetails?.cached_tokens) ?? 0, inputTokens ?? 0);

  return {
    inputTokens: inputTokens ?? Math.max(0, totalTokens - (outputTokens ?? 0)),
    cachedInputTokens,
    outputTokens: outputTokens ?? Math.max(0, totalTokens - (inputTokens ?? 0)),
    reasoningTokens: tokenCount(outputDetails?.reasoning_tokens) ?? 0,
    totalTokens,
  };
}

export function resolveModelPricing(model, pricingConfig, now = new Date()) {
  const custom = normalizeCustomPricing(pricingConfig);
  if (custom) {
    return {
      ...custom,
      source: "custom",
      sourceModel: String(model || "").trim(),
      updatedAt: null,
    };
  }

  const catalogKey = pricingConfig?.mode === "deepseek" ? "deepseek" : "openai";
  const catalog = PRICING_CATALOGS[catalogKey];
  const sourceModel = findCatalogPriceModel(catalog.models, model);
  if (!sourceModel) {
    return null;
  }

  const resolved = resolveCatalogPricing(catalog, sourceModel, now);
  return {
    ...resolved.pricing,
    source: catalogKey,
    sourceModel,
    updatedAt: catalog.updatedAt,
    ...(resolved.card ? { card: resolved.card } : {}),
  };
}

export function getCatalogPriceView(catalogKey, modelId) {
  const catalog = PRICING_CATALOGS[catalogKey];
  if (!catalog) {
    return null;
  }
  const sourceModel = findCatalogPriceModel(catalog.models, modelId);
  if (!sourceModel) {
    return null;
  }
  const entry = catalog.models[sourceModel];
  const hasRateCards = Boolean(catalog.peakHours && entry.peak && entry.offPeak);
  return {
    source: catalogKey,
    sourceModel,
    sourceUrl: catalog.sourceUrl,
    updatedAt: catalog.updatedAt,
    peakHours: hasRateCards ? catalog.peakHours : null,
    pricing: hasRateCards ? entry.peak : entry,
    offPeakPricing: hasRateCards ? entry.offPeak : null,
  };
}

export function estimateUsageCost(usage, pricing) {
  if (!usage || !pricing) {
    return null;
  }

  const inputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = tokenCount(usage.cachedInputTokens) ?? 0;
  const outputTokens = tokenCount(usage.outputTokens);
  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  const boundedCachedTokens = Math.min(cachedInputTokens, inputTokens);
  const regularInputTokens = inputTokens - boundedCachedTokens;
  const cachedInputRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const amount = (
    regularInputTokens * pricing.inputPerMillion
    + boundedCachedTokens * cachedInputRate
    + outputTokens * pricing.outputPerMillion
  ) / 1_000_000;

  return {
    amount: Number(amount.toFixed(12)),
    currency: pricing.currency,
    pricing: { ...pricing },
  };
}

export function getOpenAIPricingCatalog() {
  return Object.entries(OPENAI_STANDARD_PRICING).map(([model, pricing]) => ({ model, ...pricing }));
}

function findCatalogPriceModel(catalogModels, value) {
  const model = String(value || "").trim().toLowerCase();
  if (catalogModels[model]) {
    return model;
  }

  const baseModel = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return catalogModels[baseModel] ? baseModel : null;
}

function resolveCatalogPricing(catalog, sourceModel, now) {
  const entry = catalog.models[sourceModel];
  if (catalog.peakHours && entry.peak && entry.offPeak) {
    return isPeakHour(now, catalog.peakHours)
      ? { card: "peak", pricing: entry.peak }
      : { card: "off-peak", pricing: entry.offPeak };
  }
  return { card: null, pricing: entry };
}

function isPeakHour(value, peakHours) {
  const hour = new Date(value).getUTCHours();
  return peakHours.some(([start, end]) => hour >= start && hour < end);
}

function normalizeCustomPricing(value) {
  if (!value || value.mode !== "custom") {
    return null;
  }

  const inputPerMillion = nonnegativeNumber(value.inputPerMillion);
  const outputPerMillion = nonnegativeNumber(value.outputPerMillion);
  const cachedInputPerMillion = value.cachedInputPerMillion === null || value.cachedInputPerMillion === undefined
    ? null
    : nonnegativeNumber(value.cachedInputPerMillion);
  if (inputPerMillion === null || outputPerMillion === null || value.cachedInputPerMillion !== null
    && value.cachedInputPerMillion !== undefined && cachedInputPerMillion === null) {
    return null;
  }

  return {
    currency: String(value.currency || "USD").trim().toUpperCase() || "USD",
    inputPerMillion,
    cachedInputPerMillion,
    outputPerMillion,
  };
}

function price(inputPerMillion, cachedInputPerMillion, outputPerMillion, currency = "USD") {
  return { currency, inputPerMillion, cachedInputPerMillion, outputPerMillion };
}

function rateCards(peak, offPeak) {
  return { peak, offPeak };
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function nonnegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}