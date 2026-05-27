---
description: Full validation, sync with dev, push, and open a PR targeting dev. Links and closes the GitHub issue via Closes #N.
---

# Submit PR

The heavyweight gate before code goes up for review. Every check runs here.

**Trigger**: After the review gate passes (04) with GO. User says "submit PR", "create PR", or uses `/workflows:05-submit-pr`.

## Steps

> **Step notifications**: At the start of each step, output: `**[WF-05 Submit PR · Step X/8]**`.

### 1. Full Codebase Verification

```bash
git status --porcelain
```

> **Skip** the suite below if the tree is clean AND `task.md ## Checkpoints` shows WF-04 passed GO this session.

Otherwise run everything:

```bash
pnpm check
```

This runs format + lint + circular-deps + type-check + tests. All must pass. If the build fails, launch `build-error-resolver` (haiku) per the 3-strike policy.

### 2. Cleanup Artifacts

Delete any `nul` / `tmpclaude-*` files and the local `task.md` (it must not be committed).

### 3. Commit Final Changes

If verification produced fixes, stage only the relevant files and commit:

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
fix: address pre-PR verification findings

EOF
)"
```

> **Never `git add .` / `git add -A`** — only stage task files. Do NOT add `Co-Authored-By: Claude` trailers (per project preference).

### 4. Sync with dev

```bash
git fetch upstream dev
git merge-base --is-ancestor upstream/dev HEAD && echo "Up to date" || echo "Behind dev"
```

If behind: `git merge upstream/dev`. Resolve any conflicts, re-run `pnpm check`, commit the merge. **Never rebase a pushed branch; never force push.**

### 5. Push Branch

```bash
git push -u origin HEAD
```

### 6. Collect Task Context

1. Extract the issue number from the branch name (e.g. `talbers/579-predicate-vocabulary` → `579`); fetch it via `gh issue view <N> --repo Nimble-Co/FoundryVTT-Nimble --json title,body,url` if available.
2. `git log --oneline dev..HEAD` for the commit list.
3. `git diff --stat dev..HEAD` for changed files.
4. Pull the summary, acceptance criteria, key decisions, and `## Manual Testing` results from `task.md` for the PR body.

### 7. Generate PR Content & Get Approval

- **Title**: `<type>(<scope>): <summary>` (conventional-commit format, under 70 chars). Example: `feat(predicate): expand predicate vocabulary with self/target tags`.
- **Target**: always `dev`, never `main`.
- **Do NOT add the copilot reviewer** (per project preference).

Preview the title and full body via `AskUserQuestion` ("Create the PR, or edit?"). Do not create it until approved. Then:

```bash
gh pr create --base dev \
  --title "<type>(<scope>): <summary>" \
  --body "$(cat <<'EOF'
## Summary

<one or two sentences: what this PR does and why>

## Changes

- <change 1>
- <change 2>

## Test Plan

<!-- from task.md ## Manual Testing; if skipped, list unit coverage only -->
- [ ] `pnpm check` passes (format, lint, circular deps, type-check, tests)
- [ ] <feature-specific manual verification step>

## Checklist

- [x] Added or updated unit tests
- [x] PR targets the `dev` branch
- [x] `pnpm check` passes (format, lint, circular deps, type-check, tests)
- [ ] No hardcoded user-facing strings (used `localize()`)
- [ ] Tested in Foundry with no console errors
- [x] **Have you used AI to assist with this PR?** yes
- [x] **If yes:** I have reviewed all AI-generated code against the repo's [STYLE_GUIDE.md](docs/STYLE_GUIDE.md) and [AGENTS.md](AGENTS.md)

## Related Issues

<Closes #N if applicable>
EOF
)"
```

> The `Closes #N` line auto-closes the GitHub issue when the PR merges. Omit it for ad-hoc work with no issue.

### 8. Post-PR & STOP

- Output the PR URL.
- The PR body's `Closes #N` links the issue and closes it on merge — no separate status update needed.

```
PR created: <url>
When reviewer feedback arrives, run: /workflows:06-review-pr-feedback
```

## Notes

- PRs always target `dev`, never `main`.
- PR title `<type>(<scope>): summary`; reference the issue with `Closes #N` in the body.
- Never `git add .`, never force push, never skip verification.
- Use the HEREDOC format for the PR body.
- Do NOT include `Co-Authored-By: Claude` trailers in commits or PR bodies (per project preference).
- Do NOT add the copilot reviewer (per project preference).
