/**
 * Formats a router host for use in an HTTP authority. Config stores IPv6 hosts
 * without brackets because that is the form expected by server.listen().
 */
export function formatUrlHost(host) {
  const value = String(host || "127.0.0.1").trim() || "127.0.0.1";
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

export function getRouterBaseUrl(config) {
  const host = formatUrlHost(config.router?.host);
  const port = Number(config.router?.port || 4000);
  return `http://${host}:${port}`;
}

export function getChatCompletionsUrl(config) {
  return `${getRouterBaseUrl(config)}/v1/chat/completions`;
}