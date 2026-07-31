import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger } from "./logger.js";
import { convertRequestBody, convertResponseBody, normalizeRequestFormat } from "./openai-protocol.js";
import { loadRuntimeConfig, runtimeRoot } from "./runtime-config.js";
import { VendorCircuitBreaker } from "./vendor-circuit-breaker.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const RESTART_REQUIRED_FIELDS = ["router.host", "router.port", "router.logFile"];
const CONFIG_WATCH_DEBOUNCE_MS = 200;

function sendParentMessage(message) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function" || !process.connected) {
      reject(new Error("Parent IPC channel is disconnected."));
      return;
    }

    try {
      process.send(message, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function runtimeConfigRevision(config) {
  const runtimeConfig = {
    router: config.router,
    model: config.model,
    vendors: config.vendors,
  };
  return createHash("sha256").update(JSON.stringify(runtimeConfig)).digest("hex");
}

function getConfigValue(config, path) {
  return path.split(".").reduce((value, key) => value?.[key], config);
}

function prepareReloadedConfig(currentConfig, nextConfig) {
  const restartFields = RESTART_REQUIRED_FIELDS.filter(
    (field) => getConfigValue(currentConfig, field) !== getConfigValue(nextConfig, field),
  );
  const effectiveConfig = structuredClone(nextConfig);

  for (const field of restartFields) {
    const [, key] = field.split(".");
    effectiveConfig.router[key] = currentConfig.router[key];
  }

  return { effectiveConfig, restartFields };
}

function getRequestPath(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.pathname.replace(/\/+$/, "") || "/";
}

function isAuthorized(req, config, path) {
  const managementToken = process.env.LOCAL_MODEL_ROUTER_MANAGEMENT_TOKEN;
  if (path === "/health" && managementToken && req.headers["x-router-management-token"] === managementToken) {
    return true;
  }

  const expectedKey = config.router.apiKey;
  if (!expectedKey) {
    return true;
  }

  const authorization = req.headers.authorization || "";
  return authorization === `Bearer ${expectedKey}`;
}

async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error(`Request body exceeds maxBodyBytes (${maxBodyBytes}).`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }
}

function buildUpstreamUrl(vendor, requestFormat) {
  const baseUrl = vendor.baseUrl.replace(/\/+$/, "");
  const path = requestFormat === "responses"
    ? vendor.responsesPath || "/responses"
    : vendor.chatCompletionsPath || "/chat/completions";
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildUpstreamHeaders(vendor) {
  return {
    ...(vendor.apiKey ? { authorization: `Bearer ${vendor.apiKey}` } : {}),
    "content-type": "application/json",
  };
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cancel: () => clearTimeout(timeout),
  };
}

function linkClientAbort(req, res, abort) {
  const abortClosedResponse = () => {
    if (!res.writableEnded) {
      abort();
    }
  };
  req.once("aborted", abort);
  res.once("close", abortClosedResponse);
  return () => {
    req.off("aborted", abort);
    res.off("close", abortClosedResponse);
  };
}

async function callVendor(vendor, requestBody, inboundFormat, signal) {
  const upstreamFormat = normalizeRequestFormat(vendor.requestFormat);
  const body = convertRequestBody(requestBody, inboundFormat, upstreamFormat, vendor.selectedModel.id);

  const response = await fetch(buildUpstreamUrl(vendor, upstreamFormat), {
    method: "POST",
    headers: buildUpstreamHeaders(vendor),
    body: JSON.stringify(body),
    signal,
  });
  return { response, upstreamFormat };
}

function shouldFallback(statusCode, config) {
  return config.router.fallbackStatusCodes.includes(statusCode) || statusCode >= 500;
}

async function readBoundedText(response, maxBytes = 64 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total <= maxBytes) {
      chunks.push(Buffer.from(value));
    }

    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

function summarizeUpstreamError(statusCode, body) {
  const text = String(body || "").trim();
  let errorType = "upstream_error";

  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.type) {
      errorType = String(parsed.error.type);
    } else if (parsed?.error?.code) {
      errorType = String(parsed.error.code);
    }
  } catch {
    errorType = text ? "upstream_text_error" : "upstream_empty_error";
  }

  return {
    statusCode,
    errorType,
    bodyBytes: Buffer.byteLength(text, "utf8"),
  };
}

function copyUpstreamHeaders(upstream, res, vendorName) {
  for (const [key, value] of upstream.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }
  res.setHeader("x-router-vendor", vendorName);
}

