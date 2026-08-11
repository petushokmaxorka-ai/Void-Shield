#!/usr/bin/env python3
# Конвертирует рабочий ~/.config/heretic-vpn/config.json (xray) в Clash YAML,
# который VoidShield может импортировать через "IMPORT FILE".
# Запуск: python3 scripts/heretic-vpn-to-clash.py
import json, sys
from pathlib import Path

src = Path.home() / ".config/heretic-vpn/config.json"
dst = Path.home() / ".config/void-shield-desktop/import-clash.yaml"

if not src.exists():
    print(f"source not found: {src}", file=sys.stderr); sys.exit(1)

c = json.loads(src.read_text())
proxies = []
for o in c.get("outbounds", []):
    if o.get("protocol") != "vless":
        continue
    vnext = o["settings"]["vnext"][0]
    user = vnext["users"][0]
    rs = o.get("streamSettings", {}).get("realitySettings", {})
    proxies.append({
        "name": o["tag"],
        "type": "vless",
        "server": vnext["address"],
        "port": vnext["port"],
        "uuid": user["id"],
        "flow": user.get("flow", ""),
        "network": "tcp",
        "udp": True,
        "servername": rs.get("serverName", ""),
        "client-fingerprint": rs.get("fingerprint", "chrome"),
        "public-key": rs.get("publicKey", ""),
        "short-id": rs.get("shortId", ""),
    })

def q(s):
    s = str(s)
    # Quote if empty or contains YAML-special chars.
    if not s or any(ch in s for ch in ':#{}[]&*!|>%@"\'`'):
        return '"' + s.replace('"', '\\"') + '"'
    return s

lines = ["mixed-port: 7890", "proxies:"]
for p in proxies:
    lines.append(f'  - name: {q(p["name"])}')
    lines.append(f'    type: {p["type"]}')
    lines.append(f'    server: {q(p["server"])}')
    lines.append(f'    port: {p["port"]}')
    lines.append(f'    uuid: {q(p["uuid"])}')
    lines.append(f'    flow: {q(p["flow"])}')
    lines.append(f'    network: {p["network"]}')
    lines.append(f'    udp: {str(p["udp"]).lower()}')
    lines.append(f'    servername: {q(p["servername"])}')
    lines.append(f'    client-fingerprint: {q(p["client-fingerprint"])}')
    lines.append('    reality-opts:')
    lines.append(f'      public-key: {q(p["public-key"])}')
    lines.append(f'      short-id: {q(p["short-id"])}')
lines += ["proxy-groups: []", "rules: []"]

dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text("\n".join(lines) + "\n")
print(f"wrote {len(proxies)} proxies → {dst}")
