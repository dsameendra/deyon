#!/usr/bin/env bash
# Produces a self-contained aria2c for macOS at resources/bin/mac/aria2c,
# with all Homebrew dylib dependencies bundled alongside it (so end users
# don't need Homebrew or aria2 installed), plus the CA bundle it needs
# since Homebrew's aria2 links against OpenSSL rather than Secure Transport.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/resources/bin/mac"
CERT_DIR="$ROOT_DIR/resources/certs"

command -v brew >/dev/null || { echo "Homebrew is required to build the macOS aria2 binary." >&2; exit 1; }

echo "==> Installing aria2, dylibbundler, ca-certificates via Homebrew"
brew list aria2 >/dev/null 2>&1 || brew install aria2
brew list dylibbundler >/dev/null 2>&1 || brew install dylibbundler
brew list ca-certificates >/dev/null 2>&1 || brew install ca-certificates

BREW_PREFIX="$(brew --prefix)"
SRC_BIN="$BREW_PREFIX/bin/aria2c"
CACERT="$BREW_PREFIX/opt/ca-certificates/share/ca-certificates/cacert.pem"

if [ ! -x "$SRC_BIN" ]; then
  echo "aria2c not found at $SRC_BIN" >&2
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$CERT_DIR"

cp "$SRC_BIN" "$OUT_DIR/aria2c"
chmod u+w "$OUT_DIR/aria2c"
chmod +x "$OUT_DIR/aria2c"

echo "==> Bundling dynamic library dependencies with dylibbundler"
dylibbundler -od -b \
  -x "$OUT_DIR/aria2c" \
  -d "$OUT_DIR/libs" \
  -p "@executable_path/libs/"

chmod -R u+w "$OUT_DIR/libs"
find "$OUT_DIR/libs" -type f -exec chmod +x {} \;

echo "==> Ad-hoc code-signing bundled binary and libraries"
find "$OUT_DIR/libs" -type f -name "*.dylib" -print0 | xargs -0 -I{} codesign --force -s - --timestamp=none "{}"
codesign --force -s - --timestamp=none "$OUT_DIR/aria2c"

echo "==> Copying CA certificate bundle"
cp "$CACERT" "$CERT_DIR/cacert.pem"

echo "==> Verifying the bundled binary has no remaining Homebrew references"
if otool -L "$OUT_DIR/aria2c" | grep -E "/opt/homebrew|/usr/local/opt|/usr/local/Cellar"; then
  echo "ERROR: bundled binary still references Homebrew paths." >&2
  exit 1
fi
for dylib in "$OUT_DIR"/libs/*.dylib; do
  if otool -L "$dylib" | grep -E "/opt/homebrew|/usr/local/opt|/usr/local/Cellar"; then
    echo "ERROR: $dylib still references Homebrew paths." >&2
    exit 1
  fi
done

echo "==> Smoke-testing the bundled binary"
"$OUT_DIR/aria2c" --version

echo "Done. Self-contained aria2c is at $OUT_DIR/aria2c (with $OUT_DIR/libs)"
