import { OAuth2Client } from "google-auth-library";
import type { MiddlewareHandler } from "hono";
import { log } from "../util/logger";

/** Verifies an IAP assertion and returns the signed-in user's email. Throws if it isn't valid. */
export type IapVerifier = (assertion: string) => Promise<string>;

export type AuthEnv = { Variables: { user: string } };

const IAP_ISSUER = "https://cloud.google.com/iap";
const KEYS_TTL_MS = 60 * 60_000;

/**
 * IAP signs every request it lets through with a JWT in x-goog-iap-jwt-assertion.
 * Checking it means a request that somehow bypassed IAP is still rejected.
 * See https://cloud.google.com/iap/docs/signed-headers-howto
 */
export function createIapVerifier(audience: string): IapVerifier {
  const client = new OAuth2Client();
  let keys: { value: Record<string, string>; expiresAt: number } | undefined;

  return async (assertion) => {
    if (!keys || keys.expiresAt <= Date.now()) {
      const res = await client.getIapPublicKeys();
      keys = { value: res.pubkeys, expiresAt: Date.now() + KEYS_TTL_MS };
    }
    const ticket = await client.verifySignedJwtWithCertsAsync(assertion, keys.value, audience, [IAP_ISSUER]);
    const email = ticket.getPayload()?.email;
    if (!email) throw new Error("IAP assertion has no email");
    return email;
  };
}

/** Rejects requests without a valid IAP assertion. `verifier` null disables the check (local dev). */
export function requireIap(verifier: IapVerifier | null): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!verifier) {
      c.set("user", "local-dev");
      return next();
    }
    const assertion = c.req.header("x-goog-iap-jwt-assertion");
    if (!assertion) return c.json({ error: "Unauthorized" }, 401);
    try {
      c.set("user", await verifier(assertion));
    } catch (err) {
      log.warn("Rejected IAP assertion", { err });
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  };
}

/**
 * The API is only meant for the SPA served from the same origin. Browsers mark requests from
 * other sites with Sec-Fetch-Site; reject those. Requests without the header (curl, tests) pass,
 * since IAP has already authenticated them.
 */
export function sameOriginOnly(): MiddlewareHandler {
  return async (c, next) => {
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  };
}
