---
description: Implement the approved plan from task.md with incremental typecheck and checkpoint commits. Makes the red-phase tests from WF-02 pass.
---

# Implement Feature

The active coding phase. The plan was written in WF-01 and lives in `task.md`; the failing tests were written in WF-02. Implementation makes those tests pass.

**Trigger**: After tests are written (02). User says "implement this", "ready to code", or uses `/workflows:03-implement`.

## Steps

> **Step notifications**: At the start of each step, output: `**[WF-03 Implement · Step X/5]**`.

### 1. Restore Context

Read `task.md` to restore the plan, acceptance criteria, progress, and key files. If no plan exists, STOP — run `/workflows:01-start-task` first. If no tests exist yet, recommend `/workflows:02-test-coverage` first (or proceed if the user explicitly skips TDD).

### 1.5. Status & Key Decisions Gate

Set `task.md` status to `IMPLEMENTING`. Resolve any unresolved entries in `## Key Decisions` before writing code — present each decision with options and a recommendation, wait for confirmation, record the choice. During implementation, if a non-obvious decision surfaces (multiple valid approaches, trade-offs, scope questions), STOP and surface it before proceeding (see `agentic-behavior.md` Section 5).

### 2. Implementation Loop

Implement the approved plan **inline** (do not delegate to a sub-agent for the writing — agents lose Foundry context). Enforce Nimble standards:

- **Svelte 5 runes**: `$state`, `$derived`, `$effect`, `$props()` — never Svelte 4 syntax
- **TypeScript**: `lang="ts"` in `.svelte` components; `import type` for type-only imports
- **File extensions**: include `.ts` in ESM imports for TypeScript files
- **`.svelte.ts` extension**: any `.ts` file using runes outside a `.svelte` component must use `.svelte.ts`
- **Props types**: defined in separate `types/components/*.d.ts` files, not inline
- **Foundry globals**: `game`, `CONFIG`, `Hooks`, `Roll`, `Actor`, `Item` are globals — never import them
- **Document mutations**: `actor.update()` / `item.update()` — never direct assignment
- **`foundry.utils.setProperty()`** for nested system data mutation in rule hooks
- **Localization**: all user-facing strings via `localize()` from `src/utils/localize.ts`
- **Path aliases**: `#documents/*`, `#lib/*`, `#managers/*`, `#stores/*`, `#types/*`, `#utils/*`, `#view/*`
- **No barrel exports** (no `index.ts` re-export files)
- **Named exports**, one primary export per file
- **Tests**: make the red-phase tests pass; add tests alongside any new logic not already covered

Always check `docs/STYLE_GUIDE.md` and `AGENTS.md` before creating new utilities.

### 3. Build Verification

After each meaningful change:

```bash
pnpm type-check
```

**Auto-recovery (build)**: if type-check fails, follow the 3-strike retry policy from `agentic-behavior.md`; on attempt 2+, launch `build-error-resolver` (haiku).

**Runtime bugs** (wrong behavior, flaky test, unexpected throw — not a compile error): diagnose with a focused test or log before guessing — build a fast, deterministic feedback loop before attempting a fix.

### 4. Checkpoint Commit & Progress

Once a meaningful chunk is complete and the changed area's tests pass, checkpoint in one step:

1. Verify:
   ```bash
   pnpm lint && pnpm type-check && pnpm test
   ```
   Run `pnpm lint-fix` for fixable lint issues; launch `build-error-resolver` (haiku) if the build breaks.

2. Stage only the relevant files (never `git add .` / `git add -A`) and commit using conventional commit format:

   ```bash
   git add <specific-files>
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <summary under 50 chars>

   EOF
   )"
   ```

   Use the right type (`feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `perf`). `Closes #N` goes in the PR body (WF-05), not checkpoint commits. Do NOT add `Co-Authored-By: Claude` trailers (per project preference).

3. Update `task.md`: check off `## Progress` items, append to `## Checkpoints`, mark satisfied acceptance criteria.

**Phased work**: treat each plan phase as its own checkpoint — implement → verify → commit → next phase.

### 5. Completion & Auto-Continue

When all acceptance criteria are met, tests pass, and the build is green, set `task.md` status to `REVIEWING`.

Inform the user "Implementation complete. Proceeding to the review gate…" and **automatically invoke `/workflows:04-cleanup-review-gate`** via the Skill tool.

> **Auto-chain**: 02 → 03 → 04 run automatically. The chain ends at 04 — the review gate pauses for the GO/manual-testing decision before PR (05 is always manual). If any check hits the 3-strike limit, STOP and notify the user instead of chaining.

## Notes

- One logical change at a time — don't bundle unrelated changes.
- Keep `task.md` current throughout.
- Commit format `<type>(<scope>): summary`; never push during this phase (push happens in WF-05).
- **Migration reminder**: if a migration file is created, bump `LATEST_SCHEMA_VERSION` in `src/migration/MigrationRunnerBase.ts` to match.
- **In-game testing**: start `pnpm dev` before testing in Foundry (hot reload). If not using dev server, run `pnpm build` after code changes.
- **Pack data vs embedded data**: updated compendium JSON does not affect existing characters — they have embedded copies. Note this in test plans, and write a migration if existing characters need updating.
