// Builds the single print-ready petition PDF:
//   cover letter -> forms -> exhibit index -> EXHIBIT 1..N tab pages with their documents
// Draft builds carry a "pending attorney review" banner; the final build is made
// only after an attorney approves.
const fs = require('fs');
const path = require('path');
const {
  PDFDocument, StandardFonts, rgb, PDFName, PDFHexString,
} = require('pdf-lib');
const {
  getPreset, applicableQuestions, applicableChecklist, applicableForms,
} = require('./presets');
const { fillOfficialForm, usDate } = require('./forms');

const FIRM = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'firm.json'), 'utf8'));
const PAGE = [612, 792];
const MARGIN = 72;
const INK = rgb(0.1, 0.1, 0.12);
const QUIET = rgb(0.4, 0.4, 0.45);

// Standard PDF fonts only encode Latin-1 plus a few typographic characters.
function clean(s) {
  return String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\r/g, '')
    .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF–—•]/g, '?');
}

// {{field}} inserts an answer; {{#field}}...{{/field}} keeps the text only when
// the answer is present and not "No". Dates print as mm/dd/yyyy.
function render(template, answers) {
  const withSections = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    const v = answers[key];
    return v && v !== 'No' ? inner : '';
  });
  return withSections.replace(/\{\{(\w+)\}\}/g, (_, key) => usDate(answers[key] ?? `[${key}]`)).trim();
}

class Writer {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.page = null;
    this.y = 0;
  }

  newPage() {
    this.page = this.doc.addPage(PAGE);
    this.y = PAGE[1] - MARGIN;
    return this.page;
  }

  ensure(h) {
    if (!this.page || this.y - h < MARGIN) this.newPage();
  }

  lines(text, font, size, width) {
    const out = [];
    for (const para of clean(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width && line) {
          out.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      out.push(line);
    }
    return out;
  }

  text(str, { size = 11, font = this.fonts.body, indent = 0, color = INK, gap = 4, width } = {}) {
    const w = (width || PAGE[0] - 2 * MARGIN) - indent;
    for (const line of this.lines(str, font, size, w)) {
      this.ensure(size + gap);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font, color });
      this.y -= size + gap;
    }
  }

  space(h) {
    this.y -= h;
  }
}

