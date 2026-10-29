// Loads case presets from /presets and resolves which questions, forms and
// checklist items apply to a case given its answers.
const fs = require('fs');
const path = require('path');

const PRESET_DIR = path.join(__dirname, '..', 'presets');

function loadCommon() {
  return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, '_common.json'), 'utf8'));
}

function listPresets() {
  return fs.readdirSync(PRESET_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), 'utf8')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Returns the preset with shared blocks expanded into a flat question list
// and the common checklist items appended.
function getPreset(id) {
  const file = path.join(PRESET_DIR, `${id}.json`);
  if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(file)) return null;
  const preset = JSON.parse(fs.readFileSync(file, 'utf8'));
  const common = loadCommon();
  const questions = [];
  for (const blockId of preset.blocks || []) {
    const block = common.blocks[blockId];
    if (!block) continue;
    for (const q of block.questions) questions.push({ ...q, section: block.title });
  }
  for (const q of preset.questions || []) questions.push(q);
  const checklist = [...(preset.checklist || [])];
  for (const item of common.commonChecklist) {
    if (!checklist.some((c) => c.id === item.id)) checklist.push(item);
  }
  return { ...preset, questions, checklist };
}

function ageOn(dobIso, today = new Date()) {
  const dob = new Date(dobIso);
  if (Number.isNaN(dob.getTime())) return null;
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

// A condition looks like { question, equals | in | notIn | gt | ageAtLeast }.
function conditionMet(when, answers) {
  if (!when) return true;
  const v = answers[when.question];
  if ('equals' in when) return v === when.equals;
  if ('in' in when) return when.in.includes(v);
  if ('notIn' in when) return !when.notIn.includes(v);
  if ('gt' in when) return Number(v) > when.gt;
  if ('ageAtLeast' in when) {
    const age = ageOn(v);
    return age === null ? true : age >= when.ageAtLeast;
  }
  return true;
}

function applicableQuestions(preset, answers, { audience = 'staff' } = {}) {
  return preset.questions.filter((q) =>
    conditionMet(q.when, answers) && (audience === 'staff' || !q.staffOnly));
}

function applicableChecklist(preset, answers, { audience = 'staff' } = {}) {
  return preset.checklist.filter((c) =>
    conditionMet(c.when, answers) && (audience === 'staff' || !c.staffOnly));
}

// Optional forms with no condition (for example I-589 Supplement B) are listed for
// staff but only included when staff tick them in answers._includeForms.
function applicableForms(preset, answers, { includeUnchosen = false } = {}) {
  const chosen = answers._includeForms || [];
  return preset.forms
    .filter((f) => conditionMet(f.when, answers))
    .map((f) => ({ ...f, included: !(f.role === 'optional' && !f.when) || chosen.includes(f.form) }))
    .filter((f) => includeUnchosen || f.included);
}

module.exports = {
  listPresets, getPreset, conditionMet, ageOn,
  applicableQuestions, applicableChecklist, applicableForms,
};
