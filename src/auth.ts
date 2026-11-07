/** Cloudflare Access attaches these headers to requests it authenticated; requests without a valid
 * sign-in never reach the Worker on gated paths (`/api/*` behind a hostname-based Access app).
 * Behind the static-assets router only the JWT header arrives, so the email is read from its payload. */
export const authenticatedEmail = (request: Request): string | undefined => {
  const header = request.headers.get("Cf-Access-Authenticated-User");
  if (header !== null && header.length > 0) return header.toLowerCase();
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  return jwt === null ? undefined : emailFromAccessJwt(jwt);
};

/** Decode the Access JWT payload. Signature validation is intentionally omitted: gated paths let
 * authenticated requests through the edge, and Cloudflare replaces incoming Access headers. */
function emailFromAccessJwt(jwt: string): string | undefined {
  try {
    const payload = jwt.split(".")[1];
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as { custom?: { email?: unknown }; email?: unknown };
    const email = claims.custom?.email ?? claims.email;
    return typeof email === "string" && email.length > 0 ? email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `caller` may see or open a session.
 * A session with an owner belongs to that email. A session with no owner predates sign-in,
 * so only the legacy owner (the account holder's email) may reach it; an empty legacy owner hides it.
 */
export const canAccessSession = (
  owner: string | undefined,
  caller: string | undefined,
  legacyOwnerEmail: string,
): boolean => {
  if (caller === undefined) return false;
  if (owner === undefined) return legacyOwnerEmail.length > 0 && caller === legacyOwnerEmail;
  return caller === owner;
};
