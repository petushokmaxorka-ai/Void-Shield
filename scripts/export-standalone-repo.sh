#!/usr/bin/env bash
# Export VOID-SHIELD as a clean standalone git repo (no heretic-os monorepo noise).
# Usage:
#   bash scripts/export-standalone-repo.sh [/path/to/void-shield]
# Then:
#   cd /path/to/void-shield && git init && git add . && git commit -m "feat: initial Void Shield release"
#   gh repo create void-shield --public --source=. --remote=origin --push
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${1:-$HOME/void-shield}"

mkdir -p "$DST"
rsync -a --delete \
  --exclude node_modules \
  --exclude release \
  --exclude out \
  --exclude .git \
  --exclude '*.AppImage' \
  --exclude 'resources/bin/**' \
  --exclude '.anathemetron*' \
  "$SRC/" "$DST/"

# Keep bin dir placeholder so fetch-xray has a target
mkdir -p "$DST/resources/bin"
if [[ ! -f "$DST/resources/bin/.gitkeep" ]]; then
  echo '# Cores downloaded by: npm run fetch-xray' > "$DST/resources/bin/.gitkeep"
fi

# Standalone .gitignore
cat > "$DST/.gitignore" <<'EOF'
node_modules/
out/
release/
dist/
*.AppImage
*.exe
*.dmg
*.blockmap
.DS_Store
*.log
resources/bin/linux-*/
resources/bin/windows-*/
resources/bin/darwin-*/
resources/bin/*.dat
.env
.env.*
EOF

# Point package homepage at placeholder — edit after creating the GitHub repo
python3 - <<PY
import json
from pathlib import Path
p = Path("$DST") / "package.json"
data = json.loads(p.read_text())
data["name"] = "void-shield"
data["homepage"] = "https://github.com/HereticArch/void-shield"
data["description"] = "VOID-SHIELD — Heretic Dark Mechanicus VPN (paste URL, Linux + Windows)"
p.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "Exported standalone sources → $DST"
echo
echo "Next:"
echo "  cd $DST"
echo "  npm install && npm run fetch-xray && npm test"
echo "  git init && git add . && git commit -m 'feat: initial Void Shield release'"
echo "  gh repo create void-shield --public --source=. --remote=origin --push"
echo "  git tag v1.0.0 && git push origin v1.0.0   # triggers GitHub Actions release"
