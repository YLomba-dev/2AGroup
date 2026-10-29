// Sign-in, invitation and password-reset landing, and the staff two-step code.
(async () => {
  const $ = (id) => document.getElementById(id);
  const forms = { signin: $('signin'), setpw: $('setpw'), mfa: $('mfa') };
  // Read the link type before Supabase consumes the URL hash.
  const hash = new URLSearchParams(location.hash.slice(1));
  const linkType = hash.get('type');
  const params = new URLSearchParams(location.search);
  const sb = await App.client();

  const show = (name) => Object.entries(forms).forEach(([k, f]) => { f.hidden = k !== name; });
  const notice = (text, kind = 'info') => { $('notice').className = `notice ${kind}`; $('notice').textContent = text; $('notice').hidden = !text; };

  async function route() {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2') { show('mfa'); return; }
    const me = await App.api('/api/me');
    const next = params.get('next');
    location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : me.role === 'client' ? 'client.html' : 'staff.html';
  }

  forms.signin.onsubmit = async (e) => {
    e.preventDefault();
    notice('');
    const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    if (error) return notice('Email or password is not right. Try again or use "Forgot password".', 'bad');
    route().catch((err) => notice(err.message, 'bad'));
  };

  $('magic').onclick = async () => {
    const email = $('email').value.trim();
    if (!email) return notice('Type your email first.', 'warn');
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}/login.html` } });
    notice(error ? error.message : 'If this email has an account, a sign-in link is on its way.', error ? 'bad' : 'good');
  };

  $('forgot').onclick = async () => {
    const email = $('email').value.trim();
    if (!email) return notice('Type your email first.', 'warn');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/login.html` });
    notice(error ? error.message : 'If this email has an account, a reset link is on its way.', error ? 'bad' : 'good');
  };

  forms.setpw.onsubmit = async (e) => {
    e.preventDefault();
    if ($('pw1').value !== $('pw2').value) return notice('The two passwords do not match.', 'bad');
    const { error } = await sb.auth.updateUser({ password: $('pw1').value });
    if (error) return notice(error.message, 'bad');
    route().catch((err) => notice(err.message, 'bad'));
  };

  forms.mfa.onsubmit = async (e) => {
    e.preventDefault();
    const { data } = await sb.auth.mfa.listFactors();
    const factor = data && data.totp.find((f) => f.status === 'verified');
    if (!factor) return notice('No authenticator is set up on this account.', 'bad');
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: $('code').value.trim() });
    if (error) return notice('That code did not work. Check the time on your phone and try again.', 'bad');
    route().catch((err) => notice(err.message, 'bad'));
  };

  const { data } = await sb.auth.getSession();
  if (data.session && (linkType === 'invite' || linkType === 'recovery')) {
    $('subtitle').textContent = linkType === 'invite' ? 'Welcome! Your case team invited you.' : 'Reset your password';
    show('setpw');
  } else if (data.session) {
    route().catch(() => show('signin'));
  } else if (hash.get('error_description')) {
    notice(`${hash.get('error_description')}. Ask the office for a new link.`, 'bad');
  }
})();
