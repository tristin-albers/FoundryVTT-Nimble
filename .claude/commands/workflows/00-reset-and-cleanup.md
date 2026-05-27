---
description: (Optional) Reset the dev environment, clean Claude artifacts, sync dev, and prune merged branches.
---

# Reset and Cleanup

Run this between major work cycles to keep the dev environment tidy and prevent branch clutter.

**Trigger**: User says "reset environment", "clean up branches", or uses `/workflows:00-reset-and-cleanup`.

## Steps

> **Step notifications**: At the start of each step, output: `**[WF-00 Reset · Step X/6]**`.

### 1. Clean Claude Artifacts

```bash
find . -maxdepth 3 -name "nul" -type f -delete 2>/dev/null
find . -maxdepth 3 -name "tmpclaude-*" -exec rm -rf {} + 2>/dev/null
```

Delete any stray `task.md` only if the user confirms the previous task is finished. Report what was cleaned.

### 2. Update Base Branch

```bash
git checkout dev
git pull upstream dev
```

If `git status --porcelain` shows uncommitted changes, STOP and ask the user before switching.

### 3. Validate Environment

```bash
pnpm install
pnpm type-check
pnpm test
```

If any fail, STOP and tell the user the environment needs triaging before further cleanup.

### 4. Ask About Branch Cleanup

Use `AskUserQuestion`: "Clean up merged branches? (I'll show the list first — nothing is deleted without your OK.)" If the user declines, stop here.

### 5. Identify and Confirm

```bash
git fetch --prune
git branch --merged dev | grep -vE '^\*|dev|main'
git branch -r --merged dev | grep -vE 'dev|main|HEAD'
```

Present the de-duplicated list and **wait for explicit confirmation**. Never delete protected branches (`dev`, `main`). Warn if any branch still has an open PR.

### 6. Delete Confirmed Items

```bash
git branch -D <branch>
git push origin --delete <branch>   # only if pushed
```

Report: artifacts cleaned, env status, branches deleted (local + remote).

## Notes

- Never delete `dev` or `main`.
- Always present the list and wait for confirmation before deleting anything.
- This workflow doesn't auto-chain — it's a standalone hygiene pass.
