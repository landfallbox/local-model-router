# Contributing

Thanks for helping maintain Local Model Router.

## Development Setup

```powershell
git clone https://github.com/landfallbox/local-model-router.git
cd local-model-router
npm ci
npm run check
npm test
npm run test:electron
npm run gui:build
```

Use `npm run gui` for the desktop development app.

## Architecture Rules

- Keep persisted configuration normalization in `src/config.js`; form-only conversion belongs in `gui/src/config-draft.js`.
- Write desktop configuration through `gui/electron/config-store.js` so revision checks and atomic replacement are preserved.
- Keep Router process ownership in the Electron main process. Desktop-started Router processes must remain attached to Electron and use parent-child IPC for graceful shutdown; do not add `detached` or `unref()`.
- Treat PID metadata and Router instance identity as abnormal-exit recovery data. Never terminate a recovered PID without matching the Router instance identity.
- Treat downstream response commitment as the failover boundary. Do not retry another vendor after headers or body bytes have reached the client.
- Register privileged renderer operations through the guarded IPC helper in `gui/electron/main.js`.

## Pull Requests

- Keep changes focused and reviewable.
- Do not commit `config.json`, logs, build output, release artifacts, API keys, or local vendor endpoints.
- Add or update tests when behavior changes.
- Keep Router behavior tests in the fast Node test files. Put tests that launch Electron or exercise desktop lifecycle behavior in `test/electron-lifecycle.test.js`.
- Run `npm run check`, `npm test`, `npm run test:electron`, and `npm run gui:build` before opening a PR.
- For tagged releases, verify the GitHub Release includes the Windows installer `.exe`, `.exe.blockmap`, and `latest.yml` so packaged apps can detect updates.

## Configuration And Secrets

Copy `config.example.json` to `config.json` for local development. Replace all placeholder tokens and keep the file private.

If a key is committed, treat it as leaked: revoke it, rotate it, and remove it from history before publishing.