# User Guide — OpenSpec + Superpowers Workflow

This guide is for you, the human operator. Claude follows the rules in `CLAUDE.md`; this guide tells YOU what to type, when to make decisions, and what to expect at each stage.

---

## 1. Mental model

- **OpenSpec** owns the durable artifacts: `proposal.md` (what + why), `design.md` (how + why-this-way), `specs/<cap>/spec.md` (deltas), `tasks.md`. Each change lives at `openspec/changes/<name>/` until archived to `openspec/changes/archive/<YYYY-MM-DD>-<name>/`.
- **Superpowers** owns the runtime skills: brainstorming, TDD, debugging, code review, worktrees, verification, finishing.

OpenSpec = WHAT + WHY (durable). Superpowers = HOW (runtime).

---

## 2. The full lifecycle

```
  idea / request
       ↓
  Stage 0: pick entry point (3 branches)
       ↓
  Stage 1: brainstorm (if branch (a) or (b))
       ↓
  Stage 2: /opsx:propose <name>          ← Claude generates artifacts
       ↓
  Stage 3: review artifacts → approve
       ↓
  Stage 4: pre-apply staleness check
       ↓
  Stage 5: /opsx:apply <name>            ← worktree, TDD, advisor, code review
       ↓
  Stage 6: /opsx:archive <name>          ← in worktree, BEFORE merge
       ↓
  Stage 7: finishing-a-development-branch (merge / PR / cleanup)
```

---

## 3. Stage 0 — Pick your entry point

Three branches. Pick based on how resolved the request is:

| Situation | Action |
|---|---|
| Stub or unresolved architectural ambiguity (`proposal.md` marked stub, `## Open questions`, `Status: Stub`, embedded TBDs, OR open architectural questions) | **Brainstorm first** → `Use the brainstorming skill to resolve <topic>` |
| Clear requirements + visual decisions only | **Propose first**, then brainstorm-as-refinement → `/opsx:propose <description>` |
| Everything else (clear requirements, no UI, no architectural ambiguity — bug fix, simple refactor) | **Propose direct** → `/opsx:propose <description>` |

If unsure, default to brainstorm-first. Wasted brainstorming is cheaper than wasted artifact-rewrites.

---

## 4. Stage 1 — Brainstorming (conditional)

Brainstorming runs if Stage 0 picked branch (a) OR if it picked branch (b) (propose-first-with-UI). Claude invokes `superpowers:brainstorming` automatically; you don't trigger it manually unless using branch (a) before any artifacts exist.

What you'll see:

1. Claude reads the relevant code (context exploration).
2. If the upcoming questions are visual: Claude offers the Visual Companion in its own message. Reply `sure` (or decline). Companion runs at a `localhost:<port>` URL Claude provides.
3. Claude asks clarifying questions ONE AT A TIME:
   - Conceptual questions → terminal multi-choice
   - Visual questions → browser side-by-side mockups (click your pick)
4. Claude proposes 2–3 approaches with trade-offs and a recommendation.
5. Claude presents the design in sections (architecture, UX surfaces, edge cases, testing). Reply `looks good` or `change X` per section.
6. At the end, Claude either runs `/opsx:propose` (branch (a)) or rewrites the existing `design.md` (branch (b)).

What you type:
- Letters (`A`, `B`, `C`) for multi-choice
- Free text for "Other" / clarifications
- `looks good` / `change X to Y` for design-section approvals

---

## 5. Stage 2 — `/opsx:propose <description>`

What you type:
```
/opsx:propose <description-or-name>
```

What Claude does:
1. Creates `openspec/changes/<name>/` (or detects an existing stub).
2. Generates `proposal.md`, `design.md`, `specs/<cap>/spec.md` deltas, `tasks.md`.
3. Runs `openspec validate <name>` and reports green.

If branch (b) was picked at Stage 0, Claude THEN invokes brainstorming as a refinement step before Stage 3 to populate `design.md`'s `## Visual direction`.

---

## 6. Stage 3 — Review the artifacts

