# ◆ VOID-SHIELD

**Heretic Dark Mechanicus VPN client** — paste a subscription URL, ignite the field.

Cross-platform Electron app (Linux + Windows + macOS) with bundled **xray-core** / **sing-box**.
No FlClashX required. No systemd. No local VPN install.

> Aesthetic: void-black cogitator terminal, **arterial crimson** (Dark Mechanicus / Heretic), not Adeptus Mechanicus gold.

---

## End users

1. Download a release for your OS ([Releases](../../releases)):
   - **Linux** → `VoidShield-*.AppImage` → `chmod +x` → run
   - **Windows** → `VoidShield Setup *.exe` → install → run
   - **macOS** → `VoidShield-*.dmg`
2. Paste your provider **subscription URL** (Clash YAML / base64 vless / share-links).
3. Click **REGISTER & IGNITE**.
4. Linux may ask once for TUN privileges (`pkexec`). Windows uses bundled `wintun.dll`.

Most providers work with the built-in User-Agent negotiation (`clash.meta`, `mihomo`, `v2rayN`, …).  
If a panel only allows a whitelist app (e.g. “Install HAPP” stubs), use **Import File** with an exported Clash YAML, or set a **Custom User-Agent** if your panel documents one.

---

## Supported subscription formats

| Format | Notes |
|--------|--------|
| Clash / Clash.Meta YAML | `proxies:` list |
| Base64 share-link list | `vless://` `vmess://` `trojan://` `ss://` … |
| Plain share-links | One link per line |
| Local file import | Same formats from disk |
| Optional FlClashX cache | Linux advanced: import `~/.local/share/FlClashX/profiles` |

Protocols: VLESS (+ REALITY), VMess, Trojan, Shadowsocks, Hysteria2, TUIC, WireGuard (sing-box core).

---

## Build from source

```bash
npm install
npm run fetch-xray          # download cores for packaging (~140MB)
npm run build:linux         # → release/*.AppImage
npm run build:win           # → release/*Setup*.exe  (build on Windows or wine CI)
npm run build:mac           # → release/*.dmg
npm test
```

Dev loop:

```bash
npm run dev
```

---

## Architecture

```
Renderer (crimson terminal UI)
    │ IPC
Main  VpnManager → fetch URL → parse → build config → spawn xray/sing-box
                              │ gRPC / clash-api
                              └ observatory / node pin / stats
```

| Module | Role |
|--------|------|
| `subscription.ts` | Clash YAML + share-links → normalized nodes |
| `config-builder.ts` | xray JSON (TUN + REALITY + leastPing) |
| `singbox-config-builder.ts` | sing-box JSON (QUIC protocols) |
| `vpn-manager.ts` | Orchestration, UA negotiation, FlClashX fallback |
| `capabilities.ts` | Linux `setcap` once; Windows no-op |

---

## Security notes

- Subprocess via `execFile` / `spawn` only (no `shell: true` with user input)
- Subscription URL must be `http://` or `https://`
- Config / settings under Electron `userData`
- `contextIsolation` + sandbox + CSP on the renderer

---

## Releasing (GitHub Actions)

Push a tag `v*` → workflow builds Linux AppImage + Windows NSIS and uploads artifacts to the GitHub Release.

```bash
git tag v1.0.1
git push origin v1.0.1
```

---

## License

MIT

*«The Omnissiah abandoned us. The void answers.»*
