export { Session } from "./session.ts";
export { SessionRegistry } from "./registry.ts";

import { SessionRegistry, MAX_LISTED_SESSIONS, type RegistryEntry } from "./registry.ts";
import { authenticatedEmail, canAccessSession } from "./auth.ts";
import type { SessionSummary } from "./protocol.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const sessionSocketRoute = /^\/api\/sessions\/([^/]+)\/?$/;
/** Plain HTTP read of one session's summary. */
const sessionSummaryRoute = /^\/api\/session-summary\/([^/]+)\/?$/;

/** Ask each instance for its own summary. A failing object is left out rather than failing the whole list. */
async function listSessions(env: Env, request: Request): Promise<SessionSummary[]> {
  const registry = env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName(SessionRegistry.NAME));
  const response = await registry.fetch(new Request("https://internal/api/session-registry"));
  if (!response.ok) return [];
  const entries = ((await response.json()) as { sessions: { id: string; owner?: string }[] })
    .sessions;
  const caller = authenticatedEmail(request);
  const legacyOwner = env.LEGACY_OWNER_EMAIL;
  const ids = entries
    .filter(({ owner }) => canAccessSession(owner, caller, legacyOwner))
    .map(({ id }) => id)
    .slice(0, MAX_LISTED_SESSIONS);

  const results = await Promise.allSettled(
    ids.map(async (id) => {
      // `getByName` is how the app opens a session, so the list reads the same object the app uses.
      const sessionResponse = await env.SESSIONS.getByName(id).fetch(
        new Request("https://internal/api/session"),
      );
      if (!sessionResponse.ok) throw new Error(`Session answered ${sessionResponse.status}`);
      // Report the registry name, not the instance id: the landing page opens `/sessions/<name>`,
      // and `getByName(name)` resolves to this exact instance.
      return { ...((await sessionResponse.json()) as SessionSummary), sessionId: id };
    }),
  );

  const summaries: SessionSummary[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") summaries.push(result.value);
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/** Read one registry entry, to apply the owner rule before touching the session object. */
async function registryEntry(env: Env, name: string): Promise<RegistryEntry | undefined> {
  const registry = env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName(SessionRegistry.NAME));
  const response = await registry.fetch(
    new Request(`https://internal/api/session-registry/${name}`),
  );
  if (!response.ok) return undefined;
  return (await response.json()) as RegistryEntry;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/me") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      return json({ email: authenticatedEmail(request) ?? null }, 200);
    }

    // A gated URL the landing page navigates to for sign-in: Access intercepts it, and after
    // Google login the Worker sends the visitor back to the landing page.
    if (url.pathname === "/api/sign-in") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      return new Response(null, { status: 302, headers: { Location: "/" } });
    }

    if (url.pathname === "/api/sessions") {
      if (request.method === "GET")
        return json({ sessions: await listSessions(env, request) }, 200);
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
      }
      // A unique ID, so the first `get` skips the round-the-world name lookup.
      const sessionId = env.SESSIONS.newUniqueId().toString();
      const owner = authenticatedEmail(request);
      await env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName(SessionRegistry.NAME)).fetch(
        new Request("https://internal/api/session-registry", {
          method: "POST",
          body: JSON.stringify({ sessionId, ...(owner === undefined ? {} : { owner }) }),
        }),
      );
      return json({ sessionId, url: `/sessions/${sessionId}` }, 201);
    }

    const summaryMatch = sessionSummaryRoute.exec(url.pathname);
    if (summaryMatch !== null) {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      const entry = await registryEntry(env, summaryMatch[1]);
      if (!canAccessSession(entry?.owner, authenticatedEmail(request), env.LEGACY_OWNER_EMAIL)) {
        return json({ error: "This session belongs to another user" }, 403);
      }
      return env.SESSIONS.getByName(summaryMatch[1]).fetch(
        new Request("https://internal/api/session"),
      );
    }

    const sessionMatch = sessionSocketRoute.exec(url.pathname);
    if (sessionMatch !== null) {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
      }
      // Only the owner may open a session; legacy ownerless ones belong to the legacy owner email.
      const entry = await registryEntry(env, sessionMatch[1]);
      if (!canAccessSession(entry?.owner, authenticatedEmail(request), env.LEGACY_OWNER_EMAIL)) {
        return json({ error: "This session belongs to another user" }, 403);
      }
      return env.SESSIONS.getByName(sessionMatch[1]).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
