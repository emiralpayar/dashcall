// Subtitle helpers of the SPA (web/public/subtitles.js): [[written|spoken]] markup and timed subtitle chunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const NAMES = ['norm', 'MARK', 'plain', 'spoken', 'mapText', 'tokensOf', 'buildChunks'];
// The page loads it as a classic script, so its top-level consts are read back from the context's global scope.
function load(ctx = {}, before = []) {
  vm.createContext(ctx);
  for (const f of [...before, 'web/public/subtitles.js']) vm.runInContext(read(f), ctx, { filename: f });
  return vm.runInContext(`({ ${NAMES.join(', ')} })`, ctx);
}
const S = load();
// Results come from the vm realm (other Array/Object prototypes), which deepStrictEqual would reject.
const copy = x => JSON.parse(JSON.stringify(x));
const chunks = (...a) => copy(S.buildChunks(...a));
const texts = (...a) => chunks(...a).map(c => c.text);
const timed = s => s.split(' ').map((w, i) => ({ w, t: i * 0.25 }));
const starts = (...a) => chunks(...a).map(c => c.t);
const near = (actual, expected) => assert.ok(actual.length === expected.length && actual.every((x, i) => Math.abs(x - expected[i]) < 1e-9),
  `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);

test('plain shows the written part and spoken the spoken part', () => {
  const raw = "[[PR|pi ar]]'ı açtım, [[CI pipeline|si ay payplayn]] geçti.";
  assert.equal(S.plain(raw), "PR'ı açtım, CI pipeline geçti.");
  assert.equal(S.spoken(raw), "pi ar'ı açtım, si ay payplayn geçti.");
  assert.equal(S.plain('[[a|b|c]]'), 'a'); // only the written part stops at |
  assert.equal(S.spoken('[[a|b|c]]'), 'b|c');
  for (const s of ['[[PR]]', '[[|pi ar]]', '[[PR|]]', '[[PR|pi ar]', 'no markup']) {
    assert.equal(S.plain(s), s); assert.equal(S.spoken(s), s);
  }
  assert.equal(S.plain(null), ''); assert.equal(S.spoken(undefined), ''); assert.equal(S.plain(42), '42');
});

test('mapText maps every display character to its place in the spoken text', () => {
  const same = S.mapText('No markup here.');
  assert.equal(same.disp, 'No markup here.'); assert.equal(same.say, 'No markup here.');
  assert.deepEqual(copy(same.map), [...'No markup here.'].map((_, i) => i));

  const raw = 'Open the [[PR|pi ar]] and [[CI pipeline|si ay payplayn]] now.';
  const { disp, say, map } = S.mapText(raw);
  assert.equal(disp, S.plain(raw)); assert.equal(say, S.spoken(raw));
  assert.equal(map.length, disp.length);
  for (let i = 1; i < map.length; i++) assert.ok(map[i] >= map[i - 1] && map[i] < say.length, `map[${i}]`);
  // unmarked text maps one to one, a respelled word starts where its spoken form starts
  for (const part of ['Open the ', ' and ', ' now.']) {
    const d = disp.indexOf(part), s = say.indexOf(part);
    for (let i = 0; i < part.length; i++) assert.equal(map[d + i], s + i, JSON.stringify(part));
  }
  assert.equal(say.slice(map[disp.indexOf('PR')]), 'pi ar and si ay payplayn now.');
  assert.equal(say.slice(map[disp.indexOf('CI')]), 'si ay payplayn now.');
  assert.equal(map[disp.indexOf('R')], say.indexOf('pi ar') + 2); // spread proportionally across "pi ar"
  // MARK is a global regex: state left by other callers (lastIndex) must not change the result
  S.plain(raw); S.MARK.lastIndex = 12;
  assert.deepEqual(copy(S.mapText(raw)), copy({ disp, say, map }));
});

test('tokensOf returns each word with its offset', () => {
  assert.deepEqual(copy(S.tokensOf('  a  bc\nd ')), [{ text: 'a', at: 2 }, { text: 'bc', at: 5 }, { text: 'd', at: 8 }]);
  assert.deepEqual(copy(S.tokensOf(' \n ')), []);
});

test('norm compares words by letters and digits, lowercased in the UI language', () => {
  assert.equal(S.norm('"Hello,"'), 'hello');
  assert.equal(S.norm("PR'ı"), 'prı');
  assert.equal(S.norm('3.5'), '35');
  assert.equal(S.norm('—'), '');
  assert.equal(S.norm('IŞIK', 'tr'), 'ışık');
  assert.equal(S.norm('IŞIK', 'en'), 'işik');
  // with i18n.js loaded first (as on the page), the default is the UI language
  const page = (lang) => load({
    document: { addEventListener() {}, dispatchEvent() {}, documentElement: {}, querySelectorAll: () => [] },
    localStorage: { getItem: k => (k === 'lang' ? lang : null), setItem() {} }, navigator: { language: 'en-US' },
    CustomEvent: class {}, Event: class {},
  }, ['web/public/i18n.js']);
  assert.equal(page('tr').norm('IŞIK'), 'ışık');
  assert.equal(page('en').norm('IŞIK'), 'işik');
});

test('buildChunks returns nothing for empty text', () => {
  for (const s of ['', '   ', '\n\t', '**', '`#>_']) assert.deepEqual(chunks(s, null, 0), [], JSON.stringify(s));
  assert.deepEqual(chunks('', timed('a b'), 2), []);
});

