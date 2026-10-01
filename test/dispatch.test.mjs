// The dispatcher's command line (least privilege), the per-conversation queue and the friendly limit/login errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatcherArgs, conversationQueue, friendlyError, parseReset } from '../agent/dispatch.mjs';

const base = { text: 'hello', model: 'sonnet', systemPrompt: 'sys', root: '/repo' };
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('the dispatcher may only run the dashcall CLI, and never prompts', () => {
  const args = dispatcherArgs(base);
  assert.deepEqual(args.slice(0, 2), ['-p', 'hello']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(after(args, '--permission-mode'), 'dontAsk');
  assert.equal(after(args, '--tools'), 'Bash');
  assert.equal(after(args, '--allowedTools'), 'Bash(dashcall:*)');
  assert.ok(args.includes('--strict-mcp-config'));
  // --tools and --allowedTools take several values: the next argument must be an option, not a stray value
  for (const f of ['--tools', '--allowedTools']) assert.match(args[args.indexOf(f) + 2], /^--/);
  const settings = JSON.parse(after(args, '--settings'));
  assert.deepEqual(settings.claudeMdExcludes, ['/repo/CLAUDE.md', '/repo/AGENTS.md', '/repo/.claude/CLAUDE.md']);
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.ok(!args.includes('--resume'));
  assert.equal(after(dispatcherArgs({ ...base, conversationId: 'abc' }), '--resume'), 'abc');
});

test('DASHCALL_DISPATCH_UNRESTRICTED restores the old skip-permissions run', () => {
  const args = dispatcherArgs({ ...base, unrestricted: true });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  for (const f of ['--permission-mode', '--tools', '--allowedTools']) assert.ok(!args.includes(f), f);
  const settings = JSON.parse(after(args, '--settings'));
  assert.equal(settings.permissions, undefined);
  assert.equal(settings.claudeMdExcludes.length, 3);
});

// A fake job: records when it starts and which session it resumes; finish() ends it with a session id.
function fakeJobs() {
  const log = [], jobs = {};
  const job = name => (sid, done) => { log.push(`start ${name} ${sid}`); jobs[name] = { sid, finish: (s = sid) => { log.push(`end ${name}`); done(s); } }; };
  return { log, jobs, job };
}

test('jobs of one conversation run one at a time, in order', () => {
  const q = conversationQueue(), { log, jobs, job } = fakeJobs();
  assert.equal(q('c1', job('a')), false);
  assert.equal(q('c1', job('b')), true);
  assert.equal(q('c1', job('c')), true);
  assert.deepEqual(log, ['start a c1']);
  jobs.a.finish();
  assert.deepEqual(log, ['start a c1', 'end a', 'start b c1']);
  jobs.b.finish(); jobs.c.finish();
  assert.deepEqual(log.slice(-3), ['end b', 'start c c1', 'end c']);
  assert.equal(q('c1', job('d')), false, 'an idle conversation starts right away');
});

test('a queued job resumes the session the previous job ended in', () => {
  const q = conversationQueue(), { log, jobs, job } = fakeJobs();
  q('old', job('a'));
  q('old', job('b'));
  jobs.a.finish('new');
  assert.equal(jobs.b.sid, 'new');
  // a client that already knows the new id joins the same line
  assert.equal(q('new', job('c')), true);
  jobs.b.finish();
  assert.equal(jobs.c.sid, 'new');
  assert.deepEqual(log.filter(l => l.startsWith('start')), ['start a old', 'start b new', 'start c new']);
});

test('jobs without a conversation, and other conversations, never wait', () => {
  const q = conversationQueue(), { log, job } = fakeJobs();
  assert.equal(q(null, job('a')), false);
  assert.equal(q(null, job('b')), false);
  assert.equal(q('c1', job('c')), false);
  assert.equal(q('c2', job('d')), false);
  assert.deepEqual(log, ['start a null', 'start b null', 'start c c1', 'start d c2']);
});

test('a job that throws or finishes twice does not block or skip its conversation', () => {
  const q = conversationQueue(), { log, jobs, job } = fakeJobs();
  q('c1', job('a'));
  q('c1', () => { throw new Error('spawn failed'); });
  q('c1', job('b'));
  jobs.a.finish(); jobs.a.finish();
  assert.deepEqual(log, ['start a c1', 'end a', 'start b c1', 'end a']);
  q('c1', job('c'));
  assert.equal(jobs.c, undefined, 'c waits for b');
  jobs.b.finish();
  assert.equal(jobs.c.sid, 'c1');
});

test('usage limits become a short sentence in the job language, keeping the reset time', () => {
  const live = 'You\'ve hit your session limit · resets 2pm (Europe/Istanbul)';
  assert.deepEqual(friendlyError(live, 'tr'), { code: 'usage_limit', text: '[[Claude|klod]] kullanım limitine ulaşıldı, 14:00’te sıfırlanıyor.' });
  assert.deepEqual(friendlyError(live, 'en'), { code: 'usage_limit', text: 'You\'ve hit the Claude usage limit. It resets at 2pm.' });
  assert.equal(friendlyError('5-hour limit reached ∙ resets 1pm', 'tr').text, '[[Claude|klod]] kullanım limitine ulaşıldı, 13:00’te sıfırlanıyor.');
  assert.equal(friendlyError('Weekly limit reached ∙ resets Oct 9, 5am', 'tr').text, '[[Claude|klod]] kullanım limitine ulaşıldı, 9 Ekim 05:00’te sıfırlanıyor.');
  assert.equal(friendlyError('Weekly limit reached ∙ resets Oct 9, 5am', 'en').text, 'You\'ve hit the Claude usage limit. It resets Oct 9, 5am.');
  assert.equal(friendlyError('You’ve hit your Opus limit · resets Mon 9:30am', 'tr').text, '[[Claude|klod]] kullanım limitine ulaşıldı, Pazartesi 09:30’da sıfırlanıyor.');
  assert.equal(friendlyError('Claude usage limit reached. Your limit will reset at 3pm (America/New_York).', 'en').text, 'You\'ve hit the Claude usage limit. It resets at 3pm.');
  assert.equal(friendlyError('You\'ve reached your usage limit.', 'tr').text, '[[Claude|klod]] kullanım limitine ulaşıldı, biraz sonra tekrar dene.');
  assert.equal(friendlyError(live, 'xx').text, friendlyError(live, 'en').text);
});

test('the older "usage limit reached|<unix time>" format is read in local time', () => {
  const d = new Date(); d.setHours(15, 30, 0, 0);
  const f = friendlyError(`Claude AI usage limit reached|${Math.floor(d / 1000)}`, 'tr');
  assert.equal(f.text, '[[Claude|klod]] kullanım limitine ulaşıldı, 15:30’da sıfırlanıyor.');
  assert.match(friendlyError(`Claude AI usage limit reached|${Math.floor(d / 1000)}`, 'en').text, /It resets at 3:30\sPM\.$/);
});

test('login and overload failures get their own sentence', () => {
  for (const s of ['Invalid API key · Please run /login', 'Not logged in · Please run /login',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}']) {
    assert.equal(friendlyError(s, 'en')?.code, 'not_logged_in', s);
  }
  assert.match(friendlyError('Not logged in · Please run /login', 'tr').text, /yeniden giriş/);
  for (const s of ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'API Error: Repeated 529 Overloaded errors',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}']) {
    assert.equal(friendlyError(s, 'tr')?.code, 'overloaded', s);
  }
});

test('other failures are left alone', () => {
  for (const s of ['spawn claude ENOENT', 'exit 1', '', null, 'Reached max turns (10)', 'Context limit reached',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}', 'error_during_execution']) {
    assert.equal(friendlyError(s, 'tr'), null, String(s));
  }
});

test('reset times: 12-hour clock, Turkish suffixes and nonsense', () => {
  const tr = s => friendlyError(`You've hit your limit · resets ${s}`, 'tr').text.replace(/^.*ulaşıldı, | sıfırlanıyor\.$/g, '');
  assert.equal(tr('12am'), '00:00’da');
  assert.equal(tr('12pm'), '12:00’de');
  assert.equal(tr('4:40pm'), '16:40’ta');
  assert.equal(tr('10am'), '10:00’da');
  assert.equal(tr('8:20 PM'), '20:20’de');
  assert.equal(tr('6am'), '06:00’da');
  assert.equal(parseReset('resets 13pm'), null);
  assert.equal(parseReset('resets soon'), null);
  assert.equal(parseReset('no reset info'), null);
});
