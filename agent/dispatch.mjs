// Dispatcher plumbing that needs no running server: the `claude -p` command line, the per-conversation job queue and
// short spoken messages for Claude's usage-limit, login and overload errors. Kept pure so the tests can drive it.
import path from 'node:path';

// The dispatcher reads untrusted text (session screens, transcripts, research results), so a prompt injection must not
// be able to run anything but the dashcall CLI. In dontAsk mode whatever isn't allowed is denied instead of prompting.
// Claude Code checks each part of `a && b`, `a; b`, `a | b` and `$(…)` on its own, so only dashcall and its built-in
// read-only commands (head, grep, …) pass; blockReadsOutsideWorkingDirectories keeps those inside dispatcher/.
// `unrestricted` is the documented escape hatch (DASHCALL_DISPATCH_UNRESTRICTED=1): the old skip-permissions run.
export function dispatcherArgs({ text, conversationId, model, systemPrompt, root, unrestricted = false }) {
  // Claude Code also loads CLAUDE.md files from parent folders: keep the repo's contributor guide out of the dispatcher.
  const settings = { claudeMdExcludes: ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md'].map(f => path.join(root, f)) };
  // the prompt stays right after -p: --tools and --allowedTools take several values and would swallow it
  const args = ['-p', text, '--output-format', 'json', '--model', model, '--append-system-prompt', systemPrompt];
  if (unrestricted) args.push('--dangerously-skip-permissions');
  else {
    args.push('--permission-mode', 'dontAsk', '--tools', 'Bash', '--allowedTools', 'Bash(dashcall:*)', '--strict-mcp-config');
    settings.permissions = { blockReadsOutsideWorkingDirectories: true };
  }
  args.push('--settings', JSON.stringify(settings));
  if (conversationId) args.push('--resume', conversationId);
  return args;
}

// Runs the jobs of one conversation one after another, in order: two `claude -p --resume <id>` at once would both
// append to the same transcript (a background summary can arrive while the user is talking in that conversation).
// enqueue(conversationId, run) calls run(sessionId, done) now or once the jobs ahead have finished, and returns true
// if the job had to wait. The job calls done(newSessionId) when it ends; the next one resumes that id, so it still
// works if Claude ever hands back a new session id. Jobs without a conversation never wait. onError hears about a job
// that throws instead of calling done; its conversation moves on regardless.
export function conversationQueue(onError = () => {}) {
  const lanes = new Map(); // conversation or session id -> { sid, busy, waiting: [run], keys: Set }
  function next(lane) {
    const run = lane.waiting.shift();
    if (!run) { lane.busy = false; for (const k of lane.keys) lanes.delete(k); return; }
    lane.busy = true;
    let called = false;
    const done = sid => {
      if (called) return; called = true;
      if (sid && sid !== lane.sid) { lane.sid = sid; lane.keys.add(sid); lanes.set(sid, lane); }
      next(lane);
    };
    try { run(lane.sid, done); } catch (e) { onError(e); done(); } // a job that throws must not block its conversation for good
  }
  return function enqueue(conversationId, run) {
    if (!conversationId) { run(null, () => {}); return false; }
    let lane = lanes.get(conversationId);
    if (!lane) lanes.set(conversationId, lane = { sid: conversationId, busy: false, waiting: [], keys: new Set([conversationId]) });
    lane.waiting.push(run);
    if (lane.busy) return true;
    next(lane);
    return false;
  };
}

// ---------- friendly errors ----------
// Claude Code reports limits in English ("You've hit your session limit · resets 2pm (Europe/Istanbul)"); read aloud
// inside a Turkish sentence that is useless. Conservative patterns: anything else keeps the generic failure text.
// overloaded also covers rate_limit_error: either way the answer is "try again shortly".
const KINDS = [
  // also "You're out of extra usage" / "You're out of usage credits" / "Your org is out of usage", which Claude Code
  // shows once a Max plan's extra usage or an org's allowance is used up
  ['usage_limit', /\byou[’']?ve (?:hit|reached) your (?:[\w-]+ ){0,3}limit\b|\b(?:usage|session|weekly|daily|5-hour|opus|sonnet) limit (?:reached|hit)\b|\b(?:you[’']?re|your org is) out of (?:extra )?usage\b/i],
  ['not_logged_in', /\bnot logged in\b|please run \/login|\binvalid api key\b|\boauth token (?:has )?expired\b|\bauthentication_error\b/i],
  ['overloaded', /\boverloaded(?:_error)?\b|\brate_limit_error\b/i],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAYS_TR = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const pad = n => String(n).padStart(2, '0');

// When the limit resets: "resets 2pm (Europe/Istanbul)", "will reset at 3pm.", "resets Oct 9, 5am", "resets Mon 9am",
// or the older "usage limit reached|<unix seconds>". Returns {text, hour, minute, month?, day?, weekday?} or null.
export function parseReset(s) {
  const unix = /limit reached\|(\d{10})\b/i.exec(s);
  if (unix) {
    const d = new Date(Number(unix[1]) * 1000), today = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return { text: today ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`,
      hour: d.getHours(), minute: d.getMinutes(), ...(!today && { month: d.getMonth(), day: d.getDate() }) };
  }
  const m = /\breset(?:s|ting)?\s+(?:at\s+|on\s+)?([^(·∙|\n]{1,40})/i.exec(s);
  if (!m) return null;
  const text = m[1].replace(/\.(\s.*)?$/, '').replace(/[\s,]+$/, '');
  const t = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i.exec(text) || /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (!t) return null;
  let hour = Number(t[1]); const minute = Number(t[2] || 0);
  if (t[3]) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + (t[3].toLowerCase() === 'p' ? 12 : 0); }
  if (hour > 23 || minute > 59) return null;
  const r = { text, hour, minute };
  const date = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(text);
  if (date) Object.assign(r, { month: MONTHS.indexOf(date[1].toLowerCase()), day: Number(date[2]) });
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)(?:[a-z]*day)?\b/i.exec(text);
  if (wd && !date) r.weekday = DAYS.indexOf(wd[1].toLowerCase());
  return r;
}

// Turkish locative suffix of a clock time as it is read aloud: 14:00’te (on dört), 14:30’da (otuz), 09:00’da (dokuz).
const LOC_ONES = ['da', 'de', 'de', 'te', 'te', 'te', 'da', 'de', 'de', 'da']; // sıfır bir iki üç dört beş altı yedi sekiz dokuz
const LOC_TENS = ['da', 'da', 'de', 'da', 'ta', 'de']; // sıfır on yirmi otuz kırk elli
const trLocative = n => (n % 10 ? LOC_ONES[n % 10] : LOC_TENS[n / 10]);
function trReset(r) {
  const day = r.month != null ? `${r.day} ${MONTHS_TR[r.month]} ` : r.weekday != null ? `${DAYS_TR[r.weekday]} ` : '';
  return `${day}${pad(r.hour)}:${pad(r.minute)}’${trLocative(r.minute || r.hour)}`;
}

const MESSAGES = {
  usage_limit: {
    en: r => `You've hit the Claude usage limit. ${r ? `It resets ${/^\d/.test(r.text) ? 'at ' : ''}${r.text}.` : 'Try again later.'}`,
    tr: r => `[[Claude|klod]] kullanım limitine ulaşıldı, ${r ? `${trReset(r)} sıfırlanıyor.` : 'biraz sonra tekrar dene.'}`,
  },
  not_logged_in: {
    en: () => 'Claude Code on the Mac is not logged in. Log in again there.',
    tr: () => 'Mac’teki [[Claude Code|klod kod]] oturumu kapanmış, orada yeniden giriş yapman gerekiyor.',
  },
  overloaded: {
    en: () => 'Claude is too busy right now. Try again in a minute.',
    tr: () => '[[Claude|klod]] şu an çok yoğun, bir dakika sonra tekrar dene.',
  },
};

// A known Claude failure as {code, text} in the job's language, or null for anything else.
export function friendlyError(raw, lang) {
  const s = String(raw ?? '');
  const kind = KINDS.find(([, re]) => re.test(s))?.[0];
  if (!kind) return null;
  const msg = MESSAGES[kind][lang] || MESSAGES[kind].en;
  return { code: kind, text: msg(kind === 'usage_limit' ? parseReset(s) : null) };
}
