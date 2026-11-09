#!/bin/bash
# SetPilot installer for macOS. Paste in Terminal:
#   curl -fsSL https://raw.githubusercontent.com/benetocr/setpilot/main/install.sh | bash
# Downloads the right build for this Mac (Apple chip or Intel), replaces any
# older SetPilot, and opens it. On its first start SetPilot puts its script
# and its audio plug-in where Ableton Live finds them.
set -euo pipefail

BASE="https://github.com/benetocr/setpilot/releases/download/latest"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "SetPilot runs on macOS. / SetPilot funciona en macOS."

if [ "$(uname -m)" = "arm64" ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi

if [ -w /Applications ]; then DEST=/Applications; else DEST="$HOME/Applications"; mkdir -p "$DEST"; fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Descargando SetPilot ($ARCH)... / Downloading SetPilot..."
curl -fL --progress-bar -o "$TMP/SetPilot.zip" "$BASE/SetPilot-mac-$ARCH.zip" || fail "No se pudo descargar. Revisa tu internet. / Download failed, check your connection."

say "Instalando en $DEST... / Installing..."
osascript -e 'quit app "SetPilot"' >/dev/null 2>&1 || true
sleep 2
pkill -x SetPilot >/dev/null 2>&1 || true
rm -rf "$DEST/SetPilot.app"
ditto -x -k "$TMP/SetPilot.zip" "$DEST" || fail "No se pudo instalar en $DEST. / Could not install."
xattr -cr "$DEST/SetPilot.app" 2>/dev/null || true

# a plug-in from an earlier manual install may carry the download flag
for p in "$HOME/Library/Audio/Plug-Ins/VST3/SetPilot Audio.vst3" "$HOME/Library/Audio/Plug-Ins/Components/SetPilot Audio.component"; do
  [ -e "$p" ] && xattr -cr "$p" 2>/dev/null || true
done

open "$DEST/SetPilot.app"

say "Listo. SetPilot está abierto. / Done, SetPilot is open."
if pgrep -xq "Live"; then
  echo "Cierra Ableton Live y ábrelo de nuevo para que cargue SetPilot."
  echo "Quit Ableton Live and open it again so it loads SetPilot."
else
  echo "Abre Ableton Live 12 y SetPilot se conecta solo."
  echo "Open Ableton Live 12 and SetPilot connects by itself."
fi
