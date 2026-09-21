#!/usr/bin/env bash
# One-command launcher for the l10n live speech translator.
#
#   ./run.sh            serve on http://localhost:8000 (Docker, or python3 fallback)
#   ./run.sh --tunnel   also expose a public HTTPS URL (needed for phone/earbud
#                       testing, since the mic requires a secure context)
#   PORT=9000 ./run.sh  serve on a different port
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
TUNNEL=0
NO_DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --tunnel) TUNNEL=1 ;;
    --no-docker) NO_DOCKER=1 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

have_docker() {
  [[ "$NO_DOCKER" -eq 0 ]] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

echo
echo "  l10n — live speech translator"
echo "  Local:  http://localhost:${PORT}  (open in Chrome or Edge)"
if [[ "$TUNNEL" -eq 1 ]]; then
  echo "  Tunnel: watch the log below for your https://…trycloudflare.com URL,"
  echo "          then open it on your phone."
fi
echo

if have_docker; then
  if [[ "$TUNNEL" -eq 1 ]]; then
    exec docker compose --profile tunnel up --build
  fi
  exec docker compose up --build
fi

echo "Docker not available — falling back to python3 http.server."
if [[ "$TUNNEL" -eq 1 ]]; then
  echo "note: --tunnel needs Docker (it runs cloudflared in a container)." >&2
  echo "      Alternatively run: cloudflared tunnel --url http://localhost:${PORT}" >&2
fi
cd web
exec python3 -m http.server "$PORT"