test('buildChunks breaks at sentence punctuation', () => {
  assert.deepEqual(texts('One. Two! Three? Four… Five: six; seven', null, 0), ['One.', 'Two!', 'Three?', 'Four…', 'Five:', 'six;', 'seven']);
  // closing quotes and brackets after the punctuation still end the sentence
  assert.deepEqual(texts('He said "stop." Then (see docs.) next', null, 0), ['He said "stop."', 'Then (see docs.)', 'next']);
  assert.deepEqual(texts('Version 2.5 is out. Ok', null, 0), ['Version 2.5 is out.', 'Ok']);
});

test('buildChunks keeps chunks to about 7 words or 42 characters', () => {
  assert.deepEqual(texts('one two three four five six seven eight nine ten', null, 0),
    ['one two three four five six seven', 'eight nine ten']);
  // each word counts with a space: three 13-letter words make exactly 42, three 12-letter ones only 39
  const w13 = 'abcdefghijklm', w12 = 'abcdefghijkl';
  assert.deepEqual(texts(`${w13} ${w13} ${w13} x`, null, 0), [`${w13} ${w13} ${w13}`, 'x']);
  assert.deepEqual(texts(`${w12} ${w12} ${w12} x`, null, 0), [`${w12} ${w12} ${w12} x`]);
  for (const c of chunks('The quick brown fox jumps over the lazy dog and keeps running far away from the farm today', null, 0)) {
    const n = c.text.split(' ');
    assert.ok(n.length <= 7, c.text);
    assert.ok(n.slice(0, -1).join(' ').length + 1 < 42, c.text); // only the last word may cross the limit
  }
});

test('buildChunks breaks at a comma only after at least four words', () => {
  assert.deepEqual(texts('One, two three four, five six.', null, 0), ['One, two three four,', 'five six.']);
  assert.deepEqual(texts('a b c, d e f g h', null, 0), ['a b c, d e f g', 'h']);
  assert.deepEqual(texts('Well one two "three," four', null, 0), ['Well one two "three,"', 'four']);
});

test('buildChunks shows the written form and drops markdown symbols', () => {
  assert.deepEqual(texts("[[PR|pi ar]]'ı açtım. [[GitHub|git hab]] hazır.", null, 0), ["PR'ı açtım.", 'GitHub hazır.']);
  assert.deepEqual(texts('**Bold** and `code` # done', null, 0), ['Bold and code done']);
});

test('without word timings, chunks start in proportion to the spoken text', () => {
  assert.deepEqual(texts('One. Two. Three.', null, 3), ['One.', 'Two.', 'Three.']);
  near(starts('One. Two. Three.', null, 3), [0, 5 / 16 * 3, 10 / 16 * 3]);
  // no duration either: about 14 characters per second
  near(starts('One. Two. Three.', null, 0), [0, 5 / 14, 10 / 14]);
  // respelled words count with their spoken length
  near(starts('[[API|ey pi ay]] ok. Next.', null, 0), [0, 13 / 14]);
});

test('with word timings, chunks start when their first word is spoken', () => {
  const said = 'Hello there. Your build passed. Done.';
  assert.deepEqual(starts(said, timed(said), 99), [0, 0.5, 1.25]);
  // a respelled word at the start of a chunk takes the time of its spoken form
  assert.deepEqual(chunks('Tamam. [[GitHub|git hab]] açık.', [{ w: 'Tamam', t: 0 }, { w: 'git', t: 0.8 }, { w: 'hab', t: 1 }, { w: 'açık', t: 1.3 }], 2),
    [{ t: 0, text: 'Tamam.' }, { t: 0.8, text: 'GitHub açık.' }]);
  // suffix outside the brackets, as the dispatcher writes it
  assert.deepEqual(starts("Bitti. [[PR|pi ar]]'ı açtım.", [{ w: 'Bitti', t: 0 }, { w: 'pi', t: 0.7 }, { w: "ar'ı", t: 0.9 }, { w: 'açtım', t: 1.2 }], 2), [0, 0.7]);
  // a number the voice reads as words stays unmatched, and the words after it still align
  assert.deepEqual(starts('Wait 3 minutes. Then go.', [{ w: 'Wait', t: 0 }, { w: 'three', t: 0.3 }, { w: 'minutes', t: 0.6 }, { w: 'Then', t: 1.5 }, { w: 'go', t: 1.8 }], 2), [0, 1.5]);
});

