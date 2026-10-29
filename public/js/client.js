// Client portal: checklist with uploads, intake questions, messages. Updates live.
(async () => {
  const { api, el, toast, when, questionField, docStatusBadge, itemStatus } = App;
  const root = document.getElementById('app');
  const me = await App.requireUser(['client']);
  App.topbar(me, 'Client portal');
  let caseId = new URLSearchParams(location.search).get('case');
  let view = null;
  let tab = 'checklist';

  async function load() {
    if (!caseId) {
      const cases = await api('/api/cases');
      if (!cases.length) { root.replaceChildren(el('div.card', el('h1', `Hello, ${me.name.split(' ')[0]}`), el('p.muted', 'Your case is not open yet. The office will let you know when it is.'))); return; }
      if (cases.length > 1) {
        root.replaceChildren(el('div.card', el('h1', 'Your cases'), cases.map((c) => el('a.item.block', { href: `client.html?case=${c.id}` }, el('div.title', c.preset), el('div.small.muted', `${c.caseNumber} · ${c.stage}`)))));
        return;
      }
      caseId = cases[0].id;
    }
    view = await api(`/api/cases/${caseId}`);
    render();
    App.live(['messages', 'documents'], `case_id=eq.${caseId}`, refresh);
  }

  // Live update from the office: keep the tab and any text being typed.
  async function refresh() {
    const typing = document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName) && tab !== 'messages';
    view = await api(`/api/cases/${caseId}`);
    if (!typing) render();
  }

  function progress() {
    const req = view.checklist.filter((i) => i.required);
    const done = req.filter((i) => i.documents.some((d) => d.status !== 'rejected')).length;
    const qs = view.questions.filter((q) => q.required);
    const answered = qs.filter((q) => (view.answers[q.id] || '').toString().trim()).length;
    return { docs: [done, req.length], answers: [answered, qs.length] };
  }

  async function saveAnswer(id, value) {
    view = await api(`/api/cases/${caseId}/answers`, { method: 'PUT', body: { [id]: value } });
    toast('Saved');
    // Re-render only if the set of visible questions changed (conditional questions).
    const ids = view.questions.map((q) => q.id).join();
    if (ids !== root.dataset.qids) render();
  }

  async function uploadFiles(itemId, files) {
    const form = new FormData();
    form.append('checklistId', itemId);
    [...files].forEach((f) => form.append('files', f));
    view = await api(`/api/cases/${caseId}/documents`, { method: 'POST', form });
    toast(view.skipped && view.skipped.length ? `Not sent (only PDF, JPG or PNG): ${view.skipped.join(', ')}` : `${files.length} file(s) sent to the office`);
    render();
  }

  function checklistTab() {
    return view.checklist.map((item) => {
      const picker = el('input', { type: 'file', multiple: true, accept: '.pdf,.jpg,.jpeg,.png,image/*', hidden: true, onchange: (e) => e.target.files.length && uploadFiles(item.id, e.target.files) });
      return el('div.item',
        el('div.head', el('div.title', item.label), itemStatus(item)),
        item.help ? el('div.small.muted', item.help) : null,
        el('ul.doclist', item.documents.map((d) => el('li', el('span', d.originalName), docStatusBadge(d), d.note ? el('span.small.muted', `Office note: ${d.note}`) : null))),
        el('div.row', { style: 'margin-top:8px' }, picker, el('button', { onclick: () => picker.click() }, item.documents.length ? 'Add another file' : 'Upload or take a photo')));
    });
  }

  function questionsTab() {
    const out = [];
    let section = null;
    let card = null;
    for (const q of view.questions) {
      if (q.section !== section) {
        section = q.section;
        card = el('div.card', el('h2', section));
        out.push(card);
      }
      card.append(questionField(q, view.answers[q.id], saveAnswer));
    }
    root.dataset.qids = view.questions.map((q) => q.id).join();
    return [el('p.small.muted', 'Answers save automatically when you leave each box. If you are not sure, write what you know and the office will ask you.'), ...out];
  }

  function messagesTab() {
    const box = el('div.msgs', view.messages.map((m) => el(`div.msg${m.from === 'client' ? '.me' : ''}`, el('div.text', m.text), el('div.meta', `${m.from === 'client' ? 'You' : m.from === 'automation' ? '2A Group Corp (automatic)' : '2A Group Corp'} · ${when(m.at)}`))));
    const input = el('textarea', { placeholder: 'Write to your case team', id: 'compose' });
    const send = async () => {
      if (!input.value.trim()) return;
      view = await api(`/api/cases/${caseId}/messages`, { method: 'POST', body: { text: input.value } });
      tab = 'messages';
      render();
    };
    setTimeout(() => { box.scrollTop = box.scrollHeight; });
    return [el('div.card', box.childElementCount ? box : el('p.muted', 'No messages yet.'), el('div.field', { style: 'margin-top:10px' }, input), el('button.primary', { onclick: send }, 'Send'))];
  }

  function render() {
    const p = progress();
    const pct = Math.round(((p.docs[0] + p.answers[0]) / Math.max(1, p.docs[1] + p.answers[1])) * 100);
    const tabs = [['checklist', `Documents (${p.docs[0]}/${p.docs[1]})`], ['questions', `My information (${p.answers[0]}/${p.answers[1]})`], ['messages', 'Messages']];
    const body = tab === 'checklist' ? checklistTab() : tab === 'questions' ? questionsTab() : messagesTab();
    root.replaceChildren(
      el('div.card',
        el('h1', `Hello, ${view.clientName.split(' ')[0]}`),
        el('div.muted', view.preset.name),
        el('div.row', { style: 'margin:10px 0 4px' }, el('span.badge', `Stage: ${view.stage}`), el('span.small.muted', `${pct}% complete`), el('span.small.muted', view.caseNumber)),
        view.receiptNumber ? el('div.small', `USCIS receipt: ${view.receiptNumber}`) : null,
        el('div.progress', el('span', { style: `width:${pct}%` })),
        view.preset.confidential ? el('p.small.muted', 'Your case is confidential. Only your assigned case team can see it.') : null),
      el('nav.tabs.bottom-sm', tabs.map(([id, label]) => el(`button${tab === id ? '.on' : ''}`, { onclick: () => { tab = id; render(); window.scrollTo(0, 0); } }, label))),
      ...body);
  }

  load().catch((e) => { root.replaceChildren(el('div.card', e.message)); });
})();
