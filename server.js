// 2A Group Corp petition platform: API for the client portal, staff dashboard and n8n.
// Data, files and sign-in live in Supabase. People sign in with Supabase Auth (Bearer
// token); n8n authenticates with the automation key (x-automation-key header).
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const {
  listPresets, getPreset, applicableQuestions, applicableChecklist, applicableForms,
} = require('./lib/presets');
const { validateCase } = require('./lib/validate');
const { assemble } = require('./lib/assemble');
const repo = require('./lib/repo');

const { sb, must } = repo;
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const AUTOMATION_KEY = process.env.AUTOMATION_KEY || '';
const REQUIRE_STAFF_MFA = process.env.REQUIRE_STAFF_MFA === 'true';
const STAGES = ['Intake', 'Collecting documents', 'Attorney review', 'Corrections needed', 'Ready to print', 'Filed', 'Receipt received', 'Biometrics', 'Interview', 'Decision', 'Closed'];
const OPEN_STAGES = ['Intake', 'Collecting documents', 'Corrections needed'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/supabase.js', (req, res) => res.sendFile(require.resolve('@supabase/supabase-js/dist/umd/supabase.js')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ---- authentication ------------------------------------------------------------

const tokenCache = new Map();

function keyMatches(given) {
  if (!AUTOMATION_KEY || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(AUTOMATION_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return {}; }
}

async function userFromToken(token) {
  const hit = tokenCache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return null;
  const profile = must(await sb.from('profiles').select('*').eq('id', data.user.id).maybeSingle());
  if (!profile) return null;
  const user = { id: profile.id, role: profile.role, name: profile.full_name || profile.email, email: profile.email, aal: jwtClaims(token).aal };
  tokenCache.set(token, { user, until: Date.now() + 60 * 1000 });
  if (tokenCache.size > 2000) tokenCache.clear();
  return user;
}

const auth = wrap(async (req, res, next) => {
  if (req.get('x-automation-key')) {
    if (!keyMatches(req.get('x-automation-key'))) return res.status(401).json({ error: 'Bad automation key' });
    req.user = { id: null, role: 'automation', name: 'n8n automation' };
    return next();
  }
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = token && await userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Please sign in' });
  if (REQUIRE_STAFF_MFA && repo.STAFF_ROLES.includes(user.role) && user.aal !== 'aal2') {
    return res.status(403).json({ error: 'Two-step verification is required for staff', mfaRequired: true });
  }
  req.user = user;
  next();
});

const staffOnly = (req, res, next) => (repo.isStaff(req.user) ? next() : res.status(403).json({ error: 'Staff only' }));
const automationOnly = (req, res, next) => (req.user.role === 'automation' ? next() : res.status(403).json({ error: 'Automation only' }));
const attorneyOnly = (req, res, next) => (repo.isAttorney(req.user) ? next() : res.status(403).json({ error: 'Only an attorney can do this' }));

// Loads the case and checks the caller may open it.
function withCase(handler) {
  return wrap(async (req, res) => {
    const c = await repo.loadCase(req.params.id);
    if (!c || !repo.canAccess(req.user, c)) return res.status(404).json({ error: 'Case not found' });
    await handler(req, res, c);
  });
}

const audienceOf = (user) => (user.role === 'client' ? 'client' : 'staff');

// Client view hides staff-only questions and documents, internal notes and history.
async function caseView(c, user) {
  const audience = audienceOf(user);
  const preset = getPreset(c.preset);
  const a = c.answers || {};
  const questions = applicableQuestions(preset, a, { audience });
  const view = {
    id: c.id,
    caseNumber: c.caseNumber,
    clientName: c.clientName,
    preset: { id: preset.id, name: preset.name, summary: preset.summary, confidential: !!preset.confidential, confidentialityNote: preset.confidentialityNote, filing: preset.filing },
    stage: c.stage,
    receiptNumber: c.receiptNumber,
    createdAt: c.createdAt,
    answers: audience === 'staff' ? a : Object.fromEntries(questions.filter((q) => q.id in a).map((q) => [q.id, a[q.id]])),
    questions,
    checklist: applicableChecklist(preset, a, { audience }).map((item) => ({
      ...item,
      documents: c.documents.filter((d) => d.checklistId === item.id),
    })),
    messages: c.messages.filter((m) => audience === 'staff' || !m.internal),
  };
  if (audience === 'staff') {
    view.clientEmail = c.clientEmail;
    view.clientLinked = !!c.clientId;
    view.team = c.team;
    view.forms = applicableForms(preset, a, { includeUnchosen: true });
    view.packages = c.packages;
    view.validation = validateCase(c);
    view.assemblyNote = preset.assemblyNote;
    view.deadlines = must(await sb.from('deadlines').select('*').eq('case_id', c.id).order('due_date'));
    view.audit = must(await sb.from('audit_log').select('*').eq('case_id', c.id).order('at', { ascending: false }).limit(100))
      .map((x) => ({ at: x.at, actor: x.actor_name ? `${x.actor_name} (${x.actor_role})` : x.actor_role, action: x.action, detail: x.detail }));
  }
  return view;
}

async function respondCase(res, id, user, status = 200) {
  const c = await repo.loadCase(id);
  res.status(status).json(await caseView(c, user));
}

// Recalculates readiness after a change to answers or documents.
async function contentChanged(c, extra = {}) {
  await repo.updateCase(c.id, { content_changed_at: new Date().toISOString(), ...extra });
  const fresh = await repo.loadCase(c.id);
  await repo.refreshCase(fresh);
}

// ---- public ---------------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Public values the browser needs to sign in (the anon key is meant to be public).
app.get('/api/config', (req, res) => res.json({
  supabaseUrl: process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  requireStaffMfa: REQUIRE_STAFF_MFA,
}));

app.use('/api', auth);

app.get('/api/me', (req, res) => res.json(req.user));

app.get('/api/presets', (req, res) => {
  res.json(listPresets().map((p) => ({ id: p.id, name: p.name, summary: p.summary, confidential: !!p.confidential, forms: p.forms.map((f) => `${f.form} (${f.edition})`) })));
});

app.get('/api/presets/:pid', staffOnly, (req, res) => {
  const p = getPreset(req.params.pid);
  if (!p) return res.status(404).json({ error: 'Preset not found' });
  res.json(p);
});

// Form editions the presets were built against, for the n8n weekly USCIS check.
app.get('/api/editions', staffOnly, (req, res) => {
  const seen = new Map();
  for (const p of listPresets()) {
    for (const f of p.forms) {
      if (!/^\d{2}\/\d{2}\/\d{2}$/.test(f.edition) || seen.has(f.form)) continue;
      const slug = f.form.toLowerCase().split(' ')[0];
      seen.set(f.form, { form: f.form, edition: f.edition, url: `https://www.uscis.gov/${slug}`, usedBy: [] });
    }
    for (const f of p.forms) if (seen.has(f.form)) seen.get(f.form).usedBy.push(p.id);
  }
  // Supplements and companion "A" forms (I-130A, I-539A) live on the parent form's page.
  res.json([...seen.values()].filter((e) => !/supplement/i.test(e.form) && !/^I-\d+A$/.test(e.form)));
});

// ---- cases ----------------------------------------------------------------------

async function visibleCaseRows(user) {
  if (user.role === 'client') {
    return must(await sb.from('cases').select('*').eq('client_id', user.id).order('created_at', { ascending: false }));
  }
  const rows = must(await sb.from('cases').select('*, case_team(staff_id)').order('updated_at', { ascending: false }));
  return rows.filter((r) => repo.canAccess(user, { ...repo.toCase(r), team: (r.case_team || []).map((t) => ({ id: t.staff_id })) }));
}

app.get('/api/cases', wrap(async (req, res) => {
  const rows = await visibleCaseRows(req.user);
  if (req.user.role === 'client') {
    return res.json(rows.map((r) => ({ id: r.id, caseNumber: r.case_number, preset: getPreset(r.preset).name, stage: r.stage })));
  }
  const ids = rows.map((r) => r.id);
  const [unread, pkgs] = ids.length ? await Promise.all([
    sb.from('messages').select('case_id').in('case_id', ids).eq('sender_role', 'client').is('read_by_staff_at', null),
    sb.from('packages').select('case_id, version, status').in('case_id', ids).order('version'),
  ]) : [{ data: [] }, { data: [] }];
  const unreadBy = {};
  must(unread).forEach((m) => { unreadBy[m.case_id] = (unreadBy[m.case_id] || 0) + 1; });
  const lastPkg = {};
  must(pkgs).forEach((p) => { lastPkg[p.case_id] = p; });
  res.json(rows.map((r) => {
    const p = getPreset(r.preset);
    return {
      id: r.id, caseNumber: r.case_number, clientName: r.client_name, preset: p.name, presetId: p.id, confidential: r.confidential,
      stage: r.stage, ready: r.ready, unreviewed: !!(r.readiness && r.readiness.unreviewed), missingDocuments: r.missing_documents, missingAnswers: r.missing_answers,
      unreadFromClient: unreadBy[r.id] || 0, lastPackage: lastPkg[r.id] || null, updatedAt: r.updated_at,
    };
  }));
}));

// Finds the client's account by email or sends them an invitation to set a password.
async function linkClient(email, fullName) {
  const existing = must(await sb.from('profiles').select('id, role').eq('email', email).maybeSingle());
  if (existing) return { id: existing.id, invited: false, role: existing.role };
  const { data, error } = await sb.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: `${PUBLIC_URL}/login.html`,
  });
  if (error) throw new Error(`Could not invite ${email}: ${error.message}`);
  return { id: data.user.id, invited: true, role: 'client' };
}

