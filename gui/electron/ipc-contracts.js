import { z } from "zod";
import { configSchema } from "../../src/config.js";

const emptyRequest = z.tuple([]);
const okResponse = z.object({ ok: z.boolean() }).passthrough();
const pathsSchema = z.object({
  appDir: z.string(),
  dataDir: z.string(),
  configPath: z.string(),
  serverPath: z.string(),
  pidPath: z.string(),
  packageRoot: z.string(),
  nodePath: z.string(),
});

export const healthSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  url: z.string(),
  body: z.unknown().nullable().optional(),
  text: z.string().optional(),
  error: z.string().optional(),
  processCount: z.number().int().nonnegative(),
  processLogPath: z.string().optional(),
}).passthrough();

export const updateStateSchema = z.object({
  status: z.string().min(1),
  supported: z.boolean(),
  mock: z.boolean(),
  currentVersion: z.string(),
  availableVersion: z.string(),
  releaseName: z.string(),
  releaseNotes: z.string(),
  progress: z.object({
    percent: z.number(),
    bytesPerSecond: z.number(),
    transferred: z.number(),
    total: z.number(),
  }).nullable(),
  error: z.string(),
  lastCheckedAt: z.string(),
}).passthrough();

const configResultSchema = z.object({
  config: configSchema,
  revision: z.string(),
  paths: pathsSchema,
  endpoint: z.string().url(),
}).passthrough();

const vendorRequestSchema = z.object({
  baseUrl: z.string(),
  authentication: z.enum(["none", "api-key"]).optional(),
  apiKey: z.string().optional(),
}).passthrough();

const routerResultSchema = z.object({
  health: healthSchema,
  started: z.boolean().optional(),
  stopped: z.boolean().optional(),
  via: z.enum(["existing", "process"]).optional(),
  pid: z.number().int().positive().optional(),
  error: z.string().optional(),
}).passthrough();

const optionalOptionsRequest = (schema) => z.tuple([schema.optional()]);
const contract = (request, response) => ({ request, response });

export const ipcContracts = Object.freeze({
  "app:getState": contract(emptyRequest, configResultSchema.extend({ health: healthSchema, appVersion: z.string() })),
  "app:rendererReady": contract(emptyRequest, okResponse),
  "app:hideToTray": contract(emptyRequest, okResponse),
  "app:cancelClose": contract(emptyRequest, okResponse),
  "app:quitAndStop": contract(emptyRequest, okResponse),
  "config:load": contract(emptyRequest, configResultSchema.extend({ appName: z.string(), isDevelopmentRuntime: z.boolean() })),
  "config:save": contract(z.tuple([z.object({ config: configSchema, revision: z.string() })]), configResultSchema),
  "vendor:listModels": contract(z.tuple([vendorRequestSchema]), z.object({ models: z.array(z.string()), url: z.string().url() })),
  "router:start": contract(emptyRequest, routerResultSchema),
  "router:stop": contract(emptyRequest, routerResultSchema),
  "router:restart": contract(emptyRequest, routerResultSchema),
  "router:health": contract(optionalOptionsRequest(z.object({ includeProcessCount: z.boolean().optional() })), healthSchema),
  "logs:read": contract(optionalOptionsRequest(z.object({
    limit: z.number().int().optional(),
    before: z.number().int().nonnegative().nullable().optional(),
  })), z.object({
    path: z.string(),
    lines: z.array(z.string()),
    nextBefore: z.number().int().nonnegative().nullable(),
    hasMore: z.boolean(),
  })),
  "file:openConfig": contract(emptyRequest, z.string()),
  "file:openLog": contract(emptyRequest, z.string()),
  "update:getState": contract(emptyRequest, updateStateSchema),
  "update:check": contract(optionalOptionsRequest(z.object({ manual: z.boolean().optional() })), updateStateSchema),
  "update:download": contract(emptyRequest, updateStateSchema),
  "update:install": contract(emptyRequest, updateStateSchema),
  "update:openReleasePage": contract(emptyRequest, okResponse),
  "clipboard:writeText": contract(z.tuple([z.string()]), okResponse),
});

export const ipcContractChannels = Object.freeze(Object.keys(ipcContracts));

export function parseIpcRequest(channel, args) {
  return parseContractValue(channel, "request", args);
}

export function parseIpcResponse(channel, value) {
  return parseContractValue(channel, "response", value);
}

function parseContractValue(channel, direction, value) {
  const schema = ipcContracts[channel]?.[direction];
  if (!schema) {
    throw new Error(`Missing IPC ${direction} contract for ${channel}.`);
  }

  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "value"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid IPC ${direction} for ${channel}: ${details}`);
}