Open `openspec/changes/<name>/` and verify:

- **`proposal.md`** — Capabilities list matches what `specs/` contains. BREAKING markers explicit if breaking. `## What Changes` accurate.
- **`design.md`** — Decisions have alternatives + rationale (not just "we picked X"). For UI: `## Visual direction` filled with aesthetic / type / color / spacing / motion / accessibility. No defaults like Inter/purple-gradient/grid-of-cards.
- **`specs/`** — MODIFIED requirements include FULL updated content. Scenarios use exactly four hashtags (`####`).
- **`tasks.md`** — Each group small enough for one session. TDD ordering explicit. Long-running commands flagged for subagent + background.

Reply `looks good` or specific changes. Claude rewrites and re-validates.

---

## 7. Stage 4 — Pre-apply staleness check

Before Claude runs `/opsx:apply`, it spot-checks `design.md` against the current codebase: file paths, function names, architectural assumptions still match. If the codebase has shifted (different day from the brainstorming session, mid-session merge from main, sibling worktree landed), Claude either:
- Invokes `brainstorming` for parts needing re-resolution
- Edits `design.md` directly for purely-stale references (file moved, function renamed)

You don't type anything — Claude does this automatically. You'll see the staleness check happen before the worktree gets created.

---

## 8. Stage 5 — `/opsx:apply`

What you type:
```
/opsx:apply <change-name>
```

What happens:

1. **Worktree placement** — Claude asks: `in-place` (current checkout, blocks main) or `sibling` (at `.worktrees/<name>/`, parallel-friendly). Default sibling. Reply with one word.
2. **Clean baseline** — Claude verifies typecheck + full test suite green before any change.
3. **Advisor checkpoint #1** — Claude calls `advisor` to sanity-check the architectural approach before locking in.
4. **Per-task TDD loop** (for each task in `tasks.md`):
   - Subagent writes a failing test, watches it fail, writes minimum code to pass, runs test
   - Reports back; Claude reviews; checks the box
   - `requesting-code-review` skill runs at natural review checkpoints
   - **Critical issues block progression** (security vulnerability, contract break, test coverage regression, accessibility regression below WCAG AA, deviation from `design.md`)
   - **Defensible deviations** (implementation surfaced a flaw in the original decision) → Claude updates `design.md` `## Decisions` BEFORE continuing — never silent ship
5. **Advisor checkpoint #2** — Before declaring done, Claude calls `advisor` once more. Deliverable is durable BEFORE this call (commits in git, `tasks.md` updated).
6. **`verification-before-completion`** — full test suite + typecheck + lint. All green or it doesn't claim done.

What you do:
- One-word reply on worktree placement
- Watch for blockers Claude surfaces
- Answer ambiguities
- For runaway subagents: see Troubleshooting

---

## 9. Stage 5b — Context management during apply

Claude suggests `/compact` or `/clear` when triggers fire (whichever first):

- After every 3–5 completed tasks
- When Claude notices it's re-reading the same file 3+ times
- When a single task's tool output exceeds 50 lines AND that output is in git / `tasks.md`

Choose:
- `/compact` — preserves a summary; use when next task BUILDS on previous
- `/clear` — drops everything; use when next task is in a different folder with no shared identifiers
- **Neither** — if mid-debug or holding state only in chat, finish first

