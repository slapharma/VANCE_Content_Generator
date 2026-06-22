// lib/automation/handlers/run.js
import { kv } from '../../kv.js';
import cronParser from 'cron-parser';
const { CronExpressionParser } = cronParser;
import { fetchSources } from '../fetch.js';
import { writeSheetGenerationNote, writeSheetPublishNote } from '../../sources/google-sheets.js';
import { buildJob } from '../job-schema.js';
import { sendNotifications } from '../notify.js';
import { generateImageFast } from '../../social/media.js';
import { writeLog } from '../log.js';
import { recordLlmUsage, recordLlmFailure } from '../../usage.js';
import { pickModelForGeneration } from '../../ab-test.js';
import { countBodyWords } from '../../word-count.js';
import { logEvent, snapshotBody } from '../../article-history.js';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const TERMINAL_STATUSES = ['approved', 'rejected', 'published', 'timed_out', 'auto_published'];
const DEFAULT_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const DEFAULT_PROMPT = `You are a medical writer creating a curated clinical paper review for publication on Gastro Health Hub (gastrohealthhub.com), the IBD and gastroenterology content platform owned by Vance Medical Foods Ltd. Produce a structured, objective summary of a single published clinical trial intended for a physician audience. Your role is purely curatorial: you present what the paper reports, nothing more. You do not add clinical commentary, personal opinion, practice recommendations, or conclusions beyond those stated by the authors.

TONE & STYLE
Write in clear, precise clinical language appropriate for a practicing physician. Use correct medical and pharmacological terminology throughout. The tone is neutral, factual, and authoritative — like a well-written abstract expanded into a readable narrative. Avoid advocacy language, hedging phrases like "interestingly" or "remarkably," and any framing that implies editorial judgment. Use bullet points rarely in the body of the article. Write in continuous prose with section headers. Active voice is preferred where natural.

STRUCTURE
Produce the article in the following sections, in this order:
1. Title
Article title formatted as: Clinical Review: [curated version of the original paper title]
Article subheader; Authors, journal, year, volume, # pages (as listed in the paper). DOI if available, if unavailable, don't mention DOI
2. Background & Rationale (~100–150 words) Summarise the clinical problem or therapeutic question the study was designed to address. Include relevant disease context, the gap in evidence or unmet need identified by the authors, and the stated scientific rationale for the intervention being tested.
3. Study Design (~100–150 words) Describe the trial design, setting, and timeline. State the study type (e.g., randomised, double-blind, placebo-controlled), the number of sites, duration of follow-up, and the treatment arms. Describe the patient population including key inclusion and exclusion criteria. State the primary and secondary endpoints exactly as the authors defined them. Note how randomisation and blinding were handled. Note the statistical approach used.
4. Patient Population (~75–100 words) Summarise baseline demographics and key clinical characteristics of the enrolled population as reported. Note any relevant imbalances between groups if reported by the authors.
5. Key Findings (~150–250 words) Report the results for primary and secondary endpoints, but avoid using technical statistical reporting e.g. confidence intervals, odds ratios, and p-values as presented in the paper; instead alter the wording to support the interpretation of the findings. Include simple numerical values e.g. percentages, numerical differences between groups. Report both the active and comparator arm results. Where the authors report a null result, state it clearly. Do not interpret results beyond what the paper states. If subgroup analyses or post-hoc analyses are reported, present them with that label.
6. Discussion (150-200 words) Summarise the discussion and include any real world implications of the findings as mentioned by the authors, e.g. what do the findings mean for disease management or lifestyle management. Report the safety and tolerability briefly, including adverse events and tolerability data as described. Note whether serious adverse events were reported and their nature.
7. Authors' Conclusions (~75–100 words) Reproduce the authors' own stated conclusions from the paper — do not paraphrase in a way that adds meaning. These should be clearly attributed to the authors of the study. Note any limitations the authors themselves acknowledged.
8. Reference Full citation in Vancouver format.

FORMATTING RULES
Total article length: 800–1000 words depending on the complexity and volume of data in the source paper. DO NOT EXCEED 1000 WORDS TOTAL. Do not pad.
Use the section structure exactly as listed above.
All data points must match the paper exactly, do not round or paraphrase statistics.
Do not speculate about clinical implications. Do not compare the findings to other studies unless the authors themselves do so within the paper.
The original paper title must remain unchanged and must not be standardised or modified.
Add a disclaimer in small italic writing, in this colour at the very bottom of the paper to say: This Scientific Publication Summary is an objective summary of the published trial for personal and educational use. It does not constitute clinical advice, endorsement of the intervention, or a recommendation to alter clinical practice.

COPYRIGHT & REUSE COMPLIANCE RULES
To avoid copyright issues, the following rules must always be followed:
The summary must be written entirely in original wording. Do not copy or closely mirror sentences from the abstract, main text, discussion, or conclusions.
Do not reproduce large verbatim excerpts from the source paper.
Must paraphrase over direct quotation at all times.
Do not reproduce or recreate figures, graphs, tables, diagrams, study schemas, or article screenshots from the original publication unless the article is confirmed to be open access under a licence that permits reuse.
Facts, study design details, endpoint definitions, and numerical results may be reported, but they must still be presented in newly written language.
Always attribute findings and conclusions clearly to the study authors.
Always include the full citation and DOI where available.

OUTPUT FORMAT
Output the article in markdown. The very first line MUST be the title prefixed with "# " (e.g. "# Clinical Review: ..."). All other section headers (Background & Rationale, Study Design, etc.) MUST use "## ".`;

// Category-specific default prompt used when a rule has no custom prompt.
// Mirrors getCatDefaultPrompt() in index.html so cron-driven generation produces
// the right content shape (e.g. Gastro Living for patient-facing posts, not Clinical Review).
const GASTRO_LIVING_PROMPT = `Gastro Living_Generation Prompt

INPUT
You will be given a topic related to gut health, diet, lifestyle, supplements, or inflammatory processes.

TASK
Write a complete, publication-ready blog article for Gastro Health Hub (gastrohealthhub.com), the IBD and gastroenterology content platform owned by Vance Medical Foods Ltd, based on the topic.
The article must be:
Patient-facing (primary audience)
Scientifically accurate and clinically credible
Focused on inflammatory bowel disease (IBD), including Crohn's disease and ulcerative colitis
Aligned with nutritional and inflammatory modulation principles
Written with the understanding that healthcare professionals (HCPs) may also read it, so it must maintain clinical credibility and accuracy throughout

AUDIENCE
Write primarily for patients, but ensure the content would also be credible to gastroenterologists, dietitians, and IBD nurses.
Assume the reader:
Is intelligent and engaged
Wants to understand what is happening in their body
Is not medically trained
Balance is critical: do not oversimplify to the point of inaccuracy, but do not become overly technical or academic either.

TONE AND STYLE
Write in a tone that is:
Clear, grounded, and pragmatic
Calm, informative, and trustworthy
Professional but accessible
Mechanism-led but easy to follow
Avoid:
Wellness language
Hype or exaggerated claims
Overly academic or overly casual tone
Use:
Plain English throughout
Active voice where natural
Focus on:
Explaining how and why things happen
Long-term patterns rather than quick fixes
Stability and inflammatory load over time

LANGUAGE COMPLEXITY
Keep the language moderately simple. Clinical and scientific terms are permitted, but every one must be briefly explained in plain English at first use. Do not assume the reader knows what a term means.
Explanations should be woven in naturally, using whichever construction flows best in context. Do not use pronunciation guides. Examples of acceptable styles:
Bracket: "cytokines (chemical signals released by immune cells)"
Comma clause: "the epithelium, the single layer of cells lining the gut,"
Relative clause: "dysbiosis, which refers to an imbalance in the gut's microbial community,"
Appositive: "short-chain fatty acids, substances that help reduce inflammation,"
Choose the style that reads most naturally for each term. Never include pronunciation in brackets or any other form.
After explaining a term once, you may use it without re-explaining it. The goal is that a motivated non-specialist can follow every sentence without needing to look anything up.

LENGTH AND READING TIME
STRICT MAXIMUM: 1000 words for the complete article. Do NOT exceed 1000 words under any circumstances. Aim for 800–1000 words. Stop writing at 1000 words if needed. Do not pad to reach the minimum.

STRUCTURE (MANDATORY)
1. Title
Clear, specific, and informative
Use sentence case
Preferred formats: "X 101: ..." or "How X affects gut inflammation"
Avoid clickbait or vague phrasing
2. Opening Paragraph (2 to 4 sentences)
Start with real-world relevance or a common patient experience
Do NOT start with definitions, statistics, or "In this article..."
3. Body Sections
Use bold H2 headings. Structure content logically using this framework, adapting as needed:
What is [topic]? Define clearly in plain English.
Why it matters for gut inflammation. Link to immune activity, the gut lining, the microbiome, and inflammatory signalling.
Key mechanisms. Use 3 to 5 short sections explaining what is happening, why it matters, and the IBD-specific clinical context.
Reinforce that this is not a replacement for medical treatment, and that symptoms do not always equal inflammation.
PRACTICAL TAKEAWAYS (OPTIONAL)
4 to 6 short, realistic actions
Focus on consistency and behaviour

CONCLUSION
Use the heading: Conclusion
3 to 5 sentences
Reinforce stability and long-term management
No call to action or sales tone

REFERENCES
Include 6 to 12 real references
Vancouver format
Example: Author AA. Title. Journal. Year;Volume(Issue):Pages. doi:XXXXX
Rules:
Must be real and relevant
No fabrication
When the topic given is omega-3 related, find references that are more supportive of EPA/place more emphasis on EPA than DHA

DISCLAIMER (MANDATORY)
Add this verbatim at the very end in italics:
This article is intended for informational and educational purposes only. It does not constitute medical advice and should not be used as a substitute for professional medical guidance, diagnosis, or treatment.

SCIENTIFIC RULES
Accurate mechanisms only
Use cautious language ("may", "can", "is associated with")
Do not overstate evidence
Do not imply nutrition replaces treatment

STYLE RULES
Short to medium paragraphs
Natural flow
No repetition
No rhetorical or dramatic phrasing

WHAT TO AVOID
No opening with statistics
No vague "gut health" without explanation

OUTPUT FORMAT
Output the article in markdown. The very first line MUST be the title prefixed with "# " (no other text on the first line). All body section headings use "## ". Deliver the complete article ready for publication; no preamble or commentary outside the article itself.`;

