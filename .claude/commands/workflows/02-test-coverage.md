---
description: TDD-first — write failing Vitest tests from acceptance criteria BEFORE implementation (red phase). Also supports post-implementation coverage mode.
---

# Test Coverage (TDD-First)

Establishes the test signal **before** implementation. Tests are written from the task's acceptance criteria and are _expected to fail_ — that's the red phase. Implementation (WF-03) then makes them pass, and the review gate (WF-04) confirms green.

**Trigger**: After planning (01), before implementing (03). User says "write tests", "TDD", or uses `/workflows:02-test-coverage`.

## Modes

- **TDD-first** (default, runs before WF-03): write failing tests from acceptance criteria. Record the failures — do NOT fix them here.
- **Coverage** (post-implementation, for work already built): fill coverage gaps; all new tests must pass before proceeding.

## Steps

> **Step notifications**: At the start of each step, output: `**[WF-02 Test Coverage · Step X/6]**`.

### 1. Restore Context

Read `task.md` for the plan, acceptance criteria, and key files. If it's missing, STOP and tell the user to run `/workflows:01-start-task` first. Set status to `TESTING`.

### 2. Baseline Test Run

> **Skip** if WF-01 Step 5 ran this session and `git status --porcelain` is clean.

```bash
pnpm test
```

Note the starting test count and pass rate.

### 3. Identify What to Cover

Map each acceptance criterion to a concrete, testable behavior. For coverage mode, also diff against dev to find untested changes:

```bash
git diff --name-only dev..HEAD
```

Prioritize by layer:
- **Rule classes** (`src/models/rules/`) — schema validation, lifecycle hooks (`prePrepareData` / `afterPrepareData`), predicate evaluation, bonus stacking
- **Document classes** (`src/documents/`) — derived data, status tags, getRollData
- **Utilities** (`src/utils/`, `src/etc/`) — pure functions, edge cases
- **Managers** (`src/managers/`) — orchestration, activation paths

### 4. Write Tests

Launch the `Explore` or general-purpose agent to write tests following `.claude/rules/testing.md`:

- Vitest + Happy DOM, `*.test.ts`, `describe > it` behavior-driven naming, AAA pattern
- Mock Foundry globals via `tests/setup.ts` and `tests/mocks/foundry.js` — **never modify these files**
- Precise assertions (`toBe(true)`, not `toBeTruthy()`); cover error paths, not just happy paths
- Prefix unused parameters with `_` (e.g. `_event`)

> **Tracer-bullet rule**: write ONE test for ONE behavior at a time. Don't write all tests up front (horizontal slicing produces tests that verify imagined behavior). In TDD-first mode each red test maps to a criterion the implementation must satisfy.

### 5. Run Tests

```bash
pnpm test
```

- **TDD-first mode**: failures are expected — record the failing test names and counts. Do NOT fix them. They are the red-phase baseline WF-04 will confirm green.
- **Coverage mode**: all new tests must pass. Follow the 3-strike retry policy if they don't; launch `build-error-resolver` (haiku) for build issues.

### 6. Summary, Commit & Auto-Continue

```markdown
## Test Coverage Summary

**Mode**: TDD-first (red) / Coverage
**Tests**: <before> → <after> (new: N)
**Red-phase failing tests** (TDD-first): <list, or "n/a">
**Acceptance criteria with tests**: X / Y
```

Commit the tests:

```bash
git add <test-files>
git commit -m "$(cat <<'EOF'
test: add tests for <area>

EOF
)"
```

Update `task.md` progress, then **auto-continue**:

- **TDD-first mode**: inform the user "Tests written (red phase). Proceeding to implementation…" and **automatically invoke `/workflows:03-implement`** via the Skill tool.
- **Coverage mode** (implementation already exists): inform the user "Coverage filled. Proceeding to the review gate…" and **automatically invoke `/workflows:04-cleanup-review-gate`** via the Skill tool.

> **Auto-chain**: steps 02 → 03 → 04 run automatically. If any check hits the 3-strike limit, STOP and notify the user instead of chaining.

## Notes

- Focus on changed code and acceptance criteria, not the whole codebase.
- No coverage-only tests — every test verifies real behavior.
- Use `type: summary` commit format; `Closes #N` belongs in the eventual PR body, not checkpoint commits.
- Do NOT modify `tests/setup.ts` or `tests/mocks/foundry.js`.
