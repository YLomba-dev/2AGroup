// Imports every workflow in n8n/ into the n8n Docker container with this install's
// automation key and API address filled in, publishes them, and restarts n8n so the
// webhooks and schedules start. The weekly edition check stays off until it has an alert.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTAINER = process.env.N8N_CONTAINER || 'n8n';
const API_BASE = process.env.N8N_API_BASE || `http://host.docker.internal:${process.env.PORT || 3000}`;
const KEY = process.env.AUTOMATION_KEY;
const KEEP_OFF = ['ZIOijRHJMX7oq0L3'];
if (!KEY) { console.error('AUTOMATION_KEY missing: run npm run setup first'); process.exit(1); }

const dir = path.join(__dirname, '..', 'n8n');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '2a-n8n-'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.workflow.json'))) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8').replaceAll('__AUTOMATION_KEY__', KEY).replaceAll('__API_BASE__', API_BASE);
  const wf = JSON.parse(text);
  const local = path.join(tmp, file);
  fs.writeFileSync(local, text);
  docker('cp', local, `${CONTAINER}:/tmp/${file}`);
  docker('exec', CONTAINER, 'n8n', 'import:workflow', `--input=/tmp/${file}`);
  docker('exec', '-u', 'root', CONTAINER, 'rm', '-f', `/tmp/${file}`);
  if (!KEEP_OFF.includes(wf.id)) docker('exec', CONTAINER, 'n8n', 'publish:workflow', `--id=${wf.id}`);
  console.log(`${KEEP_OFF.includes(wf.id) ? 'imported (off)' : 'imported + on'}  ${wf.name}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
docker('restart', CONTAINER);
console.log(`Restarted ${CONTAINER}. Workflows call ${API_BASE}.`);
