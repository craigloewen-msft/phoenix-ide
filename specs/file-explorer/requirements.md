# File Explorer Panel

## User Story

As a desktop user, I need a persistent file tree panel alongside my conversations so that I can browse project files, quickly open them for review, and maintain context of the codebase while chatting with the agent.

## Requirements

### REQ-FE-001: Three-Column Desktop Layout

WHEN viewport is desktop-sized (> 1024px)
THE SYSTEM SHALL display a three-column layout:
  - Left: Conversation sidebar (per REQ-CONV-016)
  - Center: File explorer panel (hosts FileTree component)
  - Right: Main content area (conversation or prose reader)

WHEN viewport is below desktop threshold
THE SYSTEM SHALL hide the file explorer panel
AND display FileTree in a modal overlay when file browsing is triggered

**Rationale:** Desktop users have sufficient screen width for persistent file navigation alongside conversations. FileTree is a single responsive component hosted in different containers based on viewport.

---

### REQ-FE-002: File Tree Display

WHEN file explorer panel is visible
THE SYSTEM SHALL display a tree view of the current conversation's working directory
AND show folders and files with appropriate icons (per REQ-PF-004)
AND sort directories first, then files, alphabetically
AND allow expanding/collapsing directories inline

WHEN a directory is expanded
THE SYSTEM SHALL fetch and display its contents
AND persist expansion state for the current conversation

WHEN conversation changes
THE SYSTEM SHALL update the tree root to the new conversation's cwd
AND restore that conversation's saved expansion state (if any)

WHEN user expands or collapses a directory
THE SYSTEM SHALL persist expansion state per conversation
AND retain expansion state when switching between conversations

WHEN user requests a file-tree refresh
THE SYSTEM SHALL reload the tree root and every visible expanded directory
AND preserve the current directory expansion state
AND SHALL NOT reload descendants hidden beneath a collapsed directory

**Rationale:** The file tree reflects the conversation's project context. Expansion state helps users maintain their place when reviewing multiple files.

---

### REQ-FE-003: File Selection

WHEN user clicks a viewer-openable file in the file tree
THE SYSTEM SHALL open the file in the viewer
AND display the viewer in the main content area (replacing conversation view)
AND keep conversation sidebar and file explorer panel visible

WHEN user clicks a non-viewable file
THE SYSTEM SHALL show the file as disabled (not clickable)
AND indicate "Non-viewable file" via visual treatment

WHEN prose reader is open and user clicks the conversation in sidebar
THE SYSTEM SHALL close the prose reader
AND return to the conversation view

**Rationale:** Click-to-view is the simplest interaction. Keeping the sidebar and file tree visible maintains navigation context.

A file is *viewer-openable* exactly when the server classifies it as text or as an image — the same verdict that drives quick-open and linkified conversation paths, so a file's clickability never depends on which entry point reached it. Openability is a single typed classification carried on the listing entry, not re-derived per surface; only genuinely non-viewable content (binaries) is disabled. Text opens in the prose reader, images in the image preview.

---

### REQ-FE-004: Panel Collapse - Expanded State

WHEN file explorer panel is expanded
THE SYSTEM SHALL display the full file tree
AND show a collapse toggle button
AND use a fixed width (approximately 240-280px)

WHEN user clicks the collapse toggle
THE SYSTEM SHALL collapse the panel to its minimal state
AND persist collapse preference to localStorage

**Rationale:** Users may want to maximize main content area temporarily. Persistence respects user preference across sessions.

---

### REQ-FE-005: Panel Collapse - Collapsed State

WHEN file explorer panel is collapsed
THE SYSTEM SHALL display a narrow strip (approximately 48px)
AND show icons for recent files (last 3-5 files)
AND show an expand toggle button

WHEN user clicks a recent file icon in collapsed state
THE SYSTEM SHALL open that file in the prose reader
AND NOT expand the panel

WHEN user clicks the expand toggle
THE SYSTEM SHALL expand the panel to full tree view

WHEN user hovers over the collapsed panel
THE SYSTEM MAY show a temporary expanded preview (optional enhancement)

