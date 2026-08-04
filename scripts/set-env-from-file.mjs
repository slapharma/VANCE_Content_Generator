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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Run from the repo, whatever directory the caller is standing in. Derived from
   this file's own location rather than process.cwd(): the Vercel CLI resolves
   the project from .vercel/project.json in its working directory, so invoking
   this from C:\WINDOWS\system32 — where a fresh PowerShell opens — otherwise
   fails with a message about the project, not about the directory. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Launching npx on Windows takes more care than it looks.
   - `npx` alone: not an executable, so execFile cannot find it.
   - `npx.cmd`: Node 24 refuses to spawn .cmd/.bat without a shell (a deliberate
     security change), and fails so early that the child produces no output at
     all — which looks like the CLI failing silently rather than never starting.
   - `shell: true`: works, but puts the arguments back through cmd's quoting.
   So: run cmd.exe, which is a real .exe, and hand it the arguments already
   separated. No quoting to get wrong, and the value still goes down stdin. */
const launcher = process.platform === 'win32' ? 'cmd.exe' : 'npx';
const prefix = process.platform === 'win32' ? ['/c', 'npx'] : [];

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

// Remove any existing value first: `env add` refuses when the variable already
// exists, and its message reads like a permissions problem rather than a
// duplicate. Absent is the normal case, so a failure here is not interesting.
try {
  execFileSync(launcher, [...prefix, '--yes', 'vercel@latest', 'env', 'rm', name, target, '--yes'], {
    cwd: REPO,
    stdio: 'ignore',
  });
} catch {
  /* not present */
}

try {
  execFileSync(launcher, [...prefix, '--yes', 'vercel@latest', 'env', 'add', name, target], {
    cwd: REPO,
    // The value goes straight down stdin as exact bytes — no temp file, no
    // shell redirect, and no trailing newline. Node closes the pipe afterwards,
    // which is the EOF the CLI reads as end-of-value.
    input: clean,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
} catch (err) {
  console.error(`\nFailed to set ${name}. Vercel's own output is above.`);
  process.exit(err.status || 1);
}

console.log(`\n${name} set for ${target} — ${clean.length} characters, no surrounding whitespace.`);
console.log(`Delete ${file} now; it still holds the plaintext value.`);
