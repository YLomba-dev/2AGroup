// Creates fictional demo accounts and cases in Supabase, with placeholder documents.
// Refuses to run if the database holds real (non-demo) cases, unless --force.
// Demo sign-in details are written to data/demo-logins.txt.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const repo = require('../lib/repo');
const { getPreset } = require('../lib/presets');

const { sb, must } = repo;
const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const LOGINS = path.join(__dirname, '..', 'data', 'demo-logins.txt');

const USERS = [
  { key: 'admin', email: 'admin.demo@example.com', name: 'Office Admin (demo)', role: 'admin' },
  { key: 'attorney', email: 'attorney.demo@example.com', name: 'Attorney (demo)', role: 'attorney' },
  { key: 'staff', email: 'casemanager.demo@example.com', name: 'Case Manager (demo)', role: 'staff' },
  { key: 'maria', email: 'maria.demo@example.com', name: 'Maria Fernanda Souza', role: 'client' },
  { key: 'carlos', email: 'carlos.demo@example.com', name: 'Carlos Eduardo Mendes', role: 'client' },
  { key: 'ana', email: 'ana.demo@example.com', name: 'Ana Paula Ribeiro', role: 'client' },
];

const password = () => `Demo-${crypto.randomBytes(6).toString('hex')}A1`;

async function samplePdf(title, lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 40, y: 40, width: 532, height: 712, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1 });
  page.drawText('SAMPLE - FICTIONAL DEMO DOCUMENT', { x: 60, y: 720, size: 10, font: bold, color: rgb(0.7, 0.1, 0.1) });
  page.drawText(title, { x: 60, y: 680, size: 18, font: bold });
  lines.forEach((l, i) => page.drawText(l, { x: 60, y: 640 - i * 20, size: 12, font }));
  return Buffer.from(await doc.save());
}

async function addDoc(caseId, user, checklistId, title, lines, status = 'accepted') {
  const buffer = await samplePdf(title, lines);
  const storagePath = await repo.storeDocument(caseId, { buffer }, { ext: '.pdf', mime: 'application/pdf' });
  must(await sb.from('documents').insert({
    case_id: caseId, checklist_id: checklistId, original_name: `${title}.pdf`, storage_path: storagePath,
    mime_type: 'application/pdf', size_bytes: buffer.length, uploaded_by: user.id, uploaded_role: 'client', status,
  }));
}

async function removeDemoData() {
  const demo = must(await sb.from('cases').select('id').eq('is_demo', true));
  for (const { id } of demo) {
    for (const bucket of [repo.DOC_BUCKET, repo.PKG_BUCKET]) {
      const files = must(await sb.storage.from(bucket).list(id, { limit: 1000 }));
      if (files.length) must(await sb.storage.from(bucket).remove(files.map((f) => `${id}/${f.name}`)));
    }
  }
  if (demo.length) must(await sb.from('cases').delete().in('id', demo.map((c) => c.id)));
  const { data } = await sb.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users.filter((x) => USERS.some((d) => d.email === x.email))) {
    await sb.auth.admin.deleteUser(u.id);
  }
}

async function createUsers() {
  const out = {};
  for (const u of USERS) {
    const pw = password();
    const { data, error } = await sb.auth.admin.createUser({
      email: u.email, password: pw, email_confirm: true,
      user_metadata: { full_name: u.name }, app_metadata: { role: u.role },
    });
    if (error) throw new Error(`${u.email}: ${error.message}`);
    out[u.key] = { ...u, id: data.user.id, password: pw };
  }
  return out;
}

async function newCase(client, preset, stage, answers, createdBy) {
  return must(await sb.from('cases').insert({
    client_id: client.id, client_name: client.name, client_email: client.email, preset, stage, answers,
    confidential: !!getPreset(preset).confidential, is_demo: true, created_by: createdBy.id,
  }).select().single());
}