app.post('/api/cases', staffOnly, wrap(async (req, res) => {
  const { clientName, clientEmail, preset, team } = req.body || {};
  const p = getPreset(preset || '');
  if (!clientName || !p) return res.status(400).json({ error: 'Client name and a valid case type are required' });
  const email = clientEmail ? String(clientEmail).trim().toLowerCase() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Client email is not valid' });
  let client = null;
  if (email) {
    client = await linkClient(email, clientName);
    if (client.role !== 'client') return res.status(400).json({ error: 'That email belongs to a staff account' });
  }
  const row = must(await sb.from('cases').insert({
    client_name: String(clientName).slice(0, 200), client_email: email, client_id: client?.id || null,
    preset: p.id, confidential: !!p.confidential, created_by: req.user.id,
  }).select().single());
  // Whoever opens a restricted case is put on its team so they can keep working on it.
  const asked = Array.isArray(team) && team.length
    ? must(await sb.from('profiles').select('id').in('id', team.map(String)).in('role', repo.STAFF_ROLES)).map((p) => p.id) : [];
  const members = new Set([...asked, ...(req.user.id ? [req.user.id] : [])]);
  if (members.size) must(await sb.from('case_team').insert([...members].map((id) => ({ case_id: row.id, staff_id: id }))));
  await repo.audit(row.id, req.user, 'case created', `${p.name}${client?.invited ? `; invitation sent to ${email}` : ''}`);
  const c = await repo.loadCase(row.id);
  await repo.refreshCase(c);
  res.status(201).json({ ...(await caseView(c, req.user)), invited: !!client?.invited });
}));