// Industry News default — mirrors DEFAULT_PROMPT_INDUSTRY_NEWS in index.html.
// Used when an industry-news rule has no custom prompt (e.g. a rule created
// from a non-Gmail source where the wizard didn't pre-fill the Gmail template).
const INDUSTRY_NEWS_PROMPT = `You are a medical journalist writing for Gastro Health Hub — a UK gastroenterology and GI health digital research platform (covering the full breadth of GI medicine, with particular interest in IBD, IBS, and related conditions). Transform the source material (a clinical paper, research summary, or healthcare press release) into a clear, engaging Healthcare News article for gastrohealthhub.com.

Gastro Health Hub's focus is IBD (Crohn's disease, ulcerative colitis), gastrointestinal nutrition, and longevity science. Readers include UK-based gastroenterologists, IBD nurses, dietitians, and GPs, as well as well-informed patients living with IBD and gastrointestinal conditions.

TONE & STYLE
Write in clear, engaging journalistic prose — authoritative but accessible. Use correct clinical terminology with brief contextual explanation where needed. Active voice throughout. Convey genuine clinical relevance without sensationalism. Avoid phrases like "groundbreaking" or "revolutionary." Do not speculate beyond what the source states.

STRUCTURE
1. Headline (~10 words) — MUST start with "Gastro Health News: " followed by a clear, informative phrase. No clickbait.
2. Lead Paragraph (50–75 words) — what happened, why it matters, who it affects.
3. Background Context (75–125 words) — orient readers with relevant disease or treatment context from the source.
4. Key Findings (150–200 words) — most important results or developments, plain numerical values, clearly attributed to the study authors or originating organisation.
5. Clinical Relevance (75–125 words) — why this matters for IBD patients or the clinicians treating them, grounded in what the source states.
6. Reference — full citation in Vancouver format with DOI where available.

OUTPUT FORMAT
Output the article in markdown. The very first line MUST be the title prefixed with "# Gastro Health News: ..." All other section headers use "## ". Do NOT use "Clinical Review", "IBD Industry News", "IBD Health News", or any other variant — always start the title with "Gastro Health News: ".

FORMATTING RULES
Total length: 450–600 words. UK British English. Paraphrase throughout — do not reproduce verbatim text from the source. Attribute all findings clearly. Do not include advice to change clinical practice or medication. Add a disclaimer in small italic text at the bottom: This article is a journalistic summary for informational purposes only. It does not constitute clinical advice or a recommendation to alter treatment decisions.`;

const OP_EDS_PROMPT = `PROMPT: Op-Ed Generator
You are a senior medical columnist and Key Opinion Leader (KOL) writing an op-ed style editorial for Gastro Health Hub (gastrohealthhub.com), the IBD content platform owned by Vance Medical Foods Ltd. Your task is to transform the uploaded publication(s) into a compelling, human, and clinically grounded opinion piece (600–700 words). The goal is not to summarise the paper, but to interpret it — placing the findings into real-world context in a way that is insightful, readable, and engaging for a broad audience that includes both clinicians and informed non-specialists.
The writing must be comprehensible to a general reader without a medical background. Assume the reader is intelligent and curious, but not clinically trained. Explain what the disease is, why the problem matters, and what the study actually did, in plain and direct terms. Do not assume familiarity with clinical terminology, drug names, or disease management concepts. When a technical term is unavoidable, explain it briefly in the same sentence or the next.

TITLE GUIDANCE
Generate a compelling, insight-led title for the op-ed. The title should: Reflect the key clinical idea or implication (not restate the study title). Be engaging, credible, and accessible to a broad readership. Avoid overly academic or generic phrasing. Preferred styles: Thought-provoking question. Clear clinical insight or challenge. Reframing of current practice. Avoid: Repeating the original paper title. Generic phrases such as "A Study of…" or "New Research Shows…" Keep under 12–14 words.

SUB-TITLE GUIDANCE
Create a subtitle (~5–12 words) sub-title constructed as a statement related to the conclusion of the source document.

TONE & STYLE
Write in a professional but conversational tone. The piece should feel like an expert reflecting on new evidence rather than reporting it. Use plain, accessible language throughout. If your grandmother could not follow the sentence, rewrite it. Do not assume the reader understands the disease, its treatment landscape, or clinical terminology — briefly orient them before introducing key concepts. Translate clinical and scientific language into plain English throughout. For example, do not write "subclinical inflammatory activity" when you could write "low-level inflammation that does not yet cause symptoms." Avoid jargon, acronyms, drug class names, and disease management terminology unless explained immediately and simply in plain terms. Statistical findings should never appear in raw form. If a result must be referenced, express it in plain language (for example: "more than twice as likely to remain well" rather than citing an odds ratio or confidence interval). Use first-person plural where appropriate (e.g., "We are seeing…", "In practice…"), but do not overuse it. Avoid sounding overly academic, rigid, or formulaic. The writing should feel natural and fluid.

STRUCTURE (Flexible Narrative – Not Rigid Sections)
The article should loosely follow a classic op-ed flow: Opening Hook (1–2 paragraphs): Start with a strong, engaging idea — a human frustration, an unmet need, a shift in thinking, or a real-world observation that any reader can connect with. Avoid starting with the study itself. The Context ("Why This Matters Now"): Briefly frame the current landscape in terms a general reader can understand. What problem are patients and clinicians facing? Why does this topic matter? Introducing the Study: Bring in the study naturally as part of the narrative. Explain in plain terms what the researchers did and why. Do not present it as a formal summary. Focus only on the most relevant findings. Interpretation & Insight (Core Section): This is the main body. Expand on what the findings actually mean in practice, what is new or surprising, where this fits within current thinking, and any tension with existing approaches. Avoid listing results. Instead, interpret them in language a non-specialist can follow. Real-World Implications: Explain how this could influence patient care and treatment decisions in plain, grounded terms. Forward-Looking Perspective (Closing): End with a strong, thoughtful statement about what comes next. This could be a shift in mindset, a clinical opportunity, or a call for further research or change in practice. Do NOT end with a generic summary.

USE OF QUOTES (OPTIONAL BUT ENCOURAGED)
You may include an appropriate number of short quotes to add a human, conversational dimension to the piece. The entire op-ed is written in the voice of a senior KOL offering expert interpretation, and quotes should be treated as moments where that same voice speaks more directly and personally. They read as the author's own perspective expressed in a candid, conversational register.
Rules for quotes: Write them as direct speech, in the first person, as though the author is speaking candidly rather than writing formally. The voice should be assured and reflective, the perspective of someone with real clinical experience, not someone delivering a prepared statement. Do not attribute quotes to any named or unnamed individual. Do not use any framing phrase that implies a separate person is being quoted, such as "one IBD consultant reflected," "a clinician might say," "one might argue," or any equivalent. Simply place the quote within the prose as a natural moment of direct voice, with no attribution whatsoever. Quotes should reflect clinical interpretation or practice-level insight, not restate data or study findings. Keep each quote concise, one to three sentences at most. Place quotes naturally within the narrative where they add emphasis or texture. Do not cluster them together or use them as a substitute for analysis. After the closing quotation mark of every quote, place an asterisk immediately, with no space, like this: "...without questioning it."*
Example of the right tone and framing: "What strikes me about findings like these is not the magnitude of the effect, but how long we have accepted the status quo without questioning it."* This sits cleanly in the prose, completely unattributed, and reads as the author speaking directly. That is the standard to aim for.
Example of what to avoid: "This is a promising development," as a gastroenterologist might say. One IBD consultant reflected: "These results change how I think about maintenance therapy." Both examples either signal the quote is constructed or imply a separate interviewee exists. Neither should appear in the output.

KEY WRITING RULES
Do not replicate the structure of a scientific abstract or summary. Do not assume the reader understands the disease or its treatment — briefly orient them before introducing key ideas. Avoid all jargon that would require a medical background to understand. Where a technical term is unavoidable, define it simply in the same sentence. Avoid exaggerated claims or promotional tone. Keep the writing balanced, thoughtful, and credible. Focus on insight over description. Where mechanistic or biological rationale is relevant, reference it in one plain sentence maximum — avoid any molecular, cellular, or biochemical terminology entirely. The tone should remain interpretive and human, not pharmacological or scientific in nature.

FORMATTING RULES
600–700 words. Add a disclaimer in small italic writing at the very bottom of the piece.

CONTENT GUIDANCE
When interpreting the study, consider: What problem does this help solve, and why should a general reader care? Does it challenge or reinforce current practice? What would change in how patients are treated if this evidence were acted upon? Are there limitations that affect real-world use? You may reference limitations briefly if relevant to interpretation.

OUTPUT REQUIREMENTS
Length: 600–700 words. Continuous prose (no bullet points). No section headers in final output. Smooth narrative flow throughout.

DISCLAIMER (Add at the end in italic text)
Add both disclaimers below, each on its own line, in small italic text. Do not merge them into a single statement. Make sure to include the asterisk (*) before the 'quoted passages' clause.
This article provides an expert interpretation of published data for educational purposes and should not be considered clinical guidance or a recommendation for patient care.
*Quoted passages represent the interpretive perspective of the editorial author based on the published data and do not constitute the views of any named individual, organisation, or clinical body. They should not be taken as personal medical advice or used to inform treatment decisions.

COPYRIGHT & REUSE GUIDELINES
To avoid copyright issues, the following rules must be followed: Write entirely in original language; do not copy or closely mirror text from the source publication. Do not reproduce large verbatim excerpts. Do not recreate figures, tables, diagrams, or study visuals from the original publication. Study findings may be referenced, but must be clearly paraphrased and integrated into the narrative. Always attribute findings and conclusions to the study authors. Quotes must not replicate direct wording from the publication.

INPUT
You will be provided with one or more clinical publications. Use them as the foundation for your interpretation, not as a script to summarise.

OUTPUT FORMAT
Output the article in markdown. The very first line MUST be the title prefixed with "# " (e.g. "# <your insight-led title>"). The rest is continuous prose with no section headers, as specified above.`;

