# BurgerChat

A multiplayer chat app on Cloudflare Workers, built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) running inside a Durable Object. Derived from the [`earendil-works/pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare) sample; Pi Durable is experimental, so its APIs may still change.

Live at `https://burger.burgerchat.workers.dev`.

## What you can do

- Create a durable session, send messages, fork a conversation from an earlier message.
- Reconnect without losing committed transcripts or queued prompts; sessions survive evictions via alarms.
- Inspect live task activity, and retry a task parked after repeated crashes.
- Sign in with Google (or an emailed code) and see only your own sessions.

## Architecture

- **Worker** `burger` on `burgerchat.<your-account>.workers.dev`. Static assets (React client) + Worker routes under `/api/*`.
- **`Session`** Durable Object (SQLite storage): one object per session name. Runs the Pi Durable Harness: conversations, entries, tasks, inbox. Handles the WebSocket protocol (`conversation.open/create/fork`, `prompt.submit`, `task.retry`, typing presence) and answers `GET https://internal/api/session` with its summary.
- **`SessionRegistry`** Durable Object (synchronous KV): maps session **names** to owners. A session records itself under the name it was opened with, once per instance, so sessions opened by URL appear in the list after a visit.
- `GET /api/sessions` lists sessions owned by the signed-in email; `GET /api/session-summary/<name>` reads one; `GET /api/me` answers `{ email }`; `GET /api/sign-in` is a gated URL that redirects back to the landing page after login.
- Inference runs through the Worker's own **AI binding** and the account's AI Gateway passthrough — no third-party API token or secret. Default model: `workers-ai/@cf/google/gemma-4-26b-a4b-it`.

## Authorization

Sign-in is enforced at the edge by **Cloudflare Access**, not by app code:

- A **self-hosted Access application** whose destination is `burger.burgerchat.workers.dev/api` gates every API route. The landing page and assets stay public. It must be hostname-based: worker-level Access policies reject WebSocket upgrades with 403.
- Identity providers: **Google** (OAuth client with origin `https://<team>.cloudflareaccess.com` and redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`) and Access **Email** verification. Users are admitted by an Allow policy listing their emails; add a person = add their email to the policy. If the Google OAuth client stays in test mode, also list each person as a Google test user, or publish the app.
- Inside the Worker, identity comes from the **`Cf-Access-Jwt-Assertion`** header: behind the static-assets router, `ctx.access` and `Cf-Access-Authenticated-User` are not delivered, so `src/auth.ts` decodes `custom.email` from the JWT payload. Header presence is trustworthy because unauthenticated requests never reach the Worker on gated paths.
- Session ownership: registry entries store `{ owner }`, first owner wins; non-owners get 403 on list, summary, and WebSocket open. Sessions created before sign-in existed belong to the `LEGACY_OWNER_EMAIL` var (empty hides them).

## Deploy

```sh
pnpm install
pnpm build        # vite builds worker + client into dist/; deploy ships whatever dist/ holds
pnpm exec wrangler login
pnpm exec wrangler deploy   # or pnpm deploy (build + deploy), pnpm check for the full gate
```

- Declare every Durable Object in **both** `durable_objects.bindings` and `exports` of `wrangler.jsonc`; the vite plugin keeps only declared bindings, and `exports`-only classes are dropped from the built config (and from `wrangler types`, so `tsc` fails).
- After changing `wrangler.jsonc`, regenerate types with the same flags `pnpm check` uses: `pnpm exec wrangler types --env-file .dev.vars.example --include-runtime false` (`--check` compares the recorded hash, which depends on flags), then `pnpm format`, then `pnpm check`.
- Secrets: `printf '%s' "$VALUE" | pnpm exec wrangler secret put NAME`.
- A freshly deployed `*.workers.dev` subdomain fails TLS for ~2 minutes while certificates provision.

## Renaming a Worker (Durable Object migration)

Renaming a Worker creates new, empty DO namespaces. Recipe used once, verified: token-guarded routes OUTSIDE the Access-gated `/api/*` (`/dump/<name>` GET, `/dump-list`, `/migrate/<name>` POST, `/register/<name>` POST, header `X-Migration-Token`); dump each session with `ctx.storage.sql.exec("SELECT * FROM <table> ORDER BY rowid")` over the pi-durable table list (`sqlite_master` queries are refused); restore with DELETE + parameterized INSERTs and update `durable_metadata` counters; skip `durable_schema`. Do **not** `ctx.abort` after restoring writes — an aborted execution rolls them back; the Harness reads SQLite per operation, so no restart is needed. Save dumps locally before changing the account subdomain or Worker name.

## Local development

`pnpm dev`, `pnpm test`, and `wrangler dev` need the `workerd` binary; it aborts at startup under Android PRoot (TCMalloc requires a 1 GiB-aligned mmap the ptrace shim cannot place). Run them on a normal Linux host. `pnpm check` (format, types, tsc, build, deploy --dry-run) works anywhere.

## Quota

Workers Free gives 10,000 neurons/day, reset 00:00 UTC; exhaustion returns HTTP 429 code 3036. Gemma-class models cost roughly 9,091 neurons/M input tokens and 27,273/M output. Cheaper defaults: `workers-ai/@cf/meta/llama-3.2-1b-instruct` or `workers-ai/@cf/ibm-granite/granite-4.0-h-micro`. Change the default in `src/chat.ts`.
