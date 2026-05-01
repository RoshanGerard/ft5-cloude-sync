# User Guide — OpenSpec + Superpowers Workflow

This guide is for you, the human operator. Claude follows the rules in `CLAUDE.md`; this guide tells YOU what to type, when to make decisions, and what to expect at each stage.

---

## 1. Mental model

- **OpenSpec** owns the durable artifacts: `proposal.md` (what + why), `design.md` (how + why-this-way), `specs/<cap>/spec.md` (deltas), `tasks.md`. Each change lives at `openspec/changes/<name>/` until archived to `openspec/changes/archive/<YYYY-MM-DD>-<name>/`.
- **Superpowers** owns the runtime skills: brainstorming, TDD, debugging, code review, worktrees, verification, finishing.

OpenSpec = WHAT + WHY (durable). Superpowers = HOW (runtime).

There are **two workflow shapes**:

- **Forward** (intent → propose → ship) — new features, planned changes. Walked through in §2–§12.
- **Reactive** (issue → fix → audit → optional back-fill) — bugs, regressions, perf / accessibility / refactor improvements to existing code. Walked through in §13.

Pick the shape that matches your starting point. If a "fix" turns out to be a missing feature, Claude flips you back to the forward shape.

---

## 2. The forward lifecycle

```
  idea / request
       ↓
  Stage 0: pick entry point (3 branches)
       ↓
  Stage 1: brainstorm (if Brainstorm-first or Propose-first-with-UI)
       ↓
  Stage 2: /opsx:propose <name>          ← Claude generates artifacts
       ↓
  Stage 3: review artifacts → approve
       ↓
  Stage 4: pre-apply staleness check
       ↓
  Stage 5: /opsx:apply <name>            ← worktree, TDD, advisor, code review
       ↓
  Stage 5c (optional): /opsx:sync <name> ← fold delta specs into main specs early
       ↓
  Stage 6: /opsx:archive <name>          ← in worktree, BEFORE merge
       ↓
  Stage 7: finishing-a-development-branch (merge / PR / cleanup)
```

For bugs / fixes / improvements, jump to §13 Reactive workflow.

---

## 3. Stage 0 — Pick your entry point

**First, ask: is this reactive?** A failing test, regression, perf fix, accessibility tweak, hotfix, or improvement to previously-shipped behavior → jump to §13. The three branches below are the **forward** path only.

Pick based on how resolved the request is:

| Situation | Branch | What you type |
|---|---|---|
| Stub or unresolved architectural ambiguity — `proposal.md` marked stub, `## Open questions`, `Status: Stub`, embedded TBDs, missing `## What Changes` body, no spec delta yet, no `tasks.md`, OR open architectural questions in the request | **Brainstorm-first** | `Use the brainstorming skill to resolve <topic>` |
| Clear requirements; only visual decisions remain | **Propose-first-with-UI** | `/opsx:propose <description>` (Claude then runs brainstorming as refinement) |
| Everything else — clear requirements, no UI, no architectural ambiguity | **Propose-direct** | `/opsx:propose <description>` |

If unsure, default to Brainstorm-first. Wasted brainstorming is cheaper than wasted artifact-rewrites.

---

## 4. Stage 1 — Brainstorming (conditional)

Brainstorming runs if Stage 0 picked **Brainstorm-first** OR **Propose-first-with-UI**. Claude invokes `superpowers:brainstorming` automatically; you only trigger it manually for Brainstorm-first before any artifacts exist.

What you'll see:

1. Claude reads the relevant code (context exploration).
2. If the upcoming questions are visual: Claude offers the Visual Companion in its own message. Reply `sure` (or decline). Companion runs at a `localhost:<port>` URL Claude provides.
3. Claude asks clarifying questions ONE AT A TIME:
   - Conceptual questions → terminal multi-choice
   - Visual questions → browser side-by-side mockups (click your pick)
