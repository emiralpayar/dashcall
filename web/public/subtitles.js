// Subtitle helpers for app.js: pronunciation markup and timed subtitle chunks. A classic script (the CSP allows only
// same-origin scripts, no modules) with pure functions only, so test/subtitles.test.mjs can load it with node:vm.

// Words are matched in the UI language (Turkish I/ı lowercase differently). getLang() comes from i18n.js when the
// page loads it; on its own (tests) the default locale is used.
const subtitleLang = () => typeof getLang === 'function' ? getLang() : undefined;
const norm = (w, lang = subtitleLang()) => w.toLocaleLowerCase(lang).replace(/[^\p{L}\p{N}]/gu, '');
// Pronunciation markup from the dispatcher: [[written|spoken]] — show `written`, speak `spoken`.
const MARK = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;
const plain = t => String(t ?? '').replace(MARK, '$1');
const spoken = t => String(t ?? '').replace(MARK, '$2');
// Build display + spoken strings together, with a char map display→spoken so subtitle timing survives respelling.
function mapText(raw) {
  let disp = '', say = ''; const map = [];
  // one entry per UTF-16 unit, like the token offsets that index it (an emoji is two)
  const copy = str => { for (let i = 0; i < str.length; i++) map.push(say.length + i); disp += str; say += str; };
  let last = 0; MARK.lastIndex = 0; let m;
  while ((m = MARK.exec(raw))) {
    copy(raw.slice(last, m.index));
    const s0 = say.length, a = m[1], b = m[2];
    for (let i = 0; i < a.length; i++) map.push(s0 + Math.floor(i * b.length / a.length));
    disp += a; say += b; last = m.index + m[0].length;
  }
  copy(raw.slice(last));
  return { disp, say, map };
}
const tokensOf = str => [...str.matchAll(/\S+/g)].map(m => ({ text: m[0], at: m.index }));

// Split text into short subtitle chunks (≤ ~7 words / 42 chars, breaking at sentence punctuation),
// each with a start time aligned to the TTS word timings when available.
function buildChunks(raw, words, duration, lang = subtitleLang()) {
  const { disp, say, map } = mapText(String(raw).replace(/[*_`#>]/g, ''));
  const dTok = tokensOf(disp), sTok = tokensOf(say);
  if (!dTok.length) return [];
  // align spoken tokens to timed words (greedy, small lookahead)
  const times = new Array(sTok.length).fill(null);
  let j = 0;
  sTok.forEach((tok, i) => {
    const n = norm(tok.text, lang); if (!n || !words?.length) return;
    for (let k = j; k < Math.min(j + 4, words.length); k++) {
      const w = norm(words[k].w, lang);
      if (w && (n === w || n.startsWith(w) || w.startsWith(n))) {
        times[i] = words[k].t; j = k + 1;
        while (j < words.length && norm(words[j].w, lang) && n.includes(norm(words[j].w, lang)) && !n.startsWith(norm(words[j].w, lang))) j++;
        break;
      }
    }
  });
  const dur = duration || say.length / 14;
  sTok.forEach((t, i) => { if (times[i] == null) times[i] = (t.at / Math.max(1, say.length)) * dur; });
  for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) times[i] = times[i - 1];
  const timeAt = pos => { let k = 0; while (k + 1 < sTok.length && sTok[k + 1].at <= pos) k++; return times[k] ?? 0; };
  const chunks = []; let cur = [], curLen = 0, start = 0;
  dTok.forEach(({ text: t, at }) => {
    if (!cur.length) start = timeAt(map[at] ?? 0);
    cur.push(t); curLen += t.length + 1;
    const endSentence = /[.!?…:;]["”')]*$/.test(t), comma = /,["”')]*$/.test(t);
    if (endSentence || cur.length >= 7 || curLen >= 42 || (comma && cur.length >= 4)) {
      chunks.push({ t: start, text: cur.join(' ') }); cur = []; curLen = 0;
    }
  });
  if (cur.length) chunks.push({ t: start, text: cur.join(' ') });
  return chunks;
}