**Rationale:** Recent files provide quick access without requiring full panel expansion. This mirrors the conversation sidebar's collapsed state showing recent conversation indicators.

---

### REQ-FE-006: Recent Files Tracking

WHEN user opens a file in the prose reader
THE SYSTEM SHALL add that file to the recent files list
AND move it to the top if already present
AND limit the list to 5 most recent files

WHEN tracking recent files
THE SYSTEM SHALL store per-conversation
AND persist to localStorage
AND clear when conversation is deleted

**Rationale:** Recent files enable quick re-access to files being actively reviewed, especially useful in collapsed panel state.

---

### REQ-FE-007: Accordion Panel Behavior

WHEN both conversation sidebar and file explorer panel are present
THE SYSTEM SHALL allow each to be independently collapsed/expanded
AND persist each panel's state separately
AND ensure at least the main content area remains visible at all times

WHEN calculating panel widths
THE SYSTEM SHALL use fixed widths for sidebar and file explorer
AND give remaining width to main content area
AND enforce minimum main content width (approximately 400px)

**Rationale:** Independent panel control lets users optimize their workspace. Fixed panel widths provide predictable layout.

---

### REQ-FE-008: Prose Reader Integration

WHEN prose reader opens from file explorer click
THE SYSTEM SHALL render ProseReader component in the main content area
AND pass the selected file path and conversation's rootDir
AND provide a close/back mechanism to return to conversation

WHEN prose reader is displaying a file
THE SYSTEM SHALL highlight the corresponding file in the file tree
AND support all existing prose reader functionality (annotation, notes, send)

WHEN user sends notes from prose reader
THE SYSTEM SHALL inject notes into conversation input (per REQ-PF-009)
AND close the prose reader
AND return to conversation view

**Rationale:** File explorer is a navigation enhancement; prose reader functionality remains unchanged.

---

### REQ-FE-009: Visual Feedback

WHEN a file is open in prose reader
THE SYSTEM SHALL highlight it in the file tree with distinct styling

WHEN a file is in the recent files list
THE SYSTEM SHALL show a subtle indicator in the tree (optional)

WHEN loading directory contents
THE SYSTEM SHALL show inline loading indicator on the expanding folder

**Rationale:** Visual feedback keeps users oriented in the file tree.

---

### REQ-FE-010: Mobile File Browser Overlay

WHEN user triggers file browsing on mobile/tablet viewport
THE SYSTEM SHALL display a modal overlay hosting the FileTree component
AND show a header with current path and close button
AND allow dismissal via close button or backdrop tap

WHEN file is selected in the mobile overlay
THE SYSTEM SHALL open the prose reader (full-screen overlay)
AND close the file browser overlay

**Rationale:** Mobile uses modal overlay for focused file browsing. The same FileTree component renders in both desktop panel and mobile overlay contexts.

---

### REQ-FE-012: Live Git Status Grounding

WHEN a conversation working directory is a Git worktree
THE SYSTEM SHALL obtain a read-only, conversation-scoped status snapshot from the live checkout
AND preserve index and working-tree status as distinct typed values
AND represent modified, added, deleted, renamed, copied, type-changed, untracked, and unmerged paths without parsing ambiguity
AND exclude ignored paths from changed-path totals
AND SHALL NOT fetch remote state or mutate the index

WHEN the file tree displays a path present in the status snapshot
THE SYSTEM SHALL show a conventional compact Git decoration
AND expose the status in accessible text rather than color alone

WHEN changed paths exist beneath a displayed directory
THE SYSTEM SHALL decorate that directory with an aggregate changed-descendant count
EVEN IF the directory is collapsed or its children have not been loaded

WHEN Git status changes outside Phoenix
THE SYSTEM SHALL refresh the snapshot with the file tree's existing open, manual refresh, and visible-page refresh cycle
AND one refresh owner SHALL provide the snapshot to the summary and tree consumers
AND a stale or failed snapshot SHALL NOT be presented as clean

