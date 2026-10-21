// api/automation/rules-wizard-wp-category.test.js
//
// The automation rule wizard (index.html `_wizSubmit()`) must forward a WP
// category-slug override for the rule's chosen category, the same way manual
// generation does (`queueCurrentForPublishing()` reads `getCatConfig(catId)
// .wpCategorySlug`). Without it, a rule always saves `wpCategorySlug: null`
// (or omits the field entirely) and every automation-generated article for
// that category falls back forever to the hardcoded default in
// `CATEGORY_SLUG_MAP` (api/publish/index.js) — so fixing a category's WP slug
// in the Categories editor (e.g. after the term is renamed on the WP site)
// only ever reaches manual publishing, never automation.
//
// This test extracts the REAL payload-construction snippet out of the live
// `_wizSubmit()` source in index.html (not a re-implementation of it) and
// executes it against a stub DOM, so it reflects whatever index.html actually
// does today.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'),
  'utf8'
);

// Pull out the literal `_wizSubmit` function body so the test runs the actual
// shipped source, then isolate just the `var payload = { ... };` construction
// inside it (brace-counted, not regex-guessed, since the object nests further
// object/array/function literals of its own).
function extractWizSubmitPayloadSnippet(source) {
  const fnStart = source.indexOf('async function _wizSubmit()');
  assert.ok(fnStart !== -1, '_wizSubmit() not found in index.html — has it been renamed?');

  const payloadStart = source.indexOf('var payload = {', fnStart);
  assert.ok(payloadStart !== -1, 'var payload = {...} not found inside _wizSubmit()');

  // Also grab everything between the function start and the payload literal,
  // so any local vars the payload depends on (wizCatId, wizCatCfg, …) are
  // executed first exactly as written.
  const preludeStart = fnStart + 'async function _wizSubmit()'.length;
  const bodyOpenBrace = source.indexOf('{', preludeStart);
  const prelude = source.slice(bodyOpenBrace + 1, payloadStart);

  let depth = 0;
  let i = payloadStart + 'var payload = '.length; // points at the opening '{'
  const objStart = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const payloadLiteral = source.slice(objStart, i); // includes the closing '}'
  // Wrapped in a function so the prelude's early-return guard (email
  // notifications enabled with no recipients picked) stays valid syntax.
  return `(function(){\n${prelude}\nvar payload = ${payloadLiteral};\nreturn payload;\n})()`;
}

function runWizSubmitPayload(source, { categoryId, catConfig }) {
  const snippet = extractWizSubmitPayloadSnippet(source);

  const elements = {
    wizEmailEnabled: { checked: false },
    wizHour: { value: '7' },
    wizName: { value: 'Test Industry News Rule' },
    wizCategory: { value: categoryId },
    wizMinGap: { value: '4' },
    wizTemplate: { value: categoryId },
    wizMaxArticles: { value: '3' },
    wizSubCategorySelect: { value: '' },
    wizModel: { value: '' },
    wizHeroImage: { checked: false },
    wizHeroImageFallback: { value: '' },
    wizArticleCarousel: { checked: false },
    wizCarouselSlides: { value: '8' },
    wizCarouselDelayHours: { value: '24' },
    wizCarouselStyle: { value: 'education' },
    wizCarouselAccount: { value: '' },
    wizTimeoutHours: { value: '48' },
    wizOnTimeout: { value: 'urgent_reminder' },
    wizTgEnabled: { checked: false },
    wizTgChatId: { value: '' },
    wizTgApprove: { checked: false },
    wizEmailApprove: { checked: false },
  };

  const sandbox = {
    document: {
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
    },
    getCatConfig: (id) => (id === categoryId ? catConfig : null),
    _wizSources: [],
    _wizEmails: [],
    _wizEmailUserIds: [],
    _wizBuildCron: () => '0 7 * * 1',
    console,
    assert: undefined,
  };
  vm.createContext(sandbox);
  return vm.runInContext(snippet, sandbox);
}

describe('automation rule wizard payload — WP category slug', () => {
  it('forwards the category-editor WP slug override, mirroring manual generation', () => {
    // Simulates an operator having corrected the "Industry News" WP category
    // slug in the Categories editor (getCatConfig) after the WP-side term was
    // renamed — exactly the kind of fix that needs to reach automation too.
    const catConfig = { id: 'industry-news', wpCategorySlug: 'healthcare-news-v2' };
    const payload = runWizSubmitPayload(html, { categoryId: 'industry-news', catConfig });

    assert.equal(payload.category, 'industry-news');
    assert.equal(
      payload.wpCategorySlug,
      'healthcare-news-v2',
      '_wizSubmit() must send the category\'s configured WP slug override on the rule, ' +
      'not leave automation stuck on the hardcoded CATEGORY_SLUG_MAP default forever'
    );
  });

  it('falls back to null when the category has no override configured', () => {
    const payload = runWizSubmitPayload(html, {
      categoryId: 'industry-news',
      catConfig: { id: 'industry-news' }, // no wpCategorySlug/wpSlug set
    });
    assert.equal(payload.wpCategorySlug, null);
  });
});
