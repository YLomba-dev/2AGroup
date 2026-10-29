// Lists the fillable fields in a USCIS PDF so staff can write a field map.
// Usage: npm run inspect-form -- forms/i-130.pdf > fieldmaps/i-130.fields.txt
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { BLOCKED_FIELD } = require('../lib/forms');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Usage: npm run inspect-form -- forms/<form>.pdf'); process.exit(1); }
  const doc = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true });
  const fields = doc.getForm().getFields();
  console.log(`${file}: ${fields.length} fields, ${doc.getPageCount()} pages`);
  for (const f of fields) {
    const blocked = BLOCKED_FIELD.test(f.getName()) ? '  [never filled: attorney/preparer/interpreter/signature]' : '';
    console.log(`${f.constructor.name.replace('PDF', '').padEnd(12)} ${f.getName()}${blocked}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
