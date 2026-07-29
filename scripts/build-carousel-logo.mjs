// scripts/build-carousel-logo.mjs
//
// Turns the supplied logojpg.jpg into the two transparent PNGs the carousel slides
// use, and writes lib/social/assets/logo.js.
//
// The work here exists because the source is a JPEG: teal on an opaque white
// background, no alpha channel. To sit the mark directly on a slide (rather than in
// a white box) three things have to happen:
//
//   1. **Key the white to alpha.** Distance-from-white gives the coverage: a pixel
//      that is pure white is background, a saturated teal pixel is ink, and the
//      anti-aliased pixels in between get partial alpha.
//   2. **Unpremultiply.** An edge pixel is teal blended *with white*. Keeping that
//      blended colour at partial alpha looks right over a light ground but leaves a
//      pale halo over a dark one. Recovering the true ink colour removes it.
//   3. **Two colour variants.** The mark's teal (#006868-ish) is unreadable on the
//      navy slides, both being dark. LIGHT remaps the dark teal to white and the
//      light teal to the brand accent, keeping the two-tone treatment.
//
// PNG (not JPEG) because only PNG carries the alpha channel, and it is hand-encoded
// below rather than pulling in a dependency: zlib is built into Node and the format
// is a signature plus three chunks.
//
// Usage: node scripts/build-carousel-logo.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'logojpg.jpg');
const OUT = join(REPO, 'lib', 'social', 'assets', 'logo.js');

// Any channel below this counts as ink for the purposes of finding the crop box.
const INK_THRESHOLD = 240;
// Alpha gain on distance-from-white. At 2.0 both brand teals reach full opacity
// while genuine anti-aliased edges keep a partial value.
const ALPHA_GAIN = 2.0;

const BRAND = {
  // The two inks in the source, and what each becomes in the light variant.
  darkTeal: [0x00, 0x68, 0x68],
  accent:   [0x4d, 0xbd, 0xbd],
  white:    [0xff, 0xff, 0xff],
};

// ── minimal PNG encoder (RGBA8) ─────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Buffer} rgba - width*height*4 @returns {Buffer} a complete PNG */
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type 6 = RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 (None) keeps this simple and
  // still compresses well on flat-colour artwork.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── decode + crop ───────────────────────────────────────────────────────────
const src = jpeg.decode(readFileSync(SRC), { useTArray: true });
const { data, width: sw, height: sh } = src;

let minX = sw; let minY = sh; let maxX = -1; let maxY = -1;
for (let y = 0; y < sh; y++) {
  for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4;
    if (Math.min(data[i], data[i + 1], data[i + 2]) < INK_THRESHOLD) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) throw new Error(`${SRC} looks blank`);

const cw = maxX - minX + 1;
const ch = maxY - minY + 1;
console.log(`source ${sw}x${sh} → cropped ${cw}x${ch} (aspect ${(cw / ch).toFixed(3)})`);

// ── key the white out ───────────────────────────────────────────────────────
/**
 * @param {boolean} light - remap the inks for dark slide grounds
 */
function build(light) {
  const out = Buffer.alloc(cw * ch * 4);
  // Midpoint luminance between the two brand teals, used to decide which ink a
  // pixel belongs to when remapping.
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const midLum = (lum(BRAND.darkTeal) + lum(BRAND.accent)) / 2;

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = ((minY + y) * sw + (minX + x)) * 4;
      const d = (y * cw + x) * 4;
      const r = data[s]; const g = data[s + 1]; const b = data[s + 2];

      // Coverage from distance-to-white in the most-affected channel.
      const dist = Math.max(255 - r, 255 - g, 255 - b);
      let a = Math.min(255, Math.round(dist * ALPHA_GAIN));
      if (a === 0) { out[d + 3] = 0; continue; }

      // Unpremultiply against white to recover the true ink, which is what stops
      // edge pixels reading as a pale halo on the dark slides.
      const af = a / 255;
      const un = (c) => Math.max(0, Math.min(255, Math.round((c - 255 * (1 - af)) / af)));
      let [rr, gg, bb] = [un(r), un(g), un(b)];

      // Snap fully-opaque pixels to an exact brand ink. Two reasons: JPEG
      // compression leaves thousands of near-identical colours across areas that
      // should be flat, which both drifts the brand teals and defeats PNG's
      // compression (it cost ~3x the file size before this). Partially-transparent
      // edge pixels are left alone so anti-aliasing survives.
      const isDarkInk = lum([rr, gg, bb]) < midLum;
      if (light) {
        [rr, gg, bb] = isDarkInk ? BRAND.white : BRAND.accent;
      } else if (a === 255) {
        [rr, gg, bb] = isDarkInk ? BRAND.darkTeal : BRAND.accent;
      }

      out[d] = rr; out[d + 1] = gg; out[d + 2] = bb; out[d + 3] = a;
    }
  }
  return encodePng(out, cw, ch);
}

const variants = [
  { name: 'LOGO_DARK_B64', label: 'original teals, for the light (paper) slides', png: build(false) },
  { name: 'LOGO_LIGHT_B64', label: 'white + accent, for the navy and photo slides', png: build(true) },
];

function wrapB64(s) {
  const lines = [];
  for (let i = 0; i < s.length; i += 120) lines.push(`  '${s.slice(i, i + 120)}'`);
  return lines.join(' +\n');
}

const blocks = variants.map((v) => {
  const b64 = Buffer.from(v.png).toString('base64');
  console.log(`${v.name}: ${v.png.length} B PNG (${b64.length} b64 chars) — ${v.label}`);
  return { ...v, b64 };
});

const moduleSrc = `// lib/social/assets/logo.js
//
// GENERATED by scripts/build-carousel-logo.mjs — do not hand-edit.
//
// The Vance mark for the Article Carousel slides: logojpg.jpg with its white
// margins trimmed and its white background keyed out to alpha, as transparent
// base64 PNGs.
//
// Two variants because the source ink is teal, which is unreadable against the
// navy and photo slides (both dark). DARK keeps the original teals for the paper
// slides; LIGHT remaps the darker ink to white and the lighter to the brand accent
// so the two-tone treatment survives on dark grounds.
//
// Edge pixels are unpremultiplied against white during keying, which is what stops
// the anti-aliased outline reading as a pale halo on the dark slides.
//
// Inlined rather than read from disk: Vercel's bundler does not reliably trace
// runtime fs reads, and a plain import always ships with the function.
//
// Regenerate after any logo change: node scripts/build-carousel-logo.mjs

${blocks.map((b) => `const ${b.name} =\n${wrapB64(b.b64)};`).join('\n\n')}

/** Aspect ratio of the trimmed mark, so callers size by height alone. */
export const LOGO_ASPECT = ${(cw / ch).toFixed(4)};

export const LOGO_DARK = \`data:image/png;base64,\${LOGO_DARK_B64}\`;
export const LOGO_LIGHT = \`data:image/png;base64,\${LOGO_LIGHT_B64}\`;

/**
 * Pick the variant that stays legible on a given slide ground.
 * @param {boolean} onInk - true for the navy and photo slides, false for paper
 */
export const logoFor = (onInk) => (onInk ? LOGO_LIGHT : LOGO_DARK);
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, moduleSrc);
console.log(`wrote ${OUT}`);
