# Local Model Router

Local Model Router was created to work around a practical VS Code Copilot BYOK limitation: Copilot can use custom keys and endpoints, but configuring the same model through two different upstream vendors can cause conflicts.

This project puts one local OpenAI-compatible endpoint in front of those vendors. The client sees a single stable chat-completions endpoint, while the router handles vendor priority and fallback locally.

```text
http://127.0.0.1:4000/v1/chat/completions
```

The router tries enabled vendors in priority order. If the current vendor times out, returns a retryable status, or fails before a response is streamed, the next vendor is tried.

## What It Does

- OpenAI-compatible `/v1/chat/completions` proxy.
- Local vendor priority and fallback configuration.
- Local API key required for access.
- Electron GUI for configuration, status, logs, and tray control.
- Structured logs without API keys, authorization headers, secrets, or upstream response bodies.

## Quick Start

- Node.js 18.17 or newer.
- Windows is required for the packaged desktop installer.
- At least one upstream OpenAI-compatible chat-completions provider.

```powershell
git clone https://github.com/landfallbox/local-model-router.git
cd local-model-router
npm install
copy config.example.json config.json
npm run gui
```

`npm run gui` starts the development GUI with an isolated config directory under the system temp folder. This keeps development runs separate from the project `config.json` and uses a development default port when it creates a new config.

To point the development GUI at the project config instead, set `ROUTER_CONFIG` before starting it:

```powershell
$env:ROUTER_CONFIG = (Resolve-Path .\config.json)
npm run gui
```

In the GUI, set:

- `router.apiKey`: the local token clients send as `Authorization: Bearer ...`.
- `vendors`: upstream providers in priority order.
- `baseUrl`: the upstream API base URL, usually ending in `/v1`.
- `models[].id`: a model name this vendor can serve.
- `authentication`: `none` or `api-key`.

Each vendor can support multiple models. Requests are routed only to vendors that list the requested model id, and the same model id is sent to the selected upstream provider.

Keep `config.json` private. It is ignored by git and may contain API keys.

## Run And Check

From a configured `config.json`:

```powershell
npm start
```

Health check:

```powershell
$env:ROUTER_API_KEY="replace-with-your-local-router-token"
npm run health
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

## Important Boundaries

- Fallback is enabled for request timeouts, network failures before a response, `408`, `409`, `425`, `429`, `500`, `502`, `503`, `504`, and other `5xx` responses.
- Fallback is not enabled by default for `400`, `401`, `403`, or `404`, because those usually indicate configuration, authentication, or request-format problems.
- If an upstream fails before streaming starts, another vendor can be tried. Once partial output has reached the client, the router cannot switch vendors without corrupting the stream.
- Packaged Windows builds store configuration at `%APPDATA%\Local Model Router\config.json`.

## Development

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

Packaged Windows builds check GitHub Releases for updates after startup. The app only checks for a newer version automatically; users click the update button before the installer is downloaded.

For auto-update to work, each GitHub Release must include the installer `.exe`, its `.exe.blockmap`, and `latest.yml` from the `release` directory.

Preview the complete update UI in development mode without contacting GitHub or installing anything:

```powershell
npm run gui:update
```

This simulates an available `0.3.0-dev-preview` release. Use the update button below the app identity in the sidebar to preview download progress, then restart-to-update state. The mock flow does not close the app or change the installed version.

Preview a download that fails after reaching partial progress:

```powershell
npm run gui:update-error
```

Click `Update available`; the progress bar will stop and change to `Update failed · Retry`.

Set `LOCAL_MODEL_ROUTER_MOCK_UPDATE` before `npm run gui` to preview a specific initial result: `available`, `downloaded`, `not-available`, or `error`. Override the preview version with `LOCAL_MODEL_ROUTER_MOCK_UPDATE_VERSION`.

Run checks:

```powershell
npm run check
npm test
npm run gui:build
```

CI runs the same checks on Windows.

## Security And Contributing

- Keep `config.json` private.
- Rotate any key that appears in git history, screenshots, logs, issues, or crash reports.
- Do not bind the router to a public interface unless you understand the network exposure.
- `router.apiKey` is required before the router starts.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

MIT. See [LICENSE](LICENSE).
