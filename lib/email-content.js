// lib/email-content.js — Render article body for email.
// Mirrors index.html's formatArticleHTML() logic but uses inline styles so
// Gmail/Outlook/Apple Mail render it faithfully (email clients strip <style>).

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline-style fragments — kept short for readability where used inline
const S = {
  h1:    'margin:24px 0 8px;font-family:Georgia,serif;font-size:22px;line-height:1.3;color:#1e2d40;font-weight:700;',
  h1Sub: 'margin:0 0 18px;font-family:Georgia,serif;font-size:16px;line-height:1.4;color:#006868;font-weight:600;font-style:italic;',
  h2:    'margin:22px 0 8px;font-family:Arial,sans-serif;font-size:14px;line-height:1.4;color:#1e2d40;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;border-bottom:1px solid #dde3ea;padding-bottom:4px;',
  meta:  'margin:0 0 4px;font-family:Arial,sans-serif;font-size:12px;color:#6b7a8d;font-style:italic;',
  p:     'margin:0 0 12px;font-family:Georgia,serif;font-size:14px;line-height:1.75;color:#333;',
  ul:    'margin:0 0 12px 22px;padding:0;font-family:Georgia,serif;font-size:14px;line-height:1.7;color:#333;',
  li:    'margin:0 0 4px;',
  hr:    'border:none;border-top:1px solid #dde3ea;margin:18px 0;',
  hero:  'width:100%;max-width:100%;height:auto;display:block;border-radius:6px;margin:0 0 18px;border:1px solid #dde3ea;',
};

const SECTION_HEADER_RE = /^(\*{0,2})(Background|Study Design|Patient Population|Key Findings|Discussion|Safety|Authors|Reference|Clinical Relevance|Conclusions|Disclaimer|Industry|Op-Ed|White Paper|Infographic|Introduction|Methods|Results|Summary|What\b|When\b)/i;

// Inline transforms applied to paragraph text (bold/italic/links)
function inlineTransforms(text) {
  return escHtml(text)
    // Markdown links [text](url) — keep simple, no nested brackets
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#006868;text-decoration:underline;">$1</a>')
    // Bold **x**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic *x* (avoid touching ** sequences — handled above)
    .replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<em>$1</em>');
}

// Convert article markdown body → inline-styled HTML for email.
// Mirrors index.html's logic: first non-empty line = title (h1), the optional
// "# Subtitle" follows the title, then "## Section" → h2, plain lines → p,
// "- bullet" → ul/li, "---" → hr.
function renderBodyHtml(body) {
  const lines = (body || '').split('\n');
  let html = '';
  let titleDone = false, subtitleDone = false, inMeta = false, inList = false;

  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) { closeList(); continue; }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
      closeList();
      html += `<hr style="${S.hr}"/>`;
      continue;
    }

    // List items
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) { html += `<ul style="${S.ul}">`; inList = true; }
      html += `<li style="${S.li}">${inlineTransforms(trimmed.replace(/^[-*]\s+/, ''))}</li>`;
      continue;
    }
    closeList();

    // Strip a single pair of wrapping ** for heading detection
    const stripped = trimmed.replace(/^\*\*(.+?)\*\*$/, '$1').trim();

    // First # → article title; if title was already set, plain "# x" becomes h1 subtitle on first repeat then h2
    if (!titleDone) {
      if (trimmed.startsWith('# ')) {
        html += `<h1 style="${S.h1}">${inlineTransforms(trimmed.slice(2).replace(/\*\*/g, ''))}</h1>`;
        titleDone = true; inMeta = true;
        continue;
      }
      if (!trimmed.startsWith('#')) {
        html += `<h1 style="${S.h1}">${inlineTransforms(stripped)}</h1>`;
        titleDone = true; inMeta = true;
        continue;
      }
    }

    // Meta block (author/journal/DOI lines between title and first section)
    if (inMeta && titleDone) {
      if (SECTION_HEADER_RE.test(stripped) || trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
        inMeta = false;
      } else if (!trimmed.startsWith('#')) {
        html += `<div style="${S.meta}">${inlineTransforms(stripped)}</div>`;
        continue;
      }
    }

    // Headings
    if (trimmed.startsWith('### ')) {
      html += `<h2 style="${S.h2}">${inlineTransforms(trimmed.slice(4).replace(/\*\*/g, ''))}</h2>`;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      html += `<h2 style="${S.h2}">${inlineTransforms(trimmed.slice(3).replace(/\*\*/g, ''))}</h2>`;
      continue;
    }
    if (trimmed.startsWith('# ')) {
      const txt = inlineTransforms(trimmed.slice(2).replace(/\*\*/g, ''));
      if (!subtitleDone) { subtitleDone = true; html += `<p style="${S.h1Sub}">${txt}</p>`; continue; }
      html += `<h2 style="${S.h2}">${txt}</h2>`; continue;
    }

    // Bold-only line matching a section name → h2
    const boldMatch = trimmed.match(/^\*\*(.+?)\*\*$/);
    if (boldMatch && SECTION_HEADER_RE.test(boldMatch[1])) {
      html += `<h2 style="${S.h2}">${inlineTransforms(boldMatch[1])}</h2>`;
      continue;
    }

    // Regular paragraph
    html += `<p style="${S.p}">${inlineTransforms(trimmed)}</p>`;
  }
  closeList();
  return html;
}

/**
 * Render the article's "full content" block for a review email.
 * Includes the hero image (if any) above the rendered markdown body.
 *
 * Returns an HTML fragment ready to be embedded inside an email template.
 */
export function renderArticleEmailContent({ title, body, excerpt, heroImageUrl, category } = {}) {
  const sourceText = (body || excerpt || '').trim();
  if (!sourceText && !heroImageUrl) return '';

  const heroBlock = heroImageUrl
    ? `<img src="${escHtml(heroImageUrl)}" alt="${escHtml(title || 'Article hero image')}" style="${S.hero}"/>`
    : '';
  const renderedBody = sourceText ? renderBodyHtml(sourceText) : '';

  // Wrap in a soft card so it visually sits as "the article" inside the email shell
  return `
    <div style="margin:0 0 24px;background:#fafbfc;border:1px solid #dde3ea;border-radius:8px;padding:20px 22px;">
      <p style="font-size:11px;color:#6b7a8d;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px;font-family:Arial,sans-serif;">Full Article${category ? ` &middot; ${escHtml(category)}` : ''}</p>
      ${heroBlock}
      ${renderedBody}
    </div>`;
}
