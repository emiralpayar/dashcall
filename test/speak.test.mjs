// Segmented, pipelined speech in the SPA: speechSegments() and speak() from web/public/app.js, run in a vm with a fake
// /api/speak, a fake audio element and a fake speechSynthesis. Nothing makes a sound or touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
// the speech block: from `let speakGen` through stopSpeaking() (speechSegments, speak, playSegment…)
const block = app.match(/^let speakGen = 0;[\s\S]*?^function stopSpeaking\(\) \{[\s\S]*?^}$/m)?.[0];
const tick = () => new Promise(r => setImmediate(r));
const until = async (cond, what) => { for (let i = 0; i < 500; i++) { if (cond()) return; await tick(); } assert.fail('timed out waiting for ' + what); };
const squash = s => s.replace(/\s+/g, ' ').trim();

// Loads the speech block with fakes. `reply(call)` answers each /api/speak request (null: the test answers by hand);
// `autoEnd`: every segment plays to its end by itself. `lateAbort`: requests ignore the abort, like the real api()
// once the response headers are in (the body still arrives).
function load({ reply = () => audio(), autoEnd = true, silent = false, lateAbort = false } = {}) {
  const log = [], calls = [], states = [], urls = { made: 0, revoked: [] };
  let now = 0;
  const player = {
    _src: '', paused: true, ended: false, currentTime: 0, duration: NaN,
    get src() { return this._src; },
    set src(v) {
      Object.assign(this, { _src: v, paused: true, ended: false, currentTime: 0, duration: NaN });
      setImmediate(() => { if (this._src === v) { this.duration = 3; this.onloadedmetadata?.(); } });
    },
    play() {
      log.push('play ' + this._src); this.paused = false;
      if (autoEnd) setImmediate(() => this.finish());
      return Promise.resolve();
    },
    pause() { if (this.paused) return; this.paused = true; setImmediate(() => this.onpause?.()); },
    // like a browser at the end of the media: 'pause' then 'ended', in one task
    finish() { if (this.paused) return; this.currentTime = this.duration; this.ended = this.paused = true; this.onpause?.(); this.onended?.(); },
  };
  const synth = {
    spoken: [], current: null,
    speak(u) { this.spoken.push(u.text); this.current = u; setImmediate(() => u.onend?.()); },
    cancel() { const u = this.current; this.current = null; if (u) setImmediate(() => u.onerror?.()); },
  };
  const ctx = {
    api(path, opts) {
      return new Promise((resolve, reject) => {
        const call = { path, ...JSON.parse(opts.body), signal: opts.signal, resolve, reject };
        calls.push(call); log.push('request ' + calls.length);
        if (!lateAbort) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' })));
        if (reply) setImmediate(() => { try { resolve(reply(call)); } catch (e) { reject(e); } });
      });
    },
    player, speechSynthesis: synth,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    buildChunks: (raw, words, duration) => { log.push(['chunks', raw, words, duration]); return [{ t: 0, text: raw }]; },
    runSubtitles: (chunks, clock) => { log.push(['subs', chunks[0]?.text, clock()]); },
    stopSubtitles: () => { log.push(['stopsubs']); },
    spoken: t => String(t ?? '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2'),
    sleep: () => tick(),
    performance: { now: () => (now += 250) },
    voiceFor: l => 'voice-' + l, getLang: () => 'tr', speechLang: () => 'tr-TR', LOCALES: { en: 'en-US', tr: 'tr-TR' },
    URL: { createObjectURL: () => 'blob:' + ++urls.made, revokeObjectURL: u => urls.revoked.push(u) },
    Blob: class { constructor(parts, o) { this.type = o?.type; } },
    atob, AbortController,
    // the 1.5 s metadata fallback timer must not keep the test process alive
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); if (ms >= 1000) t.unref(); return t; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.__silent = { get: () => silent, set: v => { silent = v; } };', ctx);
  ctx.__silent.set(silent);
  const say = (text, lang) => ctx.speak(text, s => states.push(s), lang);
  return { ctx, say, log, calls, states, player, synth, urls, plays: () => log.filter(l => typeof l === 'string' && l.startsWith('play')).length };
}
const audio = (words = [{ t: 0, d: 0.2, w: 'x' }]) => ({ engine: 'neural', mime: 'audio/mpeg', audio: Buffer.from('mp3').toString('base64'), words });
const segmentsIn = load().ctx.speechSegments;
const segmentsOf = t => [...segmentsIn(t)]; // an array of this realm, for deepStrictEqual

const sentence = i => `Sentence number ${i} explains what the session is doing right now.`;
const LONG = Array.from({ length: 24 }, (_, i) => sentence(i)).join(' '); // ~1600 characters, one cut per ~600

