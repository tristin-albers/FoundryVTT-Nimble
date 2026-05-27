## Workflows

The pipeline runs 00 → 06. Steps **02 → 03 → 04 auto-chain**; everything else is invoked manually.

### Pipeline (00–06)

0. `/workflows:00-reset-and-cleanup` — **Optional hygiene pass**: clean Claude artifacts, sync `dev`, prune merged branches. Run between major work cycles.
1. `/workflows:01-start-task` — Create feature branch from `dev`, explore codebase, write the plan to `task.md`, **STOPS** for plan review.
2. `/workflows:02-test-coverage` — **TDD-first**: write failing Vitest tests from acceptance criteria (red phase). Auto-chains to 03.
3. `/workflows:03-implement` — Execute the plan inline; incremental type-check; checkpoint commits with conventional format. Auto-chains to 04.
4. `/workflows:04-cleanup-review-gate` — Dead-code cleanup → parallel multi-agent review (code-quality + security + performance + correctness + spec, last two isolated) → GO/NEEDS WORK/BLOCKED verdict → manual testing on GO → **STOPS** before PR.
5. `/workflows:05-submit-pr` — **Manual**. Full verification (`pnpm check`), sync with `dev`, push, create PR targeting `dev`.
6. `/workflows:06-review-pr-feedback` — **Manual**. Address PR comments + CI failures, re-run correctness/test-coverage review on the fixes, respond to threads. Never pushes without permission.

### Agents (`.claude/agents/`)

Reusable agent prompts referenced by name from workflows:

- **`correctness-reviewer`** (opus, isolated) — Fronix-style: data-flow tracing, lifecycle timing, namespace contracts, out-of-diff review. Gets only the spec + diff.
- **`spec-reviewer`** (sonnet, isolated) — acceptance-criteria check. Gets only the spec + diff.
- **`code-quality-reviewer`** (haiku) — Svelte 5 runes, naming, exports, path aliases, localization, Foundry globals.
- **`security-reviewer`** (sonnet) — `{@html}` / DOM bypass / input validation / secret leakage.
- **`performance-reviewer`** (sonnet) — data-prep hot paths, rule evaluation, hook efficiency, Svelte reactivity.
- **`test-coverage-reviewer`** (sonnet) — verifies test paths actually exercise the changed code, not just file presence.
- **`build-error-resolver`** (haiku) — minimal-diff fixer for `pnpm type-check` / `pnpm lint` errors.
- **`refactor-cleaner`** (haiku) — dead-code finder, Foundry-aware (knows rule registry, document classes, dispatch tables, hook bootstrap).

### Utility Commands

- `/commit` — Commit with conventional commit format
- `/commit-push` — Commit and push to remote
- `/plan` — Create implementation plan (waits for confirmation before coding)
- `/verify` — Run lint / type-check / tests / git status checks
- `/review-pr` — Quick PR review (separate from workflow 06)

### Retry Policy

All workflows use a **3-strike retry policy**: on failure, try 3 different approaches before notifying the user. On attempt 2+ for build failures, launch the `build-error-resolver` agent.

### Key Conventions

- **No `Co-Authored-By: Claude` trailers** in commits (per project preference).
- **No copilot reviewer** on PRs (per project preference).
- **PR target**: always `dev`, never `main`. Use conventional commit format for PR titles: `<type>(<scope>): summary`.
- **Strict TypeScript types always** — no `any`, no `@ts-ignore` without explanation.
- **Two reviewers run in isolation** (`correctness-reviewer`, `spec-reviewer`) — they get only the spec + diff with no implementation narrative. This is deliberate to avoid bias.