test('emoji (two UTF-16 units) do not shift later chunk times', () => {
  const { disp, map } = S.mapText('🙂 Hi [[PR|pi ar]] 👍');
  assert.equal(map.length, disp.length);
  assert.equal(map[disp.indexOf('Hi')], 3);
  near(starts('🙂🙂🙂🙂🙂🙂 Go. Up. Now.', null, 0), [0, 17 / 14, 21 / 14]);
});

test('a word the voice splits in parts is consumed whole', () => {
  // only 4 timed words are looked ahead: without consuming y…v, "Next." would get a proportional estimate (7.6)
  const words = ['Open', 'x', 'y', 'z', 'w', 'v'].map((w, i) => ({ w, t: i / 10 })).concat({ w: 'Next', t: 1.5 });
  assert.deepEqual(starts('Open x/y/z/w/v. Next.', words, 10), [0, 1.5]);
});

test('the matching locale is the fourth argument', () => {
  const words = [{ w: 'Tamam', t: 0 }, { w: 'ışık', t: 1.2 }, { w: 'yandı', t: 1.6 }];
  assert.equal(chunks('Tamam. IŞIK yandı.', words, 3, 'tr')[1].t, 1.2);
  assert.notEqual(chunks('Tamam. IŞIK yandı.', words, 3, 'en')[1].t, 1.2); // no match: proportional estimate
});

test('chunk times never go backwards, whatever the timings look like', () => {
  let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const VOCAB = ['ok', 'the', 'session', 'is', 'done.', 'tests,', 'passed!', '[[PR|pi ar]]', "[[PR|pi ar]]'ı", '[[CI pipeline|si ay payplayn]]',
    'e-posta', '3', '"quoted."', '(aside)', '**bold**', 'Işık', 'çok', 'güzel;', 'why?', 'well…', '🙂', '👍🏽.'];
  for (let n = 0; n < 300; n++) {
    const raw = Array.from({ length: 1 + rnd(30) }, () => VOCAB[rnd(VOCAB.length)]).join(rnd(5) ? ' ' : '  ');
    const parts = S.spoken(raw).split(/\s+/).filter(Boolean);
    let t = 0; const words = [];
    for (const w of parts) {
      t += 0.1 + rnd(5) / 10;
      if (rnd(6) === 0) continue; // a word the voice drops
      if (rnd(6) === 0) { words.push({ w: w.slice(0, 2), t }, { w: w.slice(2) || w, t: t + 0.05 }); continue; } // split
      words.push({ w: rnd(8) ? w : 'something else', t }); // or reads differently
    }
    const dur = rnd(3) ? t + 0.5 : 0;
    for (const c of [chunks(raw, words, dur), chunks(raw, null, dur)]) {
      const label = JSON.stringify(raw);
      assert.ok(c.length > 0, label);
      for (let i = 0; i < c.length; i++) {
        assert.ok(Number.isFinite(c[i].t) && c[i].t >= 0, label);
        if (i) assert.ok(c[i].t >= c[i - 1].t, `times go backwards for ${label}: ${JSON.stringify(c)}`);
      }
      assert.ok(c.at(-1).t <= Math.max(dur || S.spoken(raw).length / 14, t), label);
      assert.equal(c.map(x => x.text).join(' '), S.plain(raw.replace(/[*_`#>]/g, '')).split(/\s+/).filter(Boolean).join(' '), label);
    }
  }
});

test('the page loads subtitles.js after i18n.js and before app.js, without clashing names', () => {
  const html = read('web/public/index.html');
  const order = ['/i18n.js', '/subtitles.js', '/app.js'].map(s => html.indexOf(`<script src="${s}"></script>`));
  assert.ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], 'script order');
  // Classic scripts share one global scope: redeclaring a top-level name is a SyntaxError that stops app.js.
  const top = f => [...read(f).matchAll(/^(?:const|let|var|function\*?|async function|class)\s+([\w$]+)/gm)].map(m => m[1]);
  const mine = top('web/public/subtitles.js');
  for (const n of NAMES) assert.ok(mine.includes(n), n);
  const others = new Set([...top('web/public/i18n.js'), ...top('web/public/app.js')]);
  assert.deepEqual(mine.filter(n => others.has(n)), []);
});