async function pipeUpstream(upstream, res) {
  if (!upstream.body) {
    res.end();
    return;
  }

  await pipeline(Readable.fromWeb(upstream.body), res);
}

async function handleGeneration(req, res, config, logger, circuitBreaker, inboundFormat) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const requestBody = await readJsonBody(req, config.router.maxBodyBytes);
  const requestedModel = String(requestBody.model || config.model.id).trim() || config.model.id;
  const vendors = getVendorsForModel(config.vendors, requestedModel);
  const failures = [];

  if (!vendors.length) {
    sendJson(res, 404, {
      error: {
        message: `No enabled vendor supports model: ${requestedModel}`,
        type: "model_not_found",
        model: requestedModel,
      },
    });
    return;
  }

  const candidates = circuitBreaker.candidates(vendors, requestedModel);
  for (const { vendor, forced } of candidates) {
    const circuitPermission = circuitBreaker.acquire(vendor, requestedModel, { forced });
    if (!circuitPermission) {
      continue;
    }

    const vendorStartedAt = Date.now();
    const timeout = createTimeoutSignal(vendor.timeoutMs);
    const unlinkClientAbort = linkClientAbort(req, res, timeout.abort);

    try {
      logger.info("vendor_request_started", {
        requestId,
        vendor: vendor.name,
        model: requestedModel,
        inboundFormat,
        upstreamFormat: normalizeRequestFormat(vendor.requestFormat),
        stream: requestBody.stream === true,
        circuitProbe: circuitPermission.probe,
        circuitForcedProbe: circuitPermission.forced,
      });

      const { response: upstream, upstreamFormat } = await callVendor(vendor, requestBody, inboundFormat, timeout.signal);
      // requestTimeoutMs limits connection and response-header wait time. Once a
      // vendor responds, long-running streams may continue until completion or
      // until the client disconnects.
      timeout.cancel();
      const elapsedMs = Date.now() - vendorStartedAt;

      if (!upstream.ok) {
        const errorText = await readBoundedText(upstream);
        const failure = {
          vendor: vendor.name,
          elapsedMs,
          ...summarizeUpstreamError(upstream.status, errorText),
        };
        failures.push(failure);

        logger.warn("vendor_request_failed_status", {
          requestId,
          ...failure,
        });

        if (shouldFallback(upstream.status, config)) {
          recordCircuitFailure(circuitBreaker, circuitPermission, logger, {
            requestId,
            vendor: vendor.name,
            model: requestedModel,
            reason: `http_${upstream.status}`,
          });
          continue;
        }

        recordCircuitSuccess(circuitBreaker, circuitPermission, logger, {
          requestId,
          vendor: vendor.name,
          model: requestedModel,
        });
        res.statusCode = upstream.status;
        res.setHeader("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
        res.setHeader("x-router-vendor", vendor.name);
        res.end(errorText);
        return;
      }

      logger.info("vendor_request_selected", {
        requestId,
        vendor: vendor.name,
        model: requestedModel,
        statusCode: upstream.status,
        elapsedMs,
        totalElapsedMs: Date.now() - startedAt,
      });

      recordCircuitSuccess(circuitBreaker, circuitPermission, logger, {
        requestId,
        vendor: vendor.name,
        model: requestedModel,
      });
      res.statusCode = upstream.status;
      if (upstreamFormat === inboundFormat) {
        copyUpstreamHeaders(upstream, res, vendor.name);
        await pipeUpstream(upstream, res);
      } else {
        const upstreamBody = await upstream.json();
        const convertedBody = convertResponseBody(upstreamBody, upstreamFormat, inboundFormat);
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("x-router-vendor", vendor.name);
        res.end(JSON.stringify(convertedBody));
      }
      return;
    } catch (error) {
      const isProtocolFailure = error.statusCode === 400 && Boolean(error.errorType);
      const failure = {
        vendor: vendor.name,
        elapsedMs: Date.now() - vendorStartedAt,
        errorName: error.name,
        errorMessage: error.message,
        errorType: error.errorType,
        ...(isProtocolFailure ? { protocolFailure: true } : {}),
      };
      failures.push(failure);

      logger.warn("vendor_request_failed_error", {
        requestId,
        ...failure,
      });

      if (req.aborted || res.destroyed) {
        circuitBreaker.release(circuitPermission);
        return;
      }

      // Once response bytes are committed, another vendor would corrupt the stream
      // and may duplicate a billable upstream request.
      if (res.headersSent) {
        circuitBreaker.release(circuitPermission);
        res.destroy(error);
        return;
      }

      if (isProtocolFailure) {
        circuitBreaker.release(circuitPermission);
        continue;
      }

      recordCircuitFailure(circuitBreaker, circuitPermission, logger, {
        requestId,
        vendor: vendor.name,
        model: requestedModel,
        reason: error.name === "AbortError" ? "timeout" : "network_error",
      });
    } finally {
      unlinkClientAbort();
      timeout.cancel();
    }
  }

  logger.error("all_vendors_failed", {
    requestId,
    totalElapsedMs: Date.now() - startedAt,
    failures,
  });

  const protocolFailures = failures.filter((failure) => failure.protocolFailure);
  if (protocolFailures.length === failures.length && protocolFailures.length) {
    sendJson(res, 400, {
      error: {
        message: protocolFailures[0].errorMessage,
        type: protocolFailures[0].errorType,
      },
    });
    return;
  }

  sendJson(res, 502, {
    error: {
      message: "All configured vendors failed before a response could be returned.",
      type: "router_error",
      request_id: requestId,
      failures,
    },
  });
}

