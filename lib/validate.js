// Checks a case against its preset before assembly: required answers,
// required documents, form availability and USCIS timing rules.
const fs = require('fs');
const path = require('path');
const {
  getPreset, applicableQuestions, applicableChecklist, applicableForms,
} = require('./presets');

const FORMS_DIR = path.join(__dirname, '..', 'forms');
const DAY = 24 * 60 * 60 * 1000;

function days(fromIso, to = new Date()) {
  const d = new Date(fromIso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((to - d) / DAY);
}

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, n) {
  return new Date(new Date(iso).getTime() + n * DAY);
}

function formFileName(form) {
  return `${form.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;
}

// Timing rules named in each preset's "rules" list.
const RULES = {
  i751Window(a, out, today) {
    if (!a.cprExpiry) return;
    const opens = addDays(a.cprExpiry, -90);
    const expiry = new Date(a.cprExpiry);
    if (a.filingBasis === 'Jointly with my spouse') {
      if (today < opens) out.errors.push(`Joint I-751 filing window opens ${fmt(opens)} (90 days before the card expires on ${a.cprExpiry}). Filing earlier gets the petition returned.`);
      else if (today > expiry) out.warnings.push(`Conditional residence expired ${a.cprExpiry}. A late joint petition needs a written explanation of good cause and extenuating circumstances.`);
      else out.info.push(`Inside the 90-day joint filing window (closes ${a.cprExpiry}).`);
    } else {
      out.info.push('Waiver petitions may be filed any time before removal proceedings end; no 90-day window applies.');
    }
  },
  asylumOneYear(a, out, today) {
    const d = days(a.lastArrivalDate, today);
    if (d === null) return;
    if (d > 365) out.warnings.push(`Last arrival was ${d} days ago. The one-year filing deadline has passed unless changed or extraordinary circumstances apply; explain the exception in the application.`);
    else out.info.push(`${365 - d} days remain before the one-year asylum filing deadline.`);
  },
  asylumEadClock(a, out, today) {
    if (a.eligibilityCategory === '(c)(8) Pending asylum' && a.asylumFiledDate) {
      const eligible = addDays(a.asylumFiledDate, 150);
      if (today < eligible) out.errors.push(`The (c)(8) work permit may be requested only after 150 days from filing a complete asylum application (on or after ${fmt(eligible)}).`);
    } else if (!a.eligibilityCategory) {
      out.info.push('After filing, the client may request a work permit once 150 days have passed (I-589 Instructions, Part 2 VI).');
    }
  },
  permValidity(a, out, today) {
    if (a.track !== 'PERM labor certification (employer)' || !a.permCertDate) return;
    const expires = addDays(a.permCertDate, 180);
    const left = Math.floor((expires - today) / DAY);
    if (left < 0) out.errors.push(`Labor certification expired ${fmt(expires)} (180 days after certification). USCIS rejects I-140s filed with an expired certification.`);
    else if (left <= 30) out.warnings.push(`Labor certification expires in ${left} days (${fmt(expires)}). File now.`);
    else out.info.push(`Labor certification valid until ${fmt(expires)}.`);
  },
  visaBulletinNote(a, out) {
    if (a.concurrentI485 === 'Yes' || a.basis) {
      out.info.push('Check the current Visa Bulletin (travel.state.gov) and the USCIS chart in use this month before filing I-485.');
    }
  },
  vawaTwoYear(a, out, today) {
    const d = days(a.relationshipEndDate, today);
    if (d !== null && d > 730) out.warnings.push('More than 2 years since the divorce, death or loss of status. The self-petition generally must be filed within 2 years of that event.');
  },
  widowTwoYear(a, out, today) {
    if (a.category !== 'Widow(er) of a U.S. citizen') return;
    const d = days(a.spouseDeathDate, today);
    if (d !== null && d > 730) out.errors.push('The widow(er) petition must be filed within 2 years of the U.S. citizen spouse\'s death.');
    if (a.remarried === 'Yes') out.errors.push('A widow(er) who has remarried is not eligible in this category.');
  },
  eadRenewalWindow(a, out) {
    if (a.requestType === 'Renewal') out.info.push('Confirm the current renewal filing window and any automatic extension rules on uscis.gov/i-765 before filing.');
  },
  i539Timely(a, out, today) {
    const d = days(a.statusExpires, today);
    if (d !== null && d > 0) out.warnings.push(`Authorized stay ended ${a.statusExpires}. A late I-539 must show extraordinary circumstances.`);
  },
};

function isAnswered(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

function validateCase(caseObj, today = new Date()) {
  const preset = getPreset(caseObj.preset);
  const a = caseObj.answers || {};
  const out = { errors: [], warnings: [], info: [], missingAnswers: [], missingDocuments: [] };

  for (const q of applicableQuestions(preset, a)) {
    if (q.required && !isAnswered(a[q.id])) out.missingAnswers.push({ id: q.id, label: q.label, section: q.section });
  }

  const docs = caseObj.documents || [];
  for (const item of applicableChecklist(preset, a)) {
    const usable = docs.filter((d) => d.checklistId === item.id && d.status !== 'rejected');
    if (item.required && usable.length === 0) out.missingDocuments.push({ id: item.id, label: item.label, staffOnly: !!item.staffOnly });
    if (usable.some((d) => d.status === 'pending')) out.warnings.push(`"${item.label}" has documents staff have not reviewed yet.`);
  }

  const unverified = [];
  const noPdf = [];
  for (const f of applicableForms(preset, a)) {
    if (/^verify/i.test(f.edition)) unverified.push(f.form);
    if (!/civil surgeon|DOL form|law enforcement/i.test(`${f.edition} ${f.note || ''}`) &&
        !fs.existsSync(path.join(FORMS_DIR, formFileName(f.form)))) noPdf.push(f.form);
  }
  if (unverified.length) out.warnings.push(`Edition not confirmed from instructions on file for ${unverified.join(', ')}. Check uscis.gov before filing.`);
  if (noPdf.length) out.info.push(`Official blank PDFs not in /forms yet for ${noPdf.join(', ')}, so the package prints a staff data sheet for them.`);

  for (const rule of preset.rules || []) {
    if (RULES[rule]) RULES[rule](a, out, today);
  }
  if (preset.instructionsLoaded === false) out.warnings.push(preset.instructionsNote);

  if (out.missingAnswers.length) out.errors.push(`${out.missingAnswers.length} required answer(s) missing.`);
  if (out.missingDocuments.length) out.errors.push(`${out.missingDocuments.length} required document(s) missing.`);
  out.ready = out.errors.length === 0;
  return out;
}

module.exports = { validateCase, formFileName, FORMS_DIR };
