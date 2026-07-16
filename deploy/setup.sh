#!/usr/bin/env bash
# One-shot VPS setup for lattice. Run from the repo root:
#   git clone <repo> /opt/lattice && cd /opt/lattice
#   cp .env.example .env   # then edit: SOLANA_RPC / HELIUS_API_KEY / METEORA_DATAPI
#   bash deploy/setup.sh
#
# Idempotent — safe to re-run after `git pull` to redeploy.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(whoami)"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
cd "$REPO"

[ -f .env ] || { echo "ERROR: create .env first (SOLANA_RPC / HELIUS_API_KEY / METEORA_DATAPI)"; exit 1; }

echo "== [1/4] Node: install + production build =="
"$NPM_BIN" install
"$NPM_BIN" run build -w @lattice/web
[ -f data/lattice.sqlite ] || "$NPM_BIN" run db:seed   # seed only if DB is empty

echo "== [2/4] Python: Scrapling scraper =="
python3 -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate
pip install -q -r scraper/requirements.txt
scrapling install || echo "  (run 'scrapling install' manually if the browser fetch failed)"
deactivate

echo "== [3/4] systemd units (templated to $REPO, user $USER_NAME) =="
gen() { sed -e "s#/opt/lattice#$REPO#g" \
            -e "s#^ExecStart=/usr/bin/node#ExecStart=$NODE_BIN#" \
            -e "s#^ExecStart=/usr/bin/npm#ExecStart=$NPM_BIN#" \
            -e "s#^\(\[Service\]\)#\1\nUser=$USER_NAME#" "deploy/$1"; }
for u in lattice-worker.service lattice-web.service lattice-scraper.service; do
  gen "$u" | sudo tee "/etc/systemd/system/$u" >/dev/null
done
sudo cp deploy/lattice-scraper.timer /etc/systemd/system/

echo "== [4/4] enable + start =="
sudo systemctl daemon-reload
sudo systemctl enable --now lattice-worker lattice-web lattice-scraper.timer

echo
echo "Done. Dashboard on :3737. Watch the worker accumulate wallets:"
echo "  journalctl -u lattice-worker -f"
echo "Expose it publicly with Cloudflare Tunnel — see deploy/README.md."