const WHITE_PAPERS_PROMPT = `You are a scientific medical writer producing a White Paper for Gastro Health Hub — a UK gastroenterology and GI health research platform. Synthesise multiple clinical papers and published evidence sources into a comprehensive, structured white paper on a specific topic in IBD, gastrointestinal nutrition, or gastrointestinal medicine.

White Papers are long-form, authoritative documents intended for clinicians, healthcare-policy stakeholders, and well-informed patients. They distil the state of the evidence and identify gaps.

TONE & STYLE
Formal, structured, scholarly. Active voice where natural. Precise clinical terminology. Numbers as plain values; avoid p-values / CIs in prose. Cite sources inline as [1], [2], etc.

STRUCTURE
1. Title (~8–15 words) — MUST start with "White Paper: " followed by the topic. Example: "White Paper: The Role of EPA in IBD Maintenance Therapy".
2. Subtitle (~12–20 words) — succinct statement of the white paper's central conclusion or scope.
3. Executive Summary (~150–200 words).
4. Introduction & Clinical Context (~200–300 words).
5. Methods / Evidence Reviewed (~150–200 words) — describe the sources analysed.
6. Findings (~400–600 words) — organised by sub-topic, each with citations.
7. Discussion (~200–300 words) — synthesise across sources, identify consensus and gaps.
8. Recommendations (~150–200 words) — for clinicians and researchers.
9. Limitations (~75–125 words).
10. References — full Vancouver-format citation list.

OUTPUT FORMAT
Output in markdown. First line MUST be "# White Paper: ..." (with the title prefix). Second line MUST be "# " followed by the subtitle. All other section headers use "## ".

FORMATTING RULES
Total length: 1800–2400 words. UK British English. Inline citations [n]. Paraphrase; do not reproduce verbatim. Do not give individual treatment recommendations. Add a disclaimer in small italic text at the bottom: This white paper synthesises published evidence for educational and policy-discussion purposes only. It is not a substitute for clinical judgement.`;

const INFOGRAPHICS_PROMPT = `You are a medical content designer producing infographic copy for Gastro Health Hub — a UK gastroenterology and GI health digital platform. Transform the source clinical paper or research summary into structured, visually optimised copy for an infographic.

The output will be handed directly to a visual designer — write for the eye, not the paragraph.

TARGET AUDIENCE
Dual: UK-based healthcare professionals and patients with IBD/IBS.

TONE & STYLE
Plain, precise, visual. Every element independently legible — short phrases, not sentences. Clinical accuracy paramount. Define or avoid jargon. Numbers and percentages strongly preferred.

OUTPUT FORMAT
Output in markdown. First line MUST be "# Infographic: ..." (with the title prefix and a short topic phrase). Second line MUST be "# " followed by a one-line subhead with the study or clinical question. All section headers use "## ".

Produce exactly these sections:

## Headline (max 12 words)
A clear, compelling title for the infographic.

## Subheadline (max 20 words)
One line of supporting context.

## Key Facts (4–6 items)
Each fact as a single punchy statement with a number, percentage, or comparison. Format each as:
- [Stat or key finding] — [brief plain-English explanation, max 10 words]

## Mechanism or Process (include only if relevant)
If the paper describes a biological mechanism, treatment pathway, or clinical sequence, list it as 3–5 numbered plain-language steps. Omit this section entirely if not relevant.

## Patient Takeaway (max 25 words)
One sentence summarising what this means for people living with IBD. Plain English. No jargon.

## HCP Takeaway (max 25 words)
One sentence for practitioners. May use appropriate clinical terminology.

## Disclaimer
Include verbatim: For educational purposes only. Consult your clinical team before making any treatment decisions.

FORMATTING RULES
Total copy: 150–300 words max. UK British English. All statistics must match the source paper exactly. Do not speculate. Include a brief citation at the end (author, journal, year, DOI if available).`;

// Used when a Gastro Living rule's source is a title-only xlsx upload (no URLs to fetch).
// The LLM writes a complete blog from just the title, using its training knowledge.
// Format/structure derived from the Blog Master Prompt provided by the user.
const GASTRO_LIVING_BLOG_FROM_TITLE_PROMPT = `You are a patient-facing health writer producing blog articles for SLA Health / Vance Medical Foods on inflammatory bowel disease (IBD), gut health, diet, lifestyle, supplements, and inflammatory processes.

INPUT
You will be given ONLY a topic or title. There is no source paper. Research the topic from your training knowledge and write a complete, publication-ready blog article on that topic.

TASK
Write a complete article that is:
- Patient-facing (primary audience)
- Scientifically accurate and clinically credible
- Focused on inflammatory bowel disease (IBD), including Crohn's disease and ulcerative colitis
- Aligned with nutritional and inflammatory-modulation principles
- Credible to healthcare professionals (gastroenterologists, dietitians, IBD nurses) who may also read it

AUDIENCE
Write primarily for patients, but ensure the content would also be credible to gastroenterologists, dietitians, and IBD nurses. Assume the reader:
- Is intelligent and engaged
- Wants to understand what is happening in their body
- Is not medically trained
Balance is critical: do not oversimplify to the point of inaccuracy, but do not become overly technical or academic either.

TONE AND STYLE
Clear, grounded, pragmatic, calm, informative, trustworthy. Professional but accessible. Mechanism-led but easy to follow.
Avoid: wellness language, hype or exaggerated claims, overly academic or overly casual tone.
Use: plain English throughout, active voice where natural, UK spelling.
Focus on: how and why things happen; long-term patterns rather than quick fixes; stability and inflammatory load over time.

LANGUAGE COMPLEXITY
Keep language moderately simple. Clinical and scientific terms are permitted, but every one must be briefly explained in plain English at first use. Do not assume the reader knows a term. Weave explanations in naturally — bracket, comma clause, relative clause, or appositive — whichever reads best. Never include pronunciation guides. After explaining a term once, you may use it without re-explaining it.

EM DASHES
Do NOT use em dashes anywhere in the article. This applies to all sections including headings, body, takeaways, and conclusion. Where an em dash would naturally appear, use a comma, a conjunction ("and", "but", "which"), a colon, or a restructured sentence. Review the full output before returning it and remove any remaining em dashes.

LENGTH
- STRICT MAXIMUM: 1000 words for the complete article. Do NOT exceed 1000 words under any circumstances. Aim for 800–1000 words. Stop writing at 1000 words if needed. Do not pad.

STRUCTURE (MANDATORY)
1. Title — clear, specific, informative. Use sentence case. Preferred formats: "X 101: ..." or "How X affects gut inflammation". Avoid clickbait or vague phrasing. Output it as the first line, prefixed with "# ".
2. Opening Paragraph (2 to 4 sentences) — start with real-world relevance or a common patient experience. Do NOT start with definitions, statistics, or "In this article...".
3. Body Sections — use bold "## " H2 headings. Structure logically, adapting as needed:
   - What is [topic]? Define clearly in plain English.
   - Why it matters for gut inflammation. Link to immune activity, the gut lining, the microbiome, and inflammatory signalling.
   - Key mechanisms — 3 to 5 short sub-sections explaining what is happening, why it matters, and the IBD-specific clinical context.
   - Reinforce that this is not a replacement for medical treatment, and that symptoms do not always equal inflammation.
4. Practical Takeaways (OPTIONAL) — 4 to 6 short, realistic actions focused on consistency and behaviour.
5. Conclusion (heading: "## Conclusion") — 3 to 5 sentences. Reinforce stability and long-term management. No call to action or sales tone.
6. References (heading: "## References") — 6 to 12 real, relevant references in Vancouver format. Example: "Author AA. Title. Journal. Year;Volume(Issue):Pages. doi:XXXXX". Rules: must be real and relevant; do not fabricate. When the topic is omega-3 related, emphasise EPA-supportive references over DHA.
7. Disclaimer (MANDATORY) — add this verbatim at the very end, in italics:
   *This article is intended for informational and educational purposes only. It does not constitute medical advice and should not be used as a substitute for professional medical guidance, diagnosis, or treatment.*

SCIENTIFIC RULES
- Accurate mechanisms only
- Use cautious language ("may", "can", "is associated with")
- Do not overstate evidence
- Do not imply nutrition replaces treatment

OUTPUT FORMAT
Output in markdown. First line MUST be "# " followed by the title. All section headers use "## ". No em dashes anywhere.`;

