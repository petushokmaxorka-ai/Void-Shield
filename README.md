# ◆ VOID-SHIELD

<p align="center">
  <a href="#-english">English</a> · <a href="#-русский">Русский</a>
</p>

---

<a id="-english"></a>

## English

**Heretic Dark Mechanicus VPN client** — paste a subscription URL, ignite the field.

Cross-platform Electron app (Linux + Windows + macOS) with bundled **xray-core** / **sing-box**.
No FlClashX required. No systemd. No local VPN install.

> Aesthetic: void-black cogitator terminal, **arterial crimson** (Dark Mechanicus / Heretic), not Adeptus Mechanicus gold.

### Download (friends)

1. Open **[Releases](https://github.com/petushokmaxorka-ai/Void-Shield/releases)**
2. Open the latest release
3. Download:
   - **Linux** → `VoidShield-*.AppImage` → `chmod +x` → run
   - **Windows** → `VoidShield Setup *.exe` → install → run
4. Paste your subscription URL → **REGISTER & IGNITE**

If Releases is empty, check [Actions](https://github.com/petushokmaxorka-ai/Void-Shield/actions) — CI may still be building or failed.

Most providers work with built-in User-Agent negotiation.  
If a panel only allows a whitelist app (e.g. “Install HAPP” stubs), use **Import File** or set a **Custom User-Agent**.

### Capture (no admin for browsers)

- **TUN** (default): full VPN including UDP/games. Linux: one-time password for `setcap`. Windows: Run as administrator.
- **Without TUN**: browsers use the OS proxy (`127.0.0.1:7894` xray / `:7899` sing-box). Games/UDP stay off-VPN.
- **Gosuslugi / nalog / gov.ru**: each connection uses a Russian node (or direct if none). Other sites stay on foreign AUTO — no global node flip.

### License

**MIT** — you may use, modify, and share freely.  
Copyright stays with **petushokmaxorka-ai**. When you redistribute or fork, keep the copyright notice and mention this project (see [`LICENSE`](LICENSE)).

### Build from source

```bash
npm install
npm run fetch-xray
npm run build:linux   # → release/*.AppImage
npm run build:win     # → release/*Setup*.exe
npm test
```

---

<a id="-русский"></a>

## Русский

**Еретический Dark Mechanicus VPN-клиент** — вставил ссылку подписки, зажёг поле.

Кроссплатформенное Electron-приложение (Linux + Windows + macOS) со встроенными **xray-core** / **sing-box**.
FlClashX не нужен. systemd не нужен. Отдельный VPN в систему ставить не надо.

> Стиль: чёрный когитатор, **артериальный crimson** (Heretic Dark Mechanicus), не золото Adeptus Mechanicus.

### Скачать (друзьям)

1. Открыть **[Releases](https://github.com/petushokmaxorka-ai/Void-Shield/releases)**
2. Взять последний релиз
3. Скачать:
   - **Linux** → `VoidShield-*.AppImage` → `chmod +x` → запустить
   - **Windows** → `VoidShield Setup *.exe` → установить → запустить
4. Вставить URL подписки → **REGISTER & IGNITE**

Если Releases пустой — смотри [Actions](https://github.com/petushokmaxorka-ai/Void-Shield/actions): сборка ещё идёт или упала.

Большинство провайдеров работают с встроенным перебором User-Agent.  
Если панель отдаёт заглушку «Установите HAPP» — **Import File** или **Custom User-Agent**.

### Перехват (админ для браузера не нужен)

- **TUN** (по умолчанию): полноценный VPN, включая UDP/игры. Linux: один раз пароль на `setcap`. Windows: «Запуск от имени администратора».
- **Без TUN**: браузеры идут через системный прокси (`127.0.0.1:7894` xray / `:7899` sing-box). Игры/UDP мимо.
- **Госуслуги / налог / gov.ru**: это соединение — российская нода (или напрямую, если RU-нод нет). Остальной трафик остаётся на зарубежном AUTO.

### Лицензия

**MIT** — пользоваться, менять и распространять можно свободно.  
Права остаются у **petushokmaxorka-ai**. При форке / публикации своей версии нужно **оставить copyright и упомянуть** этот проект (см. [`LICENSE`](LICENSE)).

### Сборка из исходников

```bash
npm install
npm run fetch-xray
npm run build:linux   # → release/*.AppImage
npm run build:win     # → release/*Setup*.exe
npm test
```

---

## Architecture / Архитектура

```
Renderer (crimson terminal UI)
    │ IPC
Main  VpnManager → fetch URL → parse → build config → spawn xray/sing-box
```

## Security notes

- Subprocess via `execFile` / `spawn` only (no `shell: true` with user input)
- Subscription URL must be `http://` or `https://`
- `contextIsolation` + sandbox + CSP on the renderer

## Releasing

```bash
git tag v1.1.0
git push origin v1.1.0
```

Push a tag `v*` → GitHub Actions builds Linux AppImage + Windows NSIS → Release assets.

---

*«The Omnissiah abandoned us. The void answers.»*  
*«Омниссия нас бросил. Отвечает пустота.»*
