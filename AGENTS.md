# Agent notes

Wix Headless site built with Astro 5 + React ("The Queue"). All data lives in Wix (Wix Data collections `queue-state`, `queue-entries`, `pass-redemptions`; Wix Stores/Ecom for the pass; Wix Forms for complaints). There is no local database.

## Running (Base44 sandbox)
- `docker compose -f docker-compose.base44.yml up -d` → Astro dev server on host port 3000 (container 4321), live reload from the bind-mounted source.
- We run `yarn astro dev` directly, not `yarn dev` (`wix dev`), because `wix dev` needs an interactive Wix login. The `@wix/astro` integration reads `WIX_CLIENT_ID`, `WIX_CLIENT_SECRET`, `WIX_CLIENT_PUBLIC_KEY`, `WIX_CLIENT_INSTANCE_ID` from the process env (what `wix env pull` would put in `.env.local`).
- `WIX_CLIENT_ID` is the public `appId` from `wix.config.json`, set in `.env.base44-defaults`. The other three come from `/run/base44/app.env`; they start as generated placeholders, so the page renders with fallback state but every `/api/*` route returns 500 until real values are supplied.

## Registry quirk
- `.yarnrc.yml` and `yarn.lock` point at Wix's internal registry (`npm.dev.wixpress.com`), unreachable outside Wix. The compose startup `sed`s the lockfile into `.yarn/yarn.base44.lock` (gitignored) with public npm URLs (including double-encoded `%252F` patch entries and the scoped `/-/@scope/` tarball path) and installs with `YARN_LOCKFILE_FILENAME` + `--immutable`. Never edit the committed `yarn.lock` for this.
- When dependencies change, commit the lockfile as usual; the rewrite runs on every container start.

## Verify
- `curl localhost:3000/` → 200, title "The Queue".
- `curl localhost:3000/api/queue/status` → JSON (500 `Unable to read the queue.` means Wix credentials are placeholders/invalid).
- `scripts/setup-*.mjs` provision Wix resources and need `yarn wix token` (Wix login); not runnable in the sandbox.
