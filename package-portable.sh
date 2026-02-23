#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
#  Meetel Flow — Windows Portable Packaging Script
#  Creates a ready-to-distribute zip from win-unpacked
# ─────────────────────────────────────────────────────

set -euo pipefail

VERSION="0.1.0"
APP_NAME="MeetelFlow"
ZIP_NAME="${APP_NAME}-v${VERSION}-Win-Portable.zip"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
WIN_UNPACKED="${DIST_DIR}/win-unpacked"
STAGING_DIR="${DIST_DIR}/${APP_NAME}"
README_SRC="${DIST_DIR}/README.txt"
OUTPUT="${DIST_DIR}/${ZIP_NAME}"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   Meetel Flow — Portable Packager    ║"
echo "  ║   v${VERSION}                            ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── Preflight checks ──

if [ ! -d "$WIN_UNPACKED" ]; then
    echo "  [ERROR] dist/win-unpacked/ not found."
    echo "  Run 'npm run dist:win' first to build the Electron app."
    exit 1
fi

if [ ! -f "${WIN_UNPACKED}/Meetel Flow.exe" ]; then
    echo "  [ERROR] Meetel Flow.exe not found in win-unpacked/."
    echo "  The build may be incomplete."
    exit 1
fi

if [ ! -f "$README_SRC" ]; then
    echo "  [WARN] README.txt not found in dist/. Continuing without it."
fi

# Check if zip command is available
if ! command -v zip &> /dev/null; then
    echo "  [ERROR] 'zip' command not found. Install with: sudo apt install zip"
    exit 1
fi

# ── Clean previous artifacts ──

echo "  [1/4] Cleaning previous build..."
rm -rf "$STAGING_DIR"
rm -f "$OUTPUT"

# ── Create staging directory ──

echo "  [2/4] Staging files..."
mkdir -p "$STAGING_DIR"

# Copy all win-unpacked contents into the staging folder
cp -r "${WIN_UNPACKED}/." "$STAGING_DIR/"

# Add README
if [ -f "$README_SRC" ]; then
    cp "$README_SRC" "$STAGING_DIR/README.txt"
    echo "         + README.txt"
fi

# Count files for info
FILE_COUNT=$(find "$STAGING_DIR" -type f | wc -l)
echo "         ${FILE_COUNT} files staged"

# ── Compress ──

echo "  [3/4] Compressing to ${ZIP_NAME}..."
cd "$DIST_DIR"
zip -r -q "$ZIP_NAME" "${APP_NAME}/"

# ── Report ──

echo "  [4/4] Done!"
echo ""

ZIP_SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "  ┌──────────────────────────────────────┐"
echo "  │  Output: dist/${ZIP_NAME}"
echo "  │  Size:   ${ZIP_SIZE}"
echo "  │  Files:  ${FILE_COUNT}"
echo "  └──────────────────────────────────────┘"
echo ""

# ── Cleanup staging ──

rm -rf "$STAGING_DIR"
echo "  Staging cleaned. Ready to distribute."
echo ""
