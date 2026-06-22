// Shared body-prose word counter.
// Counts ONLY the paragraphs a reader actually reads — the same measure used to
// enforce the per-category generation limit, so the number shown in the UI always
// matches what the limit acts on.
//
// Deliberately NOT counted:
//   • a leading "# Title" line (kept out of stored automation bodies already, but
//     stripped here too so manual/raw articles count consistently)
//   • the "Reading Time" meta line
//   • every heading line
//   • any References / Sources / Bibliography / Citations / Disclaimer section + body
//   • a standalone italic disclaimer paragraph
// Markdown markers are stripped so they never inflate the count.
export function countBodyWords(text) {
  if (!text) return 0;
  let lines = String(text).split('\n');
  // Drop a leading "# Title" line if present (mirrors server-side title extraction).
  if (lines[0] && /^#\s+/.test(lines[0].trim())) lines = lines.slice(1);

  let words = 0;
  let inExcludedSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const h = heading[1].replace(/[*_`#]/g, '').trim().toLowerCase();
      inExcludedSection = /^(references?|sources?|bibliography|citations?|further reading|disclaimer)\b/.test(h);
      continue;
    }
    if (inExcludedSection) continue;

    if (/^reading time\b/i.test(line)) continue;

    const noEmph = line.replace(/^[*_]+|[*_]+$/g, '').trim();
    const isFullItalic = /^[*_].+[*_]$/.test(line);
    if (isFullItalic && /\b(disclaimer|informational purposes|not (constitute |a )?(clinical|medical) advice|journalistic summary)\b/i.test(noEmph)) continue;
    if (/^disclaimer\b[:\-]/i.test(noEmph)) continue;

    const plain = line
      .replace(/[*_`>]/g, ' ')
      .replace(/^\s*[-•]\s+/, ' ')
      .replace(/^\s*\d+[.)]\s+/, ' ');
    words += plain.trim().split(/\s+/).filter(Boolean).length;
  }
  return words;
}
