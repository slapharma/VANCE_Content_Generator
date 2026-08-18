/**
 * Outbound-URL vetting for the two endpoints that fetch a caller-supplied URL,
 * /api/fetch-url and /api/proxy-image.
 *
 * Both took any http/https URL, followed redirects and returned the response,
 * with no authentication — a server-side request forgery primitive and an open
 * proxy on the project's own bandwidth. The image one also set
 * `Access-Control-Allow-Origin: *`, so any page on the internet could hotlink
 * through it.
 *
 * Three things have to be true, and the third is the one a naive check misses:
 *
 *   1. The scheme is http or https (no file:, gopher:, data:).
 *   2. The host does not resolve into private, loopback, link-local or
 *      carrier-grade-NAT space — 169.254.169.254 is cloud metadata, and
 *      127.0.0.1 / 10.x / 192.168.x reach anything else sharing the network.
 *   3. That stays true after every redirect. Validating only the URL the caller
 *      supplies is defeated by a public host that 302s to 127.0.0.1, so
 *      redirects are followed manually and each hop is re-checked.
 *
 * DNS is resolved and the resulting addresses checked, rather than pattern
 * matching the hostname, because `localtest.me` and friends are public names
 * that resolve to 127.0.0.1.
 *
 * This is not a defence against a determined attacker with DNS control — a name
 * that passes the check and then re-resolves to a private address between our
 * lookup and the fetch (DNS rebinding) still gets through, which cannot be
 * closed without pinning the socket to the address we validated. It does close
 * the whole class of trivially-supplied internal URLs, and the endpoints now
 * require a session, so an attacker has to be signed in first.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_REDIRECTS = 5;

/** Private / loopback / link-local / CGNAT / documentation ranges. */
function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // RFC1918
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;         // RFC1918
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                       // multicast + reserved + broadcast
  return false;
}

function isPrivateV6(ip) {
  const s = ip.toLowerCase().split('%')[0];
  if (s === '::' || s === '::1') return true;                 // unspecified / loopback
  if (s.startsWith('fe80') || s.startsWith('fec0')) return true; // link/site-local
  if (/^f[cd]/.test(s)) return true;                          // unique-local fc00::/7
  if (s.startsWith('::ffff:')) {                              // IPv4-mapped
    const v4 = s.slice(7);
    return isIP(v4) === 4 ? isPrivateV4(v4) : true;
  }
  return false;
}

export function isPrivateAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return true; // not an address we can reason about — refuse
}

/**
 * Parse and vet a single URL. Throws with a caller-safe message on rejection.
 * Exported so a hop mid-redirect gets exactly the same treatment as hop zero.
 */
export async function assertSafeUrl(raw, { resolveDns = lookup } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // A literal address needs no lookup; a name does.
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('URL resolves to a private address');
    return url;
  }

  let addrs;
  try {
    addrs = await resolveDns(host, { all: true });
  } catch {
    throw new Error('Could not resolve host');
  }
  if (!addrs?.length) throw new Error('Could not resolve host');
  // Every answer must be public: a name with one public and one private A
  // record would otherwise be a coin flip at connect time.
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error('URL resolves to a private address');
  }
  return url;
}

/**
 * fetch() with every hop vetted. Redirects are followed by hand because
 * `redirect: 'follow'` would chase a 302 into private space without asking.
 */
export async function safeFetch(raw, init = {}, { fetchFn = fetch, resolveDns = lookup } = {}) {
  let url = await assertSafeUrl(raw, { resolveDns });

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(url.href, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return { res, url };

    const location = res.headers.get('location');
    if (!location) return { res, url };
    url = await assertSafeUrl(new URL(location, url).href, { resolveDns });
  }
  throw new Error('Too many redirects');
}
