Review surfaces (whole-branch DiffView and per-file FileReviewDiffView) currently reconcile with edits made in another editor only on an explicit `R` press or when the browser window regains focus (specs/iterative-review REQ-RV-011). That covers the alt-tab workflow but still shows a stale diff for a user who edits on a second monitor while Phoenix stays visible.

Add real filesystem watching so the review surface updates when the file changes:

- A `notify` watcher scoped to the conversation worktree, started/stopped with the surface or the work scope (decide which; the worktree is the natural owner).
- Debounce and ignore rules (.git internals, node_modules, target/) so an agent build does not produce an event storm.
- A typed SSE event on the existing wire (see crates/phoenix-ide/src/api/wire.rs + ts-rs codegen), not a new polling endpoint.
- UI: replace `useRefreshOnWindowFocus` as the primary trigger, keeping `R` as the manual path.

Keep REQ-RV-011 as written -- it states the requirement in terms of reconciliation, not mechanism -- and update the iterative-review executive.md once the watcher replaces focus as the trigger.
