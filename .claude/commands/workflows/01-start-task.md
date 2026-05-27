---
description: Create a feature branch from dev, explore the codebase, and write an implementation plan.
---

# Start Task

Every piece of work begins on a dedicated branch.

**Trigger**: User says "start task X", "new task", or uses `/workflows:01-start-task`.

## Steps

> **Step notifications**: At the start of each step, output: `**[WF-01 Step X/7]**`.

### 1. Branch Setup

```bash
git branch --show-current
git status --porcelain
```

If uncommitted changes exist, warn the user and ask if they want to stash before switching.

If already on `dev`, pull latest and continue to Step 2. Otherwise, use `AskUserQuestion`:

> "You are on branch `<current-branch>`. Start a new branch from dev, or continue on this branch?"
>
> - **New branch from dev** — checkout dev, pull, continue
> - **Continue on this branch** — skip to Step 2
> - **Just sync dev** — checkout dev, pull, then stop

If syncing only: run `git checkout dev && git pull upstream dev` and **stop**.

Otherwise:

```bash
git fetch upstream dev
git checkout dev
git pull upstream dev
```

### 2. Task Context & Requirements

Use `AskUserQuestion` to gather task details in one pass:

> "Provide a GitHub issue number (e.g., #123) or describe the work. Include any details about scope, acceptance criteria, or technical decisions needed."

**If GitHub issue provided**:

1. Use `gh issue view <number>` to fetch details
2. Display title, description, and labels
3. If the description is vague, ask one round of clarifying questions

**If manual description**:

1. Use the provided description as the task summary
2. Ask for acceptance criteria if not included
3. Ask: "Is this a feature, bug fix, or chore?"

### 3. Create Feature Branch

**Branch naming convention**:

- With issue: `talbers/<type>-<issue#>-short-description`
- Without issue: `talbers/<type>-short-description`

```bash
git checkout -b <branch-name> dev
```

If the branch already exists, ask: checkout existing, create versioned (`-v2`), enter different name, or exit.

### 4. Validate Environment

```bash
pnpm type-check
pnpm test
```

If either fails, STOP. The environment needs fixing before proceeding.

### 5. Explore Codebase

Launch an Explore agent to identify relevant files based on the task description. The agent should find:

1. Files likely to need modification (check `src/documents/`, `src/models/`, `src/view/sheets/`, `src/view/components/`, `src/view/dialogs/`, `src/stores/`, `src/utils/`, `src/managers/`)
2. Existing patterns or similar implementations to follow
3. Related test files

#### 5.1 Agent-Assisted Planning

Invoke a planning agent based on complexity:

- **Complex architectural decisions** (new patterns, cross-cutting concerns): Launch Agent (opus) for architecture planning
- **Multi-layer features** (model + document + UI): Launch Agent (sonnet) for code planning
- **Simple single-layer changes**: Plan inline without an agent

### 6. Display Summary

```markdown
## Preparation Complete

**Task:** <#issue or "ad-hoc"> — <summary>
**Branch:** <branch-name> (created from dev)
**Type-check:** pass/fail
**Tests:** pass/fail

### Key Files to Review

<list from explore agent>
```

### 6.1 Foundation Rule Design Validation

**Only for foundation rule types** (issues under #681 or tagged `automation-foundation`). Skip for other task types.

Before planning implementation, validate the schema design against ALL known dependents:

1. **List dependents** — read the issue's "Blocks" section AND search `rules-reference/` for features that need this rule type
2. **Write example JSON** — for each dependent, write the rule JSON as it would appear on the item
3. **Build a truth table** — for each example, list scenarios (attack types, item types, conditions) and whether the bonus/effect should fire or not
4. **Identify gaps** — any feature that can't be expressed naturally against the schema is a design gap that must be resolved before coding

Present the validation table to the user. If gaps exist, propose schema changes before proceeding.

**Example:**

| Feature | Rule JSON | Fires on melee weapon? | Fires on ranged weapon? | Fires on melee spell? | Fires on ranged spell? | Correct? |
|---------|-----------|----------------------|------------------------|---------------------|----------------------|----------|
| Reverberating Strikes | `{ delivery: 'melee', source: 'weapon' }` | Yes | No | No | No | Yes |
| Keen Eye | `{ delivery: 'ranged', source: 'weapon' }` | No | Yes | No | No | Yes |

### 7. Write Plan, Create task.md & Confirm

Based on codebase exploration (Step 5), design validation (Step 6.1 if applicable), and task context:

1. Formulate the plan covering: files to modify, approach per layer (model, document, UI), design decisions, and testing strategy
2. Present the plan to the user in the terminal
3. Create `task.md` in the project root:

```markdown
# Task: <#issue or branch-name>

## Task Details

- **Issue URL**: https://github.com/Nimble-Co/FoundryVTT-Nimble/issues/<number> (or "N/A")
- **Summary**: <task summary>
- **Acceptance Criteria**:
  - [ ] <criterion 1>
  - [ ] <criterion 2>

## Branch

- **Name**: <branch-name>
- **Base**: dev

## Status: PLANNING

<!-- Values: PLANNING | IMPLEMENTING | VERIFYING | CLEANING | TESTING | REVIEWING | SUBMITTING | IN_REVIEW | DONE -->

## Plan

<the formulated plan>

## Progress

- [ ] <step 1>
- [ ] <step 2>

## Key Files

<list from explore agent>

## Checkpoints

<!-- Updated by 03-verify-and-commit -->
```

> `task.md` is a local working file, not committed.

Then output and **STOP**:

```
Plan written to task.md. Review it, then run: /workflows:02-test-coverage
```

**CRITICAL — STOP HERE.** Do NOT auto-continue. The user reviews the plan, then invokes `/workflows:02-test-coverage` to start the TDD-first flow (which writes the red-phase tests, then auto-chains to `/workflows:03-implement` → `/workflows:04-cleanup-review-gate`).

## Notes

- Never force push or use destructive git commands
- If the user is already on a matching feature branch, skip branch creation
- Build warnings don't block preparation (they may be pre-existing)