4. Claude proposes 2–3 approaches with trade-offs and a recommendation.
5. Claude presents the design in sections (architecture, UX surfaces, edge cases, testing). Reply `looks good` or `change X` per section.
6. At the end, Claude either runs `/opsx:propose` (Brainstorm-first) or rewrites the existing `design.md` (Propose-first-with-UI).

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

For reactive back-fills (Pattern A / B — see §13), pass the settled `<change-id>` (kebab-case) directly instead of a free-text description.

What Claude does:
1. Creates `openspec/changes/<name>/` (or detects an existing stub).
2. Generates `proposal.md`, `design.md`, `specs/<cap>/spec.md` deltas, `tasks.md`.
3. Runs `openspec validate <name>` and reports green.

If Stage 0 picked Propose-first-with-UI, Claude THEN invokes brainstorming as a refinement step before Stage 3 to populate `design.md`'s `## Visual direction`.

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

## 10. Stage 5c — `/opsx:sync` (optional, mid-implementation)

`/opsx:sync` folds a change's delta specs into the canonical `openspec/specs/<cap>/spec.md` **without archiving the change**. It's an agent-driven intelligent merge: Claude reads each `## ADDED` / `## MODIFIED` / `## REMOVED` / `## RENAMED` block in `openspec/changes/<name>/specs/<cap>/spec.md` and applies it to the main spec, preserving content the delta doesn't mention.

**`/opsx:sync` is OFF by default.** It only appears as a slash command after you enable the `sync` workflow in your openspec profile — see §20.

### What you type

```
/opsx:sync                        # prompts you to pick which change
/opsx:sync <change-name>          # operates on that change directly
```

What Claude does:
1. Lists changes that have delta specs (`openspec list --json`) and asks you to pick (unless name was given).
2. For each capability under `openspec/changes/<name>/specs/`, reads the delta and the main spec.
3. Applies ADDED / MODIFIED / REMOVED / RENAMED blocks to the main spec, preserving unrelated existing content (partial scenario adds, etc.).
4. Creates a new `openspec/specs/<cap>/spec.md` if the capability is brand-new (Purpose marked TBD).
5. Reports per-capability what was added / modified / removed / renamed.

The operation is **idempotent** — running it twice produces the same result, so re-syncing after delta tweaks is safe.

### When to use it

- A second, in-flight change needs to read the merged main spec and you don't want to wait for the first change to fully implement + archive before downstream work can reference the new requirement.
- Long-running implementation where canonical specs should reflect the agreed contract early, so reviewers / other contributors aren't reading stale main-branch specs while implementation is still in progress.
- Drift check after implementation has surfaced design tweaks (folded back into delta specs) and you want to confirm the merged result on `openspec/specs/` before committing to archive.
- **Reactive Pattern A back-fills** (see §13) chain `propose → /opsx:sync → /opsx:archive` in one session.

### When NOT to use it

