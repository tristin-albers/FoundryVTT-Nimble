---
description: Merged gate — dead-code cleanup, then parallel correctness + code-quality + security + performance + test-coverage + spec review (last two isolated), a GO/NEEDS WORK/BLOCKED verdict, and manual testing. The single quality gate before PR.
---

# Cleanup, Review & Gate

Post-implementation hygiene and quality gate in one pass: remove dead code, run all reviews to produce a verdict **and** the manual-testing checklist, then confirm the feature works, then commit on GO.

**Trigger**: After implementation (03). User says "review", "gate", or uses `/workflows:04-cleanup-review-gate`.

## Steps

> **Step notifications**: At the start of each step, output: `**[WF-04 Cleanup & Gate · Step X/8]**`.

### 1. Scope Changed Files

```bash
git diff --name-only dev..HEAD
git diff --stat dev..HEAD
git log --oneline dev..HEAD
```

Display the changed files. If none changed, STOP. Clean up artifacts (`nul`, `tmpclaude-*`).

> **Protected-file flag**: if any of these appear in the diff, flag them now — they require explicit justification in the verdict (Step 6) and the PR description:
> - `package.json`, `pnpm-lock.yaml`
> - `tsconfig*.json`, `vite.config.*`, `vitest.config.*`, `biome.json`, `eslint.config.*`
> - `.github/workflows/`
> - `system.json`, `template.json`
> - `tests/setup.ts`, `tests/mocks/foundry.js` (never modify — flag as DANGER)
> - `src/migration/MigrationRunnerBase.ts` (schema version bumps require care)

### 2. Baseline Verification

> **Skip** if WF-03 ended with a passing checkpoint this session and `git status --porcelain` is clean.

```bash
pnpm type-check && pnpm test
```

If the build fails, launch `build-error-resolver` (haiku) per the 3-strike policy.

### 3. Cleanup Analysis

Do a fast inline scan of changed files (unused imports, commented-out blocks, obvious dead code). **If nothing found, skip to Step 5.** Otherwise launch the `refactor-cleaner` agent (haiku), which categorizes by risk:

- **SAFE**: unused imports, commented-out code, dead private functions → auto-remove
- **CAREFUL**: unused exports, consolidation opportunities → review with user
- **DANGER**: shared utility removal, rule/document class removal, lang key changes, template changes → explicit per-item approval

Foundry special cases: rule classes registered in `src/config/registerRulesConfig.ts`, document classes registered via `CONFIG.Actor.documentClass`, Svelte components loaded via dispatch tables, and hook handlers bootstrapped in `src/hooks/init.js` are NEVER unused — see the refactor-cleaner agent for the full list.

### 4. Approval & Removal

Present findings grouped by risk via `AskUserQuestion` (all SAFE / SAFE + selected CAREFUL / skip). Remove approved items in small batches, running `pnpm type-check` after each. Roll back any batch that breaks the build. Never remove DANGER items without explicit per-item approval.

### 5. Full Verification (Green Gate)

```bash
pnpm check
```

This runs format + lint + circular-deps + type-check + tests. All must pass. **TDD green gate**: every test — including the red-phase tests from WF-02 — must now pass, confirming the implementation satisfied the spec's tests. Run `pnpm lint-fix` for fixable lint issues.

### 6. Five Reviews (parallel) + Verdict

> **Launch all five agents in the SAME response** — they run in parallel.

**Contextual reviewers** (have access to the working tree and may read full files):

- **Code Quality** — `code-quality-reviewer` (haiku) on the changed files: Svelte 5 runes, naming, exports, path aliases, no-barrel-exports, localization, Foundry globals.
- **Security** — `security-reviewer` (sonnet): `{@html}` usage, DOM bypass, input validation at chat/drop/macro boundaries, secret leakage.
- **Performance** — `performance-reviewer` (sonnet): data prep hot paths, rule evaluation, hook efficiency, Svelte reactivity, embedded doc batching.

