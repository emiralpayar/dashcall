// Clean-up of whisper.cpp transcripts (pure, no I/O). whisper learned from subtitles, so on silence or noise it
// "hears" subtitle credits and outros, and it sometimes says the same thing twice. Every rule here is narrow on
// purpose: a dropped hallucination only costs a "didn't catch that", a dropped command costs the user's trust.

// Comparison key: case, accents, punctuation and spacing don't matter ("Altyazı: M. K." matches "altyazı m.k.").
const key = s => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]/gu, '');
// A word that ends a sentence: "söyle." "çalışıyor?" "Done!" "…" (closing quotes or brackets allowed).
const END = /[.!?…]["'”’)\]]*$/;

// Subtitle credits and video outros. Nobody says them to an assistant, so they are also cut from the end of a real
// transcript: without VAD, whisper appends them when a long silent tail follows the speech.
const CREDITS = new Set([
  'Altyazı M.K.', 'Abone olmayı unutmayın.', 'İzlediğiniz için teşekkürler.', 'İzlediğiniz için teşekkür ederim.',
  'Thanks for watching!', 'Thank you for watching.', 'Subtitles by the Amara.org community',
].map(key));
// Also dropped, but only when they are the whole transcript: what whisper most often returns for silence. Not here:
// one-off garbage such as "Erlendir." (also the tail of "değerlendir", a real verb); VAD keeps silence away instead.
const SILENCE = new Set([...CREDITS, ...['you', 'Thank you.'].map(key)]);

// Removes a block of whole sentences that directly repeats the block before it, until none is left:
// "A? B. A? B." → "A? B.", "A. A. A." → "A.", "X. A. A." → "X. A.". Only sentence-sized blocks count, so
// "yavaş yavaş" and "tamam, tamam" stay as spoken.
function collapseRepeats(words) {
  const k = words.map(key);
  const startsSentence = i => i === 0 || END.test(words[i - 1]);
  for (let i = 0; i < words.length; i++) {
    if (!startsSentence(i)) continue;
    for (let len = 1; i + 2 * len <= words.length; len++) {
      const end = i + 2 * len; // the copy is words[i + len .. end)
      if (!END.test(words[i + len - 1]) || (end < words.length && !END.test(words[end - 1]))) continue;
      if (k.slice(i, i + len).every((x, j) => x === k[i + len + j])) {
        words.splice(i + len, len);
        return collapseRepeats(words);
      }
    }
  }
  return words;
}

// Cuts subtitle credits that follow a finished sentence at the end of the transcript.
function stripTrailingCredits(words) {
  for (let j = Math.max(1, words.length - 8); j < words.length; j++) {
    if (END.test(words[j - 1]) && CREDITS.has(key(words.slice(j).join('')))) return stripTrailingCredits(words.slice(0, j));
  }
  return words;
}

// "[BLANK_AUDIO]", "(müzik)", "*laughs*": whisper's notes about non-speech, never spoken words.
const NOTES_ONLY = /^(\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*))+$/;

export function cleanTranscript(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text || NOTES_ONLY.test(text)) return '';
  const out = collapseRepeats(stripTrailingCredits(text.split(' '))).join(' ');
  return !key(out) || SILENCE.has(key(out)) ? '' : out; // punctuation only ("." "♪") or a known hallucination
}
