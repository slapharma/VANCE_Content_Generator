// scripts/carousel-preview.mjs
//
// Renders an Article Carousel locally so the slide design can be eyeballed
// without deploying. This is the gate before anything downstream: it exercises
// the real satori → resvg → jpeg-js path and the real fonts, so if the deck looks
// right here it will look right in production.
//
// Usage:
//   node scripts/carousel-preview.mjs <out-dir>                 # built-in fixture
//   node scripts/carousel-preview.mjs <out-dir> --spec <file>   # spec JSON on disk
//   node scripts/carousel-preview.mjs <out-dir> --content <id>  # live KV article
//   ...append --style relatable to any of the above (default: education)
//
// The --content form needs KV_REST_API_URL / KV_REST_API_TOKEN in the
// environment and OPENROUTER_API_KEY to write the slide copy.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCarouselSlides, planSlides } from '../lib/social/carousel-render.js';

// A representative worst case, not a flattering one: long clinical journal name,
// an em-dash title, authors with initials, and point copy at the upper end of the
// word caps — so overflow shows up here rather than in production.
const FIXTURE = {
  articleTitle: 'Vedolizumab versus adalimumab in moderately to severely active ulcerative colitis',
  heroImageUrl: 'https://images.pexels.com/photos/3735747/pexels-photo-3735747.jpeg?auto=compress&cs=tinysrgb&w=1600',
  heroImageCredit: { photographer: 'Anna Shvets', provider: 'pexels' },
  spec: {
    eyebrow: 'IBD research',
    hookTitle: 'Two biologics, one head-to-head trial — and a clear winner',
    context: {
      label: 'WHY IT MATTERS',
      body: 'Until now, choosing between these two drugs for ulcerative colitis meant comparing separate trials with different patients. This is the first time they were tested directly against each other.',
    },
    points: [
      { headline: 'Remission rates were higher at one year',
        body: 'Just over 31% of people on vedolizumab were in clinical remission at week 52, compared with roughly 22% on adalimumab — a meaningful gap in a hard-to-treat group.' },
      { headline: 'Healing showed up on endoscopy too',
        body: 'Visible healing of the bowel lining, not just symptom relief, favoured vedolizumab. That matters because mucosal healing predicts fewer flares later on.' },
      { headline: 'Steroid-free remission told the same story',
        body: 'Coming off steroids while staying well is the outcome clinicians care most about, and the same direction of benefit held there.' },
      { headline: 'Infection rates were lower, not higher',
        body: 'The better-performing drug also had fewer serious infections, which is unusual — more effective treatment often means more risk, and here it did not.' },
    ],
    evidence: {
      journal: 'The New England Journal of Medicine',
      authors: 'Sands BE, Peyrin-Biroulet L, et al.',
      year: '2019',
      studyType: 'Randomised controlled trial',
      sampleSize: 'n = 769',
    },
    cta: { label: 'READ THE FULL ARTICLE', domain: 'vancehealthhub.co.uk' },
  },
};

function parseArgs(argv) {
  const out = { outDir: null, spec: null, content: null, style: 'education' };
  const rest = argv.slice(2);
  out.outDir = rest.find((a) => !a.startsWith('--')) || null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--spec') out.spec = rest[i + 1];
    if (rest[i] === '--content') out.content = rest[i + 1];
    if (rest[i] === '--style') out.style = rest[i + 1];
  }
  return out;
}

const { outDir, spec: specPath, content: contentId, style } = parseArgs(process.argv);
if (!outDir) {
  console.error('Usage: node scripts/carousel-preview.mjs <out-dir> [--spec file.json | --content <contentId>]');
  process.exit(1);
}

let carousel = FIXTURE;
let label = 'built-in fixture';

if (specPath) {
  carousel = JSON.parse(readFileSync(specPath, 'utf8'));
  label = specPath;
} else if (contentId) {
  // Imported lazily so the fixture path needs no KV credentials.
  const { kv } = await import('../lib/kv.js');
  const { buildCarouselSpec } = await import('../lib/social/carousel-spec.js');
  const article = await kv.get(`content:${contentId}`);
  if (!article) throw new Error(`No content record for ${contentId}`);
  const built = await buildCarouselSpec({ article, style });
  carousel = {
    articleTitle: article.title,
    heroImageUrl: article.heroImageUrl,
    heroImageCredit: article.heroImageCredit,
    spec: built.spec,
    style,
  };
  label = `content:${contentId} — ${article.title}`;
  writeFileSync(join(outDir, 'spec.json'), JSON.stringify(carousel, null, 2));
} else {
  carousel = { ...FIXTURE, style };
}

mkdirSync(outDir, { recursive: true });
console.log(`rendering ${planSlides(carousel.spec, style).length} slides from ${label} (style: ${style})`);

const started = Date.now();
const slides = await renderCarouselSlides(carousel);
const elapsed = Date.now() - started;

for (const s of slides) {
  const name = `slide-${String(s.index).padStart(2, '0')}-${s.type}.jpg`;
  writeFileSync(join(outDir, name), s.buffer);
  console.log(`  ${name.padEnd(28)} ${(s.buffer.length / 1024).toFixed(0).padStart(4)} KB`);
}

const totalKb = slides.reduce((n, s) => n + s.buffer.length, 0) / 1024;
console.log(`\n${slides.length} slides in ${elapsed} ms (${Math.round(elapsed / slides.length)} ms/slide), ${totalKb.toFixed(0)} KB total`);
console.log(`→ ${outDir}`);
