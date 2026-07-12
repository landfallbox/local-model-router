# Contributing

Thanks for helping maintain Local Model Router.

## Development Setup

```powershell
git clone https://github.com/your-org/local-model-router.git
cd local-model-router
npm ci
npm run check
npm test
npm run gui:build
```

Use `npm run gui` for the desktop development app.

## Pull Requests

- Keep changes focused and reviewable.
- Do not commit `config.json`, logs, build output, release artifacts, API keys, or local vendor endpoints.
- Add or update tests when behavior changes.
- Run `npm run check`, `npm test`, and `npm run gui:build` before opening a PR.

## Configuration And Secrets

Copy `config.example.json` to `config.json` for local development. Replace all placeholder tokens and keep the file private.

If a key is committed, treat it as leaked: revoke it, rotate it, and remove it from history before publishing.