app.get('/api/cases/:id', withCase(async (req, res, c) => {
  const now = new Date().toISOString();
  if (audienceOf(req.user) === 'staff' && req.user.role !== 'automation') {
    await sb.from('messages').update({ read_by_staff_at: now }).eq('case_id', c.id).eq('sender_role', 'client').is('read_by_staff_at', null);
  } else if (req.user.role === 'client') {
    await sb.from('messages').update({ read_by_client_at: now }).eq('case_id', c.id).neq('sender_role', 'client').eq('internal', false).is('read_by_client_at', null);
  }
  if (req.user.role !== 'automation') await repo.audit(c.id, req.user, 'viewed case');
  res.json(await caseView(c, req.user));
}));

app.put('/api/cases/:id/answers', withCase(async (req, res, c) => {
  const preset = getPreset(c.preset);
  const client = req.user.role === 'client';
  const allowed = new Set(preset.questions.filter((q) => !client || !q.staffOnly).map((q) => q.id));
  if (!client) allowed.add('_includeForms');
  const answers = { ...c.answers };
  const changed = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.has(k)) continue;
    const value = typeof v === 'string' ? v.slice(0, 10000) : Array.isArray(v) ? v.map(String).slice(0, 50) : v;
    if (JSON.stringify(answers[k]) !== JSON.stringify(value)) changed.push(k);
    answers[k] = value;
  }
  if (changed.length) {
    await repo.updateCase(c.id, { answers });
    await repo.audit(c.id, req.user, 'answers updated', changed.join(', '));
    await contentChanged({ ...c, answers }, client ? { last_client_activity_at: new Date().toISOString() } : {});
  }
  await respondCase(res, c.id, req.user);
}));

