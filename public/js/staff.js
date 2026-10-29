// Staff dashboard: overview, case list, intake, document review, readiness, assembly,
// attorney approval. Updates live when clients upload or write, and when n8n acts.
(async () => {
  const { api, el, toast, when, day, daysUntil, questionField, docStatusBadge, itemStatus, openLink } = App;
  const me = await App.requireUser(['staff', 'attorney', 'admin']);
  App.topbar(me, 'Case dashboard');
  const attorney = ['attorney', 'admin'].includes(me.role);
  const listEl = document.getElementById('cases');
  const detail = document.getElementById('detail');
  const filter = document.getElementById('filter');
  const stageFilter = document.getElementById('stageFilter');
  const newForm = document.getElementById('newCase');
  const STAGES = ['Intake', 'Collecting documents', 'Attorney review', 'Corrections needed', 'Ready to print', 'Filed', 'Receipt received', 'Biometrics', 'Interview', 'Decision', 'Closed'];
  let cases = [];
  let current = null;
  let tab = 'readiness';
  let stageChip = 'All';
  let staffList = null;

  const table = (...rows) => el('div.table-wrap', el('table', ...rows));

  async function loadCases() {
    cases = await api('/api/cases');
    renderList();
  }

  function renderList() {
    const q = filter.value.toLowerCase();
    const chips = ['All', 'Files to review', 'Ready to build', 'Awaiting attorney', 'Waiting on client'];
    stageFilter.replaceChildren(...chips.map((c) => el(`button.chip${stageChip === c ? '.on' : ''}`, { onclick: () => { stageChip = c; renderList(); } }, c)));
    const match = (c) => {
      if (stageChip === 'Ready to build') return c.ready && !['Attorney review', 'Ready to print', 'Filed'].includes(c.stage);
      if (stageChip === 'Awaiting attorney') return c.lastPackage && c.lastPackage.status === 'draft';
      if (stageChip === 'Waiting on client') return c.missingDocuments + c.missingAnswers > 0 && ['Intake', 'Collecting documents', 'Corrections needed'].includes(c.stage);
      if (stageChip === 'Files to review') return c.unreviewed;
      return true;
    };
    const shown = cases.filter((c) => `${c.clientName} ${c.caseNumber} ${c.preset}`.toLowerCase().includes(q) && match(c));
    listEl.replaceChildren(...(shown.length ? shown : [el('li.muted.small', 'No cases match.')]).map((c) => (c instanceof Node ? c : el(`li${current && current.id === c.id ? '.active' : ''}`, { onclick: () => openCase(c.id), tabindex: 0, onkeydown: (e) => e.key === 'Enter' && openCase(c.id) },
      el('div.name', c.clientName, ' ', c.confidential ? el('span.badge.lock', 'Restricted') : null),
      el('div.small.muted', `${c.caseNumber} · ${c.preset}`),
      el('div.row', { style: 'margin-top:4px' },
        el('span.badge', c.stage),
        c.lastPackage && c.lastPackage.status === 'draft' ? el('span.badge.warn', `Draft v${c.lastPackage.version} to approve`)
          : c.ready ? el('span.badge.good', 'Ready to build')
            : c.missingDocuments + c.missingAnswers ? el('span.badge.warn', `${c.missingDocuments} docs / ${c.missingAnswers} answers missing`) : null,
        c.unreviewed ? el('span.badge.warn', 'Files to review') : null,
        c.unreadFromClient ? el('span.badge.bad', `${c.unreadFromClient} new msg`) : null)))));
  }

  // ---- overview -----------------------------------------------------------------

  async function renderOverview() {
    const d = await api('/api/dashboard');
    const kpi = (label, value, chip) => el('button.kpi', { onclick: () => { stageChip = chip; renderList(); listEl.scrollIntoView({ behavior: 'smooth' }); } }, el('div.kpi-value', String(value)), el('div.small.muted', label));
    detail.replaceChildren(
      el('div.kpis',
        kpi('Open cases', d.totals.open, 'All'),
        kpi('Ready to build', d.totals.readyToBuild, 'Ready to build'),
        kpi('Awaiting attorney', d.totals.awaitingAttorney, 'Awaiting attorney'),
        kpi('Files to review', d.totals.toReview, 'Files to review'),
        kpi('Waiting on client', d.totals.waitingOnClient, 'Waiting on client')),
      el('div.card', el('h2', 'Deadlines (next 90 days)'),
        d.deadlines.length ? el('ul.deadlines', d.deadlines.map((x) => {
          const n = daysUntil(x.due_date);
          return el('li', { onclick: () => openCase(x.case_id) },
            el('span', { class: `badge ${n < 0 ? 'bad' : n <= 14 || x.severity === 'high' ? 'warn' : ''}` }, n < 0 ? `${-n}d overdue` : n === 0 ? 'today' : `${n}d`),
            el('div', el('div', x.title), el('div.small.muted', `${x.clientName} · ${x.caseNumber} · ${day(x.due_date)}`)));
        })) : el('p.muted.small', 'Nothing due in the next 90 days.')),
      el('div.card', el('h2', 'Cases by stage'),
        el('div.stage-bars', STAGES.filter((s) => d.stages[s]).map((s) => el('div.stage-bar', el('span', s), el('b', String(d.stages[s])))))),
      el('p.small.muted', 'Automatic: n8n builds a draft as soon as a case is complete, messages clients about rejected files and stage changes, and sends weekly reminders for missing items.'));
  }

  // ---- case ---------------------------------------------------------------------

  async function openCase(id) {
    current = await api(`/api/cases/${id}`);
    document.body.classList.add('detail-open');
    history.replaceState(null, '', `staff.html?case=${id}`);
    renderDetail();
    window.scrollTo(0, 0);
    loadCases();
  }

  function closeCase() {
    current = null;
    document.body.classList.remove('detail-open');
    history.replaceState(null, '', 'staff.html');
    renderList();
    renderOverview();
  }

  async function refresh(data) {
    current = data && data.id ? data : await api(`/api/cases/${current.id}`);
    renderDetail();
    loadCases();
  }

  function readinessTab() {
    const v = current.validation;
    const list = (arr, kind) => arr.map((t) => el(`div.notice.${kind}`, t));
    return [
      el('div.card',
        el('h2', v.ready ? 'Ready to assemble' : 'Not ready yet'),
        list(v.errors, 'bad'), list(v.warnings, 'warn'), list(v.info, 'info'),
        v.missingAnswers.length ? el('div', el('h3', 'Missing answers'), el('ul.small', v.missingAnswers.map((m) => el('li', `${m.section}: ${m.label}`)))) : null,
        v.missingDocuments.length ? el('div', el('h3', 'Missing documents'), el('ul.small', v.missingDocuments.map((m) => el('li', m.label, m.staffOnly ? ' (staff task)' : '')))) : null),
      current.deadlines.length ? el('div.card', el('h2', 'Deadlines'),
        el('ul.deadlines', current.deadlines.map((x) => {
          const n = daysUntil(x.due_date);
          return el('li', el('span', { class: `badge ${n < 0 ? 'bad' : n <= 14 || x.severity === 'high' ? 'warn' : ''}` }, n < 0 ? `${-n}d overdue` : `${n}d`), el('div', el('div', x.title), el('div.small.muted', day(x.due_date))));
        }))) : null,
      el('div.card',
        el('h2', 'Forms in this filing'),
        table(el('tr', el('th', 'In package'), el('th', 'Form'), el('th', 'Title'), el('th', 'Edition'), el('th', 'Role')),
          current.forms.map((f) => {
            const choosable = f.role === 'optional' && !f.when;
            const box = el('input', { type: 'checkbox', style: 'width:auto', checked: f.included, disabled: !choosable, title: choosable ? 'Optional: tick to include' : 'Included automatically from the answers' });
            box.onchange = async () => {
              const chosen = new Set(current.answers._includeForms || []);
              if (box.checked) chosen.add(f.form); else chosen.delete(f.form);
              await refresh(await api(`/api/cases/${current.id}/answers`, { method: 'PUT', body: { _includeForms: [...chosen] } }));
            };
            return el('tr', el('td', box), el('td', f.form), el('td', f.title, f.note ? el('div.small.muted', f.note) : null), el('td', f.edition), el('td', f.role));
          })),
        el('p.small.muted', `Where to file: ${current.preset.filing.where} Fee: ${current.preset.filing.fee}`),
        el('p.small.muted', 'G-28, attorney, preparer, interpreter and translator sections are never auto-filled.')),
      teamCard(),
    ];
  }

  function teamCard() {
    const card = el('div.card', el('h2', 'Case team'),
      el('p.small.muted', current.preset.confidential ? 'Restricted case: only these people, attorneys and admins can open it.' : 'Everyone on staff can open this case. The team is who is responsible for it.'),
      el('div.row', current.team.length ? current.team.map((t) => el('span.badge', t.name || t.email)) : el('span.small.muted', 'No one assigned.')),
      el('p.small.muted', current.clientEmail ? `Client portal: ${current.clientEmail}${current.clientLinked ? '' : ' (not linked)'}` : 'No client email: the client has no portal access yet.'));
    if (attorney) {
      card.append(el('button', { style: 'margin-top:8px', onclick: async () => {
        staffList = staffList || await api('/api/staff');
        const chosen = new Set(current.team.map((t) => t.id));
        const boxes = staffList.map((s) => el('label.row', { style: 'font-weight:400' }, el('input', { type: 'checkbox', style: 'width:auto', checked: chosen.has(s.id), value: s.id }), `${s.full_name || s.email} (${s.role})`));
        card.replaceChildren(el('h2', 'Case team'), ...boxes, el('div.row', { style: 'margin-top:8px' },
          el('button.primary', { onclick: async () => {
            const ids = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
            await refresh(await api(`/api/cases/${current.id}/team`, { method: 'PUT', body: { staffIds: ids } }));
            toast('Team saved');
          } }, 'Save'),
          el('button', { onclick: () => renderDetail() }, 'Cancel')));
      } }, 'Change team'));
    }
    return card;
  }

  function intakeTab() {
    const out = [el('p.small.muted', 'Staff see every question, including staff-only ones. Changes save when you leave a field.')];
    let section = null;
    let card = null;
    for (const q of current.questions) {
      if (q.section !== section) { section = q.section; card = el('div.card', el('h2', section)); out.push(card); }
      card.append(questionField(q, current.answers[q.id], async (id, value) => {
        await refresh(await api(`/api/cases/${current.id}/answers`, { method: 'PUT', body: { [id]: value } }));
        toast('Saved');
      }));
    }
    return out;
  }

  function documentsTab() {
    return current.checklist.map((item) => {
      const picker = el('input', { type: 'file', multiple: true, hidden: true, accept: '.pdf,.jpg,.jpeg,.png', onchange: async (e) => {
        const form = new FormData();
        form.append('checklistId', item.id);
        [...e.target.files].forEach((f) => form.append('files', f));
        await refresh(await api(`/api/cases/${current.id}/documents`, { method: 'POST', form }));
        toast('Uploaded');
      } });
      return el('div.item',
        el('div.head', el('div',
          el('div.title', item.label, item.required ? '' : ' (optional)', item.staffOnly ? ' (staff)' : '', item.confidential ? ' ' : '', item.confidential ? el('span.badge.lock', 'Sensitive') : null),
          item.source ? el('div.source', `Source: ${item.source}`) : null), itemStatus(item)),
        el('ul.doclist', item.documents.map((d) => el('li',
          el('button.link', { onclick: () => openLink(`/api/cases/${current.id}/documents/${d.id}/link`) }, d.originalName),
          docStatusBadge(d),
          el('span.small.muted', `${d.uploadedBy} · ${when(d.uploadedAt)}`),
          d.status !== 'accepted' ? el('button', { onclick: () => review(d, 'accepted') }, 'Accept') : null,
          d.status !== 'rejected' ? el('button.danger', { onclick: () => review(d, 'rejected') }, 'Reject') : null,
          d.note ? el('span.small', `Note: ${d.note}`) : null))),
        el('div.row', { style: 'margin-top:8px' }, picker, el('button', { onclick: () => picker.click() }, 'Upload for client')));
    });
  }

  async function review(d, status) {
    let note = d.note || '';
    if (status === 'rejected') {
      note = prompt('Tell the client what is wrong (they get this automatically):', note);
      if (note === null) return;
    }
    await refresh(await api(`/api/cases/${current.id}/documents/${d.id}`, { method: 'PATCH', body: { status, note } }));
  }

  function packageTab() {
    const v = current.validation;
    const build = async (force) => {
      const r = await api(`/api/cases/${current.id}/assemble`, { method: 'POST', body: { force } });
      if (!r.built) { toast('Not ready: see the Readiness tab'); tab = 'readiness'; } else toast(`Built v${r.package.version}, ${r.package.pageCount} pages`);
      refresh();
    };
    const pkgs = [...current.packages].reverse().map((p) => el('div.item',
      el('div.head',
        el('div', el('div.title', `Version ${p.version}`), el('div.small.muted', `${when(p.createdAt)} by ${p.builtBy} · ${p.pageCount} pages, ${p.exhibits} exhibits${p.forced ? ' · built with missing items' : ''}`)),
        p.approved ? el('span.badge.good', `Approved by ${p.approvedBy}`) : p.rejected ? el('span.badge.bad', 'Returned') : el('span.badge.warn', 'Awaiting attorney')),
      el('div.small', el('b', 'Sections: '), p.sections.join(' > ')),
      p.notes.length ? el('ul.small.muted', p.notes.map((n) => el('li', n))) : null,
      p.rejectReason ? el('div.notice.bad', `Attorney: ${p.rejectReason}`) : null,
      el('div.row', { style: 'margin-top:8px' },
        el('button', { onclick: () => openLink(`/api/cases/${current.id}/packages/${p.version}/draft/link`) }, 'Open draft'),
        p.approved ? el('button.primary', { onclick: () => openLink(`/api/cases/${current.id}/packages/${p.version}/final/link`) }, 'Download final PDF to print') : null,
        attorney && !p.approved && !p.rejected ? el('button.primary', { onclick: async () => {
          if (!confirm(`Approve version ${p.version} as ${me.name}? This creates the final print copy.`)) return;
          await api(`/api/cases/${current.id}/packages/${p.version}/approve`, { method: 'POST', body: {} });
          toast('Approved. Final PDF is ready.');
          refresh();
        } }, 'Approve') : null,
        attorney && !p.approved && !p.rejected ? el('button.danger', { onclick: async () => {
          const reason = prompt('What needs to change?');
          if (!reason) return;
          await api(`/api/cases/${current.id}/packages/${p.version}/reject`, { method: 'POST', body: { reason } });
          refresh();
        } }, 'Return for changes') : null,
        !attorney && !p.approved && !p.rejected ? el('span.small.muted', 'Waiting for an attorney to approve.') : null)));
    return [
      el('div.card',
        el('h2', 'Assemble petition'),
        el('p.muted', 'Builds one PDF: cover letter, forms, exhibit index, then EXHIBIT 1, 2, 3... tab pages with the documents. n8n builds it automatically when the case becomes complete. Drafts carry a review banner; the final print copy is created only when an attorney approves.'),
        current.assemblyNote ? el('div.notice.info', current.assemblyNote) : null,
        el('div.row',
          el('button.primary', { onclick: () => build(false), disabled: !v.ready }, 'Assemble now'),
          !v.ready ? el('button', { onclick: () => confirm('Build a draft with missing items? It will be marked as forced.') && build(true) }, 'Build draft anyway') : null),
        !v.ready ? el('p.small.muted', 'Some required items are missing (see Readiness).') : null),
      ...(pkgs.length ? pkgs : [el('div.card.muted', 'No packages built yet.')]),
    ];
  }

  function messagesTab() {
    const who = (m) => (m.from === 'staff' ? 'Staff' : m.from === 'automation' ? 'Automatic' : current.clientName);
    const box = el('div.msgs', current.messages.map((m) => el(`div.msg${m.from !== 'client' ? '.me' : ''}${m.internal ? '.internal' : ''}`,
      el('div.text', m.text), el('div.meta', `${who(m)}${m.internal ? ' · internal note' : ''} · ${when(m.at)}`))));
    const input = el('textarea', { placeholder: 'Message the client, or write an internal note', id: 'compose' });
    const internal = el('input', { type: 'checkbox', style: 'width:auto' });
    const send = async () => {
      if (!input.value.trim()) return;
      await refresh(await api(`/api/cases/${current.id}/messages`, { method: 'POST', body: { text: input.value, internal: internal.checked } }));
    };
    setTimeout(() => { box.scrollTop = box.scrollHeight; });
    return [el('div.card', box, el('div.field', { style: 'margin-top:10px' }, input),
      el('div.row', el('label.row', { style: 'font-weight:400' }, internal, 'Internal note (client never sees it)'), el('button.primary', { onclick: send }, 'Send')))];
  }

  function auditTab() {
    return [el('div.card', el('h2', 'Activity log'),
      table(el('tr', el('th', 'When'), el('th', 'Who'), el('th', 'What'), el('th', 'Detail')),
        current.audit.map((a) => el('tr', el('td', when(a.at)), el('td', a.actor), el('td', a.action), el('td.small', a.detail)))))];
  }

  function stageControl(c) {
    const receipt = el('input', { placeholder: 'USCIS receipt no.', value: c.receiptNumber || '', style: 'width:150px' });
    const select = el('select', { style: 'width:auto' }, STAGES.map((s) => el('option', { selected: s === c.stage }, s)));
    const save = async () => {
      await api(`/api/cases/${c.id}/stage`, { method: 'PUT', body: { stage: select.value, receiptNumber: receipt.value } });
      toast(`Stage: ${select.value}`);
      refresh();
    };
    select.onchange = save;
    receipt.onchange = save;
    return el('div.row', select, ['Filed', 'Receipt received', 'Biometrics', 'Interview', 'Decision'].includes(c.stage) ? receipt : null);
  }

  function renderDetail() {
    const c = current;
    const unread = c.messages.filter((m) => m.from === 'client' && !m.readByStaff).length;
    const tabs = [['readiness', 'Readiness'], ['intake', 'Intake'], ['documents', 'Documents'], ['package', 'Package'], ['messages', `Messages${unread ? ` (${unread})` : ''}`], ['audit', 'Activity']];
    const body = { readiness: readinessTab, intake: intakeTab, documents: documentsTab, package: packageTab, messages: messagesTab, audit: auditTab }[tab]();
    detail.replaceChildren(
      el('button.link.back', { onclick: closeCase }, '< All cases'),
      el('div.card',
        el('div.row', { style: 'justify-content:space-between' },
          el('div', el('h1', c.clientName, ' ', c.preset.confidential ? el('span.badge.lock', 'Restricted') : null), el('div.muted', `${c.caseNumber} · ${c.preset.name}`)),
          stageControl(c)),
        c.preset.confidentialityNote ? el('div.notice.warn', { style: 'margin-top:10px' }, c.preset.confidentialityNote) : null),
      el('nav.tabs', tabs.map(([id, label]) => el(`button${tab === id ? '.on' : ''}`, { onclick: () => { tab = id; renderDetail(); } }, label))),
      ...body.filter(Boolean));
  }

  // ---- new case -------------------------------------------------------------

  document.getElementById('newCaseBtn').onclick = async () => {
    const presets = await api('/api/presets');
    newForm.preset.replaceChildren(...presets.map((p) => el('option', { value: p.id }, p.name)));
    newForm.hidden = false;
  };
  document.getElementById('cancelNew').onclick = () => { newForm.hidden = true; };
  newForm.onsubmit = async (e) => {
    e.preventDefault();
    const c = await api('/api/cases', { method: 'POST', body: { clientName: newForm.clientName.value, clientEmail: newForm.clientEmail.value, preset: newForm.preset.value } });
    toast(c.invited ? 'Case created. The client got an email invitation to the portal.' : 'Case created');
    newForm.reset();
    newForm.hidden = true;
    tab = 'intake';
    await openCase(c.id);
  };
  filter.oninput = renderList;

  // Live: any change the user may see (RLS decides) refreshes the list and open case,
  // unless they are typing.
  App.live(['messages', 'documents', 'packages', 'cases'], null, async () => {
    const typing = document.activeElement && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
    await loadCases();
    if (current && !typing) refresh();
    else if (!current) renderOverview();
  });

  try {
    await loadCases();
    const id = new URLSearchParams(location.search).get('case');
    if (id) await openCase(id); else await renderOverview();
  } catch (e) {
    toast(e.message);
  }
})();