After compaction, Claude restates the current task from `tasks.md` + active `design.md` constraints in one short message before resuming. If you don't see this, ask `what's the current task?`.

---

## 10. Stage 6 — `/opsx:archive` (in the worktree, BEFORE merge)

Pre-archive checklist:
- All `tasks.md` checkboxes checked
- Full test suite passes (not just new tests)
- Feature exercised against a running system
- `openspec validate <name>` is green

What you type, in the worktree branch:
```
/opsx:archive <change-name>
```

What it does: moves `openspec/changes/<name>/` into `openspec/changes/archive/<YYYY-MM-DD>-<name>/` and folds spec deltas into `openspec/specs/<cap>/spec.md` so canonical specs reflect the new behavior.

If `openspec validate <name>` fails at archive time:
- Fix the violations in the worktree branch and re-run validate
- Never use any flag to skip validation
- Never edit `openspec/specs/` directly to make validate happy — fix the spec deltas in the change directory instead

**Critical**: NEVER merge an unarchived change. Archive first, then merge.

---

## 11. Stage 7 — Merge

What you type:
```
Use finishing-a-development-branch
```

Claude presents merge / PR / cleanup options based on your repo state. You pick.

---

## 12. Decision cheat sheet

| Situation | Your move |
|---|---|
| Vague idea or unresolved architectural questions | Brainstorm first |
| Stub with open questions | Brainstorm first |
| Clear feature, visuals open | `/opsx:propose` then visual brainstorm |
| Bug fix, one path | `/opsx:propose fix-<name>` direct |
| Pure UI polish | `/opsx:propose` + visual brainstorm |
| 3–5 tasks finished, next is related | `/compact` |
| 3–5 tasks finished, next is unrelated | `/clear` |
| Mid-debug | Neither — finish debug first |
| Need a second opinion | Tell Claude `call advisor` |
| All tasks checked off | `/opsx:archive` (in worktree) → merge |
| Validate fails at archive | Fix spec deltas in worktree, re-run validate; never skip |

---

## 13. What you'll type — quick reference

```
/opsx:propose <description>             # generate artifacts
/opsx:apply <change-name>               # start implementation
/opsx:archive <change-name>             # archive (in worktree, before merge)
/compact                                # preserve summary, drop noise
/clear                                  # drop everything for unrelated next task
Use the brainstorming skill to <topic>  # invoke brainstorm explicitly (branch (a))
Use finishing-a-development-branch      # merge / PR / cleanup
A / B / C                               # answer multi-choice
looks good / change X                   # approve design sections
in-place / sibling                      # worktree placement
sure / no thanks                        # accept/decline Visual Companion
```

---

## 14. What Claude does automatically

- Calls `advisor` at architectural commits and before declaring done
- Writes failing test BEFORE implementation (TDD)
- Throwaway exploratory code permitted (≤50 lines, never committed, deleted before TDD pass)
- Creates a worktree for every `/opsx:apply` (you only pick placement)
- Runs long commands in background subagents (`run_in_background: true`)
- Requests code review between tasks
- Keeps `tasks.md` checkboxes in sync
- Updates `design.md` whenever brainstorming or implementation surfaces a defensible flaw — never silent ship
- Restates the current task after any compaction
- Validates `openspec validate <name>` is green before claiming done
- Spot-checks `design.md` staleness before `/opsx:apply`

---

## 15. What you should NOT do

- **Never commit directly to `main`** — always work in a worktree branch
- **Never edit `openspec/specs/` directly** — only the OpenSpec lifecycle modifies them
- **Never merge before `/opsx:archive`** — archive in worktree first
- **Never let Claude add a dependency without justifying it in `design.md`**
- **Never compact mid-debug** — even if Claude suggests it
- **Never let brainstorming output land in `docs/plans/`** — must go to OpenSpec artifacts
- **Never skip a `requesting-code-review` checkpoint** — critical issues block for a reason
- **Never silently ship a deviation from `design.md`** — update `## Decisions` first

---

## 16. Common scenarios

### A. New feature with clear requirements + UI

> "Add a Download button to file rows in the file explorer."

```
You: /opsx:propose add-file-explorer-download-button
Claude: [generates artifacts, then visual brainstorm to pick icon + placement]
You: looks good
You: /opsx:apply add-file-explorer-download-button
Claude: in-place or sibling worktree?
You: sibling
[Claude works through tasks.md with TDD, advisor checkpoints, code review]
You: /opsx:archive add-file-explorer-download-button
You: Use finishing-a-development-branch
```

### B. Vague idea (brainstorm-first)

> "The file explorer feels slow with a lot of files. Make it better."

