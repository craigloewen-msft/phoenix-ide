Reading the transcript layout should not mutate it.

`synchronizedPhysicalSnapshot` in `ui/src/components/VirtualTranscript.tsx` is reached
through the read-only-looking `physicalSnapshot` / `measureOffsetForIndex` handle
methods (called from `MessageList.handleRangeChanged`). It calls `recompute(store)`,
which unconditionally bumps `store.revision` and rebuilds `store.range` as a new
object. Both are dependencies of the very layout effect that invokes
`onRangeChange`, so an accessor that only reads geometry guarantees that effect
re-fires on the next render while a positioning command is active.

It terminates today only because the positioning reducer bails out with the same
state object, so the loop dies one round later. That is a property of a different
module, not of this one -- a self-perpetuating trigger held in check by a remote
bail-out. The spurious `layoutRevision` increments can also confuse the positioning
state machine, which compares revisions to decide whether a measurement is stale.

Make the snapshot path genuinely read-only: recompute into a local result without
publishing revision/range changes, or split `recompute` into a pure geometry
computation plus an explicit commit step that only the mutating callers use.