test('speechSegments: short replies stay one piece, exactly as given', () => {
  assert.deepEqual(segmentsOf(''), []);
  assert.deepEqual(segmentsOf('   '), []);
  assert.deepEqual(segmentsOf('Done.'), ['Done.']);
  const two = 'The tests passed. The [[PR|pi ar]] is ready for review, and nothing else is waiting for you right now.';
  assert.deepEqual(segmentsOf(two), [two]);
  assert.deepEqual(segmentsOf('x'.repeat(200)), ['x'.repeat(200)]);
});

test('speechSegments: first sentence first, then big segments cut at sentence ends', () => {
  const segs = segmentsOf(LONG);
  assert.equal(segs[0], sentence(0));
  assert.ok(segs[1].length >= 200 && segs[1].length <= 400, segs[1].length);
  for (const s of segs.slice(2, -1)) assert.ok(s.length >= 200 && s.length <= 600, s.length);
  for (const s of segs) assert.match(s, /\.$/);
  assert.equal(squash(segs.join(' ')), squash(LONG));
  // a first sentence under 40 characters takes the next one along, so segment 1 isn't over before 2 arrives
  assert.equal(segmentsOf('Okay. ' + LONG)[0], 'Okay. ' + sentence(0));
});

test('speechSegments: a long first sentence is cut at a clause, else at a space, by 160 characters', () => {
  const clauses = 'The payment service is running its tests again, two of them failed on the last run, so it is fixing ' +
    'them now and expects to finish within about five minutes, then it will deploy and let you know, and after that it cleans up.';
  const [a, b] = segmentsOf(clauses);
  assert.ok(a.length <= 160 && a.endsWith(','), a);
  assert.equal(squash(a + ' ' + b), squash(clauses));
  const words = Array.from({ length: 60 }, (_, i) => 'word' + i).join(' ');
  const [w] = segmentsOf(words);
  assert.ok(w.length <= 160 && w.length > 140 && words.startsWith(w + ' '), w);
});

test('speechSegments: numbers and lowercase after a period are not sentence ends', () => {
  const t = 'Here is the list for today, in order: ' + 'item 3. second thing, e.g. something small and then 12. More text '.repeat(4) + 'and the end.';
  for (const s of segmentsOf(t).slice(0, -1)) assert.doesNotMatch(s, /(\d|e\.g)\.$/, s);
});

test('speechSegments: never cuts inside [[written|spoken]] markup', () => {
  let seed = 7;
  const rnd = n => { seed = (seed * 16807) % 2147483647; return seed % n; };
  const MARKS = ['[[pull request review|pul rikuest rivyu]]', '[[CI. pipeline, v2|si ay payplayn]]', '[[GitHub|git hab]]\'ı', '[[Node.js|nod ce es]]'];
  const WORDS = ['oturum', 'çalışıyor,', 'bitti.', 'Sonra', 'test', 'hazır;', 'proje', 'Evet!', 'bekliyor', 'rapor'];
  for (let k = 0; k < 300; k++) {
    const n = 20 + rnd(300), parts = [];
    for (let i = 0; i < n; i++) parts.push(rnd(6) ? WORDS[rnd(WORDS.length)] : MARKS[rnd(MARKS.length)]);
    const text = parts.join(rnd(2) ? ' ' : '\n');
    const segs = segmentsOf(text);
    assert.equal(squash(segs.join(' ')), squash(text));
    for (const s of segs) {
      assert.equal((s.match(/\[\[/g) || []).length, (s.match(/\]\]/g) || []).length, s);
      assert.equal(s.replace(/\[\[[^\]|]+\|[^\]]+\]\]/g, '').includes('['), false, s);
    }
    // a hard cut may run on to the end of the markup it would split
    if (segs.length > 1) assert.ok(segs[0].length <= 160 + 45, segs[0]);
    if (segs.length > 2) assert.ok(segs[1].length <= 400 + 45, segs[1]);
    for (const s of segs.slice(2)) assert.ok(s.length <= 600 + 45, s.length);
  }
});

