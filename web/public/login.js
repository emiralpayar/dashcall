let loginErr = null; // {code, msg} of the last failure, re-translated on language switch
const showErr = () => { document.getElementById('err').textContent = !loginErr ? '' : hasKey('errors.' + loginErr.code) ? t('errors.' + loginErr.code) : loginErr.msg || t('errors.generic'); };
document.addEventListener('langchange', showErr);
document.getElementById('f').onsubmit = async e => {
  e.preventDefault();
  let r;
  try { r = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) }); }
  catch { loginErr = { code: 'offline' }; return showErr(); }
  if (r.ok) { location.href = '/'; return; }
  const d = await r.json().catch(() => ({}));
  loginErr = { code: d.code || (r.status === 429 ? 'rate_limited' : ''), msg: d.error }; showErr();
};
