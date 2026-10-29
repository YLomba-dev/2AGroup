// Supabase data layer. The server uses the service-role key, so every access check
// happens here and in server.js before a query runs (RLS guards direct client access).
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getPreset } = require('./presets');
const { validateCase } = require('./validate');
const { computeDeadlines } = require('./deadlines');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (run: npm run setup)');
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DOC_BUCKET = 'case-documents';
const PKG_BUCKET = 'packages';
const STAFF_ROLES = ['staff', 'attorney', 'admin'];

function must({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// ---- mapping rows to the case shape validate.js and assemble.js expect ------

const toDoc = (d) => ({
  id: d.id, checklistId: d.checklist_id, originalName: d.original_name, storedName: d.storage_path,
  mimeType: d.mime_type, size: d.size_bytes, uploadedBy: d.uploaded_role, uploadedAt: d.created_at,
  status: d.status, note: d.note, reviewedAt: d.reviewed_at,
});

const toMsg = (m) => ({
  id: m.id, from: m.sender_role, text: m.body, internal: m.internal, at: m.created_at,
  readByStaff: !!m.read_by_staff_at, readByClient: !!m.read_by_client_at,
});

const toPkg = (p) => ({
  id: p.id, version: p.version, status: p.status, file: p.draft_path, finalFile: p.final_path,
  createdAt: p.created_at, builtBy: p.built_by, pageCount: p.page_count, finalPageCount: p.final_page_count,
  exhibits: p.exhibits, sections: p.sections, notes: p.notes, forced: p.forced,
  approved: p.status === 'approved', approvedBy: p.approved_by_name, approvedAt: p.approved_at,
  rejected: p.status === 'returned', rejectReason: p.return_reason,
});

function toCase(row) {
  return {
    id: row.id, caseNumber: row.case_number, clientId: row.client_id, clientName: row.client_name,
    clientEmail: row.client_email, preset: row.preset, confidential: row.confidential, stage: row.stage,
    answers: row.answers || {}, receiptNumber: row.receipt_number, createdAt: row.created_at,
    contentChangedAt: row.content_changed_at, ready: row.ready,
    missingDocuments: row.missing_documents, missingAnswers: row.missing_answers,
  };
}

async function loadCase(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const row = must(await sb.from('cases').select('*').eq('id', id).maybeSingle());
  if (!row) return null;
  const [docs, msgs, pkgs, team] = await Promise.all([
    sb.from('documents').select('*').eq('case_id', id).order('created_at'),
    sb.from('messages').select('*').eq('case_id', id).order('created_at'),
    sb.from('packages').select('*').eq('case_id', id).order('version'),
    sb.from('case_team').select('staff_id, role, profiles(full_name, email, role)').eq('case_id', id),
  ]);
  return {
    ...toCase(row),
    documents: must(docs).map(toDoc),
    messages: must(msgs).map(toMsg),
    packages: must(pkgs).map(toPkg),
    team: must(team).map((t) => ({ id: t.staff_id, role: t.role, name: t.profiles?.full_name, email: t.profiles?.email })),
  };
}

// ---- access ------------------------------------------------------------------

const isStaff = (user) => user && (STAFF_ROLES.includes(user.role) || user.role === 'automation');
const isAttorney = (user) => user && ['attorney', 'admin'].includes(user.role);

// Same rule as public.staff_can_access(): restricted cases only for the team,
// attorneys and admins.
function canAccess(user, c) {
  if (!user || !c) return false;
  if (user.role === 'automation') return true;
  if (user.role === 'client') return c.clientId === user.id;
  if (!STAFF_ROLES.includes(user.role)) return false;
  return !c.confidential || isAttorney(user) || (c.team || []).some((t) => t.id === user.id);
}

// ---- writes -------------------------------------------------------------------

async function audit(caseId, user, action, detail = '') {
  must(await sb.from('audit_log').insert({
    case_id: caseId, actor_id: user?.id || null, actor_role: user?.role || 'system',
    actor_name: user?.name || null, action, detail: String(detail || '').slice(0, 2000),
  }));
}

async function updateCase(id, fields) {
  must(await sb.from('cases').update(fields).eq('id', id));
}

// Recalculates readiness and deadlines; the cases.ready flip fires the n8n "case.ready" event.
async function refreshCase(c, today = new Date()) {
  const preset = getPreset(c.preset);
  const v = validateCase(c, today);
  const dl = computeDeadlines(preset, c.answers, today);
  const kinds = dl.map((d) => d.kind);
  if (dl.length) {
    must(await sb.from('deadlines').upsert(dl.map((d) => ({
      case_id: c.id, kind: d.kind, title: d.title, due_date: d.due, severity: d.severity, updated_at: new Date().toISOString(),
    })), { onConflict: 'case_id,kind' }));
  }
  let del = sb.from('deadlines').delete().eq('case_id', c.id);
  if (kinds.length) del = del.not('kind', 'in', `(${kinds.map((k) => `"${k}"`).join(',')})`);
  must(await del);
  // Ready to build = nothing missing and every upload reviewed by staff, so the automatic
  // draft never includes a file nobody has looked at.
  const unreviewed = (c.documents || []).some((d) => d.status === 'pending');
  const ready = v.ready && !unreviewed;
  await updateCase(c.id, {
    ready, missing_documents: v.missingDocuments.length, missing_answers: v.missingAnswers.length,
    readiness: { errors: v.errors, warnings: v.warnings, unreviewed, checkedAt: new Date().toISOString() },
  });
  c.ready = ready;
  return v;
}

async function insertMessage(caseId, user, text, internal = false) {
  const role = user.role === 'client' ? 'client' : user.role === 'automation' ? 'automation' : 'staff';
  return must(await sb.from('messages').insert({
    case_id: caseId, sender_id: user.id || null, sender_role: role, body: text,
    internal: role !== 'client' && !!internal,
  }).select().single());
}

// ---- files --------------------------------------------------------------------

const MAGIC = {
  '.pdf': (b) => b.subarray(0, 4).toString('latin1') === '%PDF',
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
};
const MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

// Checks the file content, not only the name, before it is stored.
function checkUpload(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!MAGIC[ext] || !MAGIC[ext](file.buffer)) return null;
  return { ext, mime: MIME[ext] };
}

async function storeDocument(caseId, file, kind) {
  const storagePath = `${caseId}/${crypto.randomUUID()}${kind.ext}`;
  must(await sb.storage.from(DOC_BUCKET).upload(storagePath, file.buffer, { contentType: kind.mime }));
  return storagePath;
}

async function readDocument(doc) {
  const data = must(await sb.storage.from(DOC_BUCKET).download(doc.storedName));
  return Buffer.from(await data.arrayBuffer());
}

async function storePackage(storagePath, bytes) {
  must(await sb.storage.from(PKG_BUCKET).upload(storagePath, Buffer.from(bytes), { contentType: 'application/pdf', upsert: true }));
}

// Short-lived link; downloads still go through the server first so they are audited.
async function signedUrl(bucket, storagePath, downloadName) {
  const opts = downloadName ? { download: downloadName } : undefined;
  const data = must(await sb.storage.from(bucket).createSignedUrl(storagePath, 120, opts));
  return data.signedUrl;
}

module.exports = {
  sb, must, DOC_BUCKET, PKG_BUCKET, STAFF_ROLES,
  toCase, toPkg, loadCase, canAccess, isStaff, isAttorney,
  audit, updateCase, refreshCase, insertMessage,
  checkUpload, storeDocument, readDocument, storePackage, signedUrl,
};
