import { z } from "zod";

export const DEFAULT_CONFIG = {
  router: {
    host: "127.0.0.1",
    port: 4000,
    apiKey: "",
    requestTimeoutMs: 30000,
    maxBodyBytes: 50 * 1024 * 1024,
    fallbackStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
    logFile: "logs/router.log",
  },
  model: {
    id: "model-id",
    name: "Model Name",
    ownedBy: "local-router",
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
  },
  vendors: [],
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const httpUrlSchema = z.string().trim().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}, "Enter a valid HTTP or HTTPS URL.");

const statusCodeSchema = z.number().int().min(100).max(599);

export const vendorSchema = z.object({
  name: z.string().trim().optional().default(""),
  baseUrl: z.string().trim().optional().default(""),
  model: z.string().trim().optional().default(""),
  authentication: z.enum(["none", "api-key"]).optional().default("none"),
  enabled: z.boolean().optional().default(true),
  apiKey: z.string().trim().optional(),
  chatCompletionsPath: z.string().trim().optional(),
}).passthrough().superRefine((vendor, context) => {
  if (vendor.enabled === false) {
    return;
  }

  if (!vendor.name) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "Every vendor needs a name.",
    });
  }

  if (!httpUrlSchema.safeParse(vendor.baseUrl).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: `Vendor ${vendor.name || "(unnamed)"} has an invalid baseUrl.`,
    });
  }

  if (vendor.authentication === "api-key" && !vendor.apiKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKey"],
      message: `Vendor ${vendor.name || "(unnamed)"} requires an API key.`,
    });
  }
});

export const configSchema = z.object({
  router: z.object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    apiKey: z.string().trim().min(1, "router.apiKey is required."),
    requestTimeoutMs: z.number().int().min(100),
    maxBodyBytes: z.number().int().min(1024),
    fallbackStatusCodes: z.array(statusCodeSchema).min(1),
    logFile: z.string().trim().min(1),
  }),
  model: z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    ownedBy: z.string().trim().min(1),
    maxInputTokens: z.number().int().min(1),
    maxOutputTokens: z.number().int().min(1),
  }),
  vendors: z.array(vendorSchema),
});

export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override ?? base;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = deepMerge(base[key], value);
    }
    return merged;
  }

  return override ?? base;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && value.constructor === Object;
}

export function normalizeConfig(config) {
  const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(config) ? config : {});
  const router = merged.router || {};
  const model = merged.model || {};

  return {
    router: {
      host: String(router.host || DEFAULT_CONFIG.router.host).trim() || DEFAULT_CONFIG.router.host,
      port: Number(router.port || DEFAULT_CONFIG.router.port),
      apiKey: String(router.apiKey || ""),
      requestTimeoutMs: Number(router.requestTimeoutMs || DEFAULT_CONFIG.router.requestTimeoutMs),
      maxBodyBytes: Number(router.maxBodyBytes || DEFAULT_CONFIG.router.maxBodyBytes),
      fallbackStatusCodes: normalizeStatusCodes(router.fallbackStatusCodes),
      logFile: String(router.logFile || DEFAULT_CONFIG.router.logFile).trim() || DEFAULT_CONFIG.router.logFile,
    },
    model: {
      id: String(model.id || DEFAULT_CONFIG.model.id).trim() || DEFAULT_CONFIG.model.id,
      name: String(model.name || DEFAULT_CONFIG.model.name).trim() || DEFAULT_CONFIG.model.name,
      ownedBy: String(model.ownedBy || DEFAULT_CONFIG.model.ownedBy).trim() || DEFAULT_CONFIG.model.ownedBy,
      maxInputTokens: Number(model.maxInputTokens || DEFAULT_CONFIG.model.maxInputTokens),
      maxOutputTokens: Number(model.maxOutputTokens || DEFAULT_CONFIG.model.maxOutputTokens),
    },
    vendors: Array.isArray(merged.vendors) ? merged.vendors.map(normalizeVendor) : [],
  };
}

function normalizeStatusCodes(value) {
  const codes = Array.isArray(value) ? value : DEFAULT_CONFIG.router.fallbackStatusCodes;
  return [...new Set(codes.map(Number).filter((code) => Number.isInteger(code) && code >= 100 && code <= 599))];
}

export function normalizeVendor(vendor) {
  const authentication = vendor?.authentication === "api-key" || (!vendor?.authentication && vendor?.apiKey)
    ? "api-key"
    : "none";
  const item = {
    ...vendor,
    name: String(vendor?.name || "").trim(),
    baseUrl: String(vendor?.baseUrl || "").trim(),
    model: String(vendor?.model || "").trim(),
    authentication,
    enabled: vendor?.enabled !== false,
  };

  for (const key of ["apiKey", "chatCompletionsPath"]) {
    if (item[key] !== undefined) {
      item[key] = String(item[key] || "").trim();
      if (!item[key]) {
        delete item[key];
      }
    }
  }

  delete item.timeoutMs;
  delete item.apiKeyEnv;
  delete item.headers;

  if (authentication === "none") {
    delete item.apiKey;
  }

  return item;
}

export function validateConfig(config, { requireVendors = true, configPath = "config.json" } = {}) {
  const parsed = configSchema.safeParse(config);
  const errors = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);

  if (requireVendors && !config.vendors.length) {
    errors.push(
      `No vendors configured. Copy config.example.json to config.json, edit vendors, or set VENDOR_A_* / VENDOR_B_* environment variables. Config path: ${configPath}`,
    );
  }

  if (errors.length) {
    throw new Error(errors.join(" "));
  }
}

export function requiresRouterApiKey(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || !LOOPBACK_HOSTS.has(normalized);
}