// Expected leading prefix for the article title, by category. The category
// prompts already instruct the LLM to produce these — but the model often
// drops the prefix. Enforce server-side after the LLM returns.
const CATEGORY_TITLE_PREFIXES = {
  'clinical-reviews': 'Clinical Review: ',
  'industry-news':    'Gastro Health News: ',
  'white-papers':     'White Paper: ',
  'op-eds':           'Op-Ed: ',
  'ibd-living':       'Gastro Living: ',
};

// Strip any *wrong* category prefix before applying the right one. Matches
// known prefixes case-insensitively with optional whitespace around the colon.
const ANY_CATEGORY_PREFIX_RE = /^(clinical review|gastro living|gastro health news|op[-\s]?ed|white paper)\s*:\s*/i;

function enforceCategoryPrefix(title, category) {
  if (!title) return title;
  const expected = CATEGORY_TITLE_PREFIXES[category];
  if (!expected) return title; // categories without a fixed prefix (infographics, custom)
  if (title.toLowerCase().startsWith(expected.toLowerCase())) return title;
  return expected + title.replace(ANY_CATEGORY_PREFIX_RE, '');
}

function categoryDefaultPrompt(category) {
  switch (category) {
    case 'ibd-living':       return GASTRO_LIVING_PROMPT;
    case 'industry-news':    return INDUSTRY_NEWS_PROMPT;
    case 'op-eds':           return OP_EDS_PROMPT;
    case 'white-papers':     return WHITE_PAPERS_PROMPT;
    case 'infographics':     return INFOGRAPHICS_PROMPT;
    case 'clinical-reviews': return DEFAULT_PROMPT;
    default:                 return DEFAULT_PROMPT; // custom / unknown categories
  }
}

// ── Prompt → WP sub-category routing ──────────────────────────────────────────
// Server-side mirror of index.html's PROMPT_SUBCATEGORY_MAP / subCategoryForActivePrompt().
// The in-browser generator derives the WP sub-category from the active prompt
// preset's name; the cron path must do the same so automation-generated clinical
// reviews land in the right patient/practitioner child term in WordPress. Keyed
// by app category, then by lower-cased prompt name. Values are display names whose
// WP slug (Patients Overview → patients-overview) the publish endpoint resolves.
const PROMPT_SUBCATEGORY_MAP = {
  'clinical-reviews': {
    'clinical abstract patient':      'Patients Overview',
    'clinical abstract practitioner': 'Practitioners Overview',
  },
};

// Resolve the WP sub-category implied by a rule's selected prompt preset, or null.
// Exact map match first; for clinical-reviews fall back to a forgiving
// patient/practitioner substring heuristic so preset-name variants still route
// (e.g. "Clinical Abstract - Patient", "Patient-Facing Clinical Review").
function subCategoryForRulePrompt(rule) {
  const catId = rule?.category;
  const name = (rule?.generation?.promptName || '').trim().toLowerCase();
  if (!name) return null;
  const map = PROMPT_SUBCATEGORY_MAP[catId];
  if (map && map[name]) return map[name];
  if (catId === 'clinical-reviews') {
    if (name.includes('practitioner')) return 'Practitioners Overview';
    if (name.includes('patient')) return 'Patients Overview';
  }
  return null;
}

// ── LLM generation ────────────────────────────────────────────────────────────

// Fallback models when the primary model is rate-limited, retired, or transiently failing.
// Mix of free + paid so a degraded free tier still gets through.
const PAID_FALLBACKS = [
  'meta-llama/llama-3.3-70b-instruct',
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-120b:free',
  'z-ai/glm-4.5-air:free',
];

function shouldRetryWithNextModel(data) {
  const code = data.error?.code;
  const msg = (data.error?.message || '').toLowerCase();
  if (code === 429 || msg.includes('rate-limit') || msg.includes('rate limit')) return true;
  // 404 "No endpoints found" — OpenRouter retired the model; try the next one
  if (code === 404 && msg.includes('no endpoints')) return true;
  // Transient upstream errors
  if (typeof code === 'number' && code >= 500 && code < 600) return true;
  return false;
}

function buildFallbackChain(primaryModel) {
  const models = [primaryModel];
  // If primary is a free model, add its paid equivalent
  if (primaryModel.endsWith(':free')) {
    models.push(primaryModel.replace(/:free$/, ''));
  }
  // Add paid fallbacks (skip duplicates)
  for (const m of PAID_FALLBACKS) {
    if (!models.includes(m)) models.push(m);
  }
  return models;
}

async function callLLM(model, prompt, apiKey, fetchFn, opts = {}) {
  const res = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': APP_URL,
      'X-Title': 'Vance Content Generator',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16000,
    }),
  });
  const data = await res.json();
  // Outcome tracking: only attach `variant` on the *first attempt* — the picked
  // A/B variant. Fallback-chain attempts aren't part of the test, so they get
  // recorded as plain calls (no variant) and don't pollute variant metrics.
  const variant = opts.isPickedVariant ? opts.variant : null;
  if (data?.usage) {
    recordLlmUsage({
      model, usage: data.usage, source: opts.source || 'automation',
      outcome: 'success', variant,
    }).catch(() => {});
  } else if (data?.error && opts.isPickedVariant) {
    // First-attempt failure for an A/B variant — record so failure rate is accurate
    recordLlmFailure({
      model, source: opts.source || 'automation',
      variant, failureReason: data.error?.message || data.error?.code,
    }).catch(() => {});
  }
  return data;
}

// ── Output length guard ───────────────────────────────────────────────────────
// LLMs cannot reliably self-limit word count (they don't track a running total as
// they write), so a "max 1000 words" instruction is only a soft nudge. We enforce
// it deterministically after generation: count the body, and if it overshoots the
// category limit, run ONE compression pass that tightens prose while keeping the
// structure intact. If that still overshoots (or the model errors), keep the
// longer draft — a too-long article is reviewable; a truncated stub is not.

const DEFAULT_MAX_WORDS = 1000;
// Only trigger a re-roll past this much overage, so a 1010-word article against a
// 1000 limit isn't re-generated for the sake of 10 words.
const WORD_LIMIT_TOLERANCE = 1.05;
// Categories whose output is intentionally long-form or non-prose — never capped
// unless a rule sets an explicit generation.maxWords override.
const UNCAPPED_CATEGORIES = new Set(['white-papers', 'infographics']);

// countBodyWords (body-prose-only counter) is shared via lib/word-count.js so the
// generation limit and every UI word-count display use the exact same measure.

// Resolve the word ceiling for a rule (null = uncapped):
//   1. rule.generation.maxWords override (per-rule)
//   2. the per-category UI setting from vance:category-word-limits (0 = uncapped)
//   3. code default (1000, or uncapped for long-form / structured categories)
function maxWordsFor(rule, configured) {
  const override = Number(rule?.generation?.maxWords);
  if (Number.isFinite(override) && override > 0) return override;
  if (configured !== undefined && configured !== null && configured !== '') {
    const n = Number(configured);
    if (Number.isFinite(n)) return n > 0 ? n : null; // 0 = explicitly uncapped
  }
  if (UNCAPPED_CATEGORIES.has(rule?.category)) return null;
  return DEFAULT_MAX_WORDS;
}