async function main() {
  const real = must(await sb.from('cases').select('id', { count: 'exact' }).eq('is_demo', false));
  if (real.length && !process.argv.includes('--force')) {
    console.error('The database has non-demo cases. Re-run with --force only if you mean to keep them and add demo data.');
    process.exit(1);
  }

  // Pause n8n events while seeding so demo data does not trigger messages and builds.
  const setting = must(await sb.from('app_settings').select('value').eq('key', 'n8n_event_url').maybeSingle());
  must(await sb.from('app_settings').upsert({ key: 'n8n_event_url', value: '' }));
  try {
    await removeDemoData();
    const u = await createUsers();

    const common = {
      sex: 'Female', maritalStatus: 'Married', street: '100 Example Ave Apt 2', city: 'Newark', state: 'NJ', zip: '07102',
      phone: '(555) 010-0100', email: 'client@example.com', addressHistory: '2021-present: 100 Example Ave Apt 2, Newark, NJ 07102',
      ethnicity: 'Hispanic or Latino', race: 'White', heightFtIn: '5 ft 5 in', weightLbs: '140', eyeColor: 'Brown', hairColor: 'Black',
      everArrested: 'No', everInProceedings: 'No', employmentHistory: '2022-present: Example Bakery LLC, Newark NJ, baker',
    };

    // 1. Family green card, complete: builds a full package.
    const gc = await newCase(u.maria, 'green-card-family', 'Collecting documents', {
      ...common,
      familyName: 'Souza', givenName: 'Maria', middleName: 'Fernanda', dob: '1992-03-14', cityOfBirth: 'Belo Horizonte', countryOfBirth: 'Brazil', citizenship: 'Brazil',
      lastArrivalDate: '2021-06-02', lastArrivalPlace: 'Newark, NJ (EWR)', entryManner: 'With a visa (admitted)', i94Number: '12345678901', currentStatus: 'B-2 (expired)', passportNumber: 'FX000000', passportCountry: 'Brazil',
      spouseName: 'John Michael Carter', spouseDob: '1990-11-02', marriageDate: '2023-09-16', marriagePlace: 'Newark, NJ, USA', parents: 'Jose Souza (1965, Brazil); Lucia Souza (1967, Brazil)',
      petitionerName: 'John Michael Carter', petitionerStatus: 'U.S. citizen', petitionerDob: '1990-11-02', petitionerAddress: '100 Example Ave Apt 2, Newark, NJ 07102', relationship: 'Spouse', petitionerLprViaMarriage: 'No',
      concurrentI485: 'Yes', wantsEad: 'Yes', wantsAdvanceParole: 'No', sponsorIncome: '68,000', householdSize: '2',
    }, u.staff);
    const m = u.maria;
    await addDoc(gc.id, m, 'petitioner_status_proof', 'US passport - John Carter', ['Passport biographic page', 'Holder: John Michael Carter']);
    await addDoc(gc.id, m, 'marriage_certificate', 'Marriage certificate', ['Marriage of John Michael Carter and Maria Fernanda Souza', 'Date: 09/16/2023, Newark NJ']);
    await addDoc(gc.id, m, 'photos_petitioner', 'Photos - petitioner', ['2 passport-style photos (on file at office)']);
    await addDoc(gc.id, m, 'photos_beneficiary', 'Photos - beneficiary', ['2 passport-style photos (on file at office)']);
    await addDoc(gc.id, m, 'bona_fide_marriage', 'Joint lease', ['Residential lease, 100 Example Ave Apt 2', 'Tenants: John M. Carter and Maria F. Souza']);
    await addDoc(gc.id, m, 'bona_fide_marriage', 'Joint bank statements', ['Example Bank joint checking', 'Statements Jan - Jun 2026']);
    await addDoc(gc.id, m, 'beneficiary_birth_certificate', 'Birth certificate - Maria', ['Certidao de Nascimento (with certified translation to be added)']);
    await addDoc(gc.id, m, 'inspection_admission', 'I-94 and visa page', ['I-94 admission record', 'B-2 visa page']);
    await addDoc(gc.id, m, 'medical_i693', 'I-693 sealed envelope receipt', ['Civil surgeon sealed I-693 received at office']);
    await addDoc(gc.id, m, 'sponsor_tax_returns', 'Sponsor 2025 tax transcript', ['IRS tax return transcript 2025', 'W-2 and pay stubs']);
    await addDoc(gc.id, m, 'id_document', 'Passport - Maria', ['Brazilian passport biographic page']);
    await repo.insertMessage(gc.id, m, 'Hi! I uploaded our lease and bank statements. Do you need anything else?');

    // 2. Asylum, partly done and restricted: only the case manager, attorneys and admins see it.
    const asy = await newCase(u.carlos, 'asylum', 'Intake', {
      ...common,
      sex: 'Male', maritalStatus: 'Single, never married', familyName: 'Mendes', givenName: 'Carlos', middleName: 'Eduardo', dob: '1988-07-21', cityOfBirth: 'Caracas', countryOfBirth: 'Venezuela', citizenship: 'Venezuela',
      lastArrivalDate: iso(-300), lastArrivalPlace: 'Miami, FL (MIA)', entryManner: 'With a visa (admitted)', currentStatus: 'B-2', statusExpires: iso(-120),
      nativeLanguage: 'Spanish', ethnicGroup: 'Hispanic', grounds: 'Political opinion', includeSpouse: 'No', childrenCount: '0',
    }, u.staff);
    must(await sb.from('case_team').insert({ case_id: asy.id, staff_id: u.staff.id }));
    await addDoc(asy.id, u.carlos, 'passports_cover_to_cover', 'Passport cover to cover', ['Venezuelan passport, all pages'], 'pending');

    // 3. I-751, joint, card expires in 60 days: inside the 90-day window.
    const cr = await newCase(u.ana, 'i-751', 'Collecting documents', {
      ...common,
      familyName: 'Ribeiro', givenName: 'Ana', middleName: 'Paula', dob: '1995-01-30', cityOfBirth: 'Lisbon', countryOfBirth: 'Portugal', citizenship: 'Portugal', aNumber: 'A000000000',
      spouseName: 'David Lee Brooks', marriageDate: '2023-02-11', cprExpiry: iso(60), filingBasis: 'Jointly with my spouse', includeChildren: 'No', militaryOrders: 'No',
    }, u.staff);
    await addDoc(cr.id, u.ana, 'green_card_copy', 'Conditional green card front and back', ['Permanent Resident Card (conditional)', 'Card expires in 60 days']);
    await addDoc(cr.id, u.ana, 'joint_residence', 'Mortgage statement', ['Mortgage: David L. Brooks and Ana P. Ribeiro']);
    await addDoc(cr.id, u.ana, 'joint_finances', 'Joint 2025 tax return', ['Form 1040 Married filing jointly']);
    await addDoc(cr.id, u.ana, 'id_document', 'Passport - Ana', ['Portuguese passport biographic page'], 'pending');

    for (const row of [gc, asy, cr]) {
      await repo.audit(row.id, { role: 'system', name: 'seed' }, 'demo case seeded');
      await repo.refreshCase(await repo.loadCase(row.id));
    }

    fs.mkdirSync(path.dirname(LOGINS), { recursive: true });
    fs.writeFileSync(LOGINS, [
      'Demo sign-ins for the LOCAL test database only (fictional people). Regenerated on every seed.',
      '',
      ...Object.values(u).map((x) => `${x.role.padEnd(9)} ${x.email.padEnd(32)} ${x.password}   ${x.name}`),
      '',
    ].join('\n'));
    console.log(`Seeded 6 demo accounts and 3 fictional cases. Sign-ins: ${LOGINS}`);
  } finally {
    must(await sb.from('app_settings').upsert({ key: 'n8n_event_url', value: setting ? setting.value : '' }));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