**Isolated reviewers** (deliberately given ONLY the spec and the raw diff — no implementation narrative — so they can't be biased toward approving):

- **Correctness** — `correctness-reviewer` (opus). Pass it:
  - The GitHub issue (title + body + acceptance criteria), fetched fresh: `gh issue view <N> --repo Nimble-Co/FoundryVTT-Nimble --json title,body,comments`
  - The raw output of `git diff dev..HEAD`
  - Instruction: _"Read the issue and the diff. Trace data flow, lifecycle timing, namespace contracts, and out-of-diff impact. Read full files when needed — don't trust the diff alone for context. Report blocking issues, suggestions, out-of-diff findings, and test-coverage gaps. Do NOT rely on any narrative beyond the issue and the diff."_

- **Spec** — `spec-reviewer` (sonnet). Pass it:
  - The same fresh issue body + acceptance criteria
  - The same raw `git diff dev..HEAD`
  - Instruction: _"Read the acceptance criteria. Read the diff. Judge each criterion DONE / PARTIAL / MISSING from the diff alone — do not assume intent. Flag scope creep and criteria that look implemented but seem wrong. Rely only on the issue and the diff."_

> **Why isolation matters**: a reviewer told "this implements criterion 3" is biased toward agreeing. The correctness and spec reviewers must evaluate the diff cold. Their only inputs are the official spec (the GitHub issue) and the code (diff + read access).

**Test Coverage** is checked by both the `correctness-reviewer` (test-paths section) and explicitly by `test-coverage-reviewer` if test gaps were a concern coming out of WF-02. Spawn it as a 6th parallel agent if needed.

Combine the reviews into one report that doubles as the manual-testing checklist:

```markdown
## Review Report

### Protected File Changes
<"None" or list of package.json / tsconfig / .github / system.json / template.json / etc. — must be justified in the PR>

### Code Quality (code-quality-reviewer)
- Critical: <list or "none"> · Warnings: <list or "none">

### Security (security-reviewer)
- Critical/High: <list or "none">

### Performance (performance-reviewer)
- Critical: <list or "none"> · Warnings: <list or "none">

### Correctness (correctness-reviewer, independent)
- Spec compliance: X / Y criteria
- Blocking: <list or "none"> · Out-of-diff: <list or "none"> · Test gaps: <list or "none">

### Spec (spec-reviewer, independent)
- Criteria met: X / Y
  | Criterion | Status | Notes |
  |-----------|--------|-------|
- Scope creep: <list or "none"> · Looks-implemented-but-suspect: <list or "none">

### Manual Testing Checklist
<!-- derived from the spec criteria — becomes the PR test plan -->
- [ ] <flow from criterion 1>
- [ ] <flow from criterion 2>
- [ ] <edge/error scenario if relevant>

### Verdict: GO / NEEDS WORK / BLOCKED
```

**Verdict criteria:**

- **GO**: no critical code-quality / security / performance issues, no correctness blockers, AND every acceptance criterion DONE → proceed to Step 7.
- **NEEDS WORK**: list specific fixes. Apply them, re-verify (`pnpm check`), commit `fix: address review findings`, and re-run from Step 5. Max 3 cycles, then STOP and notify the user. **Do not run manual testing for a failed review.**
- **BLOCKED**: describe the blocking issue; recommend team discussion. Do not proceed.

> A PR with unjustified protected-file changes is NEEDS WORK, not GO.

### 7. Manual Testing (GO only)

With the Step 6 checklist, verify the feature works. Use `AskUserQuestion`:

> "Verdict: GO. How would you like to verify?"
>
> - **In Foundry** — I'll start `pnpm dev` and walk the checklist flows in a running world
> - **Manual** — I'll step through the checklist myself
> - **Skip** — small change, unit tests are sufficient

Record results in `task.md` under `## Manual Testing` (method, per-flow PASS/FAIL/SKIP, issues, screenshot paths). If any flow FAILS, fix it before Step 8 — don't carry known-broken behavior into the PR.

### 8. Commit & STOP

Use `AskUserQuestion` to confirm. Stage only task-relevant files (never `git add .` / `git add -A`) and commit if there are uncommitted review/cleanup changes:

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
refactor: cleanup and review pass

EOF
)"
```

Set `task.md` status to `SUBMITTING`, then output and **STOP**:

```
Review gate passed. Run: /workflows:05-submit-pr
```

**CRITICAL — STOP HERE.** Wait for the user.

## Notes

- The verdict (Step 6) gates manual testing (Step 7) — NEEDS WORK / BLOCKED means fix first.
- All five review agents MUST run in parallel (same response).
- The correctness and spec reviewers get ONLY spec + diff — never implementation narrative.
- Never remove DANGER items without explicit per-item approval; always type-check after each removal batch.
- Workflow 05 (submit-pr) is always manual — STOP after GO + manual testing.