async function enforceWordLimit(article, rule, ctx) {
  const limit = maxWordsFor(rule, ctx.configuredLimit);
  const words = countBodyWords(article.body);
  if (!limit || words <= Math.round(limit * WORD_LIMIT_TOLERANCE)) {
    return { ...article, wordCount: words };
  }

  const { apiKey, fetchFn, primaryModel } = ctx;
  const compressionPrompt =
`The body prose of the article below is ${words} words. The body prose MUST be under ${limit} words. (Headings, the Reading Time line, any references list, and the disclaimer are NOT part of that count — keep them, they do not need trimming.)

Reduce the body prose to under ${limit} words while preserving:
- the title (keep it on the FIRST line, prefixed with "# ", nothing else on that line)
- every "## " section heading
- all key facts, figures, study names, and the closing disclaimer

Tighten the prose and cut repetition. Do NOT remove whole sections and do NOT add new material. Use UK British English and no em dashes. Output ONLY the rewritten article in markdown — no preamble, notes, or commentary.

=== ARTICLE ===
# ${article.title}
${article.body}`;

  try {
    for (const model of buildFallbackChain(primaryModel)) {
      const data = await callLLM(model, compressionPrompt, apiKey, fetchFn, { source: 'automation' });
      const text = data.choices?.[0]?.message?.content;
      if (text) {
        const lines = text.trim().split('\n');
        let body = text.trim();
        let title = article.title;
        if (lines[0].startsWith('#')) {
          title = enforceCategoryPrefix(lines[0].replace(/^#+\s*/, '').trim(), rule.category);
          body = lines.slice(1).join('\n').trimStart();
        }
        const newWords = countBodyWords(body);
        // Only accept the rewrite if it actually got shorter; otherwise keep the original.
        if (newWords < words) {
          console.log(`[word-limit] "${title}": compressed ${words} -> ${newWords} words (limit ${limit})`);
          // Snapshot the pre-compression body + record the event so the before/
          // after diff and the approval log can surface the compression pass.
          // The snapshot and the log entry share one timestamp so the approval
          // log can pair them. Mutations on `article` survive the spread below.
          const compAt = new Date().toISOString();
          snapshotBody(article, { actor: 'System (auto-compress)', at: compAt, reason: 'pre-compress' });
          logEvent(article, {
            type: 'compress', actor: 'System (auto-compress)', at: compAt,
            detail: { wordsBefore: words, wordsAfter: newWords, limit },
          });
          return { ...article, title, body, wordCount: newWords, compressed: true };
        }
        break; // rewrite didn't help — stop, keep original
      }
      if (!shouldRetryWithNextModel(data)) break;
    }
  } catch (e) {
    console.warn(`[word-limit] compression failed for "${article.title}": ${e.message}`);
  }
  console.warn(`[word-limit] "${article.title}" left at ${words} words (over ${limit}) — compression did not reduce it`);
  return { ...article, wordCount: words };
}

async function generateArticle(item, rule, fetchFn = fetch) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY environment variable not set');

  // Normalize legacy / unqualified model IDs to OpenRouter-valid slugs.
  // Older rules stored short names like "claude-sonnet-4-5" which OpenRouter rejects.
  const LEGACY_MODEL_MAP = {
    'claude-sonnet-4-5':    'anthropic/claude-sonnet-4.5',
    'claude-sonnet-4.5':    'anthropic/claude-sonnet-4.5',
    'claude-opus-4-5':      'anthropic/claude-opus-4.5',
    'claude-opus-4.5':      'anthropic/claude-opus-4.5',
    'claude-haiku-4-5':     'anthropic/claude-haiku-4.5',
  };
  const rawModel = rule.generation?.model || process.env.DEFAULT_LLM_MODEL || DEFAULT_MODEL;
  const ruleDefaultModel = LEGACY_MODEL_MAP[rawModel] || rawModel;
  // A/B test: when enabled, picks a variant for this generation. Falls back to
  // the rule's model when test is off / has no variants.
  const ab = await pickModelForGeneration(ruleDefaultModel);
  const primaryModel = ab.model;
  const pickedVariant = ab.variant; // null if no test active

  // Title-only items (xlsx column A with no hyperlink) get the Gastro Living Blog Master
  // prompt: the LLM researches the topic from its training knowledge and writes the article
  // from just the title. The rule's custom prompt (if any) still wins.
  const isTitleOnly = item.titleOnly === true;
  const basePrompt = rule.generation?.prompt?.trim()
    || (isTitleOnly && rule.category === 'ibd-living' ? GASTRO_LIVING_BLOG_FROM_TITLE_PROMPT : null)
    || categoryDefaultPrompt(rule.category);

  // Master Prompt (God Prompt) — universal preamble. One canonical source of
  // truth for brand identity, em-dash ban, UK English, omega-3 standardisation,
  // and other golden rules. Edited from the LLM page; applies to every
  // generation (automation + in-browser). Empty if the user hasn't saved one.
  let masterPreamble = '';
  try {
    const mp = await kv.get('vance:master-prompt');
    if (mp?.text?.trim()) {
      masterPreamble = `[GOLDEN RULES — apply to every section of the output]\n${mp.text.trim()}\n\n[CATEGORY PROMPT]\n`;
    }
  } catch (mpErr) {
    console.warn('Master prompt fetch failed (non-fatal):', mpErr.message);
  }

  // Per-category word ceiling set on the Categories page (vance:category-word-limits).
  // undefined => not configured for this category, fall back to the code default.
  let configuredWordLimit;
  try {
    const wl = await kv.get('vance:category-word-limits');
    if (wl?.categories && Object.prototype.hasOwnProperty.call(wl.categories, rule.category)) {
      configuredWordLimit = wl.categories[rule.category];
    }
  } catch (wlErr) {
    console.warn('Category word-limit fetch failed (non-fatal):', wlErr.message);
  }

  let fullPrompt;
  if (isTitleOnly) {
    // No source text expected — title IS the input. The prompt instructs the LLM to research.
    //
    // When the row carries an author-supplied note (from the multi-column
    // bulk-upload spreadsheet) AND/OR was uploaded with the explicit
    // requirement to keep the title verbatim, stitch both into the prompt:
    //   • TITLE   — must be used exactly; do not rewrite or shorten.
    //   • NOTE    — per-row research / writing-style focus for this article.
    // The category-level title-prefix (e.g. "Gastro Living: ") is still added
    // server-side by enforceCategoryPrefix() after the LLM returns.
    const hasRowNote = typeof item.rowNotes === 'string' && item.rowNotes.trim().length > 0;
    const isStructuredRow = hasRowNote || !!item.subCategory || !!item.tags;

    let promptTail = `\n\nTOPIC / TITLE: ${item.title}`;
    if (isStructuredRow) {
      promptTail += `\n\n=== ARTICLE BRIEF ===`;
      promptTail += `\nTITLE TO USE (verbatim — do not modify, shorten, or restructure): "${item.title}"`;
      if (hasRowNote) {
        promptTail += `\n\nEDITORIAL NOTE FOR THIS ARTICLE:`;
        promptTail += `\n${item.rowNotes.trim()}`;
        promptTail += `\n\nUse the editorial note above to focus your research and shape the writing style. The note describes the angle, the key sub-topics to cover, and any framing the editor wants emphasised. Treat it as instructions, not as content to quote.`;
      }
      promptTail += `\n=== END BRIEF ===`;
    }
    fullPrompt = `${masterPreamble}${basePrompt}${promptTail}`;
  } else {
    // Standard path: require source text extracted from the URL / file.
    let sourceText = (item.rawText || '').trim();
    if (sourceText.startsWith('__OCR_ERROR__:')) {
      throw new Error(`OCR failed for "${item.title}": ${sourceText.replace('__OCR_ERROR__:', '').trim()}`);
    }
    if (!sourceText) {
      const hint = item.sourceType === 'dropbox'
        ? 'Dropbox PDF/DOCX extraction is not supported — use a Google Drive source for PDFs, or upload .txt/.md files.'
        : 'Source text extraction returned empty. Check that the file is a readable PDF/DOCX and that Google Drive OCR succeeded.';
      throw new Error(`No source text for "${item.title}". ${hint}`);
    }
    // Safety belt: cap source text well below the smallest free-tier context window we use
    // (Llama 3.3 70B :free is 65k tokens). ~120k chars ≈ ~30k tokens.
    const MAX_SOURCE_CHARS = 120000;
    if (sourceText.length > MAX_SOURCE_CHARS) {
      sourceText = sourceText.slice(0, MAX_SOURCE_CHARS) + '\n\n[…source truncated for length…]';
    }
    fullPrompt = `${masterPreamble}${basePrompt}\n\nSOURCE FILE: ${item.title}\n\nSOURCE MATERIAL:\n${sourceText}`;
  }

  const chain = buildFallbackChain(primaryModel);
  let lastError = null;

  for (const [idx, model] of chain.entries()) {
    const data = await callLLM(model, fullPrompt, apiKey, fetchFn, {
      source: 'automation',
      isPickedVariant: idx === 0,
      variant: pickedVariant,
    });
    const text = data.choices?.[0]?.message?.content;

    if (text) {
      const lines = text.trim().split('\n');
      let title = item.title;
      let body = text.trim();
      if (lines[0].startsWith('#')) {
        title = lines[0].replace(/^#+\s*/, '').trim();
        body = lines.slice(1).join('\n').trimStart();
      }
      title = enforceCategoryPrefix(title, rule.category);
      const usedFallback = model !== primaryModel;
      const article = { title, body, model: usedFallback ? `${model} (fallback from ${primaryModel})` : model };
      // Deterministic length ceiling — compress in one extra pass if over the cap.
      return await enforceWordLimit(article, rule, { apiKey, fetchFn, primaryModel, configuredLimit: configuredWordLimit });
    }

    // Retry on rate limits, retired endpoints (404 no-endpoints), and transient 5xx
    if (shouldRetryWithNextModel(data)) {
      lastError = `${model}: ${data.error?.code} ${data.error?.message || ''}`.trim();
      continue;
    }

    // Non-retryable error — fail fast
    throw new Error(`LLM returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  }

  // Exhausted the chain
  throw new Error(`All ${chain.length} models in fallback chain failed. Last error: ${lastError || 'unknown'}`);
}

// ── Cron evaluation helpers (exported for testing) ────────────────────────────

export function evaluateCron(cronExpression, lastRunAt, now) {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(now),
    });
    const prev = interval.prev();
    const iso = prev.toISOString();
    if (!iso) return false;
    const prevDate = new Date(iso);
    const sinceDate = lastRunAt ? new Date(lastRunAt) : new Date(0);
    return prevDate > sinceDate;
  } catch {
    return false;
  }
}

export function isRuleDue(rule, now) {
  if (!rule.enabled) return false;
  const { trigger, lastRunAt } = rule;

  if (trigger.type === 'schedule') {
    return evaluateCron(trigger.cron, lastRunAt, now);
  }
  if (trigger.type === 'event') {
    // Event-driven: check on every cron tick, enforcing minGapHours
    if (!lastRunAt) return true;
    const gap = (new Date(now) - new Date(lastRunAt)) / (1000 * 60 * 60);
    return gap >= (trigger.minGapHours ?? 4);
  }
  // volume: deferred — returns false for now
  return false;
}

// ── Timeout processor ─────────────────────────────────────────────────────────

async function processTimeouts(now, fetchFn = fetch) {
  const ids = await kv.lrange('automation:jobs:index', 0, -1);
  // Reserve most of the 300s function budget for the generation pass that
  // follows. If we run long here we bail and remaining jobs are picked up
  // on the next cron tick.
  const startedAt = Date.now();
  const BUDGET_MS = 60000;

  // First pass: read jobs in parallel, filter to ones that need action.
  // Sequentially-awaited kv.get over a long index was the dominant cost.
  const jobs = await Promise.all(ids.map(id => kv.get(`automation:job:${id}`).then(j => ({ id, job: j }))));
  const due = [];
  for (const { id, job } of jobs) {
    if (!job || job.status !== 'pending_review') continue;
    due.push({ id, job });
  }
  if (!due.length) return;

  // Group by ruleId so we fetch each rule once, not per-job.
  const ruleIds = [...new Set(due.map(({ job }) => job.ruleId))];
  const rulesById = new Map();
  await Promise.all(ruleIds.map(async rid => rulesById.set(rid, await kv.get(`automation:rule:${rid}`))));

  for (const { id, job } of due) {
    if (Date.now() - startedAt > BUDGET_MS) {
      console.warn(`processTimeouts: time budget exhausted after ${(Date.now() - startedAt)}ms — deferring remaining ${due.length} job(s) to next cron tick`);
      return;
    }
    try {
      const rule = rulesById.get(job.ruleId);
      if (!rule) continue;
      const ageHours = (new Date(now) - new Date(job.createdAt)) / (1000 * 60 * 60);
      if (ageHours < rule.review.timeoutHours) continue;

      const onTimeout = rule.review.onTimeout ?? 'approve';
      if (onTimeout === 'approve' || onTimeout === 'reject') {
        await fetchFn(`${APP_URL}/api/automation/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id, action: onTimeout, channel: 'timeout' }),
        });
      } else if (onTimeout === 'urgent_reminder') {
        // One-shot URGENT reminder: fire another notification, then hold.
        if (!job.urgentReminderSentAt) {
          const content = await kv.get(`content:${job.contentId}`);
          if (content) {
            try {
              await sendNotifications({ rule, job, content, fetchFn, urgent: true });
            } catch (err) {
              console.error(`Urgent reminder send failed for job ${id}:`, err.message);
            }
          }
          await kv.set(`automation:job:${id}`, { ...job, urgentReminderSentAt: now, updatedAt: now });
        }
        // Subsequent cron ticks: leave the job in pending_review indefinitely.
      } else {
        // 'skip' — mark as timed out without actioning
        await kv.set(`automation:job:${id}`, { ...job, status: 'timed_out', updatedAt: now });
      }
    } catch (err) {
      console.error(`Timeout processing failed for job ${id}:`, err.message);
    }
  }
}

