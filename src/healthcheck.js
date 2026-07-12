import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const configPath = process.env.ROUTER_CONFIG || resolve("config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const host = process.env.ROUTER_HOST || process.env.HOST || config.router?.host || "127.0.0.1";
const port = process.env.ROUTER_PORT || process.env.PORT || config.router?.port || "4000";
const apiKey = process.env.ROUTER_API_KEY ?? config.router?.apiKey ?? "";
const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

const response = await fetch(`http://${host}:${port}/health`, { headers });
const body = await response.text();

console.log(body);
process.exit(response.ok ? 0 : 1);
