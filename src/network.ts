/**
 * Cursus Network / Auth Helpers
 * ==============================
 * Centralizes:
 *   - safe bind decisions for loopback / Tailscale / public
 *   - per-request auth enforcement
 *   - status-shape network exposure label (never leaks the token)
 *
 * No external deps. Pure functions where possible — server.ts plugs the
 * resulting middleware into Fastify.
 */

export type NetworkExposure = "loopback_only" | "tailscale_reachable" | "public_bind";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_PREFIXES = ["127.", "::ffff:127."];

export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  return LOOPBACK_PREFIXES.some(p => host.startsWith(p));
}

/**
 * Tailscale assigns IPs from 100.64.0.0/10 (CGNAT range Tailscale reserves
 * for tailnet nodes). 100.64.0.0 – 100.127.255.255.
 */
export function isTailscaleIp(host: string): boolean {
  if (!host) return false;
  const m = /^(\d+)\.(\d+)\./.exec(host);
  if (!m) return false;
  const a = Number(m[1]); const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/** Compute the network exposure label for the configured bind host. */
export function classifyBind(host: string): NetworkExposure {
  if (isLoopbackHost(host)) return "loopback_only";
  if (host === "0.0.0.0" || host === "::") return "tailscale_reachable"; // best-honest label: user almost always wants Tailscale, but technically every interface is bound; we surface this as not loopback_only and require auth.
  if (isTailscaleIp(host)) return "tailscale_reachable";
  return "public_bind";
}

export interface NetworkConfig {
  host: string;
  port: number;
  exposure: NetworkExposure;
  auth_required: boolean;          // effective decision after env + bind
  auth_token_configured: boolean;  // boolean only, never the secret
  require_auth_env: boolean | null;// raw env decision (null if unset)
  allow_loopback_skip: boolean;    // if true, loopback connections may skip auth
}

export interface NetworkEnv {
  CURSUS_HOST?: string;
  CURSUS_PORT?: string;
  CURSUS_AUTH_TOKEN?: string;
  CURSUS_REQUIRE_AUTH?: string;
  CURSUS_ALLOW_LOOPBACK_NO_AUTH?: string;
}

/**
 * Build the network config from env vars. Throws if the configuration is
 * unsafe (e.g. binding non-loopback without a token).
 */
export function loadNetworkConfig(env: NetworkEnv): NetworkConfig {
  const host = env.CURSUS_HOST ?? "127.0.0.1";
  const port = parseInt(env.CURSUS_PORT ?? "18815", 10);
  const exposure = classifyBind(host);
  const token = env.CURSUS_AUTH_TOKEN ?? "";

  const requireAuthRaw = (env.CURSUS_REQUIRE_AUTH ?? "").toLowerCase();
  const requireAuthEnv: boolean | null =
    requireAuthRaw === "true" ? true :
    requireAuthRaw === "false" ? false :
    null;

  // Loopback-skip default = true (legacy behavior). Set CURSUS_ALLOW_LOOPBACK_NO_AUTH=false
  // to require token even on loopback when a token is configured.
  const allowLoopbackSkipRaw = (env.CURSUS_ALLOW_LOOPBACK_NO_AUTH ?? "true").toLowerCase();
  const allowLoopbackSkip = allowLoopbackSkipRaw !== "false";

  if (exposure !== "loopback_only" && !token) {
    throw new Error(
      `[cursus] FATAL: bind host "${host}" (${exposure}) exposes Cursus to the network ` +
      `but CURSUS_AUTH_TOKEN is not set. Refusing to start unauthenticated on a non-loopback interface. ` +
      `Either set CURSUS_HOST=127.0.0.1 (loopback only) or provide CURSUS_AUTH_TOKEN.`,
    );
  }

  // Effective auth_required:
  // - if env CURSUS_REQUIRE_AUTH=true → always require (even on loopback when token set)
  // - if env CURSUS_REQUIRE_AUTH=false → never require (but if non-loopback bind, we already threw above unless token set; we still respect the env override IF token also set)
  // - if unset → require iff exposure != loopback_only OR token is set (legacy)
  let auth_required: boolean;
  if (requireAuthEnv === true)  auth_required = true;
  else if (requireAuthEnv === false) auth_required = !!token && exposure !== "loopback_only";
  else auth_required = !!token || exposure !== "loopback_only";

  return {
    host, port, exposure,
    auth_required,
    auth_token_configured: !!token,
    require_auth_env: requireAuthEnv,
    allow_loopback_skip: allowLoopbackSkip,
  };
}

/** Endpoints that are always reachable without a token. */
const PUBLIC_PATHS = new Set(["/health", "/version"]);

/**
 * Decide whether a given request should be allowed without a token. Returns
 * `true` when the request can pass; `false` when the auth guard should reject.
 */
export function shouldAllowRequest(opts: {
  path: string;
  remoteAddress: string | undefined;
  authHeader: string | undefined;
  cfg: NetworkConfig;
  token: string;
}): { ok: true } | { ok: false; status: number; body: { ok: false; error: string; code: string } } {
  if (PUBLIC_PATHS.has(opts.path)) return { ok: true };
  if (!opts.cfg.auth_required) return { ok: true };

  const fromLoopback = isLoopbackHost(opts.remoteAddress ?? "");
  if (fromLoopback && opts.cfg.allow_loopback_skip && opts.cfg.require_auth_env !== true) {
    return { ok: true };
  }

  if (!opts.token) {
    // Reached only when require_auth_env=true and no token: misconfiguration.
    return { ok: false, status: 503, body: {
      ok: false, code: "auth_misconfigured",
      error: "CURSUS_REQUIRE_AUTH=true but no CURSUS_AUTH_TOKEN is configured.",
    } };
  }

  if (opts.authHeader === `Bearer ${opts.token}`) return { ok: true };

  return { ok: false, status: 401, body: {
    ok: false, code: "unauthorized",
    error: "Bearer token required for this endpoint.",
  } };
}
