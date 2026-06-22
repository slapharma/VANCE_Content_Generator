// Restore the rule's generation.prompt by copying "Prompt Updated 12/06"
// from vance:article-prompts (already clean + updated) into the rule.
// The rule's current prompt was corrupted by PowerShell ConvertTo-Json.

const KV_URL   = 'https://nearby-werewolf-76207.upstash.io';
const KV_TOKEN = 'gQAAAAAAASmvAAIncDI3MjExMjExZWM1NGE0MGNlYjYxNzZiODg1ODEzNWY5MnAyNzYyMDc';
const RULE_KEY = 'automation:rule:rule_0102c605-e526-4e28-9720-6af838abd66d';

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  return (await r.json()).result;
}

async function kvSet(key, obj) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(obj),
  });
  return (await r.json()).result;
}

// 1. Get the clean "Prompt Updated 12/06" text from vance:article-prompts
const apRaw = await kvGet('vance:article-prompts');
const ap = JSON.parse(apRaw);
const ibdPrompts = ap.categories?.['ibd-living'] || [];
const promptEntry = ibdPrompts.find(p => p.name === 'Prompt Updated 12/06');
if (!promptEntry) { console.error('Prompt Updated 12/06 not found in vance:article-prompts'); process.exit(1); }
console.log('Source prompt length:', promptEntry.text.length);
console.log('Source STRICT MAXIMUM:', promptEntry.text.includes('STRICT MAXIMUM'));

// 2. Get the current rule (may be corrupted — parse what we can)
const ruleRaw = await kvGet(RULE_KEY);
let rule;
try {
  rule = JSON.parse(ruleRaw);
  console.log('Rule JSON parsed cleanly.');
} catch (e) {
  // Corrupted — we know the rule structure. Reconstruct generation.prompt from scratch.
  // Extract everything except generation.prompt using a targeted regex.
  console.log('Rule JSON corrupt — patching prompt field via string replacement...');
  // Replace the "prompt":"..." field value with our clean prompt
  // Find the prompt field boundaries carefully
  const promptKey = '"prompt":';
  const promptStart = ruleRaw.indexOf(promptKey);
  if (promptStart === -1) { console.error('Cannot find prompt field'); process.exit(1); }
  const valueStart = promptStart + promptKey.length;
  // The value starts with " — find its real end by using the next known top-level key
  // We'll use a simpler approach: replace everything from "prompt":" to the next ",
  // by injecting the clean JSON-escaped prompt text
  const cleanPrompt = JSON.stringify(promptEntry.text); // produces "the escaped string"
  const beforePrompt = ruleRaw.slice(0, valueStart);
  // Find end of the corrupt prompt value: scan forward for ","heroImage" or ","model"
  // which are sibling keys in generation{}
  const nextKeyMatch = ruleRaw.slice(valueStart).match(/","(heroImage|model|maxArticles|subCategory)/);
  if (!nextKeyMatch) { console.error('Cannot find end of prompt field'); process.exit(1); }
  const afterPromptOffset = valueStart + ruleRaw.slice(valueStart).indexOf(nextKeyMatch[0]);
  const afterPrompt = ruleRaw.slice(afterPromptOffset);
  const patched = beforePrompt + cleanPrompt + afterPrompt;
  rule = JSON.parse(patched);
  console.log('String replacement repair succeeded.');
}

console.log('Rule name:', rule.name);
console.log('Rule category:', rule.category);

// 3. Set the clean prompt
rule.generation.prompt = promptEntry.text;
console.log('Prompt applied. STRICT MAXIMUM:', rule.generation.prompt.includes('STRICT MAXIMUM'));

// 4. Write back with proper JSON.stringify
const writeResult = await kvSet(RULE_KEY, rule);
console.log('KV write:', writeResult);

// 5. Verify
const verifyRaw = await kvGet(RULE_KEY);
const v = JSON.parse(verifyRaw);
console.log('Verify name:', v.name);
console.log('Verify prompt length:', v.generation.prompt.length);
console.log('Verify STRICT MAXIMUM:', v.generation.prompt.includes('STRICT MAXIMUM'));
console.log('Done.');