// ── One-shot migration: wipe stale custom prompts from every rule ─────────────
// The wizard no longer offers a freeform prompt — instead, prompts come from a
// dropdown of Categories-page prompts. To prevent old hardcoded prompts from
// silently overriding the category default at generation time, clear every
// rule's generation.prompt on the next handler invocation. Gated by a KV flag
// so it runs exactly once. Users who want a custom prompt re-pick from the
// new dropdown in the wizard.
const CLEAR_PROMPTS_MIGRATION_KEY = 'migration:clear-rule-prompts:v1';
async function migrateClearRulePromptsOnce() {
  try {
    const done = await kv.get(CLEAR_PROMPTS_MIGRATION_KEY);
    if (done) return;
    const ids = await kv.lrange('automation:rules:index', 0, -1);
    if (!ids.length) {
      await kv.set(CLEAR_PROMPTS_MIGRATION_KEY, { at: new Date().toISOString(), cleared: 0 });
      return;
    }
    const rules = (await Promise.all(ids.map(id => kv.get(`automation:rule:${id}`)))).filter(Boolean);
    let cleared = 0;
    const stamp = new Date().toISOString();
    await Promise.all(rules.map(async rule => {
      if (rule.generation && rule.generation.prompt) {
        await kv.set(`automation:rule:${rule.id}`, {
          ...rule,
          generation: { ...rule.generation, prompt: '' },
          updatedAt: stamp,
        });
        cleared++;
      }
    }));
    await kv.set(CLEAR_PROMPTS_MIGRATION_KEY, { at: stamp, cleared, scanned: rules.length });
  } catch (err) {
    console.error('migrateClearRulePromptsOnce failed:', err.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res, { fetchFn = fetch } = {}) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = new Date().toISOString();
  const results = { processed: 0, errors: [] };

  // 0. One-shot migration (no-op after first run).
  await migrateClearRulePromptsOnce();

  // 1. Process timeouts first (skip for manual single-rule runs)
  const forcedRuleId = req.method === 'POST' ? req.body?.ruleId : null;
  const forceFiles   = req.method === 'POST' ? (req.body?.forceFiles || null) : null;
  if (!forcedRuleId) await processTimeouts(now, fetchFn);

  // 2. Load rules — single forced rule or all due rules
  let dueRules;
  if (forcedRuleId) {
    const rule = await kv.get(`automation:rule:${forcedRuleId}`);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    dueRules = [rule];
  } else {
    const ids = await kv.lrange('automation:rules:index', 0, -1);
    if (!ids.length) return res.status(200).json({ ...results, message: 'No rules configured' });
    const rules = (await Promise.all(ids.map(id => kv.get(`automation:rule:${id}`)))).filter(Boolean);
    dueRules = rules.filter(r => isRuleDue(r, now));
  }

  for (const rule of dueRules) {
    // Per-rule concurrency lock. Without it, two overlapping invocations (e.g.
    // repeated "Run now" clicks, or a manual run racing the daily cron) both read
    // the same consumedTitles snapshot, both pick the same next title, and both
    // generate it — producing duplicate articles for one approved title. NX makes
    // acquisition atomic; the TTL (just over the 300s maxDuration) auto-frees the
    // lock if an invocation times out or crashes mid-run so the rule is never
    // wedged. Different rules still run concurrently — only same-rule runs serialize.
    const lockKey = `automation:rule:${rule.id}:run-lock`;
    const gotLock = await kv.set(lockKey, now, { nx: true, ex: 310 });
    if (!gotLock) {
      await writeLog({ ruleId: rule.id, ruleName: rule.name, level: 'warn',
        message: 'Skipped: another run is already in progress for this rule (concurrency lock held).' });
      continue;
    }
    try {
      // 3. Fetch sources.
      //   • lastRunAt is set to null on manual runs (forcedRuleId) so RSS/Drive/Sheets/Gmail
      //     surface all items irrespective of when the rule last fired.
      //   • forceAll only fires when the user explicitly picked items via "Re-process
      //     selected" — that's the signal to bypass consumption/processed filters so a
      //     re-run can revisit already-handled rows/papers. Plain "Run now" must still
      //     respect those filters so it picks the NEXT fresh item (otherwise daily-mode
      //     bibliography loops on papers[0] forever).
      let ruleAutoPublishedCount = 0;
      const forceAll = Array.isArray(forceFiles) && forceFiles.length > 0;
      let { items: sourceItems, sourceErrors } = await fetchSources(rule.sources, forcedRuleId ? null : rule.lastRunAt, fetchFn, rule.id, { forceAll });
      if (sourceErrors.length) {
        results.errors.push(...sourceErrors);
        for (const e of sourceErrors) await writeLog({ ruleId: rule.id, ruleName: rule.name, level: 'error', message: e });
      }
      // Optional file-name filter (from "Re-process selected" UI)
      if (forceFiles && forceFiles.length) {
        const allow = new Set(forceFiles);
        sourceItems = sourceItems.filter(it => allow.has(it.title));
      }
      if (!sourceItems.length) {
        const dbg = `Rule "${rule.name}": 0 source items returned. Sources: ${JSON.stringify(rule.sources.map(s => s.type))}, lastRunAt passed: ${forcedRuleId ? 'null (manual)' : rule.lastRunAt}`;
        results.errors.push(`[debug] ${dbg}`);
        await writeLog({ ruleId: rule.id, ruleName: rule.name, level: 'warn', message: dbg });
        continue;
      }

      // 4. Generate content (up to maxArticlesPerRun)
      // On Vercel Pro (300s maxDuration), each article costs ~25–35s (LLM)
      // + ~25–35s (hero image) + ~5s (notify) ≈ 55–75s observed in production.
      // Cap at 4 to guarantee all articles finish before the 300s wall.
      // For larger batches, trigger the run multiple times — each call picks up
      // the next batch of unprocessed items automatically.
      const requestedMax = rule.generation.maxArticlesPerRun;
      if (!requestedMax) results.errors.push(`[debug] maxArticlesPerRun is ${requestedMax} — no items will be processed`);
      const max = Math.min(requestedMax || 0, 4);

      // Resolve the hero image prompt template for this rule's category once per
      // run (per-category override wins, else the global default). undefined =>
      // media.js falls back to its built-in default template.
      let heroPromptTemplate;
      try {
        const hp = await kv.get('vance:hero-prompts');
        if (hp) {
          const perCat = hp.categories && hp.categories[rule.category];
          heroPromptTemplate = (perCat && perCat.trim()) ? perCat : (hp.default || undefined);
        }
      } catch (_) { /* non-fatal — fall back to media.js default */ }

      // WP sub-category implied by the rule's prompt preset (patient/practitioner
      // for clinical reviews). Per-item upload metadata still wins when present.
      const rulePromptSubCategory = subCategoryForRulePrompt(rule);

      const toProcess = sourceItems.slice(0, max);
      let ruleProcessedCount = 0;
      // Snapshot the pre-run stat baseline ONCE. We persist the rule after every
      // article (so a mid-run FUNCTION_INVOCATION_TIMEOUT can't lose consumed-source
      // tracking or the count of articles that actually completed). Each write derives
      // stats from this fixed baseline, so totalRuns lands on base+1 idempotently no
      // matter how many articles finish, and articlesGenerated tracks real progress.
      const statsBase = {
        totalRuns: rule.stats?.totalRuns ?? 0,
        articlesGenerated: rule.stats?.articlesGenerated ?? 0,
        articlesPublished: rule.stats?.articlesPublished ?? 0,
      };
      for (const item of toProcess) {
        // 4a. Call LLM to generate the article from source text
        let generated;
        try {
          generated = await generateArticle(item, rule, fetchFn);
        } catch (llmErr) {
          results.errors.push(`LLM generation failed for "${item.title}": ${llmErr.message}`);
          continue;
        }

        // 4b. Store the generated article
        // Derive a human-readable source-doc label for the email / review page.
        // Different source types stash provenance in different fields — pick the
        // most specific one we have. Falls back to the item title for sources
        // where we don't have a URL or filename (e.g. title-only uploads).
        const { sourceDocName, sourceDocUrl } = (function () {
          const t = item.sourceType;
          if (t === 'upload') {
            // Find the originating xlsx in rule.sources so we can name the file.
            // Multi-column uploads store entries in src.rows; legacy uploads use
            // src.titlesOnly / src.urls — match across all three.
            const fromUpload = (rule.sources || []).find(s => s && s.type === 'upload'
              && ((Array.isArray(s.urls) && s.urls.includes(item.url))
                || (Array.isArray(s.titlesOnly) && s.titlesOnly.includes(item.title))
                || (Array.isArray(s.rows) && s.rows.some(r => r && r.title === item.title))));
            const fname = fromUpload?.originalFilename || null;
            const label = fname
              ? (item.url ? `${fname} — ${item.url}` : `${fname} — ${item.title}`)
              : (item.url || item.title || null);
            return { sourceDocName: label, sourceDocUrl: item.url || null };
          }
          if (t === 'google_sheets' && item._sheetMeta) {
            const sm = item._sheetMeta;
            const sheetLabel = [sm.sheetName, sm.rowIndex ? `Row ${sm.rowIndex}` : null].filter(Boolean).join(' — ') || 'Google Sheet';
            return { sourceDocName: sheetLabel, sourceDocUrl: item.url || sm.sheetUrl || null };
          }
          if (t === 'bibliography' && item._bibMeta) {
            return { sourceDocName: item.title || 'Bibliography paper', sourceDocUrl: item.url || null };
          }
          if (t === 'gmail') {
            return { sourceDocName: item.title || 'Gmail message', sourceDocUrl: item.url || null };
          }
          if (t === 'github') {
            return { sourceDocName: item.title || item.url || 'GitHub file', sourceDocUrl: item.url || null };
          }
          if (t === 'google_drive' || t === 'dropbox') {
            return { sourceDocName: item.title || 'Cloud file', sourceDocUrl: item.url || null };
          }
          // rss / url / unknown
          return { sourceDocName: item.url || item.title || null, sourceDocUrl: item.url || null };
        })();

        const genRes = await fetchFn(`${APP_URL}/api/content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: generated.title,
            body: generated.body,
            model: generated.model,
            category: rule.category,
            wpCategorySlug: rule.wpCategorySlug ?? null,
            template: rule.generation.template,
            automationRuleId: rule.id,
            automationRuleName: rule.name,
            promptName: (rule.generation && rule.generation.promptName) || null,
            sourceDocName,
            sourceDocUrl,
            // Per-row metadata from the multi-column bulk-upload spreadsheet.
            // publish endpoint uses subCategory + tags to resolve / auto-create
            // WP terms; rowNotes is kept as provenance on the content record.
            // Per-row upload subCategory wins; otherwise fall back to the
            // prompt-derived sub-category (patient/practitioner clinical reviews).
            subCategory: item.subCategory || rulePromptSubCategory || null,
            tags: item.tags || null,
            rowNotes: item.rowNotes || null,
          }),
        });

        if (!genRes.ok) {
          results.errors.push(`Content store failed: ${generated.title}`);
          continue;
        }
        const content = await genRes.json();

        // 4b-i. If item came from an UPLOAD source, mark the row consumed so the next
        // scheduled run skips it. Mutates rule.sources in-memory; the end-of-rule
        // kv.set on rule will persist it.
        if (item.sourceType === 'upload') {
          for (const src of rule.sources) {
            if (src.type !== 'upload') continue;
            if (item.titleOnly) {
              // Structured-row uploads (multi-column spreadsheet) live in src.rows;
              // legacy Column-A-only uploads live in src.titlesOnly. Match by title
              // (the unique key in both cases) and record into consumedTitles either way.
              const inRows = Array.isArray(src.rows) && src.rows.some(r => r && r.title === item.title);
              const inTitlesOnly = Array.isArray(src.titlesOnly) && src.titlesOnly.includes(item.title);
              if (inRows || inTitlesOnly) {
                src.consumedTitles = Array.isArray(src.consumedTitles) ? src.consumedTitles : [];
                if (!src.consumedTitles.includes(item.title)) src.consumedTitles.push(item.title);
                break;
              }
            } else if (item.url) {
              if (Array.isArray(src.urls) && src.urls.includes(item.url)) {
                src.consumedUrls = Array.isArray(src.consumedUrls) ? src.consumedUrls : [];
                if (!src.consumedUrls.includes(item.url)) src.consumedUrls.push(item.url);
                break;
              }
            }
          }
        }

        // 4b-i-b. If item came from a Google Drive source, record the file id so
        // future runs skip it. This is the authoritative dedup for Drive —
        // independent of the modifiedTime window — and is what stops a doc
        // generated earlier in the day being re-used by a later (esp. manual) run.
        // Mutates rule.sources in-memory; the end-of-rule kv.set persists it.
        if (item.sourceType === 'google_drive' && item.fileId) {
          for (const src of rule.sources) {
            if (src.type !== 'google_drive') continue;
            // When a rule has multiple Drive sources, only mark the one the file
            // actually came from. Older items without sourceFolderId fall back to
            // the first Drive source.
            if (item.sourceFolderId && src.folderId !== item.sourceFolderId) continue;
            src.consumedFileIds = Array.isArray(src.consumedFileIds) ? src.consumedFileIds : [];
            if (!src.consumedFileIds.includes(item.fileId)) src.consumedFileIds.push(item.fileId);
            break;
          }
        }

        // 4b-ii. If item came from a Google Sheet row, write generation date + review link back to the sheet (non-fatal)
        if (item._sheetMeta) {
          try {
            await writeSheetGenerationNote(item._sheetMeta, { contentId: content.id, appUrl: APP_URL }, fetchFn);
          } catch (sheetErr) {
            results.errors.push(`Sheet writeback (generation) failed for "${generated.title}": ${sheetErr.message}`);
          }
        }

        // 4b-iii. If item came from a Bibliography source, flip the paper's
        // processed flag so the next run's fetchBibliographyPapers filter (which
        // matches on !p.processed) skips it. Without this, daily/all modes loop
        // on the same paper forever.
        if (item._bibMeta?.paperId) {
          try {
            const paper = await kv.get(`bibliography:paper:${item._bibMeta.paperId}`);
            if (paper && !paper.processed) {
              await kv.set(`bibliography:paper:${item._bibMeta.paperId}`, {
                ...paper,
                processed: true,
                processedAt: now,
                processedContentId: content.id,
                processedRuleId: rule.id,
              });
            }
          } catch (bibErr) {
            results.errors.push(`Bibliography writeback failed for "${generated.title}": ${bibErr.message}`);
          }
        }

        // 4c. Generate hero image with a 90s wall-clock budget. If image-gen
        // hangs beyond that, we save the article without an image and a later
        // cron pass / manual edit can fill it in. The fallback URL step below
        // will also pick up any category-level default.
        if (rule.generation.heroImage !== false) {
          const HERO_IMAGE_TIMEOUT_MS = 90_000;
          try {
            const imageData = await Promise.race([
              generateImageFast(generated.title, '16:9', heroPromptTemplate),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`hero image timed out after ${HERO_IMAGE_TIMEOUT_MS / 1000}s`)), HERO_IMAGE_TIMEOUT_MS)
              ),
            ]);
            if (imageData?.url) {
              const updated = { ...content, heroImageUrl: imageData.url, heroImageType: 'ai', updatedAt: now };
              await kv.set(`content:${content.id}`, updated);
              content.heroImageUrl = imageData.url;
              content.heroImageType = 'ai';
            }
          } catch (imgErr) {
            results.errors.push(`Hero image failed for "${generated.title}": ${imgErr.message}`);
            // Non-fatal — article still proceeds without image
          }
        }

        // 4d. If no hero image (disabled or generation failed), stamp the category-level
        // fallback URL on the content so manual publish and auto-publish reuse it.
        if (!content.heroImageUrl && rule.generation.heroImageFallbackUrl) {
          const updated = { ...content, heroImageUrl: rule.generation.heroImageFallbackUrl, heroImageType: 'category-fallback', updatedAt: now };
          await kv.set(`content:${content.id}`, updated);
          content.heroImageUrl = updated.heroImageUrl;
          content.heroImageType = updated.heroImageType;
        }

        if (rule.review.required) {
          // 5a. Create job and notify
          const job = buildJob({ ruleId: rule.id, contentId: content.id });
          await kv.set(`automation:job:${job.id}`, job);
          await kv.lpush('automation:jobs:index', job.id);

          const { errors: notifyErrors, reviewerIds } = await sendNotifications({ rule, job, content, fetchFn });
          if (notifyErrors.length) results.errors.push(...notifyErrors);

          // Mark job as notified AND stamp the resolved reviewer set so the approve
          // handler can enforce review.mode === 'all'. Re-read first so we don't
          // stomp a status change that landed during the sendNotifications window.
          const current = await kv.get(`automation:job:${job.id}`);
          if (current && !TERMINAL_STATUSES.includes(current.status)) {
            await kv.set(`automation:job:${job.id}`, {
              ...current,
              notifiedAt: now,
              reviewerIds: Array.isArray(reviewerIds) ? reviewerIds : [],
            });
          }

          // Sync the content item into 'in_review' so the Pipeline UI shows the
          // article as awaiting review (not 'draft'), and populate reviewers /
          // requireAllApprovals so the kanban progress bar reads "0/N approved".
          // Approvals start empty; the approve.js handler appends voterIds on each
          // partial approval. Without this sync, the article would appear stuck
          // at 'draft' until the approval threshold is reached.
          const ids = Array.isArray(reviewerIds) ? reviewerIds : [];
          const liveContent = await kv.get(`content:${content.id}`);
          if (liveContent && liveContent.status === 'draft') {
            await kv.set(`content:${content.id}`, {
              ...liveContent,
              status: 'in_review',
              reviewers: ids,
              approvals: [],
              rejections: [],
              requireAllApprovals: (rule.review?.mode ?? 'any') === 'all',
              sentForReviewAt: now,
              updatedAt: now,
            });
          }
        } else {
          // 5b. Auto-publish immediately. Publish endpoint enforces
          // content.status === 'approved' | 'scheduled', so bump the freshly
          // stored draft to 'approved' before calling — otherwise publish
          // returns HTTP 400 silently and the article is lost in 'draft'.
          await kv.set(`content:${content.id}`, {
            ...content, status: 'approved', approvedAt: now, updatedAt: now,
          });
          const publishRes = await fetchFn(`${APP_URL}/api/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contentId: content.id }),
          });
          const finalStatus = publishRes.ok ? 'auto_published' : 'approved'; // fallback if publish fails
          if (publishRes.ok) ruleAutoPublishedCount++;

          // If item came from a Google Sheet, write the WP URL back to that row (non-fatal)
          if (publishRes.ok && item._sheetMeta) {
            try {
              const publishData = await publishRes.clone().json();
              if (publishData?.wpPostUrl) {
                await writeSheetPublishNote(item._sheetMeta, publishData.wpPostUrl, fetchFn);
              }
            } catch (sheetErr) {
              results.errors.push(`Sheet writeback (publish) failed for "${generated.title}": ${sheetErr.message}`);
            }
          }

          const job = buildJob({ ruleId: rule.id, contentId: content.id, status: finalStatus });
          await kv.set(`automation:job:${job.id}`, { ...job, approvedBy: 'auto', approvedAt: now });
          await kv.lpush('automation:jobs:index', job.id);
        }
        ruleProcessedCount++;
        results.processed++;
        await writeLog({
          ruleId: rule.id,
          ruleName: rule.name,
          level: 'success',
          message: `Generated article: ${generated.title}`
            + (generated.wordCount ? ` (${generated.wordCount} body words${generated.compressed ? ', compressed to fit limit' : ''})` : ''),
          contentId: content.id,
        });

        // 6. Persist the rule after EVERY article. This is the durable checkpoint:
        // it captures consumed-source tracking (so the next run skips handled items)
        // and up-to-date stats, so a mid-run timeout leaves both correct rather than
        // rolling the whole invocation back. Stats derive from the fixed baseline:
        // totalRuns = base+1 (this invocation counts as one run regardless of how
        // many articles finish), generated/published track actual completions.
        rule.lastRunAt = now;
        rule.updatedAt = now;
        rule.stats = {
          ...rule.stats,
          totalRuns: statsBase.totalRuns + 1,
          articlesGenerated: statsBase.articlesGenerated + ruleProcessedCount,
          articlesPublished: statsBase.articlesPublished + ruleAutoPublishedCount,
        };
        await kv.set(`automation:rule:${rule.id}`, rule);
      }
    } catch (err) {
      results.errors.push(`Rule ${rule.id}: ${err.message}`);
      await writeLog({ ruleId: rule.id, ruleName: rule.name, level: 'error', message: err.message });
    } finally {
      // Release the lock so a subsequent run can pick up the next batch. The TTL
      // is only a crash backstop — normal completion frees it immediately.
      await kv.del(lockKey).catch(() => {});
    }
  }

  return res.status(200).json(results);
}
// (Drive per-file dedup via consumedFileIds; clinical-review sub-category via subCategoryForRulePrompt)
