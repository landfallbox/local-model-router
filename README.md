# Local Model Router

Local Model Router is a local OpenAI-compatible routing layer for desktop workflows that need one stable chat-completions endpoint with vendor failover.

It exposes a local endpoint such as:

```text
http://127.0.0.1:4000/v1/chat/completions
```

Internally, it tries enabled vendors in priority order. If the primary vendor times out, returns a retryable status, or fails before a response is streamed, the router attempts the next vendor.

## Features

- OpenAI-compatible `/v1/chat/completions` proxy.
- Configurable vendor priority and fallback behavior.
- Local API key required for router access.
- Electron desktop GUI for configuration, status, tray control, and logs.
- Structured logs with API keys and upstream response bodies removed.
- Windows installer support through `electron-builder`.

## Requirements

- Node.js 18.17 or newer.
- Windows for the packaged desktop installer.
- Any upstream provider that offers an OpenAI-compatible chat-completions API.

## Quick Start

```powershell
git clone https://github.com/your-org/local-model-router.git
cd local-model-router
npm install
copy config.example.json config.json
npm run gui
```

Use the GUI to set:

- `router.apiKey`: the local token clients must send as `Authorization: Bearer ...`.
- `vendors`: upstream providers in priority order.
- `baseUrl`: the upstream API base URL, usually ending in `/v1`.
- `model`: the upstream model identifier to send to that vendor.
- `authentication`: `none` or `api-key`.

Keep `config.json` private. It is ignored by git and may contain API keys.

## Running The Router

From a configured `config.json`:

```powershell
npm start
```

Health check:

```powershell
$env:ROUTER_API_KEY="replace-with-your-local-router-token"
npm run health
```

You can also configure vendors through environment variables:

```powershell
$env:ROUTER_API_KEY="replace-with-your-local-router-token"
$env:VENDOR_A_BASE_URL="https://api.primary.example/v1"
$env:VENDOR_A_API_KEY="replace-with-primary-vendor-key"
$env:VENDOR_A_MODEL="model-id"
$env:VENDOR_B_BASE_URL="https://api.fallback.example/v1"
$env:VENDOR_B_API_KEY="replace-with-fallback-vendor-key"
$env:VENDOR_B_MODEL="model-id"
npm start
```

## Client Configuration

Point any OpenAI-compatible client at the local endpoint and use the same token as `router.apiKey`.

Example client entry:

```json
{
  "name": "Local Model Router",
  "vendor": "customendpoint",
  "apiKey": "replace-with-your-local-router-token",
  "apiType": "chat-completions",
  "models": [
    {
      "id": "model-id",
      "name": "Model Name",
      "url": "http://127.0.0.1:4000/v1/chat/completions",
      "toolCalling": true,
      "vision": true,
      "maxInputTokens": 200000,
      "maxOutputTokens": 64000
    }
  ]
}
```

## Fallback Behavior

Fallback is enabled for:

- Request timeout.
- Network errors or interrupted connections before a response is returned.
- HTTP `408`, `409`, `425`, `429`, `500`, `502`, `503`, `504`.
- Other `5xx` responses.

Fallback is not enabled by default for `400`, `401`, `403`, or `404`, because those usually indicate configuration, authentication, or request-format problems.

You can adjust retryable status codes in `router.fallbackStatusCodes`.

## Streaming Boundary

The router forwards a successful upstream response stream directly to the client.

If an upstream fails before streaming starts, another vendor can be tried. If the upstream fails after the client has already received partial output, the router cannot transparently switch vendors without corrupting the stream.

## Logs And Privacy

Logs are written to `logs/router.log` in development, or to the app data directory in packaged builds.

Logs include selected vendor, status code, timing, and request IDs. API keys, authorization headers, tokens, secrets, and upstream error bodies are not written to the log.

## Desktop App

Run the development desktop app:

```powershell
npm run gui
```

The GUI can:

- Edit router settings and vendor priority.
- Start, stop, and restart the router.
- Show health state.
- Read recent logs incrementally.
- Run from the Windows tray.

Packaged Windows builds store configuration under:

```text
%APPDATA%\Local Model Router\config.json
```

## Build

Build the renderer:

```powershell
npm run gui:build
```

Build an unpacked Windows app:

```powershell
npm run dist:windows:dir
```

Build the Windows NSIS installer:

```powershell
npm run dist:windows
```

The installer output is written to `release/`.

## Development Checks

```powershell
npm run check
npm test
npm run gui:build
```

CI runs the same checks on Windows.

## Security

- Keep `config.json` private.
- Rotate any key that appears in git history, screenshots, logs, issues, or crash reports.
- Do not bind the router to a public interface unless you understand the network exposure.
- `router.apiKey` is required before the router starts.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
