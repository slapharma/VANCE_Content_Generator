import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateAddress, assertSafeUrl, safeFetch } from './safe-fetch.js';

/** Stub resolver so no test touches real DNS. */
const dns = (map) => async (host) => {
  if (!(host in map)) throw new Error('ENOTFOUND');
  return map[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('private, loopback, link-local and CGNAT space is refused', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', // cloud metadata
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`);
  }
});

test('ordinary public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
  }
});

test('non-http schemes are refused', async () => {
  for (const u of ['file:///etc/passwd', 'gopher://x/', 'data:text/html,hi', 'ftp://x/']) {
    await assert.rejects(() => assertSafeUrl(u), /Only http\/https/);
  }
});

test('a public hostname that resolves to loopback is refused', async () => {
  // The reason this checks DNS rather than the hostname string: localtest.me
  // and nip.io are public names that resolve into private space.
  await assert.rejects(
    () => assertSafeUrl('http://localtest.me/', { resolveDns: dns({ 'localtest.me': ['127.0.0.1'] }) }),
    /private address/,
  );
});

test('a name with one public and one private answer is refused', async () => {
  await assert.rejects(
    () => assertSafeUrl('http://mixed.example/', { resolveDns: dns({ 'mixed.example': ['93.184.216.34', '10.0.0.5'] }) }),
    /private address/,
  );
});

test('a literal metadata IP is refused without any lookup', async () => {
  await assert.rejects(
    () => assertSafeUrl('http://169.254.169.254/latest/meta-data/', {
      resolveDns: async () => { throw new Error('DNS must not be consulted'); },
    }),
    /private address/,
  );
});

test('a public host is allowed', async () => {
  const url = await assertSafeUrl('https://example.com/a?b=c', {
    resolveDns: dns({ 'example.com': ['93.184.216.34'] }),
  });
  assert.equal(url.host, 'example.com');
});

test('a redirect into private space is refused', async () => {
  // This is the hop the original code missed entirely: it passed
  // redirect: 'follow' to fetch(), so a public host could 302 to 127.0.0.1 and
  // the validated first URL told you nothing.
  const resolveDns = dns({ 'evil.example': ['93.184.216.34'], 'localtest.me': ['127.0.0.1'] });
  const fetchFn = async () => ({
    status: 302,
    headers: { get: (h) => (h === 'location' ? 'http://localtest.me/admin' : null) },
  });
  await assert.rejects(
    () => safeFetch('https://evil.example/', {}, { fetchFn, resolveDns }),
    /private address/,
  );
});

test('a redirect to another public host is followed', async () => {
  const resolveDns = dns({ 'a.example': ['93.184.216.34'], 'b.example': ['1.1.1.1'] });
  let seen = 0;
  const fetchFn = async (href) => {
    seen++;
    if (href.startsWith('https://a.example')) {
      return { status: 302, headers: { get: (h) => (h === 'location' ? 'https://b.example/final' : null) } };
    }
    return { status: 200, headers: { get: () => null } };
  };
  const { res, url } = await safeFetch('https://a.example/', {}, { fetchFn, resolveDns });
  assert.equal(res.status, 200);
  assert.equal(url.href, 'https://b.example/final');
  assert.equal(seen, 2);
});

test('a redirect loop terminates', async () => {
  const resolveDns = dns({ 'loop.example': ['93.184.216.34'] });
  const fetchFn = async () => ({
    status: 302,
    headers: { get: (h) => (h === 'location' ? 'https://loop.example/again' : null) },
  });
  await assert.rejects(
    () => safeFetch('https://loop.example/', {}, { fetchFn, resolveDns }),
    /Too many redirects/,
  );
});

test('an unresolvable host is refused rather than attempted', async () => {
  await assert.rejects(
    () => assertSafeUrl('http://nope.invalid/', { resolveDns: dns({}) }),
    /Could not resolve host/,
  );
});
