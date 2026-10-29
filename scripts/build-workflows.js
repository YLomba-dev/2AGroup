// Generates the two automatic n8n workflows (case events, daily reminders) in n8n/.
// Run after editing the message wording here: node scripts/build-workflows.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'n8n');
const H = { sendHeaders: true, headerParameters: { parameters: [{ name: 'x-automation-key', value: '__AUTOMATION_KEY__' }] } };
const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters, id: `d3f7a0c2-${String(id).padStart(4, '0')}-4c00-9000-${String(id).padStart(12, '0')}`, name, type, typeVersion, position, ...extra,
});
function link(...names) {
  const c = {};
  for (let i = 0; i < names.length - 1; i++) (c[names[i]] = c[names[i]] || { main: [[]] }).main[0].push({ node: names[i + 1], type: 'main', index: 0 });
  return c;
}
function merge(...cs) {
  const o = {};
  for (const c of cs) for (const [k, v] of Object.entries(c)) { o[k] = o[k] || { main: [[]] }; o[k].main[0].push(...v.main[0]); }
  return o;
}

const decide = String.raw`// Decides what happens after each change in the database. Returns zero or more actions.
// Client messages use only what the client may see; internal notes stay with staff.
const e = $('Case event').first().json.body;
const s = $input.first().json;
const out = [];
const act = (action, body = {}) => out.push({ json: { caseId: s.caseId, action, body } });
const msg = (text, extra = {}) => act('message', { text, kind: e.event, ...extra });
const hi = 'Hello ' + s.firstName + ',';

switch (e.event) {
  case 'case.ready':
    // Everything required is in: build the draft package for attorney review.
    act('auto-assemble');
    break;
  case 'case.created':
    if (s.hasClientAccount) msg(hi + ' welcome to your 2A Group Corp portal for your ' + s.preset + ' case (' + s.caseNumber + ').\nStart with the Documents tab: upload each item on the list (a clear phone photo is fine). Then answer the questions in "My information". You can write to us here any time.');
    break;
  case 'document.reviewed':
    if (s.document && s.document.status === 'rejected') msg(hi + ' we reviewed "' + s.document.name + '" for "' + s.document.item + '" and need a new file.' + (s.document.note ? '\nWhat to fix: ' + s.document.note : '') + '\nPlease upload it again in the Documents tab.');
    break;
  case 'package.built':
    if (e.version === 1 && !e.forced) msg(hi + ' good news: we have everything we need. Your attorney is now reviewing your ' + s.preset + ' petition. We will write here if anything else is needed.');
    msg('Draft v' + e.version + ' was built' + (e.forced ? ' with missing items (forced)' : '') + ' and is waiting for attorney approval.', { internal: true });
    break;
  case 'package.approved':
    msg(hi + ' your attorney approved your petition. We are printing it and will send it to USCIS. We will tell you here when it is mailed and when the receipt arrives.');
    break;
  case 'package.returned':
    msg('The attorney returned draft v' + e.version + '. See the Package tab for the changes needed.', { internal: true });
    break;
  case 'case.stage_changed': {
    const text = {
      'Filed': 'your petition was mailed to USCIS. The receipt notice usually arrives by mail within a few weeks. Please send us a photo of it when it comes.',
      'Receipt received': 'USCIS received your petition' + (s.receiptNumber ? ' (receipt number ' + s.receiptNumber + ')' : '') + '. You can check its status at egov.uscis.gov/casestatus. Keep the notice in a safe place.',
      'Biometrics': 'USCIS will schedule a biometrics appointment (fingerprints and photo). Bring the appointment notice and your ID. Tell us right away if you cannot go on that date.',
      'Interview': 'your case is at the interview stage. We will contact you to prepare. Bring the originals of every document you sent.',
      'Decision': 'USCIS made a decision on your case. We will contact you to explain it and the next steps.',
    }[e.to];
    if (text) msg(hi + ' ' + text);
    break;
  }
}
return out;`;