test('speechSegments: the speech code parses in older car and iOS browsers', () => {
  // the SPA otherwise needs no more than optional chaining and `??` (Chrome 80, Safari 13.1)
  assert.doesNotMatch(block.replace(/\/\/.*$/gm, ''), /\?\?=|\|\|=|&&=|\.at\(/);
});

test('speak: a short reply is one request, played once, as before', async () => {
  const t = load();
  assert.equal(await t.say('Your [[PR|pi ar]] is merged.', 'en'), true);
  assert.deepEqual(t.calls.map(c => [c.text, c.voice, c.lang]), [['Your pi ar is merged.', 'voice-en', 'en']]);
  assert.equal(t.plays(), 1);
  assert.deepEqual(t.states, ['speaking', 'idle']);
  assert.deepEqual(t.log.find(l => l[0] === 'chunks'), ['chunks', 'Your [[PR|pi ar]] is merged.', [{ t: 0, d: 0.2, w: 'x' }], 3]);
});

test('speak: segments play in order on the one player, one request ahead, each with its own subtitles', async () => {
  const t = load({ reply: null, autoEnd: false });
  const segs = segmentsOf(LONG), done = t.say(LONG);
  await until(() => t.calls.length === 2, 'two requests');
  assert.deepEqual(t.calls.map(c => c.text), segs.slice(0, 2), 'segment 2 is requested together with segment 1');
  t.calls[0].resolve(audio([{ t: 0, d: 0.1, w: 'a' }]));
  await until(() => t.plays() === 1, 'segment 1 playing');
  assert.equal(t.calls.length, 2, 'no more than one segment ahead');
  t.calls[1].resolve(audio([{ t: 0, d: 0.1, w: 'b' }]));
  t.player.finish();
  await until(() => t.plays() === 2, 'segment 2 playing');
  await until(() => t.calls.length === 3, 'segment 3 requested while 2 plays');
  t.calls[2].resolve(audio([{ t: 0, d: 0.1, w: 'c' }]));
  for (let k = 2; k < segs.length; k++) {
    t.player.finish();
    await until(() => t.plays() === k + 1, `segment ${k + 1} playing`);
    if (k + 1 < segs.length) { await until(() => t.calls.length === k + 2, 'next request'); t.calls[k + 1].resolve(audio()); }
  }
  t.player.finish();
  assert.equal(await done, true);
  assert.equal(t.calls.length, segs.length);
  assert.deepEqual(t.states, ['speaking', 'idle'], 'no state flicker between segments');
  const chunks = t.log.filter(l => l[0] === 'chunks');
  assert.deepEqual(chunks.map(c => c[1]), segs);
  assert.deepEqual(chunks.slice(0, 3).map(c => c[2][0].w), ['a', 'b', 'c'], 'each segment uses its own word timings');
  assert.ok(t.log.filter(l => l[0] === 'subs').every(s => s[2] === 0), 'the subtitle clock restarts for every segment');
  assert.equal(t.urls.revoked.length, segs.length - 1, 'every replaced object URL is revoked');
});

test('speak: a very long reply stops at the segment that crosses 4000 characters, like the agent\'s cap did', async () => {
  const HUGE = Array.from({ length: 150 }, (_, i) => sentence(i)).join(' '); // ~9700 characters
  assert.equal(squash(segmentsOf(HUGE).join(' ')), squash(HUGE), 'speechSegments alone has no limit');
  const t = load();
  assert.equal(await t.say(HUGE), true);
  const said = t.calls.map(c => c.text).join(' ');
  assert.ok(HUGE.startsWith(said), 'a prefix, in order');
  assert.ok(said.length >= 4000 && said.length <= 4600, said.length);
  assert.ok(t.calls.every(c => c.text.length <= 600));
  assert.equal(t.plays(), t.calls.length);
});

test('speak: stopSpeaking() during playback cancels the prefetch and returns false', async () => {
  const t = load({ autoEnd: false });
  const done = t.say(LONG);
  await until(() => t.plays() === 1, 'segment 1 playing');
  const pending = t.calls[1];
  t.ctx.stopSpeaking();
  assert.equal(await done, false);
  assert.equal(pending.signal.aborted, true);
  await tick(); await tick();
  assert.equal(t.calls.length, 2);
  assert.equal(t.plays(), 1);
  assert.deepEqual(t.states, ['speaking'], 'whoever stopped it owns the state');
});

test('speak: stopping while the next segment is still being synthesized returns false and plays nothing more', async () => {
  const t = load({ reply: null });
  const done = t.say(LONG);
  await until(() => t.calls.length === 2, 'two requests');
  t.calls[0].resolve(audio());
  await until(() => t.plays() === 1 && t.player.ended, 'segment 1 finished');
  t.ctx.stopSpeaking();
  assert.equal(await done, false);
  assert.equal(t.calls[1].signal.aborted, true);
  assert.equal(t.plays(), 1);
});

test('speak: audio that arrives after stopSpeaking() is not played', async () => {
  const t = load({ reply: null, lateAbort: true });
  const done = t.say(LONG);
  await until(() => t.calls.length === 2, 'two requests');
  t.ctx.stopSpeaking();
  t.calls[0].resolve(audio());
  assert.equal(await done, false);
  await tick(); await tick();
  assert.equal(t.urls.made, 0, 'the player is left alone: a newer speak() may be using it');
  assert.equal(t.plays(), 0);
  assert.deepEqual(t.states, ['speaking']);
});

test('speak: a newer speak() supersedes one still waiting for audio', async () => {
  const t = load({ reply: null });
  const first = t.say(LONG);
  await until(() => t.calls.length === 2, 'first requests');
  const second = t.say('Something new.');
  assert.equal(await first, false);
  assert.ok(t.calls[0].signal.aborted && t.calls[1].signal.aborted);
  await until(() => t.calls.length === 3, 'second request');
  t.calls[2].resolve(audio());
  assert.equal(await second, true);
  assert.equal(t.plays(), 1);
  assert.deepEqual(t.states, ['speaking', 'speaking', 'idle']);
});

test('speak: a superseded segment leaves the new reply\'s subtitles running', async () => {
  const t = load({ autoEnd: false });
  const first = t.say(LONG);
  await until(() => t.plays() === 1, 'segment 1 playing');
  t.ctx.__silent.set(true); // the new reply's subtitles start at once, without waiting for audio
  const second = t.say(LONG);
  const started = t.log.length;
  assert.equal(await first, false);
  assert.deepEqual(t.log.slice(started).filter(l => l[0] === 'stopsubs'), [], 'the old segment must not stop them');
  t.ctx.stopSpeaking();
  assert.equal(await second, false);
});

test('speak: if a later segment fails, the browser voice reads the rest', async () => {
  const segs = segmentsOf(LONG);
  const t = load({ reply: c => { if (c.text === segs[1]) throw new Error('HTTP 502'); return audio(); } });
  assert.equal(await t.say(LONG), true);
  assert.equal(t.plays(), 1);
  assert.deepEqual(t.synth.spoken, [segs.slice(1).join(' ')]);
  assert.equal(t.calls.length, 2, 'nothing more is requested after the hand-over');
  assert.ok(t.calls.every(c => c.signal.aborted), 'the remaining requests are cancelled');
  assert.deepEqual(t.states, ['speaking', 'idle']);
});

test('speak: if the first request fails, the browser voice reads the whole text', async () => {
  const t = load({ reply: () => { throw new Error('offline'); } });
  assert.equal(await t.say('Kısa [[PR|pi ar]] cevabı.'), true);
  assert.deepEqual(t.synth.spoken, ['Kısa pi ar cevabı.']);
});

test('speak: a segment that cannot be played hands over to the browser voice from that segment on', async () => {
  const segs = segmentsOf(LONG);
  const t = load();
  let n = 0;
  const play = t.player.play.bind(t.player);
  t.player.play = () => (++n === 2 ? Promise.reject(new Error('NotAllowedError')) : play());
  assert.equal(await t.say(LONG), true);
  assert.deepEqual(t.synth.spoken, [segs.slice(1).join(' ')]);
});

test('speak: a pause from outside ends the reply like a single one, without the rest', async () => {
  const t = load({ autoEnd: false });
  const done = t.say(LONG);
  await until(() => t.plays() === 1, 'segment 1 playing');
  const pending = t.calls[1];
  t.player.pause(); // e.g. the system gave the audio to a phone call
  assert.equal(await done, true);
  assert.equal(pending.signal.aborted, true);
  assert.equal(t.plays(), 1);
  assert.deepEqual(t.states, ['speaking', 'idle']);
});

test('speak: silent mode shows subtitles for the whole text and asks for no more audio', async () => {
  const t = load({ reply: () => ({ engine: 'silent', audio: null, words: [] }) });
  assert.equal(await t.say(LONG), true);
  assert.equal(t.ctx.__silent.get(), true);
  assert.equal(t.plays(), 0);
  assert.deepEqual(t.synth.spoken, []);
  assert.deepEqual(t.log.filter(l => l[0] === 'chunks').map(c => c[1]), [LONG], 'the whole reply, not just segment 1');
  const n = t.calls.length;
  assert.equal(await t.say(LONG), true);
  assert.equal(t.calls.length, n, 'once silent, no requests at all');
});

test('speak: the local voice (no word timings) plays each segment with estimated timing', async () => {
  const t = load({ reply: () => ({ engine: 'local', mime: 'audio/mpeg', audio: Buffer.from('mp3').toString('base64'), words: [] }) });
  assert.equal(await t.say(LONG), true);
  const chunks = t.log.filter(l => l[0] === 'chunks');
  assert.equal(chunks.length, segmentsOf(LONG).length);
  assert.ok(chunks.every(c => c[2].length === 0 && c[3] === 3));
});
