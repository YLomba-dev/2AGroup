// Staff account: two-step verification and, for admins, inviting staff.
(async () => {
  const { api, el, toast } = App;
  const me = await App.requireUser(['staff', 'attorney', 'admin']);
  App.topbar(me, 'Account');
  const sb = await App.client();
  const root = document.getElementById('app');

  async function mfaCard() {
    const { data } = await sb.auth.mfa.listFactors();
    const factors = (data && data.totp) || [];
    const verified = factors.filter((f) => f.status === 'verified');
    const card = el('div.card', el('h2', 'Two-step verification'),
      el('p.small.muted', 'Staff accounts open confidential case files. Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password...) so a stolen password is not enough.'));
    if (verified.length) {
      card.append(el('div.notice.good', 'Two-step verification is on.'),
        el('button.danger', { onclick: async () => {
          if (!confirm('Turn off two-step verification?')) return;
          for (const f of verified) await sb.auth.mfa.unenroll({ factorId: f.id });
          render();
        } }, 'Turn off'));
      return card;
    }
    // Remove half-finished setups before starting a new one.
    for (const f of factors) await sb.auth.mfa.unenroll({ factorId: f.id });
    const start = el('button.primary', { onclick: async () => {
      const { data: enr, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `2A ${Date.now()}` });
      if (error) return toast(error.message);
      const code = el('input', { inputmode: 'numeric', maxlength: 6, placeholder: '6-digit code', style: 'max-width:180px' });
      start.replaceWith(el('div',
        el('p.small', '1. Scan this code with your authenticator app.'),
        el('img', { src: enr.totp.qr_code, alt: 'QR code for the authenticator app', width: 180, height: 180, class: 'qr' }),
        el('p.small.muted', `Or type this key: ${enr.totp.secret}`),
        el('p.small', '2. Type the code the app shows.'),
        el('div.row', code, el('button.primary', { onclick: async () => {
          const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: enr.id, code: code.value.trim() });
          if (e2) return toast('That code did not work. Try the next one.');
          toast('Two-step verification is on');
          render();
        } }, 'Verify'))));
    } }, 'Set up two-step verification');
    card.append(start);
    return card;
  }

  async function teamCard() {
    const staff = await api('/api/staff');
    const form = el('form.grid',
      el('div.form-row',
        el('input', { name: 'fullName', placeholder: 'Full name', required: true }),
        el('input', { name: 'email', type: 'email', placeholder: 'Email', required: true }),
        el('select', { name: 'role' }, ['staff', 'attorney', 'admin'].map((r) => el('option', { value: r }, r)))),
      el('button.primary', { type: 'submit' }, 'Send invitation'));
    form.onsubmit = async (e) => {
      e.preventDefault();
      await api('/api/staff/invite', { method: 'POST', body: { fullName: form.fullName.value, email: form.email.value, role: form.role.value } });
      toast('Invitation sent');
      render();
    };
    return el('div.card', el('h2', 'Office team'),
      el('div.table-wrap', el('table', el('tr', el('th', 'Name'), el('th', 'Email'), el('th', 'Role')),
        staff.map((s) => el('tr', el('td', s.full_name || '-'), el('td', s.email), el('td', s.role))))),
      el('h3', { style: 'margin-top:14px' }, 'Invite a team member'),
      el('p.small.muted', 'They get an email to choose a password. Only attorneys and admins can approve petitions and open every restricted case.'),
      form);
  }

  async function render() {
    root.replaceChildren(
      el('div.card', el('h1', me.name), el('div.muted', `${me.email} · ${me.role}`)),
      await mfaCard(),
      me.role === 'admin' ? await teamCard() : null);
  }

  render().catch((e) => toast(e.message));
})();
