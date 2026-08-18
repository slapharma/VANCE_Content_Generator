/**
 * Guards the two HTML-escaping helpers in index.html and the rule that decides
 * which one to use.
 *
 * Background: index.html carried two escapers. escHtml() escaped & < > " ' and
 * was null-safe; escapeHtml() escaped only & < > " . Anywhere the second one's
 * output landed inside a single-quoted JS string in an event handler —
 *
 *     onclick="openScheduleModal('id','Crohn's Disease','gastro')"
 *
 * — the handler failed to compile and the button silently did nothing. Three of
 * the 57 articles in the production backup have an apostrophe in the title, so
 * "Schedule Post" was dead for roughly 5% of the library with no visible error.
 *
 * escHtml is not the fix on its own: the HTML parser decodes &#39; back to '
 * before JS ever sees the attribute, so it fails identically. jsAttr() exists
 * for that position and backslash-escapes instead.
 *
 * These tests read index.html rather than a copy of it, so they keep tracking
 * the real code.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');

/** Pull a named function's source out of index.html and make it callable. */
function extractFn(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found in index.html`);
  let depth = 0, i = HTML.indexOf('{', start);
  const open = i;
  for (; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) break;
  }
  const body = HTML.slice(open + 1, i);
  return new Function('str', body);
}

const escHtml = extractFn('escHtml');
const jsAttr = extractFn('jsAttr');

/**
 * What a browser does to a double-quoted attribute value before handing it to
 * the JS parser: character references are decoded.
 */
function decodeAttr(v) {
  return v
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('escHtml escapes apostrophes and is null-safe', () => {
  assert.equal(escHtml("Crohn's"), 'Crohn&#39;s');
  assert.equal(escHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
});

test('the escapeHtml duplicate is gone', () => {
  // It escaped neither ' nor null, and 143 call sites could not tell the two
  // apart by name. Reintroducing it reopens the whole class.
  assert.ok(!HTML.includes('escapeHtml'), 'escapeHtml reappeared in index.html');
});

test('jsAttr survives the HTML-attribute decode that defeats escHtml', () => {
  const title = "Crohn's Disease";

  // escHtml is correct for HTML text, and wrong in this position: the decode
  // step hands the JS parser a broken string literal.
  const viaEsc = decodeAttr(`openScheduleModal('id','${escHtml(title)}','gastro')`);
  assert.throws(() => new Function(viaEsc), SyntaxError,
    'escHtml should NOT be usable inside a single-quoted JS string');

  const viaJsAttr = decodeAttr(`openScheduleModal('id','${jsAttr(title)}','gastro')`);
  assert.doesNotThrow(() => new Function(viaJsAttr));
});

test('jsAttr handles the other characters that break out of the literal', () => {
  for (const nasty of ["it's", 'back\\slash', 'line\nbreak', '</script>', 'quote"d', "';alert(1);'"]) {
    const src = decodeAttr(`f('${jsAttr(nasty)}')`);
    assert.doesNotThrow(() => new Function(src), `jsAttr failed to neutralise ${JSON.stringify(nasty)}`);
  }
});

test('no handler attribute interpolates human-authored text without jsAttr', () => {
  // Article titles, person names, category labels and prompt names all reach
  // the UI from a human keyboard, so all of them can carry an apostrophe.
  const HUMAN = /title|name|label|email|author|headline|caption|topic|subject|prompt|desc|\btext\b/i;
  const ATTR = /on(?:click|change|input|keyup|keydown|submit|dblclick|focus|blur)=\\?"(.*?)\\?"(?=[\s>])/g;
  const INTERP = /\$\{([^{}]+)\}/g;

  const offenders = [];
  for (const line of HTML.split('\n')) {
    for (const [, body] of line.matchAll(ATTR)) {
      // Only interpolations sitting inside a quoted JS string argument matter.
      if (!/\('|,\s*'/.test(body)) continue;
      for (const [, expr] of body.matchAll(INTERP)) {
        if (HUMAN.test(expr) && !expr.includes('jsAttr(')) offenders.push(expr.trim());
      }
    }
  }
  assert.deepEqual(offenders, [],
    'these must be wrapped in jsAttr(), not escHtml() or raw:\n  ' + offenders.join('\n  '));
});
