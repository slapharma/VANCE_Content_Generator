export const HOOK_ARCHETYPES = [
  {
    id: 'curiosity_gap',
    label: 'Curiosity Gap',
    template: (topic) => `The one thing ${topic} isn't telling you…`,
  },
  {
    id: 'bold_claim',
    label: 'Bold Claim',
    template: (topic) => `You don't need [common assumption] to [desired result] — here's what actually works`,
  },
  {
    id: 'list_number',
    label: 'List/Number',
    template: (topic) => `3 things most clinicians miss about ${topic}`,
  },
  {
    id: 'relatability',
    label: 'Relatability',
    template: (topic) => `POV: You've just reviewed 40 patients and none hit their targets`,
  },
  {
    id: 'direct_callout',
    label: 'Direct Call-Out',
    template: (topic) => `If you're a clinician not sharing ${topic} updates, you're invisible online`,
  },
];

// Returns archetype for platform slot — cycles through 5 archetypes so each platform gets a different one
export function pickArchetype(platformIndex) {
  return HOOK_ARCHETYPES[platformIndex % HOOK_ARCHETYPES.length];
}

export const CTA_TEMPLATES = {
  grow:    'Follow @gastrohealthhub for weekly clinical insights',
  engage:  'Comment YES below if this changed how you think about this',
  convert: 'DM us or click the link in bio to learn more',
  save:    'Save this for later and share with a colleague who needs it',
};

export const PILLAR_INSTRUCTIONS = {
  educate:   'This content should build clinical authority. Lead with a surprising fact, data point, or insight that genuinely teaches something. Tone: expert but accessible.',
  entertain: 'This content should be relatable and human. Show the real experience of clinicians and patients. Tone: warm, honest, slightly vulnerable.',
  sell:      'This content should convert interest to action. Lead with a result or testimonial. Make the offer clear. Tone: confident, specific, outcome-focused.',
};

export const PLATFORM_CONFIGS = {
  instagram: {
    maxChars: 2200,
    hashtagCount: '5-8',
    tone: 'engaging, emojis welcome, hook must stop the scroll in under 3 seconds',
    generateReelScript: true,
    imageAspect: '4:5',
    videoAspect: '9:16',
  },
  tiktok: {
    maxChars: 300,
    hashtagCount: '3-5',
    tone: 'hook-first, casual, punchy — written for 18-35 year olds who care about health',
    generateReelScript: true,
    videoAspect: '9:16',
  },
  linkedin: {
    maxChars: 1300,
    hashtagCount: '3-5',
    tone: 'professional, data-backed insight lead, business outcome CTA — no emojis',
    generateReelScript: false,
    imageAspect: '1:1',
  },
  twitter: {
    maxChars: 280,
    hashtagCount: '1-2 per tweet',
    tone: 'concise, punchy, each tweet must stand alone AND chain as a thread',
    generateReelScript: false,
    threadLength: 3,
  },
  facebook: {
    maxChars: 2000,
    hashtagCount: '3-5',
    tone: 'conversational, shareable — end with a question to drive comments',
    generateReelScript: false,
    imageAspect: '1:1',
  },
  substack: {
    maxChars: 600,
    hashtagCount: 'none',
    tone: 'newsletter teaser — compelling summary that makes readers want to click through',
    generateReelScript: false,
  },
};

// Build the full system prompt for a given platform + pillar + CTA + archetype
export function buildPlatformPrompt(platform, pillar, ctaGoal, archetype, articleTitle, articleExcerpt) {
  if (!PLATFORM_CONFIGS[platform])   throw new Error(`Unknown platform: "${platform}". Valid: ${Object.keys(PLATFORM_CONFIGS).join(', ')}`);
  if (!PILLAR_INSTRUCTIONS[pillar])  throw new Error(`Unknown pillar: "${pillar}". Valid: ${Object.keys(PILLAR_INSTRUCTIONS).join(', ')}`);
  if (!CTA_TEMPLATES[ctaGoal])       throw new Error(`Unknown ctaGoal: "${ctaGoal}". Valid: ${Object.keys(CTA_TEMPLATES).join(', ')}`);

  const cfg = PLATFORM_CONFIGS[platform];
  const pillarInstruction = PILLAR_INSTRUCTIONS[pillar];
  const ctaText = CTA_TEMPLATES[ctaGoal];
  const hookTemplate = archetype.template(articleTitle);

  const isThread = platform === 'twitter';
  const hasReelScript = cfg.generateReelScript;

  let prompt = `You are a social media expert applying the Ava personal brand methodology for Gastro Health Hub, a clinical intelligence platform focused on inflammatory bowel disease.

CONTENT PILLAR: ${pillar.toUpperCase()}
${pillarInstruction}

HOOK ARCHETYPE: ${archetype.label}
Hook inspiration (adapt, don't copy literally): "${hookTemplate}"

PLATFORM: ${platform} — Tone: ${cfg.tone}
Character limit: ${cfg.maxChars} chars${isThread ? ' per tweet' : ''}
Hashtags: ${cfg.hashtagCount} (clinical/medical niche — e.g. #IBD #Gastro #ClinicalUpdate)
CTA to use (adapt naturally): "${ctaText}"

ARTICLE TITLE: ${articleTitle}
ARTICLE EXCERPT:
${articleExcerpt}

`;

  if (isThread) {
    prompt += `OUTPUT FORMAT — write a thread of exactly 3 tweets. Format:
TWEET 1: [text — the hook, grabs attention]
TWEET 2: [text — the value, delivers the insight]
TWEET 3: [text — the CTA, one clear action]

Each tweet must be self-contained AND flow as a thread. No "1/3" numbering. Write only the tweet text — no labels, no preamble.`;
  } else if (hasReelScript) {
    prompt += `OUTPUT FORMAT — write two things separated by ---SCRIPT---:

1. CAPTION: The Instagram/TikTok caption with hashtags. Start with the hook. End with CTA. Max ${cfg.maxChars} chars.

---SCRIPT---

2. REEL SCRIPT: A short-form video script for filming. Format:
HOOK: [First 1-3 seconds. One punchy sentence that stops the scroll. Written to be spoken on camera.]
BODY: [20-25 seconds of value. Short sentences, max 10 words each. Stage directions in [brackets]. Numbered points work well. Conversational English — write how people talk, not how they write.]
CTA: [5 seconds. Single clear action. Spoken directly to camera.]
DURATION: [estimated seconds, e.g. "28s"]

Write ONLY the output in this format. No preamble, no "Here is your caption:".`;
  } else {
    prompt += `Write ONLY the post caption with hashtags. Start with the hook. End with the CTA naturally woven in. No preamble, no labels.`;
  }

  return prompt;
}