function recordCircuitFailure(circuitBreaker, permission, logger, context) {
  const transition = circuitBreaker.recordFailure(permission);
  if (transition.opened) {
    logger.warn("vendor_circuit_opened", {
      ...context,
      durationMs: transition.durationMs,
      ejectionCount: transition.ejectionCount,
      retryAt: transition.retryAt,
    });
  }
}

function recordCircuitSuccess(circuitBreaker, permission, logger, context) {
  const transition = circuitBreaker.recordSuccess(permission);
  if (transition.closed) {
    logger.info("vendor_circuit_closed", {
      ...context,
      ejectionCount: transition.ejectionCount,
    });
  }
}

function getVendorsForModel(vendors, requestedModel) {
  return vendors.flatMap((vendor) => {
    const selectedModel = vendor.models.find((model) => model.enabled !== false && model.id === requestedModel);
    return selectedModel ? [{ ...vendor, selectedModel }] : [];
  });
}

function handleModels(_req, res, config) {
  const modelIds = [...new Set(config.vendors.flatMap((vendor) => vendor.models
    .filter((model) => model.enabled !== false)
    .map((model) => model.id)))];

  sendJson(res, 200, {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: config.model.ownedBy,
    })),
  });
}

function handleHealth(_req, res, runtime) {
  const { config, circuitBreaker } = runtime;
  sendJson(res, 200, {
    ok: true,
    instanceId: process.env.LOCAL_MODEL_ROUTER_INSTANCE_ID || "",
    configRevision: runtime.configRevision,
    restartRequired: runtime.restartFields.length > 0,
    restartFields: runtime.restartFields,
    model: config.model.id,
    vendorCount: config.vendors.length,
    vendors: config.vendors.map((vendor) => ({
      name: vendor.name,
      priority: vendor.priority,
      models: vendor.models.map((model) => ({
        id: model.id,
        enabled: model.enabled !== false,
        circuit: circuitBreaker.snapshot(vendor, model.id),
      })),
      enabled: vendor.enabled !== false,
    })),
  });
}

async function handleRequest(req, res, runtime, logger) {
  const { config, circuitBreaker } = runtime;
  const path = getRequestPath(req);

  try {
    if (!isAuthorized(req, config, path)) {
      sendJson(res, 401, {
        error: {
          message: "Invalid router API key.",
          type: "authentication_error",
        },
      });
      return;
    }

    if (req.method === "GET" && path === "/health") {
      handleHealth(req, res, runtime);
      return;
    }

    if (req.method === "GET" && path === "/v1/models") {
      handleModels(req, res, config);
      return;
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      await handleGeneration(req, res, config, logger, circuitBreaker, "chat-completions");
      return;
    }

    if (req.method === "POST" && path === "/v1/responses") {
      await handleGeneration(req, res, config, logger, circuitBreaker, "responses");
      return;
    }

    sendJson(res, 404, {
      error: {
        message: `Unsupported route: ${req.method} ${path}`,
        type: "not_found",
      },
    });
  } catch (error) {
    logger.error("request_failed", {
      path,
      method: req.method,
      errorName: error.name,
      errorMessage: error.message,
    });

    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        error: {
          message: error.message,
          type: error.errorType || "router_error",
          ...(error.parameter ? { param: error.parameter } : {}),
        },
      });
    } else {
      res.destroy(error);
    }
  }
}