- **As a replacement for `/opsx:archive`.** Sync does NOT move the change out of `openspec/changes/<name>/`. The change remains active and you still must archive when implementation finishes — that's what dates the archive folder and removes the change from the active list.
- While delta specs are still in flux. You'll have to re-sync after every revision; wait until deltas have stabilised.
- For trivial changes that will archive within the same session — just go straight to archive (unless you're back-filling, in which case the propose → sync → archive chain is the standard Pattern A path).

### Why it exists

`/opsx:archive` does two things at once: it folds deltas into canonical specs AND moves the change into the dated archive directory. `/opsx:sync` is the first half on its own, for cases where main-spec truth needs to land ahead of archive readiness.

### Hard rule reminder

The "never edit `openspec/specs/` directly" rule still holds. `/opsx:sync` IS the OpenSpec lifecycle path for in-flight spec updates — it's an OpenSpec command, not a hand-edit. Don't reach for the canonical spec file even when sync is enabled; always go through the slash command (or `/opsx:archive`).

---

## 11. Stage 6 — `/opsx:archive` (in the worktree, BEFORE merge)

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

## 12. Stage 7 — Merge

What you type:
```
Use finishing-a-development-branch
```

Claude presents merge / PR / cleanup options based on your repo state. You pick. Before declaring the branch PR-ready, Claude runs the **pre-handoff backstop** (see §13) to catch any uncovered Outcome-3 commit on the branch.

---

## 13. Reactive workflow — bugs, fixes, improvements

The forward workflow (§2–§12) is for new features. Bugs, regressions, perf, accessibility, or refactors of existing code use a different shape: **investigate → fix → audit → optional back-fill**.

If during investigation you realise this is actually a missing feature rather than a defect, drop back to the forward workflow.

### Flow

1. **Investigate.** Claude uses `superpowers:systematic-debugging` for any failing test, unexpected behavior, or non-trivial issue. Skip the skill only for mechanical fixes (typo, comment, one-line semantic-preserving).
2. **Fix on a branch.** Claude writes a failing test that reproduces the bug, makes it green (Reactive TDD). Skip TDD only for mechanical fixes.
3. **Audit gate (mandatory).** Before declaring done, before committing, before handoff, Claude classifies the fix into ONE of three outcomes — see below.
4. **Act based on outcome:**
   - **Outcome 1** (no contract change) → plain commit, no OpenSpec.
   - **Outcome 2** (code wrong, spec right) → plain commit + spec citation in commit body.
   - **Outcome 3** (contract changed) → back-fill chain (Pattern A / B / C).
5. **Pre-handoff backstop** — before the branch is declared PR-ready (whether you ask Claude to open the PR or open it yourself), Claude audits every commit on the branch against the trigger checklist to catch any Outcome-3 commit that slipped through. Any uncovered Outcome-3 commit blocks the handoff until back-filled.

### Audit gate — three outcomes

| Outcome | What it means | Action |
|---|---|---|
| **1. No observable contract change** | Refactor, perf, doc, test, internal-only, or accessibility fix that's already inside WCAG AA | Plain commit, no OpenSpec |
| **2. Code wrong, spec right** | Fix restores behavior the spec already documents — code defect against an existing requirement | Plain commit + cite the restored requirement in the body (e.g. `Restores: openspec/specs/<cap>/spec.md → Requirement: <name>`) |
| **3. Contract changed** | Any trigger fires (see checklist below) | Back-fill required — Pattern A / B / C |

If you (or Claude) can't classify confidently, ask Claude to call advisor before deciding.

### Trigger checklist for Outcome 3

If ANY of these fires, the contract changed:

- New error code or coded response (any new value in a `code` / `error_code` field, e.g. `RATE_LIMITED`)
- New / changed HTTP status, response field, request field, or query param
- New default, clamp, or validation rule visible to a caller
- Scenario added / removed / renamed in the impacted capability
- Frontend↔backend vocabulary pin (enum keys, shared schema, label-to-code map)
- Previously-implicit invariant becoming load-bearing (a behavior previously assumed but never documented now becomes a hard rule)
- Removal of previously-documented behavior

### Three back-fill patterns

**Pattern A — Pure back-fill** (most common). The fix is **already shipped**; you're documenting the as-shipped contract.

```
You: /opsx:propose <change-id>
Claude: [proposal.md opens with "Implementation already shipped in commit <sha>",
         tasks.md is pre-checked, design.md captures the as-shipped contract,
         spec delta in ## ADDED / ## MODIFIED Requirements,
         calls advisor checkpoint A1 BEFORE drafting design.md]
You: looks good
Claude: [calls advisor checkpoint A2 BEFORE archive]
You: /opsx:sync <change-id>          # requires sync enabled — see §20
You: /opsx:archive <change-id>
```

For Pattern A, BOTH advisor checkpoints (before drafting `design.md`, and before `/opsx:archive`) are mandatory regardless of any earlier same-session advisor calls — back-fills drift from shipped reality more easily than forward proposals because nothing forces re-reading the actual diff.

`/opsx:apply` is **bypassed** for Pattern A (the implementation already shipped) — but the rest of the Coding discipline still applies: TDD + verification cover the fix commit (Step 2), code review runs between artifact drafts, and the audit gate covers spec coverage.

Multi-capability fixes bundle all spec deltas into ONE change.

**Pattern B — Forward proposal** — interim partial fix shipped; full contract still being designed.

Standard forward flow:
```
You: /opsx:propose <change-id>
You: looks good
You: /opsx:apply <change-id>         # finish the implementation
You: /opsx:sync <change-id>          # optional, see §10
You: /opsx:archive <change-id>
```

**Pattern C — Deferred back-fill** — emergency hotfix or release-branch fix where the full OpenSpec round-trip isn't feasible right now.

Allowed only if you:
- File a tracking ticket (`<TICKET_PREFIX>-*`)
- Set a deadline (default: before the next merge to `main`)

Cap: at most **ONE open deferred back-fill per branch**. A second one blocks merge until the first is back-filled. Owner = author of the fix.

### Hard rules specific to reactive

- Audit gate is mandatory even for fixes that "feel trivial." The 30-second checklist is cheaper than a missed contract change.
- Never ship an Outcome 2 fix without citing the restored requirement in the commit body — without the cite, the audit isn't auditable post-hoc.
- Never amend an archived change. A new back-fill is always a NEW change directory under `openspec/changes/`, even if the impacted requirement was originally added by an archived change.
- Never bundle the impl fix commit with the back-fill commits — keep the fix as one commit, and the OpenSpec proposal/sync/archive as its own commit chain.

---

## 14. Decision cheat sheet

| Situation | Your move |
|---|---|
| Vague idea or unresolved architectural questions | Brainstorm-first |
| Stub with open questions / TBDs / missing `## What Changes` / no spec delta / no `tasks.md` | Brainstorm-first |
| Clear feature, visuals open | Propose-first-with-UI: `/opsx:propose` then visual brainstorm |
| Clear feature, no UI, no architectural ambiguity | Propose-direct: `/opsx:propose <description>` |
| Pure UI polish | Propose-first-with-UI |
| Failing test / bug / regression | Reactive workflow (§13) — Claude investigates → fixes → audits → back-fills if needed |
| Hotfix needs to ship NOW, full OpenSpec round-trip impossible | Reactive Pattern C — file ticket + deadline, cap of one per branch |
| Fix already shipped, contract changed, need to back-fill | Reactive Pattern A — `/opsx:propose <change-id>` → review → `/opsx:sync` → `/opsx:archive` |
| Fix is internal-only / refactor / perf / already-AA accessibility | Reactive Outcome 1 — plain commit, no OpenSpec |
| Fix restores spec-documented behavior | Reactive Outcome 2 — plain commit + cite the restored requirement |
| 3–5 tasks finished, next is related | `/compact` |
| 3–5 tasks finished, next is unrelated | `/clear` |
| Mid-debug | Neither — finish debug first |
| Need a second opinion | Tell Claude `call advisor` |
| All tasks checked off | `/opsx:archive` (in worktree) → merge |
| Validate fails at archive | Fix spec deltas in worktree, re-run validate; never skip |
| Need merged main specs BEFORE archive (downstream change blocks on them, or Pattern A back-fill chain) | `/opsx:sync <change-name>` (requires `sync` enabled — see §20) |
| `/opsx:sync` slash command not present | Enable `sync` in your openspec profile (`openspec config profile` → custom) and re-run `openspec update` |

---

## 15. What you'll type — quick reference

```
/opsx:propose <description>             # generate artifacts (forward) OR
/opsx:propose <change-id>               # back-fill (reactive Pattern A or B)
/opsx:apply <change-name>               # start implementation (forward / Pattern B)
/opsx:sync <change-name>                # fold delta specs into main specs (no archive) — opt-in, see §20
/opsx:archive <change-name>             # archive (in worktree, before merge)
/compact                                # preserve summary, drop noise
/clear                                  # drop everything for unrelated next task
Use the brainstorming skill to <topic>  # invoke brainstorm explicitly (Brainstorm-first)
Use finishing-a-development-branch      # merge / PR / cleanup
A / B / C                               # answer multi-choice
looks good / change X                   # approve design sections
in-place / sibling                      # worktree placement
sure / no thanks                        # accept/decline Visual Companion
call advisor                            # ask Claude to escalate to advisor
```

---

## 16. What Claude does automatically

Forward and reactive both:

- Calls `advisor` at the two checkpoints (before locking architectural approach; before declaring done). For reactive **Pattern A back-fills**, BOTH checkpoints (before drafting `design.md`, before `/opsx:archive`) are **always mandatory** regardless of any earlier same-session advisor calls.
- Writes failing test BEFORE implementation (TDD); throwaway exploratory code permitted (≤50 lines, never committed, deleted before TDD pass)
- Runs long commands in background subagents (`run_in_background: true`)
- Requests code review between tasks; critical issues block progress
- Updates `design.md` whenever brainstorming or implementation surfaces a defensible flaw — never silent ship
- Validates `openspec validate <name>` is green before claiming done

Forward-specific:

- Creates a worktree for every `/opsx:apply` (you only pick placement)
- Keeps `tasks.md` checkboxes in sync
- Restates the current task after any compaction
- Spot-checks `design.md` staleness before `/opsx:apply`

Reactive-specific:

- Uses `superpowers:systematic-debugging` for any non-trivial issue
- Runs the **audit gate** before declaring done / committing / handoff and classifies into Outcome 1 / 2 / 3
- Cites the restored requirement in commit body for Outcome 2 fixes
- Runs the **pre-handoff backstop** before declaring the branch PR-ready (`git log <base>..HEAD --no-merges` audit against trigger checklist + cross-check `openspec/changes/` and recent archives on this branch)

---

## 17. What you should NOT do

- **Never commit directly to `main`** — always work in a worktree branch
- **Never edit `openspec/specs/` directly** — only the OpenSpec lifecycle (forward change OR reactive back-fill) modifies them
- **Never merge before `/opsx:archive`** — archive in worktree first
- **Never let Claude add a dependency without justifying it in `design.md`**
- **Never compact mid-debug** — even if Claude suggests it
- **Never let brainstorming output land in `docs/plans/`** — must go to OpenSpec artifacts
- **Never skip a `requesting-code-review` checkpoint** — critical issues block for a reason
- **Never silently ship a deviation from `design.md`** — update `## Decisions` first
- **Never treat `/opsx:sync` as a substitute for `/opsx:archive`** — sync only folds deltas; the change still needs to be archived once implementation is complete
- **Never skip the reactive audit gate** even for fixes that "feel trivial" — the 30-second checklist is cheaper than a missed contract change
- **Never ship an Outcome 2 fix without citing the restored requirement** in the commit body — without the cite, the audit isn't auditable post-hoc
- **Never amend an archived change** — a new back-fill is always a *new* change directory under `openspec/changes/`, even if the impacted requirement was originally added by an archived change
- **Never bundle the impl fix commit with the back-fill commits** — keep the fix as one commit, and the OpenSpec proposal/sync/archive as its own commit chain

---

## 18. Common scenarios

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

### B. Vague idea (Brainstorm-first)

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

### D. Bug fix — Outcome 1 (no contract change)

> "The Reconnect button has a stale CSS class that we no longer use."

```
You: The Reconnect button still has the .button-old class — clean it up.
Claude: [classifies as cosmetic refactor, runs the failing-test-where-applicable + fix loop,
         hits the audit gate → Outcome 1 (no observable contract change),
         commits the fix as a plain commit, no OpenSpec involved]
[Pre-handoff backstop runs at branch close-out — confirms no Outcome-3 commits]
You: Use finishing-a-development-branch
```

### E. Bug fix — Outcome 2 (code wrong, spec right)

> "The Reconnect button doesn't dismiss its spinner when consent is cancelled, but the spec already says it should."

```
You: Reconnect spinner sticks when the user cancels consent — fix it.
Claude: [systematic-debugging finds the missed cancel branch,
         writes a failing test, fixes, runs the audit gate → Outcome 2,
         commits with body:
         "fix(reconnect): dismiss spinner on consent-cancel
          Restores: openspec/specs/datasource-onboarding/spec.md → Requirement: Reconnect must clear pending state on cancel"]
You: Use finishing-a-development-branch
```

### F. Bug fix — Outcome 3 + Pattern A (contract changed; fix already shipped, back-fill the spec)

> "We shipped a hotfix that introduced a new `RATE_LIMITED` error code on the engine API. No spec delta yet."

```
You: /opsx:propose backfill-rate-limited-error-code
Claude: [creates change dir, drafts proposal.md opening with "Implementation already shipped in commit <sha>",
         pre-checks tasks.md, calls advisor checkpoint A1 to validate the as-shipped reading,
         drafts design.md from the actual diff, drafts ## ADDED Requirements spec delta]
You: looks good
Claude: [calls advisor checkpoint A2]
You: /opsx:sync backfill-rate-limited-error-code
You: /opsx:archive backfill-rate-limited-error-code
You: Use finishing-a-development-branch
```

### G. Bug fix — Outcome 3 + Pattern C (emergency hotfix, full back-fill deferred)

> Production is down; you need to ship a fix in the next 10 minutes.

```
You: Hotfix: <describe>. File ticket FT5-1234 to back-fill the spec, deadline before next merge to main.
Claude: [investigates, fixes with reactive TDD, commits the fix,
         records FT5-1234 + deadline, flags it as the one open Pattern C on this branch]
You: Use finishing-a-development-branch
[Pre-handoff backstop notes the open deferred back-fill — you (the owner) are responsible for resolving FT5-1234 before the next merge to main]
```

---

## 19. Troubleshooting

| Symptom | What to do |
|---|---|
| Brainstorming companion URL not loading | Check `http://localhost:<port>` (Claude reports the port). If the server died, ask Claude to restart. Session dir: `.superpowers/brainstorm/<sessionid>/`. |
| `openspec validate <name>` fails | Don't proceed to `/opsx:apply`. Tell Claude to fix the validation error and re-run. |
| `openspec validate <name>` fails at ARCHIVE | Fix spec deltas in the worktree, re-run validate. Never skip; never edit `openspec/specs/` directly. |
| Subagent runs forever (claude-code #11716) | Restart the Claude Code session. Tell Claude to re-run with explicit foreground timeout (`timeout: 300000`). |
| Claude wants to compact mid-debug | Say `no, finish the debug first`. Hard rule forbids mid-task compaction. |
| Claude skipped the advisor checkpoint | Ask: `did you call advisor before this commit?` If no, tell Claude to call advisor and reconsider. **Pattern A back-fills**: BOTH advisor checkpoints (before `design.md`, before archive) are mandatory regardless of session history. |
| `/opsx:apply` started before you approved | Cancel, review artifacts, approve, then re-run. |
| You spotted an unresolved decision in `design.md` | Don't proceed. Tell Claude to brainstorm the unresolved part. |
| Code review found a critical issue mid-task | Block on it. Don't move to the next task until resolved. |
| Implementation found a flaw in a `design.md` decision | Tell Claude to update `design.md` `## Decisions` BEFORE continuing — no silent shipping. |
| You want to merge before `/opsx:archive` | DON'T. Archive in worktree first. Hard rule. |
| `/opsx:sync` slash command isn't recognised | The `sync` workflow isn't enabled in your global openspec profile. See §20. |
| `/opsx:sync` ran but `openspec/specs/<cap>/spec.md` looks unchanged | Re-read Claude's summary — sync only touches capabilities that have a delta under `openspec/changes/<name>/specs/`. If a capability has no delta, it's untouched on purpose. |
| You want to undo a sync | Sync edits are in git. Revert the `openspec/specs/` changes via your normal git workflow. There's no `/opsx:unsync`. |
| Claude classified an audit gate as Outcome 1 but you suspect a contract change | Walk through the trigger checklist (§13) with Claude. If any trigger fires, it's Outcome 3 — back-fill needed. When in doubt, ask Claude to escalate to advisor. |
| You see a fix commit on the branch but no matching change directory | Audit it against the trigger checklist. If Outcome 3, back-fill via Pattern A *before* PR/merge. The pre-handoff backstop should have caught this — flag it. |
| Two open Pattern C deferred back-fills on the same branch | Hard cap is one. Resolve the older one (back-fill via Pattern A) before merging or starting another deferred fix. |
| Pattern A back-fill ran but Claude amended an existing archived change | Wrong. Revert. New back-fill = new change directory under `openspec/changes/`. Never amend an archive. |

---

## 20. Enabling `/opsx:sync` (and other optional workflows) via `openspec config profile`

`/opsx:sync` is an opt-in workflow. It's controlled by your **global** OpenSpec config — not by anything in this repo. The slash command file (`.claude/commands/opsx/sync.md`) is generated by `openspec update` only when `sync` is in the profile's `workflows` list.

### Where the global config lives

```
openspec config path                # prints the file location
```

Typical paths:
- Windows: `C:\Users\<you>\AppData\Roaming\openspec\config.json`
- macOS: `~/Library/Application Support/openspec/config.json`
- Linux: `~/.config/openspec/config.json`

### Inspect current state

```
openspec config list                # full settings dump
openspec config get profile         # current profile name (e.g. "core" or "custom")
openspec config get workflows       # array of enabled workflows
```

The default `core` profile enables `propose`, `explore`, `apply`, `archive` — no sync. Adding `sync` requires the `custom` profile.

### Add `sync` (interactive picker — recommended)

```
openspec config profile             # opens the interactive picker
```

Select `custom`, then check `sync` alongside the other workflows you want enabled. The CLI writes the new config and prompts you to run `openspec update` in any project that should pick up the change.

### Add `sync` (preset shortcut — limited)

```
openspec config profile core        # disables sync; restores defaults
openspec config profile custom      # NOT a valid shortcut — only "core" is exposed as a non-interactive preset
```

Custom profiles must be configured via the interactive picker or by editing the config file directly.

### Add `sync` (manual config edit)

If interactive prompts are blocked (CI, scripted setup), edit the global config file directly:

```jsonc
{
  "profile": "custom",
  "delivery": "both",
  "workflows": ["propose", "explore", "apply", "sync", "archive"],
  "featureFlags": {},
  "telemetry": { ... }
}
```

Then verify:
```
openspec config get workflows
# ["propose","explore","apply","sync","archive"]
openspec config get profile
# custom
```

### Apply to this project

After the profile changes, run **inside the project repo**:

```
openspec update
```

This regenerates `.claude/commands/opsx/`. After the update, you should see `sync.md` alongside `apply.md` / `archive.md` / `explore.md` / `propose.md`. Commit the new file (or any other changes `openspec update` produces) so collaborators get the same slash commands.

### Switching back

```
openspec config profile core        # disables sync (and any other custom workflows)
openspec update                     # regenerates slash commands without sync.md
```

Or set workflows manually back to `["propose","explore","apply","archive"]` and rerun `openspec update`.

### Caveat — global scope

Profile changes are global. Every project on this machine that uses OpenSpec inherits them. If you want `sync` available everywhere, leave the custom profile in place. If you only want it in one project, that's not currently expressible — pick the broadest workflow set you're comfortable with and accept that the slash command will be generated in every `openspec update`d project.

---

## 21. Glossary

- **Capability** — a top-level feature area (e.g., `file-explorer`, `fs-sync-service`). Each has one canonical `openspec/specs/<cap>/spec.md`.
- **Change** — a planned modification at `openspec/changes/<name>/` until archived.
- **Delta spec** — a `specs/<cap>/spec.md` inside a change directory listing `## ADDED Requirements` / `## MODIFIED Requirements` / `## REMOVED Requirements` / `## RENAMED Requirements`. Archive folds these into the canonical spec.
- **Stub** — a change in `openspec/changes/` whose `proposal.md` is incomplete: open questions, TBDs, missing `## What Changes` body, no spec delta yet, no `tasks.md`. Not yet implementable.
- **Worktree** — a separate git working directory tied to a branch. Lets you work on a change without disturbing your main checkout.
- **Subagent** — a Claude-spawned helper task running in parallel/background for one task scope.
- **Visual Companion** — a browser-based mockup tool offered inside `brainstorming` for visual questions; not a standalone skill.
- **Advisor** — a stronger reviewer model with full transcript access. Called at architectural commits and before declaring done. For reactive Pattern A back-fills, the two checkpoints are always mandatory regardless of session history.
- **Sync (`/opsx:sync`)** — optional, opt-in OpenSpec lifecycle command that folds a change's delta specs into the canonical `openspec/specs/` files **without archiving the change**. Useful when downstream work needs to read the merged main spec before this change is fully implemented, and as the middle step in a Pattern A back-fill chain. Off by default — enable via the `custom` openspec profile (see §20). Idempotent.
- **Profile (openspec config)** — global OpenSpec setting that decides which workflows produce slash commands. `core` (default) gives `propose / explore / apply / archive`. `custom` lets you add extras like `sync`. Configured via `openspec config profile`.
- **Forward workflow** — intent → propose → ship. New features, planned changes. §2–§12.
- **Reactive workflow** — issue → fix → audit → optional back-fill. Bugs, regressions, perf, accessibility, refactor of existing code. §13.
- **Audit gate** — mandatory classification step in the reactive workflow that decides between Outcome 1 (no contract change), Outcome 2 (code wrong / spec right), Outcome 3 (contract changed → back-fill required). Runs before declaring done, before committing, before handoff.
- **Trigger checklist** — the seven contract-change indicators that promote a fix to Outcome 3 (new error code, changed status / field / param, new default-clamp-validation, scenario added/removed/renamed, frontend↔backend vocab pin, previously-implicit invariant becoming load-bearing, removal of documented behavior).
- **Pattern A — Pure back-fill** — the most common reactive back-fill. Implementation already shipped; you document the as-shipped contract via `propose → /opsx:sync → /opsx:archive` in one session. Both advisor checkpoints mandatory.
- **Pattern B — Forward proposal** — interim partial fix shipped; full contract still being designed. Standard forward flow follows.
- **Pattern C — Deferred back-fill** — emergency hotfix where the OpenSpec round-trip can't happen now. Requires a tracking ticket + deadline. Cap of one open per branch.
- **Pre-handoff backstop** — sweep that runs before the branch is declared PR-ready: `git log <base>..HEAD --no-merges` audited against the trigger checklist, cross-checked against `openspec/changes/` (active) and recent `openspec/changes/archive/` entries on this branch. Any uncovered Outcome-3 commit blocks the handoff.

---

The short version: forward workflow for new features (Brainstorm-first when ambiguous, Propose-first-with-UI when only visuals are open, Propose-direct when trivially clear); reactive workflow for bugs and improvements (investigate → fix → audit → back-fill if the contract changed); always archive in the worktree before merging.
