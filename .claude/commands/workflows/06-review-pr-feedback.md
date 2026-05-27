---
description: Fetch PR review comments and CI failures, address every fix, re-run the correctness reviewer on the fixes, respond to each thread, and verify CI. Never pushes without permission.
---

# Review PR Feedback

Systematically address every code-review comment and CI failure on an existing PR.

**Trigger**: User says "fix PR", "address comments", "review feedback", or uses `/workflows:06-review-pr-feedback`.

## Steps

> **Step notifications**: At the start of each step, output: `**[WF-06 PR Feedback · Step X/11]**`.

### 1. Identify the PR

```bash
gh pr view --json number,title,url,headRefName
```

If none is found, ask the user for the PR number. Fetch the linked issue (from branch name or PR body):

```bash
gh issue view <N> --repo Nimble-Co/FoundryVTT-Nimble
```

Keep the issue spec in context — fixes must not violate the original design.

### 2. Ensure Correct Branch

```bash
git branch --show-current
gh pr view <PR_NUMBER> --json headRefName --jq '.headRefName'
git checkout <pr-branch>   # if on the wrong branch
```

### 3. Check CI Status

```bash
gh pr checks <PR_NUMBER>
gh run view <run-id> --log-failed   # if any check failed
```

**Build/CI failures take priority over review comments — fix them first.** Never bypass a failing CI step manually — fix the underlying cause so the CI step itself passes.

### 4. Gather Review Comments

```bash
gh pr view <PR_NUMBER> --comments
gh api repos/Nimble-Co/FoundryVTT-Nimble/pulls/<PR_NUMBER>/comments
```

Catalog every open thread: requested changes (block merge), suggestions, nitpicks/questions.

### 5. Plan Fixes

Prioritize: (1) CI failures, (2) requested changes, (3) suggestions, (4) nitpicks. For fundamental design concerns, launch `correctness-reviewer` (opus) with just the issue + current branch diff to re-analyze cold.

### 6. Execute Fixes

Work the checklist in priority order. Batch low-risk fixes (style, naming, imports) and verify once; apply high-risk fixes (logic, public API, lifecycle changes) one at a time and verify after each:

```bash
pnpm type-check && pnpm test
```

**Auto-recovery**: launch `build-error-resolver` (haiku) if the build breaks.

### 7. Full Verification

```bash
pnpm check
```

All must pass before proceeding.

### 8. Correctness Review of the Fixes (parallel)

Launch **two agents in parallel** to verify the fixes didn't introduce regressions:

- **Correctness** — `correctness-reviewer` (opus). Pass it only:
  - The fresh issue body + acceptance criteria (`gh issue view`)
  - The raw `git diff dev..HEAD` (the full branch, including the new fixes)
  - Instruction: _"Read the issue and the diff. Verify the fixes for review feedback don't violate the original spec. Check for regressions in adjacent code, lifecycle timing changes, and data-flow issues introduced by the fixes. Do NOT rely on narrative — judge from the spec and the code."_

- **Test Coverage** — `test-coverage-reviewer` (sonnet). Pass it the diff and check that the fixes don't bypass test paths and that any new behavior has corresponding tests.

If either review finds blocking issues, loop back to step 6 (max 2 cycles). If still failing after 2 cycles, STOP and present findings.

### 9. Commit Locally & Wait for Push Approval

Stage and commit only the relevant files (never `git add .`):

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
fix: address PR review feedback

EOF
)"
```

> Do NOT add `Co-Authored-By: Claude` trailers (per project preference).

**Do NOT push automatically.** Present a summary:

```markdown
## Ready to push

**Commit**: `<hash>` — fix: address PR review feedback
**Files changed**: <count>
**Key changes**:
- <summary of fix 1>
- <summary of fix 2>

Push to origin and respond to PR threads?
```

**STOP and wait for explicit "yes" / "push" / "go ahead".** Only proceed to step 10 after approval.

### 10. Push and Respond to Every Thread

After user approval:

```bash
git push
```

Then iterate through **every** open conversation thread. For each, post a reply — 1–2 sentences referencing the file/function:

```bash
gh api repos/Nimble-Co/FoundryVTT-Nimble/pulls/<PR_NUMBER>/comments/<COMMENT_ID>/replies \
  --method POST \
  --field body="<response>"
```

Examples:
- "Fixed — moved validation to `src/utils/validation.ts:42`."
- "Updated per suggestion — using `$derived` instead of manual reactivity."
- "Good catch — added type guard for the `actorType` check."

Do NOT bulk-resolve threads without individual replies. If a suggestion doesn't apply, explain why rather than ignoring it.

### 11. Verify CI & Summarize

```bash
gh pr checks <PR_NUMBER>
```

If checks fail again, loop back to Step 3. Once green, post a summary comment:

```bash
gh pr comment <PR_NUMBER> --body "$(cat <<'EOF'
Addressed all review feedback:
- <fix 1>
- <fix 2>

All checks passing. Ready for re-review.
EOF
)"
```

Tell the user every conversation has been addressed.

## Notes

- **NEVER push without explicit user permission** — commit locally, present summary, wait for approval.
- Always build and test after fixes, before pushing.
- The correctness review (step 8) catches bugs introduced by the fixes themselves — do not skip it.
- Respond to every thread individually — don't bulk-resolve.
- Re-read the issue spec when planning fixes — don't violate the original design while fixing feedback.
- Commit format `<type>(<scope>): summary`; never force push.
- Do NOT add `Co-Authored-By: Claude` trailers (per project preference).
