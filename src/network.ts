/**
 * Toba Network Helpers
 * ====================
 * Centralizes safe bind decisions for loopback / Tailscale / public
 * and status-shape network exposure labels.
 *
 * No external deps. Pure functions — server.ts uses the resulting config.
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
  if (host === "0.0.0.0" || host === "::") return "tailscale_reachable";
  if (isTailscaleIp(host)) return "tailscale_reachable";
  return "public_bind";
}

export interface NetworkConfig {
  host: string;
  port: number;
  exposure: NetworkExposure;
}

export interface NetworkEnv {
  TOBA_HOST?: string;
  TOBA_PORT?: string;
  // Backward-compat aliases
  CURSUS_HOST?: string;
  CURSUS_PORT?: string;
}

/**
 * Build the network config from env vars.
 * TOBA_* preferred, CURSUS_* accepted as fallback.
 */
export function loadNetworkConfig(env: NetworkEnv): NetworkConfig {
  const host = env.TOBA_HOST ?? env.CURSUS_HOST ?? "127.0.0.1";
  const port = parseInt(env.TOBA_PORT ?? env.CURSUS_PORT ?? "18815", 10);
  const exposure = classifyBind(host);

  return { host, port, exposure };
}
