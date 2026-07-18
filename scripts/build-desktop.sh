#!/usr/bin/env bash
# Standalone Windows installer build - mirrors the Windows build block in
# scripts/release.sh but without tagging, release notes, or uploads. Use this
# to validate the desktop build independently before cutting a real release.
#
# Builds ENTIRELY ON LINUX - no Windows VM. electron-builder cross-builds the
# win32 NSIS target: it downloads the win32-x64 Electron dist, packs the app
# (the holepunch native deps and active-win ship cross-platform prebuilds, so
# no win32 compile), and runs rcedit/NSIS under wine. desktop/package.json's
# `files` config ships the win32-x64 prebuilds so the native modules load on
# Windows. The .exe is unsigned. Install-test the result on a real Windows box.
#
# Usage:
#   scripts/build-desktop.sh <version>          (e.g. 1.0.1)
#
# Output:
#   pearguard-v<version>.exe          in the repo root
#   pearguard-v<version>.exe.sha256   sidecar with "<hash>  <filename>"
#   latest.yml                        electron-updater metadata
#
# Requirements: node + npm, wine (Fedora: sudo dnf install wine), and
#   `npm install` already run in desktop/.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

# Load app config (ARTIFACT_PREFIX, etc.)
if [ -f "$SCRIPT_DIR/app.conf" ]; then
  set -a; source "$SCRIPT_DIR/app.conf"; set +a
fi

APP_VERSION="${1:-}"
if [ -z "$APP_VERSION" ]; then
  echo "Usage: $0 <version>   (e.g. 1.0.1)" >&2
  exit 1
fi
APP_VERSION="${APP_VERSION#v}"
RELEASE_TAG="v${APP_VERSION}"

command -v wine >/dev/null 2>&1 || {
  echo "ERROR: wine not found - electron-builder needs it for the win32 rcedit/NSIS steps." >&2
  echo "       Fedora: sudo dnf install wine" >&2
  exit 1
}

# ---- 1. Ensure UI bundle exists (desktop/scripts/prepack.js reads it) -------
if [ ! -f "$REPO_ROOT/assets/app-ui.bundle" ]; then
  echo "==> Building UI bundle (required by desktop/scripts/prepack.js)..."
  ( cd "$REPO_ROOT" && npm run build:ui )
fi

# ---- 2. Stamp desktop/package.json version ----------------------------------
# electron-builder's artifactName template ("pearguard-v${version}.${ext}")
# uses this, so the .exe is named for direct GitHub-release upload.
APP_VERSION="$APP_VERSION" node -e "
  const fs = require('fs');
  const f = '$REPO_ROOT/desktop/package.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = process.env.APP_VERSION;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('==> stamped desktop/package.json version=' + j.version);
"

# ---- 3. Build the Windows installer -----------------------------------------
# `npm run build` = prepack.js (refresh vendor + fetch active-win bindings)
# then electron-builder --win.
echo "==> Building Windows installer (.exe) locally (this takes a few minutes)..."
( cd "$REPO_ROOT/desktop" && npm run build )

# ---- 4. Collect the installer + electron-updater metadata -------------------
EXE_NAME="${ARTIFACT_PREFIX:-pearguard}-${RELEASE_TAG}.exe"
cp "$REPO_ROOT/desktop/dist/pearguard-${RELEASE_TAG}.exe" "$REPO_ROOT/$EXE_NAME"
cp "$REPO_ROOT/desktop/dist/latest.yml" "$REPO_ROOT/latest.yml"
EXE_SIZE=$(du -sh "$REPO_ROOT/$EXE_NAME" | cut -f1)

# ---- 5. sha256 sidecar ------------------------------------------------------
( cd "$REPO_ROOT" && sha256sum "$EXE_NAME" > "${EXE_NAME}.sha256" )

echo ""
echo "==> Done."
echo "    Installer : ${REPO_ROOT}/${EXE_NAME}  (${EXE_SIZE})"
echo "    Metadata  : ${REPO_ROOT}/latest.yml"
echo "    sha256    : $(cut -d' ' -f1 < "${REPO_ROOT}/${EXE_NAME}.sha256")"
