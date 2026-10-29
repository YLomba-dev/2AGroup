// Shared helpers: Supabase sign-in, API calls, live updates and small UI pieces.
window.App = (() => {
  let sb = null;
  let config = null;

  // Creates the Supabase client once from the server's public settings.
  async function client() {
    if (sb) return sb;
    config = await fetch('/api/config').then((r) => r.json());
    sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    return sb;
  }

  async function token() {
    const { data } = await (await client()).auth.getSession();
    return data.session ? data.session.access_token : null;
  }

  function toLogin() {
    location.href = `login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
  }

  async function api(path, { method = 'GET', body, form } = {}) {
    const t = await token();
    if (!t) { toLogin(); throw new Error('Please sign in'); }
    const headers = { Authorization: `Bearer ${t}` };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(path, { method, headers, body: payload });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (res.status === 401) { toLogin(); throw new Error('Please sign in'); }
    if (res.status === 403 && data && data.mfaRequired) { location.href = 'login.html?mfa=1'; throw new Error(data.error); }
    if (!res.ok && res.status !== 422) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  // Requires a signed-in user with one of the given roles; returns /api/me.
  async function requireUser(roles) {
    if (!(await token())) { toLogin(); return new Promise(() => {}); }
    const me = await api('/api/me');
    if (roles && !roles.includes(me.role)) {
      location.href = me.role === 'client' ? 'client.html' : 'staff.html';
      return new Promise(() => {});
    }
    return me;
  }

  async function signOut() {
    await (await client()).auth.signOut();
    location.href = 'login.html';
  }

  // Opens a short-lived file link. The tab is opened first so pop-up blockers allow it.
  async function openLink(path) {
    const w = window.open('', '_blank');
    try {
      const { url } = await api(path);
      if (w) w.location = url; else location.href = url;
    } catch (e) {
      if (w) w.close();
      toast(e.message);
    }
  }

  // Calls onChange (debounced) when rows the user may see change in these tables.
  async function live(tables, filter, onChange) {
    const s = await client();
    let timer = null;
    const fire = () => { clearTimeout(timer); timer = setTimeout(onChange, 400); };
    const ch = s.channel(`live-${Math.random().toString(36).slice(2)}`);
    tables.forEach((table) => ch.on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, fire));
    ch.subscribe();
    return () => s.removeChannel(ch);
  }

  // el('div.card', {onclick}, child, 'text') -> HTMLElement
  function el(spec, attrs, ...children) {
    const [tag, ...classes] = spec.split('.');
    const node = document.createElement(tag || 'div');
    if (classes.length) node.className = classes.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v;
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function toast(text) {
    let t = document.querySelector('.toast');
    if (!t) { t = el('div.toast', { role: 'status' }); document.body.append(t); }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { dateStyle: 'medium' });
  const daysUntil = (iso) => Math.round((new Date(`${iso}T12:00:00`) - new Date()) / 86400000);

  // One input for a preset question; calls onChange(id, value).
  function questionField(q, value, onChange) {
    let input;
    if (q.type === 'select' || q.type === 'yesno') {
      const opts = q.type === 'yesno' ? ['Yes', 'No'] : q.options;
      input = el('select', { id: `q_${q.id}` }, el('option', { value: '' }, 'Choose...'), opts.map((o) => el('option', { value: o, selected: value === o }, o)));
    } else if (q.type === 'textarea') {
      input = el('textarea', { id: `q_${q.id}` });
      input.value = value || '';
    } else {
      input = el('input', { id: `q_${q.id}`, type: q.type === 'date' ? 'date' : 'text', value: value || '', autocomplete: q.sensitive ? 'off' : undefined });
    }
    input.addEventListener('change', () => onChange(q.id, input.value));
    return el('div.field',
      el('label', { for: `q_${q.id}` }, q.label, q.required ? ' *' : '', q.staffOnly ? ' (staff only)' : ''),
      input,
      q.help ? el('div.help', q.help) : null);
  }

  function docStatusBadge(d) {
    if (d.status === 'accepted') return el('span.badge.good', 'Accepted');
    if (d.status === 'rejected') return el('span.badge.bad', 'Needs a new file');
    return el('span.badge.warn', 'Under review');
  }

  function itemStatus(item) {
    const docs = item.documents || [];
    if (docs.some((d) => d.status === 'accepted')) return el('span.badge.good', 'Done');
    if (docs.some((d) => d.status === 'pending')) return el('span.badge.warn', 'Under review');
    if (docs.length && docs.every((d) => d.status === 'rejected')) return el('span.badge.bad', 'Needs a new file');
    return item.required ? el('span.badge.bad', 'Missing') : el('span.badge', 'Optional');
  }

  // Top bar with the signed-in name and sign-out.
  function topbar(me, label) {
    const bar = document.querySelector('.topbar');
    bar.replaceChildren(...[
      el('a.brand', { href: me.role === 'client' ? 'client.html' : 'staff.html' }, '2A GROUP CORP'),
      el('span.small.hide-sm', label),
      el('span.spacer'),
      el('span.small.hide-sm', `${me.name}${me.role !== 'client' ? ` · ${me.role}` : ''}`),
      me.role !== 'client' ? el('a', { href: 'account.html' }, 'Account') : null,
      el('button.link', { onclick: signOut }, 'Sign out'),
    ].filter(Boolean));
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  return { client, api, requireUser, signOut, openLink, live, el, toast, when, day, daysUntil, questionField, docStatusBadge, itemStatus, topbar };
})();
