## What and why

<!-- What does this change, and why? Link related issues: "Fixes #123". -->

## How I tested it

<!-- Commands you ran, views you checked in demo mode, devices/browsers. Screenshots for UI changes. -->

## Checklist

- [ ] `npm test` and `npm run check` pass
- [ ] New behaviour or bug fixes have tests (when testable without herdr/Claude)
- [ ] UI changes checked with `npm run demo` in **EN and TR**, at phone width
- [ ] New UI strings are in `web/public/i18n.js` in **both** languages
- [ ] New settings are in `agent/config.mjs` / the top of `web/server.mjs`, the `.env.example` files and `docs/CONFIGURATION.md`
- [ ] New error codes follow the `{error, code}` contract and are listed in `docs/API.md`
- [ ] Docs and `CHANGELOG.md` (`[Unreleased]`) updated where relevant
- [ ] No new runtime dependencies
- [ ] Tests and scripts make no sound (headless browsers muted with `--mute-audio` and audio stubs; no `say`/TTS playback)
- [ ] No personal data, secrets or runtime files (`.env`, `dispatcher/brain/`, `state/`, `logs/`)
