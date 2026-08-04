#!/usr/bin/env node
/**
 * Set a Vercel environment variable from a file, without the interactive prompt.
 *
 *   node scripts/set-env-from-file.mjs GOOGLE_OAUTH_CLIENT_SECRET ./secret.txt
 *   node scripts/set-env-from-file.mjs GOOGLE_OAUTH_CLIENT_SECRET ./secret.txt preview
 *
 * Why this exists rather than `vercel env add` on its own:
 *
 * 1. **The prompt is the problem.** `vercel env add` masks the value it is
 *    reading, so a paste shows nothing and looks like it failed — and in some
 *    terminals it genuinely does not arrive. Reading from a file removes the
 *    interaction entirely.
 *
 * 2. **Piping mangles it.** `Get-Content x | vercel env add` appends a newline
 *    in PowerShell, so the stored secret is one byte longer than the real one.
 *    Google answers `invalid_client`, which reads exactly like a revoked
 *    credential and sends you to the Cloud console instead of the env var.
 *    This trims, then writes the exact bytes to a temp file and redirects it in.
 *
 * 3. **It replaces cleanly.** `vercel env add` refuses when the variable already
 *    exists in that environment, so a second attempt fails with a message that
 *    sounds like a permissions problem. This removes first.
 *
 * The value is never printed, never passed as an argv (argv is visible in the
 * process list), and the temp file is deleted in a finally block.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [name, file, target = 'production'] = process.argv.slice(2);

if (!name || !file) {
  console.error('Usage: node scripts/set-env-from-file.mjs <VAR_NAME> <file> [production|preview|development]');
  process.exit(1);
}

let value;
try {
  value = readFileSync(file, 'utf8');
} catch (err) {
  console.error(`Could not read ${file}: ${err.code || err.message}`);
  process.exit(1);
}

// Strip a UTF-8 BOM as well as whitespace — Notepad and PowerShell's Out-File
// both add one, and it is invisible in every editor that would show you the file.
const clean = value.replace(/^﻿/, '').trim();

if (!clean) {
  console.error(`${file} is empty after trimming. Nothing to set.`);
  process.exit(1);
}
if (/\s/.test(clean)) {
  console.error(`Refusing: the value in ${file} contains whitespace in the middle, so it is probably not just a credential.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'vercel-env-'));
const exact = join(dir, 'value');

try {
  // No trailing newline: this file IS the value.
  writeFileSync(exact, clean, { encoding: 'utf8' });

  // Remove any existing value, so this is a set rather than an add that refuses.
  try {
    execFileSync('npx', ['--yes', 'vercel@latest', 'env', 'rm', name, target, '--yes'], {
      stdio: 'ignore', shell: true,
    });
  } catch {
    /* not present — that is the normal case */
  }

  execFileSync(
    'cmd',
    ['/c', `npx --yes vercel@latest env add ${name} ${target} < "${exact}"`],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );

  console.log(`\n${name} set for ${target} — ${clean.length} characters, no surrounding whitespace.`);
  console.log(`Delete ${file} now; it still holds the plaintext value.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
