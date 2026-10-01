# Dashcall

[English](README.md)

[![CI](https://github.com/emiralpayar/dashcall/actions/workflows/ci.yml/badge.svg)](https://github.com/emiralpayar/dashcall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org)
[![macOS agent](https://img.shields.io/badge/agent-macOS-black.svg)](docs/INSTALL.md)

**Claude Code oturumlarınla telefonundan ya da arabanın tarayıcısından konuş.**

Sen bilgisayarın başında değilken Claude Code oturumların Mac'inde çalışmaya devam eder. Dashcall ile onları sesle ya
da dokunarak takip eder ve yönlendirirsin. "Son işler ne durumda?" diye sor, kısa bir sesli özet dinle. Bir oturuma
devam etmesini söyle, yanlış yola sapanı durdur ya da herhangi bir proje klasöründe yeni bir iş başlat. "Şunu araştır,
bitince haber ver" de ve uygulamayı kapat: iş bittiğinde sesli bir özet bildirim olarak gelir.

## Ekran görüntüleri

<p align="center">
  <img src="docs/images/drive-tr.png" width="300" alt="Türkçe arayüzle sürüş modu: büyük konuşma düğmesi, soru ve altyazılı cevap">
  <br><sub><b>Sürüş modu, Türkçe.</b> Dokun, konuş, kısa cevabı altyazısıyla dinle. Arayüz, konuşma tanıma ve ses tamamen Türkçe.</sub>
</p>

Aşağıdaki görüntüler İngilizce arayüzden:

<table>
  <tr>
    <td align="center" valign="top" width="33%">
      <img src="docs/images/sessions-en.png" width="260" alt="İşler: çalışan Claude Code oturumları, durumları, son istek ve son cevap">
      <br><sub><b>İşler.</b> Çalışan tüm oturumlar tek bakışta: çalışıyor, takıldı ya da bitti.</sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img src="docs/images/session-detail-en.png" width="260" alt="Tek oturum: canlı terminal, Sustur, Durdur (Esc) ve mesaj kutusu">
      <br><sub><b>Tek oturum.</b> Canlı terminali; mesaj gönder ya da Esc'ye bas.</sub>
    </td>
    <td align="center" valign="top" width="33%">
      <img src="docs/images/brain-en.png" width="260" alt="Beyin: notlar ve hatırlatmalar, hafıza ve susturulan oturumlar">
      <br><sub><b>Beyin.</b> Notlar, hatırlatmalar, hafıza ve susturulanlar.</sub>
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/wide-en.png" width="800" alt="Geniş ekranda sürüş modu: solda konuşma düğmesi, sağda soru ve altyazılar">
  <br><sub>Dizüstünde ya da arabanın geniş ekranında düğme ve altyazılar yan yana durur. Telefonda sekmeler, başparmağın
  ulaştığı alttaki çubuktadır.</sub>
</p>

## 30 saniyede demo

Mac, Claude Code ya da herdr gerekmez; yalnızca Node.js 22 veya üstü yeter:

```sh
git clone https://github.com/emiralpayar/dashcall.git && cd dashcall && npm run demo
```

<http://localhost:8080> adresini aç ve `demo` şifresiyle giriş yap. Demo, gerçek web uygulamasını sahte oturumlar,
notlar ve bildirimlerle çalışan bir sahte agent'a bağlar. Sorulara hazır cevaplar döner ve zamanlı altyazıyla
görünür. Demo varsayılan olarak sessizdir; cevapları tarayıcının kendi sesiyle dinlemek için
`DASHCALL_DEMO_SOUND=1 npm run demo` çalıştır. Sağ üstteki EN/TR düğmesiyle dili Türkçeye çevirebilirsin.

## Neler yapabiliyor?

- **Sürüş modu.** Tek, büyük bir konuşma düğmesi. Sen konuşursun; Claude tabanlı bir "dispatcher" (yönlendirici) ne
  demek istediğini anlar, oturumlarında gereğini yapar ve kısa cevabı altyazıyla birlikte sesli okur. Sustuğunda kayıt
  kendiliğinden biter; istersen yazarak da sorabilirsin.
- **İşler.** Çalışan tüm Claude Code oturumlarını ve son 48 saatte bitenleri gör. Bir oturumun terminalini oku, ona
  mesaj gönder ya da Esc ile durdur.
- **Yeni iş.** Proje klasörünü seç, görevi sesle ya da yazarak anlat; Dashcall o iş için yeni bir Claude Code oturumu
  açar.
- **Arka plan işleri.** "Şuna bak, bitince söyle." Dispatcher bir oturum başlatır ya da mevcut oturumu izler; iş
  bittiğinde, takıldığında ya da oturum kapandığında sana sesli bir özet gönderir.
- **Bildirimler.** Her cevap ve arka plan sonucu saklanır; araba sürerken uygulamayı kapatsan da hiçbir şey kaybolmaz.
  Her bildirim, yazıldığı dilde sesli okunur.
- **Beyin.** Kalıcı hafıza, notlar ve hatırlatmalar, susturulan oturumlar. Hepsini sesle ya da uygulamadan
  yönetebilirsin.
- **Türkçe ve İngilizce.** Dili uygulamadan değiştir; konuşma tanıma, sesler ve dispatcher'ın cevapları da ona uyar.
- **Telefona göre tasarlandı.** Telefonda sekmeler başparmağın ulaştığı alttaki çubukta durur; geniş ekranda sürüş
  modu düğmeyi ve altyazıları yan yana gösterir.
- **Hafif.** npm bağımlılığı olmayan iki Node.js sunucusu, whisper.cpp ile tamamen yerel konuşma tanıma.

## Nasıl çalışıyor?

```
 telefon / araba tarayıcısı
        │  HTTPS
        ▼
 web/  (Node, Docker, herhangi bir Linux sunucu)
        │  şifreyle giriş, uygulamayı sunar, /api/* isteklerini bearer token ile iletir
        │  özel ağ, örn. Tailscale
        ▼
 agent/  (Node, Mac'inde)
        ├── herdr ──────────────▶ etkileşimli Claude Code oturumların
        ├── claude -p ──────────▶ dispatcher (dispatcher/CLAUDE.md + `dashcall` CLI)
        ├── ffmpeg + whisper.cpp   ses → metin
        └── edge-tts / macOS say   metin → ses
```

- **`agent/`** oturumlarının çalıştığı Mac'te çalışır. Terminal panellerini listelemek, okumak ve onlara yazmak için
  [herdr](https://herdr.dev) kullanır; oturum kayıtlarını `~/.claude/projects` altından okur.
- **Dispatcher**, her soru için çalışan ve sohbet boyunca devam ettirilen başsız bir `claude -p`'dir.
  [`dispatcher/CLAUDE.md`](dispatcher/CLAUDE.md) talimatlarına uyar ve oturumlara yalnızca
  [`dashcall` CLI](docs/CLI.md) üzerinden dokunur.
- **`web/`** tek sayfalık uygulamayı sunar, girişi yönetir ve API çağrılarını agent'a iletir.

Ayrıntılar için [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (İngilizce).

## Hızlı kurulum

Agent için bir Mac, web uygulaması için Docker kurulu herhangi bir Linux sunucu gerekir. İkisi birbirine Tailscale
üzerinden ulaşabilir. Mac'te [Claude Code](https://code.claude.com/docs/en/setup) ve [herdr](https://herdr.dev) kurulu
olmalı, Claude Code oturumların da herdr içinde çalışmalı. Kısaca:

```sh
# Mac'te
brew install node ffmpeg whisper-cpp      # Node.js 22 veya üstü
git clone https://github.com/emiralpayar/dashcall.git && cd dashcall
./scripts/download-model.sh
cp .env.example .env        # DASHCALL_TOKEN ve DASHCALL_BIND değerlerini gir
npm run agent

# sunucuda
git clone https://github.com/emiralpayar/dashcall.git && cd dashcall/web
cp .env.example .env        # şifre, secret, agent adresi ve token'ı gir
docker compose up -d --build
```

Claude Code, herdr, Tailscale, HTTPS, agent'ın açılışta başlaması ve kurulumun doğrulanması adım adım burada anlatılıyor:
**[docs/INSTALL.md](docs/INSTALL.md)** (İngilizce).

## Dil desteği

Dashcall **Türkçe** ve **İngilizce** konuşur. Dili uygulamanın üst çubuğundaki ya da giriş sayfasındaki EN/TR
düğmesiyle seçersin. Seçim şunları belirler:

- arayüz metinleri
- konuşma tanıma (whisper seçilen dilde çalışır)
- sesler: Türkçe için Emel ya da Ahmet, İngilizce için Ava ya da Andrew, veya Mac'inin kendi sesi
- dispatcher'ın cevap dili

İlk ziyarette tarayıcının dili esas alınır. Türkçe cevaplarda dispatcher, İngilizce terimleri Türkçe sesin doğru
okuması için `[[PR|pi ar]]` gibi bir telaffuz işaretiyle yazar; altyazıda yazılı hâli görünür.

## Güvenlik

**Kurmadan önce oku.** Girişi geçen herkes, Claude Code üzerinden Mac'inde istediği komutu çalıştırabilir. Tek koruma
şifrendir.

- Dispatcher, `dashcall` CLI'yı gözetimsiz kullanabilmek için `--dangerously-skip-permissions` ile çalışır. Okuduğu
  metinler (oturum çıktıları, araştırma sonuçları, yanlış anlaşılmış bir ses kaydı) prompt injection içerebilir.
- Agent'ı özel bir ağda (Tailscale) tut, asla internete açma. Her istek bearer token gerektirir.
- Web uygulamasında isteğe bağlı iki adımlı doğrulamalı (`DASHCALL_TOTP_SECRET`) hız sınırlı şifre girişi, 30 gün
  kullanılmayınca geçersizleşen imzalı HttpOnly çerezler, API yazma isteklerinde aynı köken kontrolü ve sıkı bir
  Content Security Policy var. Uygulamayı yalnızca HTTPS üzerinden sun.
- Yeni oturumlar yalnızca `DASHCALL_WORKSPACE_ROOT` altında açılabilir (varsayılan: ev dizinin).

Ayrıntılar [SECURITY.md](SECURITY.md) dosyasında. Güvenlik açıklarını lütfen orada anlatıldığı gibi gizli bildir.

## Belgeler

| Belge | İçerik |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | Sıfırdan kurulum, açılışta çalıştırma, HTTPS, güncelleme, kaldırma |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Tüm ortam değişkenleri |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Bileşenler, istek akışları, veri dosyaları ve gizlilik |
| [docs/API.md](docs/API.md) | Agent ve web HTTP uç noktaları, hata kodları |
| [docs/CLI.md](docs/CLI.md) | `dashcall` CLI ve beyin |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Sık karşılaşılan sorunlar ve çözümleri |
| [AGENTS.md](AGENTS.md) | Katkıda bulunanlar ve yapay zekâ kodlama ajanları için rehber |
| [CHANGELOG.md](CHANGELOG.md) | Sürüm notları |

Belgeler İngilizcedir.

## Katkıda bulunmak

Issue ve pull request'ler memnuniyetle karşılanır. Arayüz üzerinde çalışmak için `npm run demo` yeterli; `npm test`
testleri hiçbir bağımlılık olmadan çalıştırır. Testler ve demo sessizdir: otomasyon geliştiricinin bilgisayarında
asla ses çıkarmamalı ([AGENTS.md](AGENTS.md#safety-rules)). [CONTRIBUTING.md](CONTRIBUTING.md) ve [AGENTS.md](AGENTS.md) ile başla.
Proje bir [Davranış Kuralları](CODE_OF_CONDUCT.md) belgesine uyar.

## Lisans

[MIT](LICENSE). Dashcall aşağıdaki araçları ayrı programlar olarak çalıştırır; her birinin kendi lisansı vardır: Claude
Code, herdr, ffmpeg, whisper.cpp ve modeli (MIT), edge-tts (LGPL-3.0). edge-tts, Microsoft Edge'in çevrim içi
metin okuma hizmetini kullanır; bu resmî, herkese açık bir API değildir.

Dashcall bağımsız bir projedir, Anthropic ile bir bağlantısı yoktur.