function main() {
  const { config, configPath } = loadRuntimeConfig();
  const logger = createLogger(config, runtimeRoot);
  let runtime = {
    config,
    circuitBreaker: new VendorCircuitBreaker(),
    configRevision: runtimeConfigRevision(config),
    restartFields: [],
  };
  let reloadQueue = Promise.resolve();
  let configWatcher = null;
  let configWatchTimer = null;
  let stopping = false;

  const server = http.createServer((req, res) => {
    const snapshot = runtime;
    void handleRequest(req, res, snapshot, logger);
  });

  const reloadRuntimeConfig = (source) => {
    const operation = reloadQueue.then(() => {
      const loaded = loadRuntimeConfig();
      const nextRevision = runtimeConfigRevision(loaded.config);
      if (nextRevision === runtime.configRevision) {
        return {
          ok: true,
          applied: false,
          configRevision: runtime.configRevision,
          restartRequired: runtime.restartFields.length > 0,
          restartFields: runtime.restartFields,
        };
      }

      const { effectiveConfig, restartFields } = prepareReloadedConfig(runtime.config, loaded.config);
      runtime = {
        config: effectiveConfig,
        circuitBreaker: new VendorCircuitBreaker(),
        configRevision: nextRevision,
        restartFields,
      };
      logger.info("config_reloaded", {
        source,
        configRevision: nextRevision,
        restartRequired: restartFields.length > 0,
        restartFields,
      });
      return {
        ok: true,
        applied: true,
        configRevision: nextRevision,
        restartRequired: restartFields.length > 0,
        restartFields,
      };
    });

    reloadQueue = operation.catch((error) => {
      logger.error("config_reload_failed", {
        source,
        errorName: error.name,
        errorMessage: error.message,
      });
    });
    return operation;
  };

  const scheduleWatchedReload = () => {
    clearTimeout(configWatchTimer);
    configWatchTimer = setTimeout(() => {
      configWatchTimer = null;
      void reloadRuntimeConfig("file-watch").catch(() => null);
    }, CONFIG_WATCH_DEBOUNCE_MS);
  };

  try {
    configWatcher = watch(dirname(configPath), (_eventType, filename) => {
      if (!filename || String(filename) === basename(configPath)) {
        scheduleWatchedReload();
      }
    });
    configWatcher.on("error", (error) => {
      logger.error("config_watch_failed", { errorName: error.name, errorMessage: error.message });
    });
  } catch (error) {
    logger.error("config_watch_failed", { errorName: error.name, errorMessage: error.message });
  }

  server.listen(config.router.port, config.router.host, () => {
    logger.info("router_started", {
      host: config.router.host,
      port: config.router.port,
      configPath,
      model: config.model.id,
      vendors: config.vendors.map((vendor) => vendor.name),
    });
  });

  const stopRouter = (reason) => {
    if (stopping) {
      return;
    }

    stopping = true;
    clearTimeout(configWatchTimer);
    configWatcher?.close();
    logger.info("router_stopping", { reason });
    server.close(() => {
      logger.close(() => process.exit(0));
    });
    server.closeIdleConnections();
    if (reason === "parent_disconnect") {
      server.closeAllConnections();
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => stopRouter(signal));
  }

  if (typeof process.send === "function") {
    process.on("message", (message) => {
      if (message?.type === "shutdown") {
        stopRouter("parent_request");
        return;
      }
      if (message?.type === "reload-config" && message.requestId) {
        void (async () => {
          let response;
          try {
            const result = await reloadRuntimeConfig("parent-request");
            response = {
              type: "config-reloaded",
              requestId: message.requestId,
              ...result,
            };
          } catch (error) {
            response = {
              type: "config-reload-failed",
              requestId: message.requestId,
              ok: false,
              error: error.message || String(error),
            };
          }

          try {
            await sendParentMessage(response);
          } catch (error) {
            logger.error("config_reload_response_failed", {
              requestId: message.requestId,
              responseType: response.type,
              errorName: error.name,
              errorMessage: error.message,
            });
          }
        })();
      }
    });
    process.on("disconnect", () => stopRouter("parent_disconnect"));
  }
}

main();
