// Writes .env from the running local Supabase stack (npx supabase start).
// Keeps an existing automation key so n8n workflows stay valid.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ENV = path.join(__dirname, '..', '.env');
const parse = (text) => Object.fromEntries(text.split(/\r?\n/)
  .map((l) => l.match(/^([A-Z0-9_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));

const status = parse(execSync('npx supabase status -o env', { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
if (!status.API_URL || !status.SERVICE_ROLE_KEY) {
  console.error('Supabase is not running. Start it with: npx supabase start');
  process.exit(1);
}
const old = fs.existsSync(ENV) ? parse(fs.readFileSync(ENV, 'utf8')) : {};

const env = {
  PORT: old.PORT || '3000',
  PUBLIC_URL: old.PUBLIC_URL || 'http://localhost:3000',
  SUPABASE_URL: status.API_URL,
  PUBLIC_SUPABASE_URL: old.PUBLIC_SUPABASE_URL || status.API_URL,
  SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  AUTOMATION_KEY: old.AUTOMATION_KEY || crypto.randomBytes(24).toString('base64url'),
  REQUIRE_STAFF_MFA: old.REQUIRE_STAFF_MFA || 'false',
};

fs.writeFileSync(ENV, `${[
  '# Written by npm run setup. Keep this file private: the service role key bypasses all security rules.',
  ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
].join('\n')}\n`);
console.log(`Wrote ${ENV}`);
console.log(`Supabase Studio: ${status.STUDIO_URL || 'http://127.0.0.1:54323'}   Test inbox: ${status.INBUCKET_URL || status.MAILPIT_URL || 'http://127.0.0.1:54324'}`);
