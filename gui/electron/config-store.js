import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeConfig, validateConfig } from "../../src/config.js";

let writeQueue = Promise.resolve();

function revisionFor(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function readConfigStore(configPath) {
  const text = (await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, "");
  return {
    config: normalizeConfig(JSON.parse(text)),
    revision: revisionFor(text),
  };
}

/**
 * Serializes writes and rejects stale renderer snapshots. The temporary file is
 * kept beside config.json so rename remains an atomic filesystem operation.
 */
export function writeConfigStore(configPath, config, expectedRevision) {
  const operation = writeQueue.then(async () => {
    const current = await readConfigStore(configPath);
    if (expectedRevision && current.revision !== expectedRevision) {
      const error = new Error("Config changed since it was loaded. Reload settings and try again.");
      error.code = "CONFIG_CONFLICT";
      throw error;
    }

    const normalized = normalizeConfig(config);
    validateConfig(normalized, { requireVendors: false, configPath });
    const text = `${JSON.stringify(normalized, null, 2)}\n`;
    const temporaryPath = join(dirname(configPath), `.config-${randomUUID()}.tmp`);
    const handle = await fs.open(temporaryPath, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.rename(temporaryPath, configPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => null);
      throw error;
    }

    return { config: normalized, revision: revisionFor(text) };
  });

  writeQueue = operation.catch(() => null);
  return operation;
}