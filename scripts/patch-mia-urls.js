import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';

// Re-extract URLs from the xlsx using the same logic the browser parser uses.
function findEOCD(view, len) {
  const minOffset = Math.max(0, len - 65557);
  for (let i = len - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error('EOCD not found');
}

async function extractEntries(buffer, wantedPaths) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const wanted = new Set(wantedPaths);
  const entries = {};
  const eocd = findEOCD(view, bytes.length);
  const cdCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  let p = cdOffset;
  for (let i = 0; i < cdCount && p + 46 < bytes.length; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const compMethod = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLenCD = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    p = p + 46 + nameLen + extraLenCD + commentLen;
    if (!wanted.has(name)) continue;
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = bytes.slice(dataStart, dataStart + compSize);
    let raw;
    if (compMethod === 0) raw = compData;
    else if (compMethod === 8) {
      const stream = new Response(compData).body.pipeThrough(new DecompressionStream('deflate-raw'));
      raw = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error('unsupported method ' + compMethod);
    entries[name] = new TextDecoder('utf-8').decode(raw);
  }
  return entries;
}

const buf = readFileSync('C:/Users/clift/Downloads/IBD bibliography_gastrohealthhub.xlsx');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const entries = await extractEntries(ab, [
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/_rels/sheet1.xml.rels',
]);
const sheet = entries['xl/worksheets/sheet1.xml'];
const rels = entries['xl/worksheets/_rels/sheet1.xml.rels'];
const rIdToUrl = {};
(rels.match(/<Relationship[^>]*\/>/g) || []).forEach((rel) => {
  const id = rel.match(/Id="([^"]+)"/);
  const type = rel.match(/Type="([^"]+)"/);
  const target = rel.match(/Target="([^"]+)"/);
  if (id && type && target && type[1].includes('/hyperlink')) rIdToUrl[id[1]] = target[1];
});
const urls = [];
const seen = new Set();
(sheet.match(/<hyperlink[^>]+\/>/g) || []).forEach((hl) => {
  const id = hl.match(/r:id="([^"]+)"/);
  const ref = hl.match(/ref="([^"]+)"/);
  if (!id || !ref) return;
  const m = /^A([0-9]+)$/.exec(ref[1]);
  if (!m || parseInt(m[1], 10) < 2) return;
  const url = rIdToUrl[id[1]];
  if (!url || seen.has(url)) return;
  seen.add(url);
  urls.push(url);
});
console.log('Extracted', urls.length, 'URLs from xlsx');

// Find and patch the rule
const ids = await kv.lrange('automation:rules:index', 0, -1);
let patched = false;
for (const id of ids) {
  const r = await kv.get('automation:rule:' + id);
  if (!r || r.name !== 'IBD Bibliography - Mia (Upload)') continue;
  const newSources = r.sources.map((s) => {
    if (s.type !== 'upload') return s;
    return {
      ...s,
      urls,
      originalFilename: 'IBD bibliography_gastrohealthhub.xlsx',
    };
  });
  await kv.set('automation:rule:' + id, {
    ...r,
    sources: newSources,
    updatedAt: new Date().toISOString(),
  });
  console.log('✓ Patched rule "' + r.name + '" with', urls.length, 'URLs');
  patched = true;
}
if (!patched) console.log('⚠ Rule not found');