```
You: Use the brainstorming skill to think through file explorer performance
Claude: [explores code, asks: what counts as slow? virtualization vs pagination vs caching?]
You: [answer one at a time]
Claude: [proposes 3 approaches; you pick; presents design; you approve sections]
Claude: [runs /opsx:propose with resolved approach]
You: looks good
You: /opsx:apply <name>
```

### C. Stub promotion

> A stub at `openspec/changes/add-feature-x/proposal.md` exists with `## Open questions`.

```
You: Use the brainstorming skill to resolve the open questions in add-feature-x
Claude: [reads stub + relevant code; asks one question per open question]
You: [answer each]
Claude: [rewrites the stub artifacts: proposal.md, design.md, specs/, tasks.md]
You: looks good
You: /opsx:apply add-feature-x
```

### D. Bug fix (propose direct)

> "The Reconnect button doesn't dismiss its spinner when consent is cancelled."

```
You: /opsx:propose fix-reconnect-spinner-on-cancel
Claude: [generates artifacts; one task group; no brainstorm needed]
You: looks good
You: /opsx:apply fix-reconnect-spinner-on-cancel
[Claude writes failing test → fixes → green]
You: /opsx:archive fix-reconnect-spinner-on-cancel
You: Use finishing-a-development-branch
```

---

## 17. Troubleshooting

| Symptom | What to do |
|---|---|
| Brainstorming companion URL not loading | Check `http://localhost:<port>` (Claude reports the port). If the server died, ask Claude to restart. Session dir: `.superpowers/brainstorm/<sessionid>/`. |
| `openspec validate <name>` fails | Don't proceed to `/opsx:apply`. Tell Claude to fix the validation error and re-run. |
| `openspec validate <name>` fails at ARCHIVE | Fix spec deltas in the worktree, re-run validate. Never skip; never edit `openspec/specs/` directly. |
| Subagent runs forever (claude-code #11716) | Restart the Claude Code session. Tell Claude to re-run with explicit foreground timeout (`timeout: 300000`). |
| Claude wants to compact mid-debug | Say `no, finish the debug first`. Hard rule forbids mid-task compaction. |
| Claude skipped the advisor checkpoint | Ask: `did you call advisor before this commit?` If no, tell Claude to call advisor and reconsider. |
| `/opsx:apply` started before you approved | Cancel, review artifacts, approve, then re-run. |
| You spotted an unresolved decision in `design.md` | Don't proceed. Tell Claude to brainstorm the unresolved part. |
| Code review found a critical issue mid-task | Block on it. Don't move to the next task until resolved. |
| Implementation found a flaw in a `design.md` decision | Tell Claude to update `design.md` `## Decisions` BEFORE continuing — no silent shipping. |
| You want to merge before `/opsx:archive` | DON'T. Archive in worktree first. Hard rule. |

---

## 18. Glossary

- **Capability** — a top-level feature area (e.g., `file-explorer`, `fs-sync-service`). Each has one canonical `openspec/specs/<cap>/spec.md`.
- **Change** — a planned modification at `openspec/changes/<name>/` until archived.
- **Delta spec** — a `specs/<cap>/spec.md` inside a change directory listing `## ADDED Requirements` / `## MODIFIED Requirements` / `## REMOVED Requirements` / `## RENAMED Requirements`. Archive folds these into the canonical spec.
- **Stub** — a change with only `proposal.md` AND marked stub / `## Open questions` / `Status: Stub` / embedded TBDs. Not yet implementable.
- **Worktree** — a separate git working directory tied to a branch. Lets you work on a change without disturbing your main checkout.
- **Subagent** — a Claude-spawned helper task running in parallel/background for one task scope.
- **Visual Companion** — a browser-based mockup tool offered inside `brainstorming` for visual questions; not a standalone skill.
- **Advisor** — a stronger reviewer model with full transcript access. Called at architectural commits and before declaring done.

---

The short version: brainstorm-first when ambiguous, propose-first when clear, propose-direct when trivial; review artifacts; `/opsx:apply` with a worktree; archive in worktree before merging.
