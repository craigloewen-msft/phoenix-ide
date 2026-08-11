# File Explorer Panel - Executive Summary

## Requirements Summary

The File Explorer Panel provides persistent browsing and live Git grounding on desktop, while the mobile file overlay reuses the same tree. Users see the conversation's working directory with expandable folders, clickable files, compact Git decorations, and aggregate dirty counts on ancestor folders. A Git grounding summary shows the live checkout and changed-path count and opens the existing Workspace Diff surface. Mobile presents that summary in the file-browser header. File selection opens the file viewer inline on desktop and as an overlay on mobile. Eligible active-conversation files can be explicitly armed for per-file text editing or confirmed deletion; the safety gate never persists across file sessions.

## Technical Summary

`FileExplorerPanel` and `FileBrowserOverlay` share `FileTree`. A conversation-scoped endpoint captures bounded porcelain-v2 status without network access or index mutation, while the checkout model is shared with Workspace Diff. `FileTree` owns the existing visible-page refresh cadence and refreshes the Git snapshot through the same tick. Typed path states preserve index and worktree semantics; the UI derives one compact file badge and ancestor counts. Viewer-slot commands open Workspace Diff from desktop and mobile grounding summaries. Conversation-scoped content APIs derive their root from `Conversation::file_root`, return typed mutable/delete-only/read-only capability plus an opaque content version, and enforce optimistic concurrency. `FileViewer` keeps edit state ephemeral, and successful mutations fan out through `FileExplorerProvider` to immediately refresh tree, Git, and review projections.

## Status Summary

| Requirement | Status | Notes |
|-------------|--------|-------|
| **REQ-FE-001:** Three-Column Desktop Layout | ✅ Complete | Sidebar + FileExplorer + Main |
| **REQ-FE-002:** File Tree Display | ✅ Complete | Per-conversation expansion via atomic state |
| **REQ-FE-003:** File Selection | ✅ Complete | Opens ProseReader inline on desktop |
| **REQ-FE-004:** Panel Collapse - Expanded State | ✅ Complete | Toggle + localStorage persistence |
| **REQ-FE-005:** Panel Collapse - Collapsed State | ✅ Complete | Recent file icon strip |
| **REQ-FE-006:** Recent Files Tracking | ✅ Complete | Per-conversation, max 5, localStorage |
| **REQ-FE-007:** Accordion Panel Behavior | ✅ Complete | Independent collapse states |
| **REQ-FE-008:** Prose Reader Integration | ✅ Complete | Inline on desktop, overlay on mobile |
| **REQ-FE-009:** Visual Feedback | ✅ Complete | Active file highlight + loading spinners |
| **REQ-FE-010:** Mobile File Browser Overlay | ✅ Complete | FileBrowserOverlay hosts FileTree |
| **REQ-FE-011:** Context Menu, Drag-and-Drop, Keyboard Nav | ✅ Complete | FileTreeContextMenu + custom drag type + focus scope |
| **REQ-FE-012:** Live Git Status Grounding | ✅ Complete | Typed status snapshot, tree badges, ancestor counts, desktop/mobile summaries |
| **REQ-FE-013:** Explicit Per-File Edit Mode | ✅ Complete | Off by default; ephemeral to one open-file session |
| **REQ-FE-014:** Explicit Text Save | ✅ Complete | Controlled source editor; atomic versioned save preserves permissions |
| **REQ-FE-015:** Viewer-Only File Deletion | ✅ Complete | Armed viewer action plus named destructive confirmation; no directory/tree deletion |
| **REQ-FE-016:** Conversation-Scoped Mutation Authority | ✅ Complete | Server-derived root, relative regular-file targets, typed read-only capability |
| **REQ-FE-017:** Optimistic File-Mutation Concurrency | ✅ Complete | SHA-256 expected-version conflicts preserve newer bytes and user drafts |
| **REQ-FE-018:** Dirty Draft Exit Protection | ✅ Complete | Close/disarm/file/sidebar transitions and unload are guarded while dirty |
| **REQ-FE-019:** Immediate Mutation Grounding | ✅ Complete | File tree, Git status, and review manifest refresh after successful mutation |

**Progress:** 19 of 19 complete
