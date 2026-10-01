// Single-page app: drive mode (voice), sessions, new job, brain, notifications.
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const MIC_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>';

// Every request has a timeout so a dead car connection can't leave the UI hanging forever.
let inflight = null; // AbortController of the current voice pipeline request (tap to cancel)
async function api(path, opts = {}) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctl.abort(), opts.timeout || 25000);
  let r;
  try {
    r = await fetch('/api' + path, { ...opts, signal: ctl.signal, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  } catch (e) {
    if (opts.signal?.aborted) throw cancelled();
    if (ctl.signal.aborted) throw Object.assign(new Error(t('errors.timeout')), { code: 'timeout', timedOut: true });
    throw Object.assign(new Error(t('errors.offline')), { code: 'offline' });
  } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); }
  if (r.status === 401) { location.href = '/'; throw new Error('login'); } // our login expired (agent auth problems arrive as 502)
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) {
    const code = data?.code;
    let msg = code && hasKey('errors.' + code) ? t('errors.' + code) : data?.error || t('errors.http', { status: r.status });
    if (DETAILED.has(code) && data?.error) msg += ': ' + data.error; // keep the useful detail (e.g. which binary is missing)
    throw Object.assign(new Error(msg), { code });
  }
  return data;
}
const DETAILED = new Set(['internal', 'session_start_failed']);
const cancelled = () => Object.assign(new Error(t('errors.cancelled')), { code: 'cancelled' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// msg is an i18n key (re-translated if the language changes while it shows) or plain text.
function toast(msg, vars, ms = 3500) {
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status');
  if (hasKey(msg)) { el.dataset.key = msg; el.dataset.vars = JSON.stringify(vars || {}); }
  el.textContent = hasKey(msg) ? t(msg, vars) : msg;
  document.querySelectorAll('.toast').forEach(x => x.remove());
  document.body.appendChild(el); setTimeout(() => el.remove(), ms);
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base = p => (p || '').split('/').filter(Boolean).pop() || '~';
function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 60) return t('ago.now'); if (s < 3600) return t('ago.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('ago.hour', { n: Math.floor(s / 3600) }); return t('ago.day', { n: Math.floor(s / 86400) });
}
const statusLabel = st => hasKey('status.' + st) ? t('status.' + st) : st;
const speechLang = () => getLocale();

// ---------- tabs ----------
let current = 'drive';
function show(view) {
  current = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'v-' + view);
  if (view === 'sessions') loadSessions();
  if (view === 'new') loadDirs();
  if (view === 'brain') loadBrain();
  if (view === 'notifs') renderNotifs();
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => show(t.dataset.view));

// ---------- audio out ----------
const player = new Audio();
player.preload = 'auto';
let audioUnlocked = false;
function silentWavUrl() {
  const b = new ArrayBuffer(44 + 800), v = new DataView(b), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + 800, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, 800, true);
  for (let i = 0; i < 800; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
function unlockAudio() {
  if (audioUnlocked) return; audioUnlocked = true;
  if (silent) return;
  player.src = silentWavUrl(); player.play().catch(() => {});
}
let lastSpoken = store.get('lastReply', '');
// Voice choice is per language; the old single 'voice' key was Turkish-only.
const VOICES = { tr: [['tr-TR-EmelNeural', 'Emel'], ['tr-TR-AhmetNeural', 'Ahmet']], en: [['en-US-AvaNeural', 'Ava'], ['en-US-AndrewNeural', 'Andrew']] };
const voiceFor = l => { const v = store.get('voice.' + l, l === 'tr' ? store.get('voice', null) : null); return v === 'local' || VOICES[l].some(x => x[0] === v) ? v : VOICES[l][0][0]; };
let voice = voiceFor(getLang());

// ---------- subtitles ----------
// Markup and chunking helpers (plain, spoken, buildChunks, …) are in subtitles.js, loaded before this file.
let subRaf = 0, subShown = -1;
function setSub(text, idle = false) {
  const el = $('sub'); el.classList.toggle('idle', idle); subKey = null;
  el.innerHTML = `<span>${esc(text)}</span>`;
}
function runSubtitles(chunks, clock) {
  cancelAnimationFrame(subRaf); subShown = -1;
  const tick = () => {
    const t = clock();
    let i = 0; while (i + 1 < chunks.length && chunks[i + 1].t <= t) i++;
    if (i !== subShown && chunks[i]) { subShown = i; setSub(chunks[i].text); }
    subRaf = requestAnimationFrame(tick);
  };
  tick();
}
function stopSubtitles() { cancelAnimationFrame(subRaf); subShown = -1; }

let speakGen = 0; // bumped by stopSpeaking(): a speak() still waiting for audio must not start playing afterwards
let speakAbort = null; // aborts the segment requests of the current speak()
let playerUrl = null;
// Silent mode (demo/development, announced by the agent): subtitles run on a timer and nothing makes a sound.
let silent = false;
async function silentSubtitles(text, gen, lang) {
  const dur = Math.max(2, spoken(text).length / 14), t0 = performance.now();
  runSubtitles(buildChunks(text, null, dur, lang), () => (performance.now() - t0) / 1000);
  while (gen === speakGen && performance.now() - t0 < dur * 1000) await sleep(100);
}
// Long replies are synthesized in segments so the first sentence plays while the rest is still being made: the
// whole reply's audio (~300 KB of base64 for 600 characters) would otherwise have to reach the car before anything
// plays. The first segment is the first sentence (≥ 40 characters, or cut at a clause if it runs past 160); the
// second is at most 400 characters, as it has only the first one's playing time to arrive; later ones up to 600,
// to keep requests and seams few. Cuts fall at a sentence end, else a clause, else a space, never inside
// [[written|spoken]] markup. Up to 200 characters stays one request: splitting would gain nothing. With `max`, no
// segment starts at or after that many characters.
const SEG_MIN = [40, 200, 200], SEG_MAX = [160, 400, 600]; // segment 1, segment 2, every later one
// The agent cuts every /api/speak text at 4000 characters. That used to bound a whole reply; with one request per
// segment it no longer would, so the app keeps the bound itself (ending at a segment boundary, not mid-word).
const SPEAK_MAX = 4000;
function speechSegments(raw, max = Infinity) {
  const text = String(raw ?? '').trim();
  if (text.length <= 200) return text ? [text] : [];
  const marks = [...text.matchAll(/\[\[[^\]|]+\|[^\]]+\]\]/g)].map(m => [m.index, m.index + m[0].length]);
  const cuts = (re, ok = () => true) => [...text.matchAll(re)].filter(ok).map(m => m.index + m[0].length)
    .filter(p => !marks.some(([a, b]) => p > a && p < b));
  const levels = [
    // a sentence ends before a capital (or a line break), but "3. madde" / "2. Ahmet" is a number, not an end
    cuts(/[.!?…]+["'”’)\]]*(?=\s+[^\s\p{Ll}])|\n/gu, m => !(m[0][0] === '.' && /\d/.test(text[m.index - 1] || ''))),
    cuts(/[,;:—–]["'”’)\]]*(?=\s)/g),
    cuts(/\S(?=\s)/g),
  ];
  const segs = [];
  for (let s = 0; s < text.length && s < max;) {
    const k = Math.min(segs.length, 2), first = !k, lo = s + SEG_MIN[k], hi = s + SEG_MAX[k];
    let e = text.length;
    if (e > hi) {
      e = null;
      for (const l of levels) {
        const c = l.filter(p => p >= lo && p <= hi);
        if (c.length) { e = c[first && l === levels[0] ? 0 : c.length - 1]; break; }
      }
      // not a single space: hard cut, after any markup (no `??=`: older car and iOS browsers can't parse it)
      if (e == null) e = marks.find(([a, b]) => hi > a && hi < b)?.[1] ?? hi;
    }
    segs.push(text.slice(s, e).trim()); s = e;
  }
  return segs.filter(Boolean);
}
// Reads text aloud with synced subtitles. Returns false if it was stopped or superseded, in which case whoever
// took over owns the UI state and the caller must not reset it.
async function speak(text, onState, lang = getLang()) {
  if (!text) return true;
  stopSpeaking();
  const gen = speakGen, ctl = speakAbort = new AbortController(), v = voiceFor(lang), segs = speechSegments(text, SPEAK_MAX);
  // Settles to {d} or {e}, never rejects: a prefetch nobody awaits any more (speech stopped) must not throw.
  const reqs = [];
  const request = i => i < segs.length && (reqs[i] || (reqs[i] = api('/speak', {
    method: 'POST', body: JSON.stringify({ text: spoken(segs[i]), voice: v, lang }), timeout: 30000, signal: ctl.signal,
  }).then(d => ({ d }), e => ({ e }))));
  onState?.('speaking');
  let i = 0;
  try {
    if (silent) throw new Error('silent');
    // Segment 2 is requested right away too: segment 1 is short, and an edge-tts request takes ~0.7-1.1 s whatever
    // its length, so segment 2 needs the head start to arrive before segment 1 has finished playing.
    request(0); request(1);
    for (; i < segs.length; i++) {
      const { d, e } = await request(i);
      reqs[i] = null; // consumed (never requested again): don't keep its audio until the whole reply is over
      if (gen !== speakGen) return false;
      if (e) throw e;
      if (d?.engine === 'silent') { silent = true; throw new Error('silent'); }
      if (!d?.audio) throw new Error('no audio'); // no neural voice available: use the browser's
      request(i + 1); // one segment ahead: synthesized while this one plays
      const ended = await playSegment(segs[i], d, gen, lang);
      if (gen !== speakGen) return false;
      if (!ended) break; // paused from outside (another app took the audio): stop, as a single reply would
    }
    ctl.abort(); // nothing left to fetch, or a prefetch after an outside pause
  } catch {
    ctl.abort(); // the browser speaks the rest: cancel the segment requests not answered yet
    if (gen !== speakGen) return false;
    const rest = i ? segs.slice(i).join(' ') : text; // a segment that fails mid-reply hands over from that segment on
    if (silent) await silentSubtitles(rest, gen, lang);
    // fallback: browser TTS, subtitles paced by elapsed time
    else if ('speechSynthesis' in window) {
      const chunks = buildChunks(rest, null, 0, lang), t0 = performance.now();
      runSubtitles(chunks, () => (performance.now() - t0) / 1000);
      await new Promise(res => {
        const u = new SpeechSynthesisUtterance(spoken(rest)); u.lang = LOCALES[lang] || speechLang(); u.onend = res; u.onerror = res;
        speechSynthesis.speak(u);
      });
    }
    if (gen !== speakGen) return false;
  }
  stopSubtitles();
  onState?.('idle');
  return true;
}
// Plays one segment on the shared player, which a tap unlocked (a new Audio element could be blocked by autoplay
// rules in car and iOS browsers), with subtitles on that segment's own clock. True if it played to the end, false
// if it was paused before; throws if it can't play, so the browser voice takes over from this segment.
async function playSegment(raw, d, gen, lang) {
  const bytes = Uint8Array.from(atob(d.audio), c => c.charCodeAt(0));
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  player.src = playerUrl = URL.createObjectURL(new Blob([bytes], { type: d.mime || 'audio/mpeg' }));
  await new Promise(res => { player.onloadedmetadata = res; player.onerror = res; setTimeout(res, 1500); });
  if (gen !== speakGen) return false;
  const chunks = buildChunks(raw, d.words, isFinite(player.duration) ? player.duration : 0, lang);
  // At the end 'pause' fires just before 'ended' (same task): only a pause that 'ended' doesn't follow counts.
  const end = new Promise(res => {
    player.onended = () => res('ended'); player.onerror = () => res('error');
    player.onpause = () => setTimeout(() => res(player.ended ? 'ended' : 'paused'));
  });
  await player.play();
  if (gen !== speakGen) return false;
  runSubtitles(chunks, () => player.currentTime);
  const how = await end;
  if (gen !== speakGen) return false; // stopped: the subtitles belong to whoever took over
  stopSubtitles(); // the next segment's clock restarts at 0: don't flash this one's first line while it loads
  if (how === 'error') throw new Error('playback failed');
  return how === 'ended';
}
function stopSpeaking() {
  speakGen++;
  speakAbort?.abort(); speakAbort = null;
  stopSubtitles();
  try { player.pause(); } catch {}
  try { speechSynthesis.cancel(); } catch {}
}

// ---------- audio in ----------
// Primary: record with MediaRecorder → server whisper. Fallback: Web Speech API.
class Recorder {
  constructor() { this.active = false; }
  static supported() { return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder); }
  async start(onLevel) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => MediaRecorder.isTypeSupported?.(m)) || '';
    try {
      this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      this.chunks = [];
      this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
      this.done = new Promise(res => this.rec.onstop = () => res(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' })));
      this.rec.start(250);
    } catch (e) { this.stream.getTracks().forEach(t => t.stop()); throw e; } // don't leave the mic (and its indicator) on
    this.active = true;
    // Hard cap on a timer too: animation frames (used below) stop in background tabs.
    this.cap = setTimeout(() => this.stop(), 120000);
    // silence detection: see the thresholds in tick()
    try {
      const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(this.stream).connect(an);
      const data = new Uint8Array(an.fftSize);
      let heard = false, quietSince = Date.now(); const t0 = Date.now();
      const tick = () => {
        if (!this.active) return;
        an.getByteTimeDomainData(data);
        let sum = 0; for (const x of data) sum += (x - 128) ** 2;
        const rms = Math.sqrt(sum / data.length);
        onLevel?.(rms);
        if (rms > 6) { heard = true; quietSince = Date.now(); }
        // 3.5s pause ends the recording (tapping the button sends earlier); 2-min hard cap
        if ((heard && Date.now() - quietSince > 3500) || Date.now() - t0 > 120000 || (!heard && Date.now() - t0 > 12000)) return this.stop();
        requestAnimationFrame(tick);
      };
      tick();
    } catch {}
    return this.done;
  }
  stop() {
    if (!this.active) return; this.active = false;
    clearTimeout(this.cap);
    try { this.rec.stop(); } catch {}
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close().catch(() => {});
  }
}

function webSpeechListen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR(); r.lang = speechLang(); r.interimResults = false; r.maxAlternatives = 1;
  const p = new Promise((res, rej) => {
    r.onresult = e => res(e.results[0][0].transcript);
    r.onerror = e => rej(new Error(e.error));
    r.onend = () => res('');
  });
  r.start();
  return { promise: p, stop: () => r.stop() };
}

let activeListen = null;
// Upload a recording for transcription, retrying once. Only drive mode (`drive`) keeps a failed recording for the
// Resend button and lets the talk button cancel it: a failed dictation must not turn into a drive-mode question.
// A dictation's upload is cancelled from its own (lit) mic button instead, through dictCtl.
let pendingAudio = null;
async function transcribe(blob, drive = false) {
  if (drive) { pendingAudio = blob; renderResend(); }
  let lastErr;
  // Long recordings (up to 2 min) take a while to transcribe; stay under the web proxy's 120s limit.
  const timeout = Math.min(110000, 30000 + blob.size / 10);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    if (drive) inflight = ctl; else dictCtl = ctl;
    try {
      const d = await api('/stt?lang=' + getLang(), { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob, timeout, signal: ctl.signal });
      if (drive) { pendingAudio = null; renderResend(); }
      return d.text || '';
    } catch (e) {
      lastErr = e;
      // a timed-out request may still be running on the server: retrying would transcribe twice
      if (ctl.signal.aborted || e.timedOut) break;
      await sleep(1500);
      if (ctl.signal.aborted) { lastErr = cancelled(); break; } // cancelled during the pause before the retry
    } finally { if (inflight === ctl) inflight = null; if (dictCtl === ctl) dictCtl = null; }
  }
  throw Object.assign(new Error(t('drive.sttFailed', { msg: lastErr.message })), { code: lastErr.code });
}
function renderResend() { const b = document.getElementById('resend'); if (b) b.hidden = !pendingAudio; }
// Listen once and return transcript text ('' if nothing). `drive`: see transcribe().
async function listen(onPhase, drive = false) {
  if (Recorder.supported()) {
    const rec = new Recorder();
    activeListen = { stop: () => rec.stop() };
    let blob;
    // A failed start (no permission, no device) must not leave a dead recorder behind as the active one.
    try { blob = await rec.start(); } finally { activeListen = null; }
    if (blob.size < 2000) return '';
    onPhase?.('transcribing');
    return transcribe(blob, drive);
  }
  const ws = webSpeechListen();
  if (!ws) throw new Error(t('drive.noMic'));
  activeListen = ws;
  try { return await ws.promise; } finally { activeListen = null; }
}

// ---------- drive mode ----------
const talk = $('talk'), stateEl = $('state');
let driveState = 'idle', driveLabel = null; // driveLabel: {key} (re-translated on language switch) or {text}
let conversationId = store.get('conversationId', null);
let history = store.get('history', []);
function setDrive(s, label) {
  driveState = s;
  talk.className = 'talk' + (s === 'idle' ? '' : ' ' + s);
  driveLabel = label == null ? { key: 'state.' + s } : typeof label === 'object' ? label : { text: label };
  renderState();
}
function renderState() { stateEl.textContent = driveLabel.key ? t(driveLabel.key) : driveLabel.text; }
// Full text / history / a past session live in a sheet so the drive screen never grows. The title is an i18n key,
// or render() returns [title, html] and runs again on a language switch (for bodies with translated text).
let sheetKey = null, sheetRender = null, sheetOpener = null;
function openSheet(key, html, render = null) {
  sheetKey = key; sheetRender = render;
  fillSheet(render ? render() : [t(key), html]);
  if ($('sheet').hidden) sheetOpener = document.activeElement; // focus goes back there on close
  $('sheet').hidden = false; $('sheet-body').scrollTop = 0;
  $('sheet-close').focus();
}
function fillSheet([title, html]) { $('sheet-title').textContent = title; $('sheet-body').innerHTML = html; }
function closeSheet() {
  if ($('sheet').hidden) return;
  // Safari doesn't focus a tapped button, so there may be no opener to go back to: don't leave focus in a hidden sheet
  if ($('sheet').contains(document.activeElement)) document.activeElement.blur();
  $('sheet').hidden = true; sheetRender = null;
  let o = sheetOpener; sheetOpener = null;
  // the session list re-renders every 15 s: if the card that opened the sheet was replaced, focus its successor
  if (o && !o.isConnected && o.dataset?.sid) o = document.querySelector(`[data-sid="${CSS.escape(o.dataset.sid)}"]`);
  o?.focus?.();
}
$('sheet-close').onclick = closeSheet;
$('sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
document.addEventListener('keydown', e => {
  if ($('sheet').hidden) return;
  if (e.key === 'Escape') return closeSheet();
  if (e.key !== 'Tab') return;
  // aria-modal doesn't stop Tab from wandering into the page behind: wrap around inside the sheet instead.
  // A notification popup floats above the sheet and can be tapped, so it stays reachable by keyboard too.
  const zone = [$('sheet'), $('npop')].filter(z => !z.hidden);
  const f = zone.flatMap(z => [...z.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')])
    .filter(x => !x.disabled && x.getClientRects().length);
  const first = f[0], last = f[f.length - 1], at = document.activeElement;
  if (!zone.some(z => z.contains(at))) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
});
document.addEventListener('langchange', () => { if (!$('sheet').hidden && sheetRender) fillSheet(sheetRender()); });
$('showfull').onclick = () => { const h = history[history.length - 1]; if (h) openSheet('sheet.lastReply', `<div class="m me">${esc(h.q)}</div>${esc(plain(h.a))}`); };
$('showlog').onclick = () => openSheet('sheet.history', history.slice().reverse().map(h => `<div class="m me">${esc(h.q)}</div><div class="m">${esc(plain(h.a))}</div>`).join(''));
function renderActions() { $('showfull').hidden = !history.length; $('showlog').hidden = history.length < 2; }
function showSaid(q) { $('said').textContent = q ? `“${q}”` : ''; }
let subKey = null; // key of the idle subtitle currently shown, re-translated on language switch
function idleSub(key = history.length ? 'drive.done' : 'drive.hint') { setSub(t(key), true); subKey = key; }
if (history.length) showSaid(history[history.length - 1].q);
idleSub(); renderActions();
function renderVoices() {
  const l = getLang();
  $('voice').innerHTML = [...VOICES[l], ['local', t('voice.local')]].map(([v, n]) => `<option value="${v}">${esc(t('voice.name', { name: n }))}</option>`).join('');
  $('voice').value = voice;
}
renderVoices(); setDrive('idle');
$('voice').onchange = () => { voice = $('voice').value; store.set('voice.' + getLang(), voice); };

// Drive mode owns the mic, the conversation and the speaker while in these states.
const DRIVE_BUSY = new Set(['listening', 'transcribing', 'thinking']);
// One id per question, sent with each attempt, so the agent can tell a retried POST from a new question.
// crypto.randomUUID needs Chromium 92+ and HTTPS; the car's browser may have neither.
function newRequestId() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch {}
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); } catch { b.forEach((_, i) => b[i] = Math.random() * 256); }
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; // UUID version 4, RFC 4122 variant
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function ask(text) {
  const lang = getLang(); // answer in the language the question was asked in, even if the user switches meanwhile
  const requestId = newRequestId();
  setDrive('thinking');
  showSaid(text); setSub('…', true);
  let j;
  const ctl = inflight = new AbortController(), sig = ctl.signal;
  try {
    for (let attempt = 0; ; attempt++) {
      try { j = await api('/ask', { method: 'POST', body: JSON.stringify({ text, conversationId, lang, requestId }), signal: sig }); deliveringJobs.add(j.id); break; }
      catch (e) { if (sig.aborted || attempt >= 1) throw e; await sleep(1500); }
    }
    // The agent runs the jobs of one conversation one at a time: a job waiting for an earlier one (e.g. a background
    // task's summary) is `queued`, and its 5 minutes only start when it runs. Agents without queues never send it.
    const t0 = Date.now();
    let ran = 0, still = false;
    const late = () => Date.now() - t0 > 15 * 60e3 || (ran && Date.now() - ran > 5 * 60e3);
    for (;;) {
      if (j.status === 'running' && j.queued) { if (driveLabel.key !== 'state.queued') setDrive('thinking', { key: 'state.queued' }); }
      else if (!ran) { ran = Date.now(); if (driveLabel.key === 'state.queued') setDrive('thinking'); }
      if (j.status !== 'running') break;
      if (ran && !still && Date.now() - ran > 12000) { still = true; setDrive('thinking', { key: 'state.stillThinking' }); }
      if (late()) throw new Error(t('drive.tooLong'));
      await sleep(1200);
      if (sig.aborted) throw cancelled();
      try { j = await api('/ask/' + j.id, { timeout: 15000, signal: sig }); } catch (e) {
        // The agent forgot the job (it restarted): it will never finish, so don't keep "thinking" for 5 minutes.
        if (e.code === 'unknown_job') throw Object.assign(new Error(t('drive.jobLost')), { code: e.code });
        if (sig.aborted || late()) throw e;
      }
    }
    // With `detail` (Claude's own words), `error` is a sentence in the question's language, ready to be spoken as is.
    // Spoken right here, like a reply: its notification must not pop up again as unread next time the app opens.
    if (j.status === 'error' && j.notificationId) markRead([j.notificationId]);
    if (j.status === 'error') throw Object.assign(new Error(j.error || t('errors.generic')), { ready: !!(j.error && j.detail) });
    conversationId = j.conversationId; store.set('conversationId', conversationId);
    const reply = j.reply || t('drive.emptyReply');
    history.push({ q: text, a: reply, ts: Date.now() }); history = history.slice(-30); store.set('history', history);
    lastSpoken = reply; store.set('lastReply', reply);
    renderActions();
    if (j.notificationId) markRead([j.notificationId]); // delivered right here: don't count it as unread while it plays
    if (!(await speak(reply, s => setDrive(s), lang))) return;
  } catch (e) {
    // we are not delivering this answer ourselves any more: let it pop up as a notification when it arrives
    if (j?.status === 'running') deliveringJobs.delete(j.id);
    if (e.code === 'cancelled') { setDrive('idle', { key: 'drive.cancelled' }); return; }
    if (!(await (e.ready ? speak(e.message, s => setDrive(s), lang) : speak(t('drive.problem', { msg: e.message }), s => setDrive(s))))) return;
  } finally { if (inflight === ctl) inflight = null; }
  setDrive('idle'); idleSub();
}

// Microphone errors, as an i18n key (null: show the browser's own message).
const micErrorKey = e => e.name === 'NotAllowedError' || e.message.includes('Permission') ? 'drive.noMicPermission'
  : e.name === 'NotFoundError' || e.name === 'NotReadableError' ? 'drive.noMic' : null;
talk.onclick = async () => {
  unlockAudio();
  requestWakeLock();
  if (driveState === 'listening') return activeListen?.stop();
  if (driveState === 'speaking') { stopSpeaking(); setDrive('idle'); return idleSub(); }
  if (driveState === 'transcribing' || driveState === 'thinking') { inflight?.abort(); return; }
  if (driveState !== 'idle') return;
  if (dictating) return toast('common.voiceBusy');
  setDrive('listening');
  try {
    const text = (await listen(p => setDrive(p), true)).trim();
    if (!text) { setDrive('idle', { key: 'drive.didntHear' }); return; }
    await ask(text);
  } catch (e) {
    const key = micErrorKey(e);
    setDrive('idle', key ? { key } : e.message);
  }
};
$('resend').onclick = async () => {
  if (!pendingAudio || driveState !== 'idle') return;
  if (dictating) return toast('common.voiceBusy');
  unlockAudio(); setDrive('transcribing');
  try {
    const text = (await transcribe(pendingAudio, true)).trim();
    if (!text) { setDrive('idle', { key: 'drive.emptyRecording' }); pendingAudio = null; renderResend(); return; }
    await ask(text);
  } catch (e) { setDrive('idle', e.message); }
};
$('repeat').onclick = async () => { unlockAudio(); if (lastSpoken && driveState === 'idle' && await speak(lastSpoken, s => setDrive(s))) idleSub(); };
$('newchat').onclick = () => { conversationId = null; store.set('conversationId', null); history = []; store.set('history', []); showSaid(''); idleSub('drive.newChatSub'); renderActions(); };
$('typeform').onsubmit = e => {
  e.preventDefault(); unlockAudio();
  const v = $('typein').value.trim(); if (!v || driveState !== 'idle') return;
  $('typein').value = ''; ask(v);
};

let wakeLock = null;
async function requestWakeLock() {
  try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => wakeLock = null; } } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && current === 'drive') requestWakeLock(); });

