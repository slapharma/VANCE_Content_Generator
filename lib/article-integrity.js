// lib/article-integrity.js
//
// Deterministic checks on a generated Clinical Review before it can reach the
// review queue. A prompt asks the model to behave; these checks do not.

// "[Journal name, year, volume, pages as published]", "[insert DOI]", "TBC" ...
// Bracketed template text. No digits allowed inside, so a real "[DOI: 10.1000/x]"
// or "[PMID 123456]" is not flagged. A markdown link "[text](url)" is not flagged.
const PLACEHOLDER_BRACKET =
  /\[[^\]\d\n]{0,100}\b(journal|year|volume|pages?|insert|tbc|tbd|todo|placeholder|as published)\b[^\]\d\n]{0,100}\](?!\()/i;
// A bare one-word field name in brackets: "[DOI]", "[Authors]".
const PLACEHOLDER_FIELD = /\[(?:doi|pmid|authors?|year|journal|volume|pages?)\](?!\()/i;
const PLACEHOLDER_WORD = /\b(?:TBC|TBD|TODO|XXXX+)\b|\blorem ipsum\b/i;

// Combining marks U+0300 to U+036F, built from code points so the source holds no invisible characters.
const MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');

// Letters with no Unicode decomposition, so NFD alone leaves them untouched.
// Keys are code points (0x142 = l with stroke, 0xf8 = o with stroke, 0x111 = d with stroke, 0xdf = sharp s).
const UNDECOMPOSED = { [String.fromCharCode(0x142)]: 'l', [String.fromCharCode(0xf8)]: 'o', [String.fromCharCode(0x111)]: 'd', [String.fromCharCode(0xdf)]: 'ss' };

function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(MARKS, '')
    .replace(/./g, c => UNDECOMPOSED[c] ?? c);
}

// Folded text as space-separated words, for whole-word matching.
function words(s) {
  return ` ${fold(s).replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** First author's surname from a stored author string such as "Karłowicz K". */
export function firstSurname(authors) {
  const first = Array.isArray(authors) ? authors[0] : String(authors || '').split(',')[0];
  return String(first || '').trim().split(/\s+/)[0] || '';
}

/**
 * Returns a list of problems. An empty list means the article may proceed.
 * `paper` is the stored bibliography record (doi, authors, pmid) when the
 * article came from a bibliography source; omit it for other sources.
 */
export function checkArticleIntegrity(body, paper = null) {
  const problems = [];
  const text = String(body || '');

  const ph = text.match(PLACEHOLDER_BRACKET) || text.match(PLACEHOLDER_FIELD) || text.match(PLACEHOLDER_WORD);
  if (ph) problems.push(`placeholder text left in the article: "${ph[0].slice(0, 80)}"`);

  if (paper) {
    const lower = text.toLowerCase();
    if (paper.doi && !lower.includes(String(paper.doi).toLowerCase())) {
      problems.push(`the reference does not carry the source paper's DOI (${paper.doi})`);
    }
    const surname = firstSurname(paper.authors);
    // PubMed stores "Surname Initials"; a manual entry may read "Given Surname".
    // Accept either end of the first author's name. Whole-word match, so the
    // surname "Li" does not pass on the word "clinical".
    const first = Array.isArray(paper.authors) ? paper.authors[0] : String(paper.authors || '').split(',')[0];
    const tokens = String(first || '').trim().split(/\s+/).filter(Boolean);
    // The last token counts only when it is longer than an initial: "Smith J" must not
    // pass on the letter "J" in "J Crohns Colitis". The first token always counts ("Li", "Wu").
    const last = tokens[tokens.length - 1];
    const candidates = [...new Set([tokens[0], last && last.length >= 3 ? last : null].filter(Boolean))];
    const haystack = words(text);
    if (candidates.length && !candidates.some(t => haystack.includes(words(t)))) {
      problems.push(`the reference does not name the source paper's first author (${surname})`);
    }
  }
  return problems;
}

/**
 * Rules appended to the prompt for bibliography items. Appended in code, not
 * stored in a prompt preset, so a custom or master prompt cannot drop them.
 */
export function buildSourceGuard(item) {
  const abstractOnly = item.sourceHasFullText ? '' : `
- Only the abstract was supplied, not the full text. Leave out anything an abstract cannot support: the number of centres, full exclusion criteria, secondary endpoints it does not name, and adverse-event detail it does not report.`;
  return `

=== SOURCE RULES (these override every other instruction above) ===
- Use only facts, numbers and wording found in SOURCE MATERIAL. If a detail is not there, leave it out. Do not fill a gap with typical trial wording.
- Build the Reference section from the CITATION RECORD in SOURCE MATERIAL only. Copy authors, journal, year, volume, pages and DOI from it. Never write a citation from memory.
- Report each result in the direction the source reports it. If the source reports separate results for separate diseases or subgroups, report them separately. Do not call a marginal result significant.
- Label each endpoint primary or secondary only if the source does so.
- Never leave placeholder text such as "[Journal name, year]". If a citation field is missing from the record, omit that field.${abstractOnly}
=== END SOURCE RULES ===`;
}
