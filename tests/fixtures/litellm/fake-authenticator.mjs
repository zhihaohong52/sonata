#!/usr/bin/env node
// Stands in for the Python interpreter that owns litellm. `loginGateway`
// spawns it with `-c <script>`; we ignore the script and read our behaviour
// from FAKE_MODE, so the test controls the outcome without a network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_MODE ?? 'success';
const dir = process.env.CHATGPT_TOKEN_DIR ?? process.env.GITHUB_COPILOT_TOKEN_DIR;
const file = process.env.CHATGPT_TOKEN_DIR ? 'auth.json' : 'api-key.json';

// Captured verbatim from litellm 1.82.3 chatgpt/authenticator.py:162-168.
console.log('Sign in with ChatGPT using device code:');
console.log('1) Visit https://auth.openai.com/codex/device');
console.log('2) Enter code: WDJB-MJHT');
console.log('Device codes are a common phishing target. Never share this code.');

if (mode === 'hang') { setTimeout(() => {}, 60_000); }
else if (mode === 'exit-nonzero') { console.error('GetAccessTokenError: Timed out'); process.exit(1); }
else if (mode === 'exit-zero-no-credential') { process.exit(0); }
else {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ access_token: 'fake' }));
  process.exit(0);
}