// ---------- dictation mic buttons ----------
// One voice input at a time: dictation and drive mode share the mic (and activeListen), so neither starts while the
// other is busy. A failed dictation is only a toast; it never becomes a drive-mode Resend.
let dictating = false, dictCtl = null; // from tap to transcript; the dictation's STT upload (see transcribe())
document.querySelectorAll('[data-mic]').forEach(b => {
  b.innerHTML = MIC_SVG;
  b.onclick = async () => {
    // tapping the lit button sends the recording, or cancels its upload (which would otherwise block drive mode)
    if (b.classList.contains('on')) return activeListen ? activeListen.stop() : dictCtl?.abort();
    if (dictating || DRIVE_BUSY.has(driveState)) return toast('common.voiceBusy');
    dictating = true; b.classList.add('on');
    try {
      const text = await listen();
      const ta = $(b.dataset.mic);
      if (text) ta.value = (ta.value ? ta.value.trimEnd() + ' ' : '') + text;
    } catch (e) { toast(e.code === 'cancelled' ? 'errors.cancelled' : micErrorKey(e) || e.message); }
    finally { dictating = false; b.classList.remove('on'); }
  };
});

// ---------- sessions ----------
let openPane = null, screenTimer = null;
function card(s, live) {
  const st = live ? s.status : 'past';
  return `<button class="card${s.muted ? ' muted' : ''}" ${live ? `data-pane="${esc(s.pane)}"` : `data-sid="${esc(s.sessionId)}"`}>
    <div class="h"><i class="dot ${live ? esc(s.status) : ''}"></i><span class="t">${esc(s.title || base(s.cwd))}</span>
      <span class="badge">${esc(statusLabel(st))} · ${ago(s.lastTs || s.mtime)}</span></div>
    <div class="proj">${esc(base(s.cwd))}</div>
    ${s.lastUser ? `<div class="u">▸ ${esc(s.lastUser)}</div>` : ''}
    ${s.lastAssistant ? `<div class="a">${esc(s.lastAssistant)}</div>` : ''}
  </button>`;
}
async function loadSessions() {
  try {
    const [{ sessions }, { sessions: recent }] = await Promise.all([api('/sessions'), api('/recent?hours=48')]);
    setConn(true);
    sessions.sort((a, b) => (a.status === 'working' ? -1 : 0) - (b.status === 'working' ? -1 : 0) || new Date(b.lastTs || 0) - new Date(a.lastTs || 0));
    const liveIds = new Set(sessions.map(s => s.sessionId));
    const past = recent.filter(r => !liveIds.has(r.sessionId));
    const live = sessions.filter(s => !s.muted), pastShown = past.filter(s => !s.muted);
    const muted = [...sessions.filter(s => s.muted).map(s => [s, true]), ...past.filter(s => s.muted).map(s => [s, false])];
    $('live').innerHTML = live.length ? live.map(s => card(s, true)).join('') : `<div class="empty-note">${t('sessions.none')}</div>`;
    $('recent').innerHTML = pastShown.length ? pastShown.map(s => card(s, false)).join('') : `<div class="empty-note">${t('common.none')}</div>`;
    $('muted-wrap').hidden = !muted.length;
    $('mutedlist').innerHTML = muted.map(([s, l]) => card(s, l)).join('');
    document.querySelectorAll('#live [data-pane], #mutedlist [data-pane]').forEach(c => c.onclick = () => openDetail(sessions.find(s => s.pane === c.dataset.pane)));
    document.querySelectorAll('#recent [data-sid], #mutedlist [data-sid]').forEach(c => c.onclick = () => openPast(past.find(s => s.sessionId === c.dataset.sid)));
  } catch (e) { setConn(false); $('live').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
$('refresh').onclick = loadSessions;
// A past session has no pane to type into any more, so it opens read-only in the sheet. No whitespace between the
// tags: the sheet body keeps it (pre-wrap).
function openPast(s) {
  if (!s) return;
  openSheet(null, null, () => [s.title || base(s.cwd), `<p class="sheet-meta">${s.cwd ? esc(s.cwd) + ' <span>· ' : '<span>'}${esc(statusLabel('past'))} · ${ago(s.lastTs || s.mtime)}</span></p>`
    + (s.lastUser ? `<h3 class="sheet-label">${t('sessions.lastPrompt')}</h3><div class="m me">${esc(s.lastUser)}</div>` : '')
    + (s.lastAssistant ? `<h3 class="sheet-label">${t('sheet.lastReply')}</h3><div class="m">${esc(s.lastAssistant)}</div>` : '')]);
}

async function refreshScreen() {
  if (!openPane) return;
  try {
    const { text } = await api(`/sessions/${encodeURIComponent(openPane)}/screen?lines=200`);
    const el = $('screen');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.textContent = text;
    if (atBottom) el.scrollTop = el.scrollHeight;
  } catch (e) { $('screen').textContent = e.message; }
}
let openSession = null;
const renderMute = () => { $('d-mute').textContent = t(openSession?.muted ? 'sessions.unmute' : 'sessions.mute'); };
function openDetail(s) {
  openPane = s.pane; openSession = s;
  renderMute();
  $('list').hidden = true; $('detail').hidden = false;
  $('d-title').textContent = s.title || base(s.cwd);
  $('d-dot').className = 'dot ' + s.status;
  $('screen').textContent = t('sessions.loading');
  refreshScreen().then(() => { $('screen').scrollTop = 1e9; });
  clearInterval(screenTimer); screenTimer = setInterval(refreshScreen, 3000);
}
$('back').onclick = () => { openPane = null; clearInterval(screenTimer); $('detail').hidden = true; $('list').hidden = false; loadSessions(); };
$('d-mute').onclick = async () => {
  const s = openSession; if (!s?.sessionId) return;
  try {
    if (s.muted) {
      // the agent names the mute that matched (this session's id or a folder); not_found then means it is already gone.
      // An older agent sends no mutedBy: the session id is only a guess, so a miss there must not look like success.
      await api('/brain/forget', { method: 'POST', body: JSON.stringify({ key: s.mutedBy || s.sessionId }) })
        .catch(e => { if (e.code !== 'not_found' || !s.mutedBy) throw e; });
      s.muted = false; s.mutedBy = null; toast('sessions.unmuted');
    } else {
      await api('/brain/mute', { method: 'POST', body: JSON.stringify({ key: s.sessionId, label: s.title || base(s.cwd) }) });
      s.muted = true; s.mutedBy = s.sessionId; toast('sessions.mutedToast');
    }
    renderMute();
  } catch (e) { toast(e.message); }
};
async function sendKey(key, msg, vars) {
  if (!openPane) return;
  try { await api(`/sessions/${encodeURIComponent(openPane)}/keys`, { method: 'POST', body: JSON.stringify({ keys: [key] }) }); toast(msg, vars); setTimeout(refreshScreen, 600); }
  catch (e) { toast(e.message); }
}
$('d-esc').onclick = () => sendKey('esc', 'sessions.escSent');
// 1/2/3/Enter answer permission and menu prompts. One key at a time, and a short pause after it: a double tap in the
// car must not also answer the prompt that comes next.
let keyBusy = false;
document.querySelectorAll('#d-keys [data-key]').forEach(b => b.onclick = async () => {
  if (keyBusy) return;
  keyBusy = true; $('d-keys').classList.add('busy');
  await Promise.all([sendKey(b.dataset.key, 'sessions.keySent', { key: b.textContent }), sleep(700)]);
  keyBusy = false; $('d-keys').classList.remove('busy');
});
$('composer').onsubmit = async e => {
  e.preventDefault();
  const text = $('d-text').value.trim(); if (!text || !openPane) return;
  try { await api(`/sessions/${encodeURIComponent(openPane)}/prompt`, { method: 'POST', body: JSON.stringify({ text }) }); $('d-text').value = ''; toast('sessions.sent'); setTimeout(refreshScreen, 800); }
  catch (e) { toast(e.message); }
};

// ---------- new job ----------
let dirsLoaded = false, nErrKey = null; // nErrKey: form error shown from an i18n key (re-translated on language switch)
async function loadDirs() {
  if (dirsLoaded) return;
  try {
    const { dirs } = await api('/dirs');
    $('n-dir').innerHTML = dirs.map(d => `<option value="${esc(d.path)}">${esc(d.name)}</option>`).join('');
    dirsLoaded = true;
  } catch (e) { nErrKey = null; $('n-err').textContent = e.message; }
}
$('newform').onsubmit = async e => {
  e.preventDefault();
  if ($('n-go').disabled) return; // already starting one (Enter in a field still submits)
  const cwd = $('n-custom').value.trim() || $('n-dir').value;
  const prompt = $('n-prompt').value.trim();
  if (!prompt) { nErrKey = 'new.needTask'; return $('n-err').textContent = t(nErrKey); }
  nErrKey = null; $('n-err').textContent = ''; $('n-go').disabled = true; $('n-go').textContent = t('new.starting');
  try {
    // Starting takes up to about a minute (shell, Claude Code, the trust prompt); the web proxy gives up at 120 s.
    const r = await api('/sessions/new', { method: 'POST', body: JSON.stringify({ cwd, prompt }), timeout: 100000 });
    toast('new.started', { name: base(r.cwd) });
    $('n-prompt').value = ''; $('n-custom').value = '';
    if (current === 'new') show('sessions'); // don't yank someone who moved on (e.g. to Drive) meanwhile
  } catch (err) {
    if (err.timedOut) {
      // The agent may still be starting it: point to Sessions instead of inviting a retry that would start a duplicate.
      nErrKey = 'new.maybeStarting'; $('n-err').textContent = t(nErrKey);
      toast('new.maybeStarting', null, 8000);
      if (current === 'new') show('sessions');
    } else { nErrKey = null; $('n-err').textContent = err.message; }
  }
  $('n-go').disabled = false; $('n-go').textContent = t('new.start');
};

// ---------- connection indicator ----------
function setConn(ok) { $('conn').className = 'conn ' + (ok ? 'ok' : 'bad'); }
async function ping() { try { const d = await api('/health'); if (d?.silent) silent = true; setConn(true); } catch { setConn(false); } }
ping(); setInterval(ping, 30000);
setInterval(() => { if (current === 'sessions' && !openPane) loadSessions(); }, 15000);

// ---------- brain ----------
const fmtDate = ts => new Date(ts).toLocaleString(getLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function items(el, list, render) {
  $(el).innerHTML = list.length ? list.map(render).join('') : `<li class="none">${t('brain.empty')}</li>`;
}
async function loadBrain() {
  try {
    const b = await api('/brain');
    const notes = [...b.notes.filter(n => !n.done).reverse(), ...b.notes.filter(n => n.done).reverse().slice(0, 10)];
    items('notes', notes, n => `<li class="${n.done ? 'done' : ''}"><div class="txt">${esc(n.text)}<div class="meta">${fmtDate(n.ts)}</div></div>
      ${n.done ? '' : `<button class="btn" data-done="${n.id}">${t('brain.done')}</button>`}<button class="btn ghost" data-forget="${n.id}" aria-label="${t('common.delete')}">✕</button></li>`);
    items('memory', [...b.memory].reverse(), m => `<li><div class="txt">${esc(m.text)}<div class="meta">${fmtDate(m.ts)}</div></div><button class="btn ghost" data-forget="${m.id}" aria-label="${t('common.delete')}">✕</button></li>`);
    items('muted', [...b.muted].reverse(), m => `<li><div class="txt">${esc(m.label)}${m.reason ? `<div class="meta">${esc(m.reason)}</div>` : ''}<div class="meta">${fmtDate(m.ts)}</div></div><button class="btn" data-forget="${esc(m.key)}">${t('brain.remove')}</button></li>`);
    document.querySelectorAll('#v-brain [data-done]').forEach(x => x.onclick = () => api('/brain/done/' + x.dataset.done, { method: 'POST' }).then(loadBrain, e => toast(e.message)));
    document.querySelectorAll('#v-brain [data-forget]').forEach(x => x.onclick = () => api('/brain/forget', { method: 'POST', body: JSON.stringify({ key: x.dataset.forget }) }).then(loadBrain, e => toast(e.message)));
  } catch (e) { toast(e.message); }
}
function brainForm(form, input, kind) {
  $(form).onsubmit = async e => {
    e.preventDefault();
    const text = $(input).value.trim(); if (!text) return;
    try { await api('/brain/' + kind, { method: 'POST', body: JSON.stringify({ text }) }); $(input).value = ''; loadBrain(); } catch (err) { toast(err.message); }
  };
}
brainForm('noteform', 'note-in', 'note');
brainForm('memform', 'mem-in', 'memory');

// ---------- notifications ----------
// Every dispatcher answer is stored server-side; unread ones are answers I never heard (app closed, music on…)
// or background task results. New ones pop up; tapping one reads it aloud and continues that conversation.
let notifs = [], notifSeen = null, popFor = null, popTimer = 0;
const deliveringJobs = new Set();
function markRead(ids) { return api('/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) }).then(pollNotifs).catch(() => {}); }
function setBadge(n) { const b = $('nbadge'); b.hidden = !n; b.textContent = n > 9 ? '9+' : n; }
const notifTitle = n => n.kind === 'task' ? t('notifs.task', { title: plain(n.title || '') }) : n.error ? t('notifs.error') : t('notifs.reply');
function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(880, ctx.currentTime); o.frequency.setValueAtTime(1320, ctx.currentTime + .12);
    g.gain.setValueAtTime(.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(.25, ctx.currentTime + .02); g.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .45);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + .5); o.onended = () => ctx.close();
  } catch {}
}
let popExtra = 0;
const renderPopTitle = () => { if (popFor) $('npop-title').textContent = notifTitle(popFor) + (popExtra ? t('notifs.unreadMore', { n: popExtra }) : ''); };
function popup(n, extra = 0) {
  popFor = n; popExtra = extra;
  renderPopTitle();
  $('npop-text').textContent = plain(n.text);
  $('npop').hidden = false;
  if (audioUnlocked && !silent) chime();
  clearTimeout(popTimer); popTimer = setTimeout(() => $('npop').hidden = true, 20000);
}
$('npop-close').onclick = () => { $('npop').hidden = true; };
// the sheet overlays every view: close it, or it would hide the Drive screen that is about to read this aloud
$('npop-open').onclick = () => { $('npop').hidden = true; closeSheet(); if (popFor) openNotif(popFor); };

async function pollNotifs() {
  try {
    const d = await api('/notifications', { timeout: 10000 });
    notifs = d.items; setBadge(d.unread);
    if (notifSeen === null) {
      notifSeen = new Set(notifs.map(n => n.id));
      const unread = notifs.filter(n => !n.read);
      if (unread.length) popup(unread[0], unread.length - 1); // came back to the app: surface what I missed
    } else {
      for (const n of notifs.slice().reverse()) {
        if (notifSeen.has(n.id)) continue;
        notifSeen.add(n.id);
        if (!n.read && !deliveringJobs.has(n.jobId)) popup(n);
      }
    }
    if (current === 'notifs') renderNotifs();
  } catch {}
}
function renderNotifs() {
  $('nlist').innerHTML = notifs.length ? notifs.map(n => `<button class="nitem${n.read ? '' : ' unread'}" data-nid="${n.id}">
      <div class="nh"><i class="dot"></i><span class="nt">${esc(notifTitle(n))}</span><span class="badge">${ago(n.ts)}</span></div>
      ${n.kind !== 'task' && n.q ? `<div class="nq">“${esc(n.q)}”</div>` : ''}
      <div class="nx">${esc(plain(n.text))}</div></button>`).join('') : `<div class="empty-note">${t('notifs.none')}</div>`;
  $('nlist').querySelectorAll('[data-nid]').forEach(b => b.onclick = () => openNotif(notifs.find(n => n.id === b.dataset.nid)));
}
$('nreadall').onclick = () => markRead('all');

// Open a notification: continue its conversation and read it aloud.
async function openNotif(n) {
  if (!n) return;
  // A question in progress would overwrite the conversation and talk over this when its answer lands: keep it unread.
  if (DRIVE_BUSY.has(driveState)) return toast('notifs.busy');
  unlockAudio();
  if (!n.read) markRead([n.id]);
  show('drive');
  if (n.conversationId) { conversationId = n.conversationId; store.set('conversationId', conversationId); }
  history.push({ q: n.kind === 'task' ? '🔔 ' + plain(n.title || t('notifs.taskFallback')) : n.q || t('notifs.fallbackQ'), a: n.text, ts: Date.now() });
  history = history.slice(-30); store.set('history', history);
  lastSpoken = n.text; store.set('lastReply', n.text);
  showSaid(history[history.length - 1].q); renderActions();
  if (driveState === 'speaking') stopSpeaking();
  if ((driveState === 'idle' || driveState === 'speaking') && await speak(n.text, st => setDrive(st), n.lang || getLang())) { setDrive('idle'); idleSub(); }
}
pollNotifs(); setInterval(pollNotifs, 8000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollNotifs(); });

// ---------- language switch: re-render everything in place ----------
document.addEventListener('langchange', () => {
  voice = voiceFor(getLang()); renderVoices();
  renderState();
  if (subKey) idleSub(subKey);
  if (!$('sheet').hidden && sheetKey) $('sheet-title').textContent = t(sheetKey);
  if (openSession) renderMute();
  if (!$('n-go').disabled) $('n-go').textContent = t('new.start');
  if (nErrKey) $('n-err').textContent = t(nErrKey);
  document.querySelectorAll('.toast[data-key]').forEach(el => el.textContent = t(el.dataset.key, JSON.parse(el.dataset.vars)));
  renderPopTitle();
  if (current === 'sessions' && !openPane) loadSessions();
  if (current === 'brain') loadBrain();
  renderNotifs();
});