async function newDoc() {
  const doc = await PDFDocument.create();
  const fonts = {
    body: await doc.embedFont(StandardFonts.TimesRoman),
    bold: await doc.embedFont(StandardFonts.TimesRomanBold),
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansBold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  return { doc, fonts, w: new Writer(doc, fonts) };
}

async function buildCoverLetter(ctx) {
  const { preset, answers, forms, exhibits } = ctx;
  const { doc, fonts, w } = await newDoc();
  w.newPage();
  w.text(FIRM.name, { size: 16, font: fonts.sansBold, gap: 2 });
  w.text([...FIRM.addressLines, `${FIRM.phone}  |  ${FIRM.email}`].join('\n'), { size: 9, font: fonts.sans, color: QUIET, gap: 2 });
  w.page.drawLine({ start: { x: MARGIN, y: w.y - 4 }, end: { x: PAGE[0] - MARGIN, y: w.y - 4 }, thickness: 0.75, color: QUIET });
  w.space(22);
  w.text(new Date(ctx.today).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
  w.space(10);
  w.text('U.S. Citizenship and Immigration Services');
  w.text(`[Filing address: ${preset.filing.where}]`, { color: QUIET, size: 10 });
  w.space(12);
  w.text(`RE: ${render(preset.coverLetter.re, answers)}`, { font: fonts.bold });
  const who = [fullName(answers)];
  if (answers.dob) who.push(`DOB ${usDate(answers.dob)}`);
  if (answers.aNumber) who.push(`A-Number ${answers.aNumber}`);
  w.text(`      ${who.join('  |  ')}`, { font: fonts.bold });
  w.space(12);
  w.text('Dear Officer:');
  w.space(6);
  w.text(render(preset.coverLetter.request, answers));
  w.space(6);
  const points = preset.coverLetter.points.map((p) => render(p, answers)).filter(Boolean);
  if (points.length) {
    w.text('As shown in the enclosed documents:');
    points.forEach((p, i) => w.text(`${i + 1}.  ${p}`, { indent: 18 }));
    w.space(6);
  }
  w.text('Enclosed please find:');
  for (const f of forms) w.text(`•  Form ${f.form}, ${f.title}`, { indent: 18 });
  if (exhibits.length) w.text(`•  Exhibit index and Exhibits 1 - ${exhibits.length} in support`, { indent: 18 });
  w.space(10);
  w.text('Please direct any questions about this filing to our office. Thank you for your attention to this matter.');
  w.space(20);
  w.text('Respectfully submitted,');
  w.space(36);
  w.text('______________________________');
  w.text(`${FIRM.attorneyName}\n${FIRM.attorneyBar}\n${FIRM.name}`);
  return doc;
}

function fullName(a) {
  return [a.givenName, a.middleName, a.familyName].filter(Boolean).join(' ');
}

// One staff data sheet printed in place of every form whose official PDF is not loaded yet.
async function buildDataSheet(ctx, forms) {
  const { preset, answers } = ctx;
  const { doc, fonts, w } = await newDoc();
  w.newPage();
  w.text('STAFF DATA SHEET - remove before filing', { size: 14, font: fonts.sansBold });
  w.text('Transcribe these answers onto the official forms below, or add the blank PDF to /forms with a field map so it fills automatically. Attorney/G-28, preparer, interpreter and signature sections are intentionally left for staff.', { size: 9, font: fonts.sans, color: QUIET });
  w.space(4);
  for (const f of forms) {
    w.text(`•  Form ${f.form}, ${f.title} (edition ${f.edition})${f.note ? ` - ${f.note}` : ''}`, { size: 9.5, font: fonts.sans, indent: 8, gap: 3 });
  }
  w.space(8);
  let section = null;
  for (const q of applicableQuestions(preset, answers)) {
    if (q.section !== section) {
      section = q.section;
      w.space(6);
      w.text(section, { size: 11, font: fonts.sansBold });
    }
    const v = answers[q.id];
    w.text(clean(q.label), { size: 8.5, font: fonts.sans, color: QUIET, gap: 1 });
    w.text(v ? usDate(v) : '-', { size: 10.5, font: fonts.body, indent: 10, gap: 5 });
  }
  return doc;
}

async function buildIndex(exhibits, startPages) {
  const { doc, fonts, w } = await newDoc();
  w.newPage();
  w.text('INDEX OF EXHIBITS', { size: 14, font: fonts.sansBold });
  w.space(8);
  exhibits.forEach((ex, i) => {
    const range = startPages ? `pp. ${startPages[i]}-${startPages[i] + ex.pageCount - 1}` : '';
    const y0 = w.y;
    w.text(`Exhibit ${i + 1}`, { font: fonts.bold, width: 90 });
    const yAfterLabel = w.y;
    w.y = y0;
    w.text(ex.title, { indent: 90, width: PAGE[0] - 2 * MARGIN - 80 });
    ex.docNames.forEach((name) => w.text(`- ${name.replace(/\.(pdf|jpe?g|png)$/i, '')}`, { indent: 100, size: 9.5, color: QUIET, gap: 2, width: PAGE[0] - 2 * MARGIN - 80 }));
    if (range) w.page.drawText(range, { x: PAGE[0] - MARGIN - fonts.body.widthOfTextAtSize(range, 11), y: y0 - 11, size: 11, font: fonts.body, color: INK });
    w.y = Math.min(w.y, yAfterLabel) - 4;
  });
  return doc;
}

// One exhibit = the firm's tab page ("EXHIBIT N", as in Clients/Forms/Exhibit layout.pdf)
// followed by every document filed under that checklist item.
async function buildExhibit(n, item, docs, readFile) {
  const { doc, fonts } = await newDoc();
  const tab = doc.addPage(PAGE);
  const label = `EXHIBIT ${n}`;
  const size = 40;
  tab.drawText(label, {
    x: (PAGE[0] - fonts.sansBold.widthOfTextAtSize(label, size)) / 2,
    y: PAGE[1] / 2,
    size,
    font: fonts.sansBold,
    color: INK,
  });
  const notes = [];
  for (const d of docs) {
    const ext = path.extname(d.originalName).toLowerCase();
    try {
      const bytes = await readFile(d);
      if (ext === '.pdf') {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => doc.addPage(p));
      } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
        const img = ext === '.png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const page = doc.addPage(PAGE);
        const scale = Math.min((PAGE[0] - 2 * 36) / img.width, (PAGE[1] - 2 * 54) / img.height, 1);
        const wImg = img.width * scale;
        const hImg = img.height * scale;
        page.drawImage(img, { x: (PAGE[0] - wImg) / 2, y: (PAGE[1] - hImg) / 2, width: wImg, height: hImg });
      } else {
        throw new Error(`file type ${ext || '(none)'} cannot be printed`);
      }
    } catch (err) {
      const page = doc.addPage(PAGE);
      page.drawText(clean(`Could not include ${d.originalName}: ${err.message}. Convert it to PDF or JPG and re-upload.`), { x: MARGIN, y: PAGE[1] / 2, size: 11, font: fonts.sans, color: rgb(0.7, 0.1, 0.1), maxWidth: PAGE[0] - 2 * MARGIN });
      notes.push(`${d.originalName}: ${err.message}`);
    }
  }
  return { doc, title: item.label, docNames: docs.map((d) => d.originalName), pageCount: doc.getPageCount(), notes };
}

