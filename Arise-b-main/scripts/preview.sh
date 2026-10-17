#!/bin/sh
# Preview entrypoint: run the Convex backend and the Vite dev server together.
#
# `convex dev --start` keeps the local deployment (and the function watcher)
# alive in this same process group, so the preview has one supervised command.
set -e
cd "$(dirname "$0")/.."
sh ./scripts/convex-local-setup.sh
exec bunx convex dev --start "bun run dev -- --host 0.0.0.0 --port ${PORT:-5173}"
