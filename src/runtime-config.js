import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfig, validateConfig } from "./config.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(moduleDirectory, "..");
export const runtimeRoot = process.env.LOCAL_MODEL_ROUTER_DATA_DIR || projectRoot;

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Loads file configuration, applies environment overrides, then validates the runtime shape. */
export function loadRuntimeConfig() {
  const configPath = process.env.ROUTER_CONFIG || resolve(projectRoot, "config.json");
  const fileConfig = existsSync(configPath) ? readJsonFile(configPath) : {};
  const config = normalizeConfig(fileConfig);

  config.router.host = process.env.HOST || process.env.ROUTER_HOST || config.router.host;
  config.router.port = Number(process.env.PORT || process.env.ROUTER_PORT || config.router.port);
  config.router.apiKey = process.env.ROUTER_API_KEY ?? config.router.apiKey;

  if (!config.vendors.length) {
    config.vendors = vendorsFromEnvironment();
  }

  config.vendors = config.vendors
    .filter((vendor) => vendor.enabled !== false)
    .map((vendor) => ({
      ...vendor,
      models: normalizeRuntimeVendorModels(vendor, config.model.id),
      timeoutMs: Number(config.router.requestTimeoutMs),
    }))
    .filter((vendor) => vendor.models.some((model) => model.enabled !== false));

  validateConfig(config, { configPath });
  return { config, configPath };
}

function normalizeRuntimeVendorModels(vendor, defaultModelId) {
  const models = Array.isArray(vendor.models) ? vendor.models : [];
  if (!models.length) {
    const id = String(vendor.model || defaultModelId || "model-id").trim();
    return [{ id, enabled: true }];
  }

  return models
    .map((model) => ({
      id: String(model.id || defaultModelId || "model-id").trim(),
      enabled: model.enabled !== false,
    }))
    .filter((model) => model.id);
}

function vendorsFromEnvironment() {
  return [vendorFromEnvironment("VENDOR_A", "vendor-a"), vendorFromEnvironment("VENDOR_B", "vendor-b")].filter(Boolean);
}

function vendorFromEnvironment(prefix, fallbackName) {
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (!baseUrl && !apiKey) {
    return null;
  }

  return {
    name: process.env[`${prefix}_NAME`] || fallbackName,
    baseUrl,
    apiKey,
    model: process.env[`${prefix}_MODEL`] || "model-id",
    authentication: apiKey ? "api-key" : "none",
    enabled: true,
  };
}