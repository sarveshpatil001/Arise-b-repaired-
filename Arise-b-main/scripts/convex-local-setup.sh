#!/bin/sh
# Prepare the Convex local backend for this host.
#
# The backend binary Convex ships is built against glibc 2.38/2.39, while this
# sandbox runs glibc 2.35. We install a private newer glibc under /opt/glibc2439
# (no system libraries are touched) and wrap the cached backend binary so it is
# launched through that loader. Idempotent: safe to run on every preview start.
set -e

GLIBC_DIR=/opt/glibc2439
LOADER="$GLIBC_DIR/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"
CACHE="$HOME/.cache/convex/binaries"

if [ ! -x "$LOADER" ]; then
  echo "[convex-local] installing private glibc 2.39 into $GLIBC_DIR"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/libc6.deb" \
    "http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.39-0ubuntu8.9_amd64.deb"
  curl -fsSL -o "$tmp/libstdc6.deb" \
    "http://archive.ubuntu.com/ubuntu/pool/main/g/gcc-14/libstdc++6_14.2.0-4ubuntu2~24.04.1_amd64.deb"
  mkdir -p "$GLIBC_DIR"
  dpkg-deb -x "$tmp/libc6.deb" "$GLIBC_DIR"
  dpkg-deb -x "$tmp/libstdc6.deb" "$GLIBC_DIR"
  rm -rf "$tmp"
fi

wrap_binaries() {
  for d in "$CACHE"/*/; do
    [ -d "$d" ] || continue
    b="$d/convex-local-backend"
    [ -f "$b" ] || continue
    [ -f "$b.real" ] && continue
    mv "$b" "$b.real"
    cat > "$b" <<EOF
#!/bin/sh
exec $LOADER --library-path $GLIBC_DIR/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu "\$(dirname "\$0")/convex-local-backend.real" "\$@"
EOF
    chmod +x "$b"
    echo "[convex-local] wrapped $b"
  done
}

wrap_binaries

# If no binary is cached yet, let the CLI download one, then wrap it.
if ! ls "$CACHE"/*/convex-local-backend.real >/dev/null 2>&1; then
  (cd "$(dirname "$0")/.." && bunx convex dev --once) >/dev/null 2>&1 || true
  wrap_binaries
fi

if ! ls "$CACHE"/*/convex-local-backend.real >/dev/null 2>&1; then
  echo "[convex-local] warning: Convex backend binary not found; local deployment may be unavailable" >&2
fi

echo "[convex-local] ready"