const reminders = String.raw`// One friendly reminder per client who has had missing items for a week.
const r = $input.first().json.reminders || [];
return r.map((x) => {
  const lines = x.missingDocuments.map((d) => '- ' + d);
  if (x.missingAnswers) lines.push('- ' + x.missingAnswers + ' question(s) in "My information"');
  return { json: { caseId: x.caseId, body: { kind: 'reminder', text: 'Hello ' + x.firstName + ', a friendly reminder from 2A Group Corp. To prepare your filing we still need:\n' + lines.join('\n') + '\nYou can upload documents and answer questions in your portal. Write to us if you have trouble getting anything.' } } };
});`;

const digest = String.raw`// Staff digest of deadlines in the next 30 days.
const d = $input.first().json;
const lines = (d.deadlines || []).map((x) => x.due + '  ' + x.client + ' (' + x.caseNumber + '): ' + x.title);
return [{ json: { subject: '2A daily digest: ' + lines.length + ' deadline(s) in 30 days, ' + d.reminders.length + ' reminder(s) sent', text: lines.join('\n') || 'No deadlines in the next 30 days.' } }];`;

const events = {
  id: 'Ev7Qm2cAseEvnt01',
  name: '2A - Case events (automatic)',
  nodes: [
    node(1, 'Case event', 'n8n-nodes-base.webhook', 2, [0, 300], { httpMethod: 'POST', path: 'case-event', responseMode: 'onReceived', options: {} }, { webhookId: '2a-case-event' }),
    node(2, 'Case summary', 'n8n-nodes-base.httpRequest', 4.2, [240, 300], { url: "=__API_BASE__/api/automation/cases/{{ $json.body.caseId }}/summary?documentId={{ $json.body.documentId || '' }}", ...H, options: {} }),
    node(3, 'Decide what to do', 'n8n-nodes-base.code', 2, [480, 300], { jsCode: decide }),
    node(4, 'Do it (build draft or message)', 'n8n-nodes-base.httpRequest', 4.2, [720, 300], { method: 'POST', url: '=__API_BASE__/api/automation/cases/{{ $json.caseId }}/{{ $json.action }}', ...H, sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.body }}', options: {} }),
  ],
  connections: link('Case event', 'Case summary', 'Decide what to do', 'Do it (build draft or message)'),
  settings: { executionOrder: 'v1', timezone: 'America/New_York' },
  pinData: {},
};

const daily = {
  id: 'Dy4Rk9DailyJob01',
  name: '2A - Daily reminders and deadlines',
  nodes: [
    node(11, 'Every day 7am', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 300], { rule: { interval: [{ field: 'days', triggerAtHour: 7 }] } }),
    node(12, 'Refresh cases and list reminders', 'n8n-nodes-base.httpRequest', 4.2, [240, 300], { method: 'POST', url: '__API_BASE__/api/automation/daily', ...H, options: {} }),
    node(13, 'Write reminders', 'n8n-nodes-base.code', 2, [480, 200], { jsCode: reminders }),
    node(14, 'Send reminder in portal', 'n8n-nodes-base.httpRequest', 4.2, [720, 200], { method: 'POST', url: '=__API_BASE__/api/automation/cases/{{ $json.caseId }}/message', ...H, sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.body }}', options: {} }),
    node(15, 'Write staff digest', 'n8n-nodes-base.code', 2, [480, 420], { jsCode: digest }),
    node(16, 'Send digest (connect email or Slack here)', 'n8n-nodes-base.noOp', 1, [720, 420], {}),
  ],
  connections: merge(
    link('Every day 7am', 'Refresh cases and list reminders', 'Write reminders', 'Send reminder in portal'),
    link('Refresh cases and list reminders', 'Write staff digest', 'Send digest (connect email or Slack here)'),
  ),
  settings: { executionOrder: 'v1', timezone: 'America/New_York' },
  pinData: {},
};

fs.writeFileSync(path.join(OUT, 'case-events.workflow.json'), `${JSON.stringify(events, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'daily-reminders.workflow.json'), `${JSON.stringify(daily, null, 2)}\n`);
console.log('Wrote n8n/case-events.workflow.json and n8n/daily-reminders.workflow.json');
