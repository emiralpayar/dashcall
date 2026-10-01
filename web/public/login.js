let loginErr = null; // {code, msg} of the last failure, re-translated on language switch
const showErr = () => { document.getElementById('err').textContent = !loginErr ? '' : hasKey('errors.' + loginErr.code) ? t('errors.' + loginErr.code) : loginErr.msg || t('errors.generic'); };
document.addEventListener('langchange', showErr);
const pw = document.getElementById('pw'), code = document.getElementById('code');
// The one-time-code field only shows when the server has two-factor login on (DASHCALL_TOTP_SECRET).
fetch('/login/config').then(r => r.json()).then(c => { if (c.totp) code.hidden = false; }).catch(() => {});
document.getElementById('f').onsubmit = async e => {
  e.preventDefault();
  // Enter in the password field moves on to the code instead of sending a login that can only fail
  if (!code.hidden && !code.value.trim()) return code.focus();
  let r;
  try { r = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw.value, code: code.value }) }); }
  catch { loginErr = { code: 'offline' }; return showErr(); }
  if (r.ok) { location.href = '/'; return; }
  const d = await r.json().catch(() => ({}));
  loginErr = { code: d.code || (r.status === 429 ? 'rate_limited' : ''), msg: d.error }; showErr();
  // these only come from a server with two-factor login, even if /login/config couldn't be read
  if (d.code === 'bad_login' || d.code === 'code_used') code.hidden = false;
  if (d.code === 'code_used') { code.value = ''; code.focus(); }
};
