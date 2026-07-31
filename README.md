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
- Optional login startup on Windows and macOS, disabled by default.
- Structured logs without API keys, authorization headers, secrets, or upstream response bodies.

## Quick Start

- Node.js 22.12 or newer.
- Windows or macOS for desktop development; formal installers are built in CI on their target operating system.
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

The Router accepts both `POST /v1/chat/completions` and `POST /v1/responses`. Each vendor can independently use Chat Completions or Responses upstream format; the desktop app exposes this choice in Vendor Settings.

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
- Circuit breaking is tracked independently for each vendor and model. Two consecutive fallback-eligible failures open the circuit for 10 seconds. Repeated failed probes increase that duration linearly up to 60 seconds; one successful probe restores the configured vendor priority.
- When every matching vendor has an open circuit, the Router probes the vendor whose circuit expires first instead of immediately reporting that no vendor is available.
- Saved Router credentials, limits, fallback settings, vendors, priorities, and models are applied to new requests without restarting the Router. Requests already in progress continue with the configuration snapshot they started with.
- Changes to `router.host`, `router.port`, or `router.logFile` require a Router restart. Other changes in the same save are still applied immediately.
- Manual edits to `config.json` are detected automatically. Invalid or incomplete edits are logged and ignored, so the Router keeps serving with its last valid configuration.
- Requests and responses are forwarded unchanged when the client and vendor use the same format, including streaming. For different formats, the Router converts common non-streaming text and function-call payloads. Cross-format streaming and format-specific parameters that cannot be converted safely return `400` instead of being silently discarded.
- If an upstream fails before streaming starts, another vendor can be tried. Once partial output has reached the client, the router cannot switch vendors without corrupting the stream.
- Packaged builds store configuration in Electron's platform user-data directory:
  - Windows: `%APPDATA%\Local Model Router\config.json`.
  - macOS: `~/Library/Application Support/Local Model Router/config.json`.

## Development

The main runtime boundaries are:

- `src/server.js`: HTTP routing, upstream failover, and stream ownership.
- `src/vendor-circuit-breaker.js`: per-vendor, per-model passive failure tracking and half-open recovery.
- `src/runtime-config.js`: file and environment configuration for the Router process.
- `src/logger.js`: structured logging and recursive secret redaction.
- `gui/electron/main.js`: Electron lifecycle, tray, IPC registration, and orchestration.
- `gui/electron/config-store.js`: validated, revision-checked, atomic configuration writes.
- `gui/electron/log-store.js`: byte-cursor log pagination.
- `gui/src/config-draft.js`: lossless conversion between persisted configuration and form state.

Router processes started by the desktop app are owned by the Electron main process and do not outlive an explicit app exit. The current app session uses a private parent-child IPC channel for graceful shutdown, with forced termination only as a timeout fallback. PID metadata and instance identity are retained for recovery after an abnormal app exit; a Router started outside the app is reported as external and is not terminated automatically.

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

Build an unpacked macOS Universal app on macOS:

```powershell
npm run dist:mac:dir
```

Build the macOS Universal DMG and ZIP installers on macOS:

```powershell
npm run dist:mac
```

Packaged Windows and macOS builds check GitHub Releases for updates after startup. The app only checks for a newer version automatically; users click the update button before the update is downloaded.

For auto-update to work, each GitHub Release must include the Windows installer `.exe`, its `.exe.blockmap`, and `latest.yml`, plus the macOS `.dmg`, `.zip`, `.zip.blockmap`, and `latest-mac.yml` from the `release` directory.

Tag pushes matching `v*` build both platforms and publish their artifacts in one GitHub Release. macOS builds are Universal binaries for Intel and Apple Silicon. To produce signed and notarized public macOS releases, configure these repository secrets:

- `MAC_CSC_LINK`: Base64-encoded Developer ID Application certificate or certificate URL.
- `MAC_CSC_KEY_PASSWORD`: certificate password.
- `APPLE_ID`: Apple developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

Without those secrets, CI still creates an unsigned macOS package suitable for internal testing, but Gatekeeper will warn users before opening it.

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
npm run test:electron
npm run gui:build
```

`npm test` contains the fast Router and repository tests. `npm run test:electron` launches the real Electron development app with isolated temporary configuration, verifies that it owns the Router process, verifies that hiding the window keeps Router running, and verifies that an explicit app exit stops Router. CI runs the fast and Electron lifecycle suites on both Windows and macOS.

## Security And Contributing

- Keep `config.json` private.
- Rotate any key that appears in git history, screenshots, logs, issues, or crash reports.
- Do not bind the router to a public interface unless you understand the network exposure.
- `router.apiKey` is required before the router starts.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

MIT. See [LICENSE](LICENSE).