function addOutline(doc, entries) {
  const { context } = doc;
  const pages = doc.getPages();
  const rootRef = context.nextRef();
  const refs = entries.map(() => context.nextRef());
  entries.forEach((e, i) => {
    const dict = {
      Title: PDFHexString.fromText(clean(e.title)),
      Parent: rootRef,
      Dest: [pages[e.pageIndex].ref, 'XYZ', null, null, null],
    };
    if (i > 0) dict.Prev = refs[i - 1];
    if (i < entries.length - 1) dict.Next = refs[i + 1];
    context.assign(refs[i], context.obj(dict));
  });
  context.assign(rootRef, context.obj({
    Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: entries.length,
  }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

// readFile(doc) returns the bytes of one uploaded document (Supabase Storage).
async function assemble(caseObj, { draft = true, readFile, today = new Date() } = {}) {
  const preset = getPreset(caseObj.preset);
  const answers = caseObj.answers || {};
  const forms = applicableForms(preset, answers);
  const docs = (caseObj.documents || []).filter((d) => d.status !== 'rejected');
  const notes = [];

  // Exhibits follow the preset checklist order; documents under items that no longer
  // apply are grouped at the end so nothing uploaded is silently dropped.
  const items = applicableChecklist(preset, answers);
  const groups = items
    .map((item) => ({ item, docs: docs.filter((d) => d.checklistId === item.id) }))
    .filter((g) => g.docs.length);
  const orphan = docs.filter((d) => !items.some((i) => i.id === d.checklistId));
  if (orphan.length) groups.push({ item: { label: 'Additional supporting documents' }, docs: orphan });

  const exhibits = [];
  for (let i = 0; i < groups.length; i++) {
    const ex = await buildExhibit(i + 1, groups[i].item, groups[i].docs, readFile);
    notes.push(...ex.notes);
    exhibits.push(ex);
  }

  const ctx = { preset, answers, forms, exhibits, today };
  const sections = [{ title: 'Cover letter', doc: await buildCoverLetter(ctx), stamp: true }];
  const unfilled = [];
  for (const f of forms) {
    if (/civil surgeon|DOL form/i.test(f.edition) || /law enforcement official/i.test(f.note || '')) {
      notes.push(`${f.form}: completed by a third party (sealed or signed by them); insert the original by hand.`);
      continue;
    }
    const filled = await fillOfficialForm(f.form, answers);
    if (filled.doc) {
      notes.push(`${f.form}: ${filled.note}`);
      sections.push({ title: `Form ${f.form}`, doc: filled.doc, stamp: false });
    } else {
      unfilled.push(f);
    }
  }
  if (unfilled.length) {
    notes.push(`Data sheet printed for ${unfilled.map((f) => f.form).join(', ')} (official PDFs not loaded).`);
    sections.push({ title: `Staff data sheet (${unfilled.map((f) => f.form).join(', ')})`, doc: await buildDataSheet(ctx, unfilled), stamp: true });
  }

  // Build the index twice: once to learn its length, then with real page numbers.
  const before = sections.reduce((n, s) => n + s.doc.getPageCount(), 0);
  let index = await buildIndex(exhibits, null);
  const starts = [];
  let cursor = before + index.getPageCount() + 1;
  for (const ex of exhibits) {
    starts.push(cursor);
    cursor += ex.pageCount;
  }
  index = await buildIndex(exhibits, starts);
  if (exhibits.length) sections.push({ title: 'Index of exhibits', doc: index, stamp: true });
  exhibits.forEach((ex, i) => sections.push({ title: `Exhibit ${i + 1} - ${ex.title}`, doc: ex.doc, stamp: true }));

  const out = await PDFDocument.create();
  const sans = await out.embedFont(StandardFonts.Helvetica);
  const sansBold = await out.embedFont(StandardFonts.HelveticaBold);
  const outline = [];
  const stampPages = [];
  for (const s of sections) {
    const copied = await out.copyPages(s.doc, s.doc.getPageIndices());
    outline.push({ title: s.title, pageIndex: out.getPageCount() });
    copied.forEach((p) => {
      out.addPage(p);
      if (s.stamp) stampPages.push(out.getPageCount() - 1);
    });
  }

  const total = out.getPageCount();
  const who = clean(`${fullName(answers)}${answers.aNumber ? `  |  ${answers.aNumber}` : ''}`);
  out.getPages().forEach((page, i) => {
    const { width } = page.getSize();
    if (stampPages.includes(i)) {
      const footer = `Page ${i + 1} of ${total}`;
      page.drawText(who, { x: MARGIN, y: 30, size: 8, font: sans, color: QUIET });
      page.drawText(footer, { x: width - MARGIN - sans.widthOfTextAtSize(footer, 8), y: 30, size: 8, font: sans, color: QUIET });
    }
    if (draft) {
      const banner = 'DRAFT - PENDING ATTORNEY REVIEW - NOT FOR FILING';
      page.drawText(banner, { x: (width - sansBold.widthOfTextAtSize(banner, 9)) / 2, y: page.getSize().height - 24, size: 9, font: sansBold, color: rgb(0.75, 0.1, 0.1) });
    }
  });
  addOutline(out, outline);
  out.setTitle(clean(`${preset.name} - ${who}`));
  out.setAuthor(FIRM.name);

  return { bytes: await out.save(), pageCount: total, exhibits: exhibits.length, sections: outline.map((o) => o.title), notes };
}

module.exports = { assemble, render };
