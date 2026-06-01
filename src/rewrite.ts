/**
 * Request URL rewrite for backward compatibility.
 *
 * Legacy /cursus/* request paths are mapped onto the canonical /toba/* routes
 * so old clients keep working after the Cursus → Toba rename. Canonical
 * /toba/* paths (and every other path) pass through unchanged.
 *
 * History: this used to do `"/toba/" + url.slice(8)` against a "/toba/" prefix
 * (6 chars), which dropped the first two characters of every /toba/* path and
 * 404'd the entire API. Keep the prefix length tied to the literal so it can
 * never drift again.
 */
const LEGACY_PREFIX = "/cursus/";
const CANONICAL_PREFIX = "/toba/";

export function rewriteRequestUrl(url: string | undefined): string {
  if (!url) return "/";
  if (url.startsWith(LEGACY_PREFIX)) {
    return CANONICAL_PREFIX + url.slice(LEGACY_PREFIX.length);
  }
  return url;
}
