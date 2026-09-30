// UI strings (English + Turkish) and the tiny i18n runtime shared by app.js and login.js.
const STRINGS = {
  en: {
    'conn.title': 'Mac connection',
    'lang.label': 'Language',
    'tab.drive': 'Drive', 'tab.sessions': 'Sessions', 'tab.new': 'New job', 'tab.brain': 'Brain', 'tab.notifs': 'Notifications',
    'common.send': 'Send', 'common.close': 'Close', 'common.refresh': 'Refresh', 'common.back': '← Back', 'common.add': 'Add',
    'common.delete': 'Delete', 'common.none': 'None.', 'common.dictate': 'Dictate',
    'drive.talk': 'Talk', 'drive.repeat': 'Replay', 'drive.newChat': 'New chat', 'drive.voice': 'Voice',
    'drive.hint': 'Try asking “How are my sessions doing?”',
    'drive.done': 'Done. Tap “Replay” to hear it again.', 'drive.newChatSub': 'New chat. Tap and talk.',
    'drive.resend': 'Resend', 'drive.showFull': 'Show text', 'drive.showLog': 'History', 'drive.typePlaceholder': 'Or type…',
    'drive.cancelled': 'Cancelled — if a reply arrives it goes to notifications',
    'drive.didntHear': 'Didn’t catch that, tap again', 'drive.noMicPermission': 'No microphone permission',
    'drive.noMic': 'No microphone in this browser — type instead', 'drive.emptyRecording': 'Heard nothing in the recording',
    'drive.sttFailed': 'Couldn’t send the audio ({msg})', 'drive.problem': 'Something went wrong: {msg}',
    'drive.emptyReply': '(empty reply)', 'drive.tooLong': 'Timed out',
    'voice.name': 'Voice: {name}', 'voice.local': 'Local',
    'state.idle': 'Tap and talk', 'state.listening': 'Listening… (tap to send)', 'state.transcribing': 'Transcribing… (tap to cancel)',
    'state.thinking': 'Looking into it… (tap to cancel)', 'state.speaking': 'Speaking… (tap to stop)', 'state.stillThinking': 'Still looking…',
    'sheet.lastReply': 'Last reply', 'sheet.history': 'History',
    'sessions.running': 'Running sessions', 'sessions.recent': 'Last 48 hours', 'sessions.muted': 'Muted',
    'sessions.mute': 'Mute', 'sessions.unmute': 'Unmute', 'sessions.stop': 'Stop (Esc)', 'sessions.composer': 'What should I tell this session?',
    'sessions.none': 'No running sessions.', 'sessions.loading': 'Loading…', 'sessions.unmuted': 'Unmuted',
    'sessions.mutedToast': 'Muted — won’t mention it any more', 'sessions.escSent': 'Esc sent', 'sessions.sent': 'Sent',
    'status.working': 'working', 'status.idle': 'waiting', 'status.done': 'done', 'status.blocked': 'stuck', 'status.unknown': '?', 'status.past': 'past',
    'new.title': 'Start a new job', 'new.folder': 'Folder', 'new.customPath': 'or type a path: ~/project', 'new.what': 'What should it do?',
    'new.task': 'Task…', 'new.start': 'Start', 'new.starting': 'Starting…', 'new.needTask': 'Write a task', 'new.started': 'Started: {name}',
    'brain.notes': 'Notes', 'brain.addNote': 'Add a note…', 'brain.memory': 'Memory', 'brain.addMemory': 'Something it should know…',
    'brain.muted': 'Muted', 'brain.empty': 'Empty', 'brain.done': 'Done', 'brain.remove': 'Remove',
    'notifs.title': 'Notifications', 'notifs.readAll': 'Mark all read', 'notifs.listen': 'Listen', 'notifs.later': 'Later',
    'notifs.task': 'Background job: {title}', 'notifs.taskFallback': 'Background job', 'notifs.error': 'Error', 'notifs.reply': 'Reply',
    'notifs.unreadMore': ' (+{n} unread)', 'notifs.none': 'No notifications.', 'notifs.fallbackQ': 'Notification',
    'ago.now': 'now', 'ago.min': '{n} min', 'ago.hour': '{n} h', 'ago.day': '{n} d',
    'login.password': 'Password', 'login.submit': 'Log in',
    'errors.cancelled': 'Cancelled', 'errors.timeout': 'Timed out — slow connection', 'errors.offline': 'No connection',
    'errors.http': 'HTTP {status}', 'errors.generic': 'Error',
    'errors.unauthorized': 'Not authorized', 'errors.not_found': 'Not found', 'errors.bad_path': 'Invalid path',
    'errors.invalid_json': 'Invalid request', 'errors.too_large': 'Too large', 'errors.text_required': 'Text is required',
    'errors.key_required': 'Key is required', 'errors.bad_keys': 'Invalid keys', 'errors.bad_conversation_id': 'Invalid conversation',
    'errors.unsupported_audio': 'Unsupported audio format', 'errors.unknown_job': 'Unknown job', 'errors.folder_not_found': 'Folder not found',
    'errors.folder_outside_root': 'Folder is outside the allowed root', 'errors.session_start_failed': 'Couldn’t start the session',
    'errors.internal': 'Server error', 'errors.login_required': 'Please log in', 'errors.bad_password': 'Wrong password',
    'errors.rate_limited': 'Too many attempts — try again later', 'errors.agent_unreachable': 'Can’t reach the Mac', 'errors.agent_auth': 'The Mac rejected the server’s token — check DASHCALL_AGENT_TOKEN',
    'errors.cross_origin': 'Request blocked (cross-origin)',
  },
  tr: {
    'conn.title': 'Mac bağlantısı',
    'lang.label': 'Dil',
    'tab.drive': 'Sürüş', 'tab.sessions': 'İşler', 'tab.new': 'Yeni iş', 'tab.brain': 'Beyin', 'tab.notifs': 'Bildirimler',
    'common.send': 'Gönder', 'common.close': 'Kapat', 'common.refresh': 'Yenile', 'common.back': '← Geri', 'common.add': 'Ekle',
    'common.delete': 'Sil', 'common.none': 'Yok.', 'common.dictate': 'Sesle yaz',
    'drive.talk': 'Konuş', 'drive.repeat': 'Tekrar oku', 'drive.newChat': 'Yeni sohbet', 'drive.voice': 'Ses',
    'drive.hint': '"Son işler ne durumda?" diye sorabilirsin.',
    'drive.done': 'Bitti. Tekrar dinlemek için “Tekrar oku”.', 'drive.newChatSub': 'Yeni sohbet. Dokun ve konuş.',
    'drive.resend': 'Tekrar gönder', 'drive.showFull': 'Metni göster', 'drive.showLog': 'Geçmiş', 'drive.typePlaceholder': 'Ya da yaz…',
    'drive.cancelled': 'İptal edildi — cevap gelirse bildirimlere düşer',
    'drive.didntHear': 'Duyamadım, tekrar dokun', 'drive.noMicPermission': 'Mikrofon izni yok',
    'drive.noMic': 'Bu tarayıcıda mikrofon yok — yazarak kullan', 'drive.emptyRecording': 'Kayıtta ses duyamadım',
    'drive.sttFailed': 'Ses gönderilemedi ({msg})', 'drive.problem': 'Bir sorun oldu: {msg}',
    'drive.emptyReply': '(boş cevap)', 'drive.tooLong': 'Zaman aşımı',
    'voice.name': 'Ses: {name}', 'voice.local': 'Yerel',
    'state.idle': 'Dokun ve konuş', 'state.listening': 'Dinliyorum… (göndermek için dokun)', 'state.transcribing': 'Anlıyorum… (iptal için dokun)',
    'state.thinking': 'Bakıyorum… (iptal için dokun)', 'state.speaking': 'Konuşuyor… (susturmak için dokun)', 'state.stillThinking': 'Hâlâ bakıyorum…',
    'sheet.lastReply': 'Son cevap', 'sheet.history': 'Geçmiş',
    'sessions.running': 'Çalışan işler', 'sessions.recent': 'Son 48 saat', 'sessions.muted': 'Susturulanlar',
    'sessions.mute': 'Sustur', 'sessions.unmute': 'Susturmayı kaldır', 'sessions.stop': 'Durdur (Esc)', 'sessions.composer': 'Bu işe ne söyleyeyim?',
    'sessions.none': 'Çalışan session yok.', 'sessions.loading': 'Yükleniyor…', 'sessions.unmuted': 'Susturma kaldırıldı',
    'sessions.mutedToast': 'Susturuldu — artık söylemeyecek', 'sessions.escSent': 'Esc gönderildi', 'sessions.sent': 'Gönderildi',
    'status.working': 'çalışıyor', 'status.idle': 'bekliyor', 'status.done': 'bitti', 'status.blocked': 'takıldı', 'status.unknown': '?', 'status.past': 'geçmiş',
    'new.title': 'Yeni iş başlat', 'new.folder': 'Klasör', 'new.customPath': 'veya yol yaz: ~/proje', 'new.what': 'Ne yapılsın?',
    'new.task': 'Görev…', 'new.start': 'Başlat', 'new.starting': 'Başlatılıyor…', 'new.needTask': 'Görev yaz', 'new.started': 'Başladı: {name}',
    'brain.notes': 'Notlar', 'brain.addNote': 'Not ekle…', 'brain.memory': 'Hafıza', 'brain.addMemory': 'Bilmesi gereken bir şey…',
    'brain.muted': 'Susturulanlar', 'brain.empty': 'Boş', 'brain.done': 'Tamam', 'brain.remove': 'Kaldır',
    'notifs.title': 'Bildirimler', 'notifs.readAll': 'Tümünü okundu say', 'notifs.listen': 'Dinle', 'notifs.later': 'Sonra',
    'notifs.task': 'Arka plan işi: {title}', 'notifs.taskFallback': 'Arka plan işi', 'notifs.error': 'Hata', 'notifs.reply': 'Cevap',
    'notifs.unreadMore': ' (+{n} okunmamış)', 'notifs.none': 'Bildirim yok.', 'notifs.fallbackQ': 'Bildirim',
    'ago.now': 'şimdi', 'ago.min': '{n} dk', 'ago.hour': '{n} sa', 'ago.day': '{n} gün',
    'login.password': 'Şifre', 'login.submit': 'Giriş',
    'errors.cancelled': 'İptal edildi', 'errors.timeout': 'Zaman aşımı — bağlantı yavaş', 'errors.offline': 'Bağlantı yok',
    'errors.http': 'HTTP {status}', 'errors.generic': 'Hata',
    'errors.unauthorized': 'Yetkisiz', 'errors.not_found': 'Bulunamadı', 'errors.bad_path': 'Geçersiz yol',
    'errors.invalid_json': 'Geçersiz istek', 'errors.too_large': 'Çok büyük', 'errors.text_required': 'Metin gerekli',
    'errors.key_required': 'Anahtar gerekli', 'errors.bad_keys': 'Geçersiz tuşlar', 'errors.bad_conversation_id': 'Geçersiz sohbet',
    'errors.unsupported_audio': 'Desteklenmeyen ses biçimi', 'errors.unknown_job': 'Bilinmeyen iş', 'errors.folder_not_found': 'Klasör bulunamadı',
    'errors.folder_outside_root': 'Klasör izin verilen dizinin dışında', 'errors.session_start_failed': 'İş başlatılamadı',
    'errors.internal': 'Sunucu hatası', 'errors.login_required': 'Giriş yapmalısın', 'errors.bad_password': 'Şifre yanlış',
    'errors.rate_limited': 'Çok fazla deneme — biraz sonra tekrar dene', 'errors.agent_unreachable': 'Mac’e ulaşılamıyor', 'errors.agent_auth': 'Mac sunucunun token’ını reddetti — DASHCALL_AGENT_TOKEN’ı kontrol et',
    'errors.cross_origin': 'İstek engellendi (farklı kaynak)',
  },
};
const LOCALES = { en: 'en-US', tr: 'tr-TR' };
let LANG = (() => {
  let l; try { l = localStorage.getItem('lang'); } catch {}
  if (l in STRINGS) return l;
  return /^tr/i.test(navigator.language || '') ? 'tr' : 'en';
})();
const getLang = () => LANG;
const getLocale = () => LOCALES[LANG];
const hasKey = key => key in STRINGS[LANG];
function t(key, vars) {
  const s = STRINGS[LANG][key] ?? STRINGS.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}
function applyI18n(root = document) {
  document.documentElement.lang = LANG;
  root.querySelectorAll('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  for (const a of ['placeholder', 'aria-label', 'title'])
    root.querySelectorAll(`[data-i18n-${a}]`).forEach(el => el.setAttribute(a, t(el.getAttribute('data-i18n-' + a))));
  root.querySelectorAll('[data-lang]').forEach(b => { b.classList.toggle('on', b.dataset.lang === LANG); b.setAttribute('aria-pressed', b.dataset.lang === LANG); });
}
function setLang(l) {
  if (!(l in STRINGS) || l === LANG) return;
  LANG = l;
  try { localStorage.setItem('lang', l); } catch {}
  applyI18n();
  document.dispatchEvent(new CustomEvent('langchange', { detail: l }));
}
applyI18n();
document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));
