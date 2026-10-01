import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript as clean } from '../agent/stt-text.mjs';

test('collapses a transcript that repeats itself sentence by sentence', () => {
  const q = 'Kaç iş çalışıyor? Tek cümle ile söyle.';
  assert.equal(clean(`${q} ${q}`), q, 'A B A B → A B (seen in the agent log)');
  assert.equal(clean(`${q} ${q} ${q}`), q);
  assert.equal(clean('Evet. Evet.'), 'Evet.', 'A A → A');
  assert.equal(clean('Evet. evet'), 'Evet.', 'the last copy may lack its full stop');
  assert.equal(clean(`${q} kaç iş çalışıyor, tek cümle ile söyle`), q, 'case and punctuation are ignored');
  assert.equal(clean('Run the tests. Stop. Stop. Stop.'), 'Run the tests. Stop.', 'a repeating tail');
  assert.equal(clean('Dur. Dur. Hepsini durdur.'), 'Dur. Hepsini durdur.');
  assert.equal(clean('  Merhaba\n  dünya  '), 'Merhaba dünya');
  assert.equal(clean('Dur. Bekle. Bekle. Dur. Bekle.'), 'Dur. Bekle.', 'a removal that makes an earlier repeat');
});

test('collapses a long whisper loop quickly (the agent is single-threaded)', () => {
  // 600 distinct sentences, then whisper stuck on one: took ~2 s per 800 words with the first version
  const said = Array.from({ length: 600 }, (_, i) => `Madde ${i}.`).join(' ');
  const t0 = performance.now();
  assert.equal(clean(`${said} ${Array(1500).fill('Dur.').join(' ')}`), `${said} Dur.`);
  assert.equal(clean(Array(1000).fill('Dur. Bekle.').join(' ')), 'Dur. Bekle.');
  assert.ok(performance.now() - t0 < 500, `${Math.round(performance.now() - t0)} ms`);
});

test('keeps repetition that is not a repeated sentence', () => {
  for (const t of [
    'yavaş yavaş anlat', 'Tamam, tamam.', 'Çok çok iyi.', 'Bir. İki. Bir.', 'Run the tests. Then run the tests again.',
    'Kaç iş çalışıyor? Kaç iş bitti?', 'Say it twice: hello hello.', 'Testleri çalıştır testleri çalıştır',
    'Sil. Şil.', 'Kır. Kir.', // Turkish letters with and without marks are different letters
  ]) assert.equal(clean(t), t);
});

test('drops whisper silence hallucinations when they are the whole transcript', () => {
  for (const t of [
    'Altyazı M.K.', ' altyazı: m. k. ', 'ALTYAZI M.K.', 'Abone olmayı unutmayın.', 'İzlediğiniz için teşekkür ederim.',
    'İzlediğiniz için teşekkürler.', 'Thank you.', 'thank you', 'Thanks for watching!', 'Thank you for watching.',
    'Subtitles by the Amara.org community', 'you', 'You', 'Altyazı M.K. Altyazı M.K.', 'Thank you. Thank you.',
    '.', '...', '♪', '♪ ♪', '[BLANK_AUDIO]', '[Müzik]', '(müzik)', '*laughs*', '', '   ', null, undefined,
  ]) assert.equal(clean(t), '', JSON.stringify(t));
});

test('keeps real commands, including thanks inside a longer request', () => {
  for (const t of [
    'Thank you, run the tests.', 'Testleri çalıştır. Thank you.', 'Thank you for the summary, now push it.',
    'Abone olmayı unutmayın diye yazan satırı sil.', 'Altyazı dosyasını aç.', 'You decide.', 'Teşekkürler.',
    // a one-off hallucination is not a pattern: blocking it would also block the tail of "değerlendir"
    'Erlendir.', 'Değerlendir.', 'items[0] değerini yazdır', 'Evet (ama hızlı).',
  ]) assert.equal(clean(t), t);
});

test('cuts subtitle credits from the end of a real transcript', () => {
  assert.equal(clean('Kaç iş çalışıyor? Tek cümle ile söyle. Altyazı M.K.'), 'Kaç iş çalışıyor? Tek cümle ile söyle.');
  assert.equal(clean('Run the tests. Subtitles by the Amara.org community'), 'Run the tests.');
  assert.equal(clean('Testleri çalıştır. Altyazı M.K. Altyazı M.K.'), 'Testleri çalıştır.');
  assert.equal(clean('Kaç iş çalışıyor? Kaç iş çalışıyor? Altyazı M.K.'), 'Kaç iş çalışıyor?');
  // only after a finished sentence, and only credits: outros and thanks may be dictated
  assert.equal(clean('Ekrandaki yazı altyazı m.k.'), 'Ekrandaki yazı altyazı m.k.');
  for (const t of ['Push it. Thank you.', 'Run the tests. Thanks for watching!', 'Videonun sonuna ekle. Abone olmayı unutmayın.'])
    assert.equal(clean(t), t);
});
