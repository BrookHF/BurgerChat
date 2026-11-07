import { DurableObject } from "cloudflare:workers";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

/** How many sessions one list request reads. Kept small, because the whole read runs inside one Worker request. */
export const MAX_LISTED_SESSIONS = 50;

/** Who a session belongs to. `owner` stays undefined for sessions predating sign-in. */
export type RegistryEntry = { owner?: string };

const registryNameRoute = /^\/api\/session-registry\/([^/]+)\/?$/;

/** One object per namespace that records every session name with its owner, so a list request can find them. */
export class SessionRegistry extends DurableObject {
  /** Registry object name. A session records itself under this name on open. */
  static readonly NAME = "registry";

  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      const body = (await request.json()) as { sessionId?: unknown; owner?: unknown };
      if (typeof body.sessionId !== "string") return json({ error: "sessionId required" }, 400);
      if (body.owner !== undefined && typeof body.owner !== "string") {
        return json({ error: "owner must be a string" }, 400);
      }
      // Synchronous KV keeps this bookkeeping out of the SQLite hot path of chat objects.
      // The first recorded owner wins: a legacy entry stays legacy even if it is opened again.
      const existing = await this.ctx.storage.kv.get<RegistryEntry | true>(body.sessionId);
      const owner =
        typeof existing === "object" && existing !== null && existing.owner !== undefined
          ? existing.owner
          : body.owner;
      this.ctx.storage.kv.put(body.sessionId, owner === undefined ? {} : { owner });
      return json({ ok: true }, 200);
    }
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    const nameMatch = registryNameRoute.exec(new URL(request.url).pathname);
    if (nameMatch !== null) {
      const entry = await this.ctx.storage.kv.get<RegistryEntry | true>(nameMatch[1]);
      const owner = typeof entry === "object" && entry !== null ? entry.owner : undefined;
      return json({ id: nameMatch[1], owner }, 200);
    }

    const sessions = [
      ...this.ctx.storage.kv.list<RegistryEntry | true>({ limit: MAX_LISTED_SESSIONS }),
    ].map(([id, value]) => ({
      id,
      owner: typeof value === "object" && value !== null ? value.owner : undefined,
    }));
    return json({ sessions }, 200);
  }
}
