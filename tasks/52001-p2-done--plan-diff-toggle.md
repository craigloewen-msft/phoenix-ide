# Plan diff: show what changed since I last reviewed a plan

## Problem

`propose_task` parks an Explore conversation in `AwaitingTaskApproval` and the
`TaskApprovalReader` overlay renders `phase.plan` as markdown. When the user
annotates lines and hits **Request changes**, the state machine posts the
formatted notes as a user message and returns to `LlmRequesting`; the agent
revises the task file and calls `propose_task` again, which re-enters
`AwaitingTaskApproval` with a fresh plan and a freshly-mounted reader.

Every revision therefore arrives as an undifferentiated wall of markdown. The
reviewer has no way to see what the agent actually changed, or whether a
specific comment they left was addressed. The reader's local `notes` state is
discarded on unmount, so the previous round's comments are gone too.

## Outcome

On a *revised* plan (second and later `propose_task` in the same conversation),
the approval reader offers a **Plan diff** toggle. Toggled on, the same rendered
markdown gains inline change marks — word-level insertions and deletions —
relative to the plan version the user last reviewed, plus a change count and
next/previous-change navigation. Comments the user left on the previous version
are anchored next to the changed regions so "was my point addressed?" is
answerable at a glance. Toggled off, the reader looks exactly as it does today.

On a first proposal there is no baseline, so no toggle is shown.

## Design

### 1. Persist plan revisions (backend)

The baseline must survive reload, reconnect, and a different browser, so it is
server-side state, not reader-local memory. Per the schema rule, this is a child
collection and gets tables, not a JSON blob:

```sql
CREATE TABLE IF NOT EXISTS task_plan_revisions (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,   -- 1-based proposal number in this conversation
  task_file         TEXT NOT NULL,
  title             TEXT NOT NULL,
  priority          TEXT NOT NULL,
  plan              TEXT NOT NULL,
  proposed_at       TEXT NOT NULL,
  UNIQUE (conversation_id, ordinal)
);

CREATE TABLE IF NOT EXISTS task_plan_revision_notes (
  revision_id   TEXT NOT NULL REFERENCES task_plan_revisions(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,       -- order the note was added
  line_number   INTEGER NOT NULL,
  line_content  TEXT NOT NULL,
  note          TEXT NOT NULL,
  PRIMARY KEY (revision_id, ordinal)
);
```

- A revision row is written by the executor when the state machine enters
  `AwaitingTaskApproval` (alongside `PersistCheckpoint`/`PersistState`), via a
  new `Effect::RecordPlanRevision`. Keeping it an effect keeps `transition.rs`
  pure and keeps the write on the same path as the state persist.
- Note rows are written by `POST /api/conversations/:id/task-feedback`. The
  request gains a structured `notes: [{ line_number, line_content, note }]`
  field carrying the same notes the client already formats into `annotations`.
  `annotations` stays the authoritative LLM-bound prose (one consumer);
  `notes` is the structured review record used only for diff anchoring (a
  different consumer, non-overlapping contract — not a parallel representation
  of the same value, but if review disagrees, derive `annotations` from `notes`
  server-side instead and drop the string from the request).
- Rejection/approval do not write notes; unsent notes are, as today, discarded.

### 2. Surface the baseline on the wire

`ConvState::AwaitingTaskApproval` stays as-is — it is the state machine's
authority over the *current* proposal and must not accrete UI history. The
baseline is fetched by the reader instead:

`GET /api/conversations/:id/plan-revisions/baseline` → 200 with
`{ ordinal, plan, notes: [...] }` for the most recent *reviewed* revision
(the newest revision strictly older than the current one), or 204 when the
current proposal is the first. Typed request/response structs get
`#[derive(ts_rs::TS)]` + `export_to = "../ui/src/generated/"`; run
`./dev.py codegen`.

The reader fetches on mount when `phase.type === 'awaiting_task_approval'` and
renders the toggle only after a 200.

### 3. Inline diff rendering (UI)

New `ui/src/components/taskApproval/planDiff.ts`:

- Align previous vs current plan at the block level using the existing
  `buildMarkdownDisplayBlocks` projection (already used by the reader for Find),
  so block identity/line numbers stay consistent with annotation anchors.
- Classify each aligned pair as `unchanged` / `added` / `removed` / `changed`.
  For `changed`, compute a word-level LCS over the block's source tokens to get
  insert/delete runs.
- Pure, unit-testable module; no React. Tests cover: identical plans → zero
  changes; pure insertion; pure deletion; reordered sections; word-level marks
  inside a paragraph; code-fence bodies treated as opaque blocks.

New `PlanDiffOverlay` rendering rules inside `TaskApprovalReader`:

- Reading experience is preserved — still rendered markdown, not a patch view.
  Changed blocks get a left rail (green `+` / red `−` / amber `~`), inserted
  words get a green underline, deleted words a red strikethrough ghost.
- Unchanged blocks are dimmed while the toggle is on so the eye lands on change.
- Header gains `Plan diff` toggle (keyboard `d`), a `N changes` count, and
  `‹ ›` next/previous-change jump reusing the Find scroll/highlight plumbing.
- Prior-round notes render as a small marker on the block they were anchored to,
  with state derived structurally: `touched` when the anchored block is
  `added`/`changed`, `untouched` otherwise. Marker click opens the note text.
  This is a display of history, not a new annotation surface — prior notes are
  read-only and are never re-sent.
- Styling lives in the reader's colocated CSS (extend the existing
  `task-approval-*` block), not `index.css`.

### 4. Persistence of the toggle

Toggle default: **on** when a baseline exists and the current revision has
changes, so the value is visible without a hunt; the user's last explicit choice
is remembered per-browser in localStorage.

## Specs

- `specs/prose-feedback/requirements.md`: add REQ-PF-018 (plan revision diff in
  the task approval reader) and cross-reference from REQ-PF-015/016.
- `specs/bedrock/requirements.md`: note under REQ-BED-028 that entering
  `AwaitingTaskApproval` records a plan revision.
- Update `specs/prose-feedback/executive.md` verification coverage.
- No new ADR unless review changes the `notes`-on-the-wire decision above; if it
  does, record it in `specs/adrs/`.

## Test plan

- Rust: DDL/migration test for both tables; executor test that a second
  `propose_task` writes ordinal 2; handler tests for baseline 200/204 and for
  feedback persisting notes; state-machine tests unchanged (no state shape
  change).
- TS: `planDiff.test.ts` (cases above); `TaskApprovalReader.test.tsx` for toggle
  visibility (absent on first proposal), change count, dimming, note markers,
  and that toggling off restores the current rendering byte-for-byte.
- Manual: propose → comment → revise → confirm the diff highlights exactly the
  edited sections and that reload preserves the diff.

## Out of scope

- Raw unified-source-diff view of the plan (can be added later behind the same
  toggle group).
- Diffing across conversations or against the on-disk task file.
- Re-anchoring prior notes onto moved text; anchoring is block-level only.
