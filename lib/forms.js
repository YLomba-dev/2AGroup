// Fills an official USCIS PDF from a field map, when both exist:
//   forms/<form>.pdf          blank fillable form downloaded from uscis.gov
//   fieldmaps/<form>.json     { "edition": "04/01/24", "fields": { "<pdf field>": "<answer id>" | { "answer", "checked" } } }
// Fields for G-28, attorney, preparer, interpreter and signatures are never filled,
// even if a field map lists them.
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFTextField, PDFCheckBox } = require('pdf-lib');
const { formFileName, FORMS_DIR } = require('./validate');

const MAP_DIR = path.join(__dirname, '..', 'fieldmaps');
const BLOCKED_FIELD = /g-?28|attorney|atty|preparer|interpreter|signature|barnumber|accredited/i;

function mapFile(form) {
  return path.join(MAP_DIR, formFileName(form).replace(/\.pdf$/, '.json'));
}

function usDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? `${m[2]}/${m[3]}/${m[1]}` : v;
}

async function fillOfficialForm(form, answers) {
  const pdfPath = path.join(FORMS_DIR, formFileName(form));
  if (!fs.existsSync(pdfPath) || !fs.existsSync(mapFile(form))) return { doc: null, note: 'not loaded' };
  const map = JSON.parse(fs.readFileSync(mapFile(form), 'utf8'));
  try {
    const doc = await PDFDocument.load(fs.readFileSync(pdfPath), { ignoreEncryption: true });
    const pdfForm = doc.getForm();
    if (typeof pdfForm.deleteXFA === 'function') pdfForm.deleteXFA();
    let filled = 0;
    for (const [fieldName, spec] of Object.entries(map.fields || {})) {
      if (BLOCKED_FIELD.test(fieldName)) continue;
      const rule = typeof spec === 'string' ? { answer: spec } : spec;
      const value = answers[rule.answer];
      if (value === undefined || value === '') continue;
      const field = pdfForm.getFieldMaybe(fieldName);
      if (field instanceof PDFTextField) {
        field.setText(String(rule.date ? usDate(value) : value));
        filled++;
      } else if (field instanceof PDFCheckBox && rule.checked !== undefined) {
        if (value === rule.checked) { field.check(); filled++; }
      }
    }
    pdfForm.flatten();
    return { doc, note: `filled ${filled} field(s) from map edition ${map.edition || '?'}` };
  } catch (err) {
    return { doc: null, note: `could not fill (${err.message})` };
  }
}

module.exports = { fillOfficialForm, usDate, BLOCKED_FIELD };
