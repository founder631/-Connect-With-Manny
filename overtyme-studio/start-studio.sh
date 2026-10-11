#!/usr/bin/env bash
# Start OverTyme Studio (and ComfyUI, if it isn't running yet), then open the page.
#
#   ./start-studio.sh             start the studio
#   ./start-studio.sh --install   add an "OverTyme Studio" icon to the Desktop and app menu
#
# Optional settings in overtyme-studio/.env (see .env.example):
#   COMFYUI_DIR=/home/you/ComfyUI   start ComfyUI from here when it isn't running
#   STUDIO_ENGINE=router            make photos on Comfy Router instead of ComfyUI
#   STUDIO_SHARE=1                  let phones/laptops on your Wi-Fi open the page

set -u
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PORT=8790
COMFY_URL="http://127.0.0.1:8188"

# Read one setting from .env without running anything in it.
setting() {
  [ -f "$HERE/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$HERE/.env" | tail -n 1 | sed 's/^["'\'']//; s/["'\'']$//'
}

pause_and_exit() {
  echo
  read -r -p "Press Enter to close this window." _ || true
  exit "${1:-1}"
}

install_launcher() {
  local icon="$HERE/static/icon.svg"
  local entry="[Desktop Entry]
Type=Application
Name=OverTyme Studio
Comment=Make one photo from your OverTyme inspirations
Exec=\"$HERE/start-studio.sh\"
Icon=$icon
Terminal=true
Categories=Graphics;"
  mkdir -p "$HOME/.local/share/applications"
  printf '%s\n' "$entry" > "$HOME/.local/share/applications/overtyme-studio.desktop"
  chmod +x "$HOME/.local/share/applications/overtyme-studio.desktop"
  echo "Added OverTyme Studio to your app menu."

  local desktop
  desktop="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
  if [ -d "$desktop" ] && [ "$desktop" != "$HOME" ]; then
    printf '%s\n' "$entry" > "$desktop/OverTyme Studio.desktop"
    chmod +x "$desktop/OverTyme Studio.desktop"
    gio set "$desktop/OverTyme Studio.desktop" metadata::trusted true 2>/dev/null || true
    echo "Added an OverTyme Studio icon to your Desktop."
    echo "If it shows a warning the first time, right-click it and choose \"Allow Launching\"."
  fi
}

if [ "${1:-}" = "--install" ]; then
  chmod +x "$HERE/start-studio.sh"
  install_launcher
  exit 0
fi

command -v python3 >/dev/null || { echo "Python 3 is not installed."; pause_and_exit; }
cd "$HERE" || pause_and_exit

open_page() {
  (xdg-open "http://127.0.0.1:$PORT" >/dev/null 2>&1 &) || true
}

# Already running? Just open it.
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/catalog"; then
  echo "OverTyme Studio is already running. Opening it."
  open_page
  sleep 2
  exit 0
fi

ENGINE="$(setting STUDIO_ENGINE)"
ENGINE="${ENGINE:-comfy}"
ARGS=(--engine "$ENGINE")
[ "$(setting STUDIO_SHARE)" = "1" ] && ARGS+=(--share)

if [ "$ENGINE" != "router" ] && ! curl -s -o /dev/null --max-time 2 "$COMFY_URL/system_stats"; then
  COMFYUI_DIR="$(setting COMFYUI_DIR)"
  COMFYUI_DIR="${COMFYUI_DIR/#\~/$HOME}"
  if [ -n "$COMFYUI_DIR" ] && [ -f "$COMFYUI_DIR/main.py" ]; then
    PY=python3
    for candidate in "$COMFYUI_DIR/venv/bin/python" "$COMFYUI_DIR/.venv/bin/python"; do
      [ -x "$candidate" ] && PY="$candidate" && break
    done
    mkdir -p "$HERE/Results"
    echo "Starting ComfyUI from $COMFYUI_DIR (log: overtyme-studio/Results/comfyui.log)…"
    (cd "$COMFYUI_DIR" && nohup "$PY" main.py --listen 127.0.0.1 --port 8188 >"$HERE/Results/comfyui.log" 2>&1 &)
    for _ in $(seq 1 90); do
      curl -s -o /dev/null --max-time 2 "$COMFY_URL/system_stats" && break
      sleep 2
    done
    if curl -s -o /dev/null --max-time 2 "$COMFY_URL/system_stats"; then
      echo "ComfyUI is ready."
    else
      echo "ComfyUI is still starting. The page will show \"Engine ready\" once it is up."
    fi
  else
    echo "ComfyUI isn't running. Start it, or set COMFYUI_DIR in overtyme-studio/.env"
    echo "so this script can start it for you. The page will show \"Engine ready\" once it is up."
  fi
fi

echo
echo "Keep this window open while you use the studio. Close it (or press Ctrl+C) to stop."
echo
python3 studio.py "${ARGS[@]}"
pause_and_exit $?