WHEN the desktop file explorer is expanded
THE SYSTEM SHALL show a compact Git grounding section with live checkout identity, changed-path count, and locally known upstream relationship
AND when the conversation mode supports workspace diffs, activating it SHALL open Workspace Diff

WHEN the mobile file browser overlay is open
THE SYSTEM SHALL show the same compact Git grounding summary in its header
AND activating it SHALL close the file browser and open Workspace Diff

WHEN the path is not a Git worktree or Git observation is unavailable
THE SYSTEM SHALL keep file browsing operational
AND show a neutral non-Git or unavailable state instead of a clean claim

**Rationale:** Inline decorations make worktree state visible at the point of file navigation, while Workspace Diff remains the single detailed review surface. Live checkout identity follows `specs/projects/requirements.md` REQ-PROJ-038.

---

### REQ-FE-011: File Tree Context Menu, Drag-and-Drop, and Keyboard Navigation

WHEN user right-clicks a text file in the file tree
THE SYSTEM SHALL display a context menu with actions:
  - Copy relative path (relative to the conversation's working directory)
  - Copy absolute path
  - Insert `@file` reference (include file contents at send time, per REQ-IR-001)
  - Insert `./path` reference (point the AI at the file without expansion, per REQ-IR-008)

WHEN user right-clicks a non-text file (image, binary) or a directory in the file tree
THE SYSTEM SHALL display a context menu with actions:
  - Copy relative path
  - Copy absolute path
  - Insert `./path` reference (per REQ-IR-008 — `@` expansion is text-only and rejects non-text files and directory paths)

AND shift-right-click SHALL defer to the native browser menu (escape hatch)

WHEN user drags a text file from the file tree to the message composer
THE SYSTEM SHALL insert an `@file` reference into the composer draft
AND activate the composer's drop highlight during the drag
AND NOT interfere with the existing OS file drag-and-drop (for attaching files from the desktop)

WHEN user drags a non-text file or a directory from the file tree to the message composer
THE SYSTEM SHALL insert a `./path` reference into the composer draft
(since `@` expansion is text-only, non-text files and directories use `./path` instead)
AND NOT interfere with the existing OS file drag-and-drop (for attaching files from the desktop)

WHEN a file tree item has keyboard focus
THE SYSTEM SHALL support the following keyboard navigation:
  - Arrow Down/Up: move focus between visible tree items
  - Enter/Space: open file or toggle directory expansion
  - Arrow Left: collapse an expanded directory, or move focus to parent
  - Arrow Right: expand a collapsed directory, or move focus to first child
  - Home/End: jump to first/last visible item
  - Escape: blur the tree
AND the file tree SHALL register as a focus scope (per `specs/keyboard-interaction/` REQ-KB-001) while it has keyboard focus, so navigation keys do not leak to the sidebar or other scopes

**Rationale:** A file browser without context menu, drag-and-drop, or keyboard navigation forces users to type `@path` references manually. These affordances reduce friction when referencing files in messages and make the tree usable without a mouse. The focus scope integration prevents key leak per the keyboard interaction model.

**Dependencies:** `specs/keyboard-interaction/` REQ-KB-001 through REQ-KB-008, `specs/inline-references/` REQ-IR-001, REQ-IR-008

---

### REQ-FE-013: Explicit Per-File Edit Mode

WHEN a viewer-openable file opens
THE SYSTEM SHALL display its content read-only
AND SHALL keep editing and deletion controls disarmed

WHEN the user enables edit mode for the open file
THE SYSTEM SHALL arm editing and deletion only for that file-viewer session
AND SHALL NOT persist the armed state in the viewer URL, browser storage, conversation state, or reconnect state

WHEN the file viewer closes, opens another file, changes conversation, or reloads
THE SYSTEM SHALL begin the resulting file-viewer session with edit mode disarmed

**Rationale:** Destructive capabilities require fresh, file-specific user intent rather than a preference that can remain active after context changes.

---

### REQ-FE-014: Explicit Text Save

WHEN edit mode is armed for a mutable UTF-8 text file
THE SYSTEM SHALL display a controlled source editor initialized from the loaded file content
AND SHALL allow normal text entry and indentation
AND SHALL expose Save only when the draft differs from the loaded baseline

WHEN the user saves a dirty draft against the loaded file version
THE SYSTEM SHALL atomically replace the file content
AND preserve the file's permissions
AND adopt the saved content and returned version as the clean viewer baseline
AND SHALL NOT stage, commit, or otherwise mutate Git state beyond the working-tree file change

WHEN edit mode is armed for an image
THE SYSTEM SHALL NOT expose a text editor or Save action

**Rationale:** Save is an explicit full-content replacement operation; the UI never implies that binary/image content can be edited as text.

---

### REQ-FE-015: Viewer-Only File Deletion

WHEN edit mode is armed for the open file
THE SYSTEM SHALL expose a Delete action in the file viewer
AND SHALL require an additional confirmation that names the file and states that deletion cannot be undone

WHEN the user confirms deletion against the loaded file version
THE SYSTEM SHALL delete exactly that file
AND close the invalidated viewer
AND disarm the file-edit session

WHEN the file tree or a directory is displayed
THE SYSTEM SHALL NOT expose file deletion in the tree context menu
AND SHALL NOT expose empty or recursive directory deletion

**Rationale:** Keeping deletion behind both an open-file context and a second confirmation minimizes accidental destructive actions.

---

### REQ-FE-016: Conversation-Scoped Mutation Authority

WHEN file content is loaded for an active conversation
THE SYSTEM SHALL derive the file root from the server-authoritative conversation environment
AND SHALL classify the result as mutable text, delete-only image, or read-only

WHEN a save or delete request is received
THE SYSTEM SHALL derive the root again from the conversation id
AND accept only a non-empty relative path to an existing regular-file descendant of that root
AND reject absolute paths, traversal components, directories, symbolic-link leaf targets, and targets that resolve outside the root
AND reject mutation when the conversation environment is read-only, archived, continued, retired, or absent

THE SYSTEM SHALL NOT use the cross-conversation preview/read allowlist or a client-supplied root as mutation authority

**Rationale:** Readability across viewer surfaces does not imply write authority; mutation belongs only to the live conversation environment named by the request.

---

### REQ-FE-017: Optimistic File-Mutation Concurrency

WHEN file content is loaded with mutation capability
THE SYSTEM SHALL return an opaque version derived from the complete current bytes

WHEN Save or Delete supplies a version that differs from the current file bytes
THE SYSTEM SHALL reject the mutation as a conflict
AND preserve the current filesystem content
AND keep the user's draft available
AND offer an explicit reload-latest recovery
AND SHALL NOT offer an implicit or force overwrite

WHEN reload-latest would replace a dirty draft
THE SYSTEM SHALL require explicit discard confirmation before replacing it

**Rationale:** Agents, terminals, Git operations, and other browser sessions can edit the same worktree; stale viewers must never silently overwrite newer work.

---

### REQ-FE-018: Dirty Draft Exit Protection

WHEN the open file has a dirty edit draft
AND the user requests viewer close, edit-mode disarm, file replacement, conversation navigation, or page unload
THE SYSTEM SHALL require an explicit discard decision before completing the transition
AND SHALL retain the draft when the user keeps editing

WHEN the draft is clean or edit mode is disarmed
THE SYSTEM SHALL complete the requested transition without a discard prompt

WHEN a save, delete, reload, or validation request fails
THE SYSTEM SHALL keep the file viewer open
AND preserve the draft and edit-mode state
AND expose an accessible error

**Rationale:** The safety gate must protect both filesystem content and unsaved user input.

---

### REQ-FE-019: Immediate Mutation Grounding

WHEN a file save succeeds
THE SYSTEM SHALL immediately refresh the owning visible file-tree listing, Git grounding, and review manifest
AND keep the viewer on the saved clean baseline

WHEN a file deletion succeeds
THE SYSTEM SHALL immediately close the deleted file's viewer
AND refresh the owning visible file-tree listing, Git grounding, and review manifest
AND SHALL NOT wait for the periodic file-tree refresh interval

**Rationale:** A successful mutation is user-visible truth; stale file and Git projections must not contradict it.
