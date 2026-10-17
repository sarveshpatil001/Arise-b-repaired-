# Repository source migration

## Current state

- The verified application source is committed at `Arise-b-main/`; a clean checkout
  builds and tests it (CI runs on `main`).
- `Arise-b-main-repaired.zip` remains the tracked **pre-repair** snapshot:
  `sha256 92c8aff7a0e3505ba108d0616f5204cd4c410bed7900eb964db4761866d0682a`.
  It does not contain the security repairs.
- CI (`.github/workflows/ci.yml`) no longer extracts the archive; it verifies the
  committed source tree and supports either the current `Arise-b-main/` subdirectory
  or a root-level layout.

The source was migrated on a reviewed branch and merged to `main`; no history was
rewritten and no force-push was used. CI locates the source at either the repository
root or `Arise-b-main/`, so a later layout move does not invalidate the workflow.

## Baseline (pre-hardening, already verified)

The clean tree that was merged passed the following before the post-merge hardening
described in the audit report. The post-hardening tree is re-verified separately
(550 tests after the final hardening pass).

```
bun install --frozen-lockfile   # 413 packages, no changes
bunx tsc -b --noEmit            # exit 0
bun run lint                    # exit 0 (2 pre-existing Admin.tsx warnings)
bun run test                    # 531/531 passing, 33 files
bun run build                   # exit 0, dist/ produced
bun audit                       # exit 0, no vulnerabilities
```

This works because Convex generated types (`src/convex/_generated/`) are now
committed instead of ignored. They must be regenerated with `bunx convex dev --once`
whenever a Convex function is added or renamed.

Recovery is possible at every step: the original archive remains in git history and
can be extracted from the checksum above.

## Migration steps

1. **Snapshot the archive.** Record `sha256sum Arise-b-main-repaired.zip` in the pull
   request description. Do not delete the archive in this commit. (Done.)
2. **Keep or move the source.** The source is committed at `Arise-b-main/`; the root
   move below remains optional and has not been performed. If it is done:
   - `git mv Arise-b-main/* .` is not sufficient for dotfiles; move those explicitly
     (`.gitignore`, `.github` stays at root).
   - Keep `Arise-b-main-repaired.zip` unchanged; `.gitignore` already ignores `*.zip`
     for new files but the existing tracked archive stays tracked until step 4.
3. **Verify the migrated tree** with the same commands CI runs
   (`bun install --frozen-lockfile`, `bunx tsc -b --noEmit`, `bun run lint`,
   `bun run test`, `bun run build`, `bun audit`) and confirm the tree still contains
   every file from the archive, e.g.
   `diff -rq <extracted-archive> . -x node_modules -x dist -x .git` shows only the
   intentional repairs.
4. **Retire the archive in a follow-up commit** (never before step 3 passes):
   `git rm Arise-b-main-repaired.zip`, keep the checksum in this document, and note
   in the README that the source tree is now the source of record. The old blob
   remains in git history for recovery.
5. **Update the root `README.md`** to point at the source tree and the audit
   documents instead of the archive.
6. **Preview commands.** Re-save them for the root layout
   (`freebuff-preview set-install "bun install --frozen-lockfile"`,
   `freebuff-preview set "bun run dev" 5173`) if the platform does not detect them.

## Analysis section (additive, post-merge)

The Analysis navigation item (`/dashboard/analysis`) is additive: existing routes, the home
screen, authentication, paper trading and admin surfaces are unchanged. The feature adds:

- one table, `analysisRecords`, which is append-only (no update/delete function);
- one index, `positions.userId`, for bounded per-user monitoring/performance reads;
- pure modules `src/lib/arise/analysis.ts` and `src/lib/arise/arena.ts`;
- Convex endpoints in `src/convex/arise/analysis.ts`.

Convex creates the table/index on deploy; no data backfill or destructive migration is needed.
`bunx convex dev --once` must be run after checkout so `_generated` includes the new module.

The optional catalyst feed is disabled unless `ECONOMIC_CALENDAR_URL` is set; existing
installations need no action to stay safe, and the UI will report `UNCONFIGURED`.

## History

Git cannot preserve per-file history that never existed in this repository: the
source has only ever been a zip blob, so every file's history starts at the migration
commit. The archive's own commits remain reachable. No rewrite or force-push is
needed, and none should be used.

## Rollback

- Before step 4: `git revert` the migration commit; the archive is still tracked.
- After step 4: `git show <migration-commit>:Arise-b-main-repaired.zip > /tmp/restore.zip`
  (or recover the blob from history) and verify the checksum above before extracting.