app.put('/api/cases/:id/stage', staffOnly, withCase(async (req, res, c) => {
  const stage = String(req.body.stage || '');
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage' });
  const fields = { stage };
  if (typeof req.body.receiptNumber === 'string') fields.receipt_number = req.body.receiptNumber.trim().slice(0, 20) || null;
  await repo.updateCase(c.id, fields);
  await repo.audit(c.id, req.user, 'stage changed', `${c.stage} -> ${stage}${fields.receipt_number ? ` (receipt ${fields.receipt_number})` : ''}`);
  res.json({ stage });
}));

app.put('/api/cases/:id/team', attorneyOnly, withCase(async (req, res, c) => {
  const ids = Array.isArray(req.body.staffIds) ? req.body.staffIds.map(String) : [];
  const staff = ids.length ? must(await sb.from('profiles').select('id').in('id', ids).in('role', repo.STAFF_ROLES)) : [];
  must(await sb.from('case_team').delete().eq('case_id', c.id));
  if (staff.length) must(await sb.from('case_team').insert(staff.map((s) => ({ case_id: c.id, staff_id: s.id }))));
  await repo.audit(c.id, req.user, 'team changed', `${staff.length} member(s)`);
  await respondCase(res, c.id, req.user);
}));

app.post('/api/cases/:id/documents', upload.array('files', 20), withCase(async (req, res, c) => {
  const { checklistId } = req.body;
  const preset = getPreset(c.preset);
  const item = applicableChecklist(preset, c.answers, { audience: audienceOf(req.user) }).find((i) => i.id === checklistId);
  if (!item) return res.status(400).json({ error: 'Unknown checklist item' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Choose at least one file' });
  const bad = [];
  for (const f of req.files) {
    const kind = repo.checkUpload(f);
    if (!kind) { bad.push(f.originalname); continue; }
    const storagePath = await repo.storeDocument(c.id, f, kind);
    const client = req.user.role === 'client';
    must(await sb.from('documents').insert({
      case_id: c.id, checklist_id: checklistId, original_name: f.originalname.slice(0, 200), storage_path: storagePath,
      mime_type: kind.mime, size_bytes: f.size, uploaded_by: req.user.id, uploaded_role: req.user.role,
      status: client ? 'pending' : 'accepted',
    }));
    await repo.audit(c.id, req.user, 'document uploaded', `${checklistId}: ${f.originalname}`);
  }
  if (bad.length === req.files.length) return res.status(400).json({ error: 'Upload PDF, JPG or PNG files only' });
  await contentChanged(c, req.user.role === 'client' ? { last_client_activity_at: new Date().toISOString() } : {});
  const view = await caseView(await repo.loadCase(c.id), req.user);
  res.status(201).json({ ...view, skipped: bad });
}));

app.patch('/api/cases/:id/documents/:docId', staffOnly, withCase(async (req, res, c) => {
  const d = c.documents.find((x) => x.id === req.params.docId);
  if (!d) return res.status(404).json({ error: 'Document not found' });
  const fields = { reviewed_by: req.user.id, reviewed_at: new Date().toISOString() };
  if (['accepted', 'rejected', 'pending'].includes(req.body.status)) fields.status = req.body.status;
  if (typeof req.body.note === 'string') fields.note = req.body.note.slice(0, 500);
  must(await sb.from('documents').update(fields).eq('id', d.id));
  await repo.audit(c.id, req.user, `document ${fields.status || d.status}`, `${d.originalName}${fields.note ? `: ${fields.note}` : ''}`);
  await contentChanged(c);
  await respondCase(res, c.id, req.user);
}));

// Returns a 2-minute link to the file after logging who opened it.
app.get('/api/cases/:id/documents/:docId/link', withCase(async (req, res, c) => {
  const d = c.documents.find((x) => x.id === req.params.docId);
  if (!d) return res.status(404).json({ error: 'Document not found' });
  await repo.audit(c.id, req.user, 'document opened', d.originalName);
  res.json({ url: await repo.signedUrl(repo.DOC_BUCKET, d.storedName) });
}));

app.post('/api/cases/:id/messages', withCase(async (req, res, c) => {
  const text = String(req.body.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  await repo.insertMessage(c.id, req.user, text, !!req.body.internal);
  if (req.user.role === 'client') await repo.updateCase(c.id, { last_client_activity_at: new Date().toISOString() });
  await respondCase(res, c.id, req.user, 201);
}));

app.get('/api/cases/:id/validate', staffOnly, withCase(async (req, res, c) => {
  res.json({ caseId: c.id, ...validateCase(c) });
}));

// ---- petition package --------------------------------------------------------------

async function buildPackage(c, user, { force = false } = {}) {
  const v = validateCase(c);
  if (!v.ready && !force) return { built: false, validation: v };
  const result = await assemble(c, { draft: true, readFile: repo.readDocument });
  const version = (c.packages.at(-1)?.version || 0) + 1;
  const draftPath = `${c.id}/v${version}-draft.pdf`;
  await repo.storePackage(draftPath, result.bytes);
  const row = must(await sb.from('packages').insert({
    case_id: c.id, version, status: 'draft', draft_path: draftPath, page_count: result.pageCount,
    exhibits: result.exhibits, sections: result.sections, notes: result.notes, forced: !v.ready, built_by: user.name || user.role,
  }).select().single());
  await repo.updateCase(c.id, { stage: 'Attorney review' });
  await repo.audit(c.id, user, 'package built', `v${version}, ${result.pageCount} pages${!v.ready ? ' (forced with missing items)' : ''}`);
  return { built: true, package: repo.toPkg(row), validation: v };
}

app.post('/api/cases/:id/assemble', staffOnly, withCase(async (req, res, c) => {
  const r = await buildPackage(c, req.user, { force: !!(req.body && req.body.force) });
  if (!r.built) return res.status(422).json({ caseId: c.id, built: false, ...r.validation });
  res.status(201).json({ caseId: c.id, ...r });
}));

const packageName = (c, pkg, kind) => `${c.clientName.replace(/[^\w]+/g, '_')}_${c.preset}_v${pkg.version}${kind === 'draft' ? '_DRAFT' : ''}.pdf`;

app.get('/api/cases/:id/packages/:v/:kind(draft|final)/link', staffOnly, withCase(async (req, res, c) => {
  const pkg = c.packages.find((p) => String(p.version) === req.params.v);
  const file = pkg && (req.params.kind === 'final' ? pkg.finalFile : pkg.file);
  if (!file) return res.status(404).json({ error: req.params.kind === 'final' ? 'Not approved yet' : 'Package not found' });
  await repo.audit(c.id, req.user, `${req.params.kind} ${req.params.kind === 'draft' ? 'opened' : 'downloaded'}`, `v${pkg.version}`);
  // Drafts open in the browser for review; the approved final downloads for printing.
  res.json({ url: await repo.signedUrl(repo.PKG_BUCKET, file, req.params.kind === 'final' ? packageName(c, pkg, 'final') : undefined) });
}));

// Attorney approval rebuilds the package without the draft banner; only then is the
// printable final available.
app.post('/api/cases/:id/packages/:v/approve', attorneyOnly, withCase(async (req, res, c) => {
  const pkg = c.packages.find((p) => String(p.version) === req.params.v);
  if (!pkg || pkg.status !== 'draft') return res.status(404).json({ error: 'No draft with that version' });
  const result = await assemble(c, { draft: false, readFile: repo.readDocument });
  const finalPath = `${c.id}/v${pkg.version}-final.pdf`;
  await repo.storePackage(finalPath, result.bytes);
  const row = must(await sb.from('packages').update({
    status: 'approved', final_path: finalPath, final_page_count: result.pageCount,
    approved_by: req.user.id, approved_by_name: req.user.name, approved_at: new Date().toISOString(),
  }).eq('id', pkg.id).select().single());
  await repo.updateCase(c.id, { stage: 'Ready to print' });
  await repo.audit(c.id, req.user, 'package approved', `v${pkg.version}`);
  res.json({ caseId: c.id, package: repo.toPkg(row) });
}));

app.post('/api/cases/:id/packages/:v/reject', attorneyOnly, withCase(async (req, res, c) => {
  const pkg = c.packages.find((p) => String(p.version) === req.params.v);
  if (!pkg || pkg.status !== 'draft') return res.status(404).json({ error: 'No draft with that version' });
  const reason = String((req.body && req.body.reason) || '').slice(0, 1000);
  const row = must(await sb.from('packages').update({ status: 'returned', return_reason: reason }).eq('id', pkg.id).select().single());
  await repo.updateCase(c.id, { stage: 'Corrections needed' });
  await repo.audit(c.id, req.user, 'package returned', reason);
  res.json({ caseId: c.id, package: repo.toPkg(row) });
}));

// ---- dashboard and team --------------------------------------------------------------

app.get('/api/dashboard', staffOnly, wrap(async (req, res) => {
  const rows = await visibleCaseRows(req.user);
  const ids = rows.map((r) => r.id);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const soon = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const [deadlines, drafts] = ids.length ? await Promise.all([
    sb.from('deadlines').select('*').in('case_id', ids).eq('done', false).lte('due_date', soon).order('due_date').limit(30),
    sb.from('packages').select('case_id, version').in('case_id', ids).eq('status', 'draft'),
  ]) : [{ data: [] }, { data: [] }];
  const stages = {};
  rows.forEach((r) => { stages[r.stage] = (stages[r.stage] || 0) + 1; });
  res.json({
    totals: {
      open: rows.filter((r) => !['Filed', 'Decision', 'Closed'].includes(r.stage)).length,
      readyToBuild: rows.filter((r) => r.ready && OPEN_STAGES.includes(r.stage)).length,
      awaitingAttorney: must(drafts).length,
      waitingOnClient: rows.filter((r) => r.missing_documents + r.missing_answers > 0 && OPEN_STAGES.includes(r.stage)).length,
      toReview: rows.filter((r) => r.readiness && r.readiness.unreviewed).length,
    },
    stages,
    deadlines: must(deadlines).map((d) => ({ ...d, clientName: byId[d.case_id]?.client_name, caseNumber: byId[d.case_id]?.case_number })),
  });
}));

app.get('/api/staff', staffOnly, wrap(async (req, res) => {
  res.json(must(await sb.from('profiles').select('id, full_name, email, role').in('role', repo.STAFF_ROLES).order('full_name')));
}));

// Admins invite staff; the role is stored in app_metadata, which users cannot change.
app.post('/api/staff/invite', wrap(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can invite staff' });
  const { email, fullName, role } = req.body || {};
  if (!email || !repo.STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'Email and a staff role are required' });
  const { data, error } = await sb.auth.admin.inviteUserByEmail(String(email).toLowerCase(), {
    data: { full_name: fullName || '' }, redirectTo: `${PUBLIC_URL}/login.html`,
  });
  if (error) return res.status(400).json({ error: error.message });
  await sb.auth.admin.updateUserById(data.user.id, { app_metadata: { role } });
  must(await sb.from('profiles').update({ role, full_name: fullName || '' }).eq('id', data.user.id));
  await repo.audit(null, req.user, 'staff invited', `${email} as ${role}`);
  res.status(201).json({ id: data.user.id, email, role });
}));

// ---- automation (n8n) ------------------------------------------------------------------

const auto = express.Router();
auto.use(automationOnly);

// What n8n needs to decide on an event. Only what the client may see is returned for
// client messages; the event body itself carries ids only.
auto.get('/cases/:id/summary', withCase(async (req, res, c) => {
  const v = validateCase(c);
  const preset = getPreset(c.preset);
  const items = applicableChecklist(preset, c.answers);
  const doc = req.query.documentId ? c.documents.find((d) => d.id === req.query.documentId) : null;
  res.json({
    caseId: c.id, caseNumber: c.caseNumber, firstName: c.clientName.split(' ')[0], preset: preset.name, presetId: preset.id,
    stage: c.stage, receiptNumber: c.receiptNumber, hasClientAccount: !!c.clientId, ready: v.ready,
    clientMissingDocuments: v.missingDocuments.filter((d) => !d.staffOnly).map((d) => d.label),
    missingAnswers: v.missingAnswers.length,
    lastPackage: c.packages.at(-1) || null,
    document: doc ? { id: doc.id, name: doc.originalName, status: doc.status, note: doc.note, item: items.find((i) => i.id === doc.checklistId)?.label || doc.checklistId } : null,
  });
}));

auto.post('/cases/:id/refresh', withCase(async (req, res, c) => {
  const v = await repo.refreshCase(c);
  res.json({ caseId: c.id, ready: v.ready });
}));

// Builds a draft only when the case is ready and changed since the last package,
// so repeated events never pile up identical drafts.
auto.post('/cases/:id/auto-assemble', withCase(async (req, res, c) => {
  const last = c.packages.at(-1);
  if (last && last.status === 'draft' && new Date(last.createdAt) >= new Date(c.contentChangedAt)) {
    return res.json({ built: false, reason: 'A current draft already exists' });
  }
  if (last && last.status !== 'draft' && new Date(last.approvedAt || last.createdAt) >= new Date(c.contentChangedAt)) {
    return res.json({ built: false, reason: `Last package was ${last.status}; nothing changed since` });
  }
  const r = await buildPackage(c, req.user);
  res.status(r.built ? 201 : 200).json(r.built ? { built: true, version: r.package.version, pages: r.package.pageCount } : { built: false, reason: 'Not ready', errors: r.validation.errors });
}));

auto.post('/cases/:id/message', withCase(async (req, res, c) => {
  const text = String(req.body.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  const msg = await repo.insertMessage(c.id, req.user, text, !!req.body.internal);
  if (req.body.kind === 'reminder') await repo.updateCase(c.id, { last_reminder_at: new Date().toISOString() });
  await repo.audit(c.id, req.user, req.body.internal ? 'internal note added' : 'client messaged', req.body.kind || '');
  res.status(201).json({ id: msg.id });
}));

// Daily: refresh every open case (time-based USCIS rules change readiness), then list
// clients to remind and the deadlines staff should see.
auto.post('/daily', wrap(async (req, res) => {
  const rows = must(await sb.from('cases').select('id').not('stage', 'in', '("Decision","Closed")'));
  const reminders = [];
  for (const { id } of rows) {
    const c = await repo.loadCase(id);
    const v = await repo.refreshCase(c);
    const row = must(await sb.from('cases').select('last_reminder_at').eq('id', id).single());
    const lastTouch = Math.max(new Date(row.last_reminder_at || 0), new Date(c.contentChangedAt || 0));
    const missing = v.missingDocuments.filter((d) => !d.staffOnly).map((d) => d.label);
    if (c.clientId && OPEN_STAGES.includes(c.stage) && (missing.length || v.missingAnswers.length) && Date.now() - lastTouch > 7 * 86400000) {
      reminders.push({ caseId: id, firstName: c.clientName.split(' ')[0], missingDocuments: missing, missingAnswers: v.missingAnswers.length });
    }
  }
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const deadlines = must(await sb.from('deadlines').select('title, due_date, severity, cases(case_number, client_name)').eq('done', false).lte('due_date', soon).order('due_date'));
  res.json({
    refreshed: rows.length,
    reminders,
    deadlines: deadlines.map((d) => ({ title: d.title, due: d.due_date, severity: d.severity, caseNumber: d.cases?.case_number, client: d.cases?.client_name })),
  });
}));

app.use('/api/automation', auto);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`2A Group Corp platform running at ${PUBLIC_URL}`);
  console.log(`  n8n reaches it at http://host.docker.internal:${PORT}`);
});
