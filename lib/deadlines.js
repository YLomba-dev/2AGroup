// Turns the USCIS timing rules a preset uses into dated deadlines for the dashboard
// and the daily n8n digest. Mirrors the rules in lib/validate.js.
const DAY = 24 * 60 * 60 * 1000;

function plus(iso, days) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + days * DAY).toISOString().slice(0, 10);
}

const BUILDERS = {
  i751Window(a) {
    if (!a.cprExpiry) return [];
    const out = [{ kind: 'cpr_expires', title: 'Conditional green card expires (I-751 must be filed before)', due: plus(a.cprExpiry, 0), severity: 'high' }];
    if (a.filingBasis === 'Jointly with my spouse') out.push({ kind: 'i751_window_opens', title: 'Joint I-751 filing window opens (90 days before expiry)', due: plus(a.cprExpiry, -90), opensWindow: true });
    return out;
  },
  asylumOneYear(a) {
    return a.lastArrivalDate ? [{ kind: 'asylum_one_year', title: 'One-year asylum filing deadline', due: plus(a.lastArrivalDate, 365), severity: 'high' }] : [];
  },
  asylumEadClock(a) {
    return a.asylumFiledDate ? [{ kind: 'asylum_ead_150', title: 'Earliest (c)(8) work permit request (150 days after asylum filing)', due: plus(a.asylumFiledDate, 150), opensWindow: true }] : [];
  },
  permValidity(a) {
    return a.permCertDate && a.track === 'PERM labor certification (employer)'
      ? [{ kind: 'perm_expires', title: 'Labor certification expires (file I-140 before)', due: plus(a.permCertDate, 180), severity: 'high' }] : [];
  },
  vawaTwoYear(a) {
    return a.relationshipEndDate ? [{ kind: 'vawa_two_year', title: 'VAWA self-petition 2-year limit after divorce, death or loss of status', due: plus(a.relationshipEndDate, 730), severity: 'high' }] : [];
  },
  widowTwoYear(a) {
    return a.category === 'Widow(er) of a U.S. citizen' && a.spouseDeathDate
      ? [{ kind: 'widow_two_year', title: 'Widow(er) petition 2-year limit', due: plus(a.spouseDeathDate, 730), severity: 'high' }] : [];
  },
  i539Timely(a) {
    return a.statusExpires ? [{ kind: 'status_expires', title: 'Authorized stay ends (file I-539 before)', due: plus(a.statusExpires, 0), severity: 'high' }] : [];
  },
};

// A date that opens a window is only useful until it arrives; deadlines stay even when
// overdue so staff see them.
function computeDeadlines(preset, answers, today = new Date()) {
  const todayIso = today.toISOString().slice(0, 10);
  const out = [];
  for (const rule of preset.rules || []) {
    if (BUILDERS[rule]) out.push(...BUILDERS[rule](answers || {}).filter((d) => d.due));
  }
  return out.filter((d) => !(d.opensWindow && d.due < todayIso)).map(({ opensWindow, ...d }) => ({ severity: 'normal', ...d }));
}

module.exports = { computeDeadlines };
