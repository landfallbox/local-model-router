import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isPlainObject } from "./config.js";

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLogLevel(value) {
  const normalized = String(value || "info").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized) ? normalized : "info";
}

/** Creates the process logger. Sensitive fields are redacted recursively before serialization. */
export function createLogger(config, runtimeRoot) {
  const logFile = config.router.logFile;
  const resolvedLogFile = isAbsolute(logFile) ? logFile : resolve(runtimeRoot, logFile);
  mkdirSync(dirname(resolvedLogFile), { recursive: true });

  const threshold = LOG_LEVELS[resolveLogLevel(process.env.LOCAL_MODEL_ROUTER_LOG_LEVEL)];

  const stream = createWriteStream(resolvedLogFile, { flags: "a" });
  stream.on("error", (error) => {
    console.error(JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      event: "log_stream_failed",
      errorMessage: error.message,
    }));
  });

  const log = (level, event, data = {}) => {
    if (LOG_LEVELS[level] < threshold) {
      return;
    }
    writeLog(stream, level, event, data);
  };

  return {
    debug: (event, data) => log("debug", event, data),
    info: (event, data) => log("info", event, data),
    warn: (event, data) => log("warn", event, data),
    error: (event, data) => log("error", event, data),
    close: (callback) => stream.end(callback),
  };
}

function writeLog(stream, level, event, data) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...redact(data),
  });
  stream.write(`${line}\n`);

  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = /api[_-]?key|authorization|token|secret/i.test(key) ? "[redacted]" : redact(item);
  }
  return result;
}