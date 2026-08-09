//! Git plumbing for the iterative review loop.
//!
//! Everything here is read-only with respect to the repository's index and
//! refs. Review state is content-addressed (blob SHAs) and persisted by
//! Phoenix, so the user's index stays available for the agent to stage and
//! commit with while a review is in progress.

use std::path::Path;

use super::{
    prepare_temp_index, run_git, run_git_capped, run_git_with_env, CappedStdout, TempPath,
};

/// Git's hash of the empty blob. Used as the checkpoint for a file the user
/// reviewed as deleted, so "reviewed as absent" is representable without a
/// nullable column.
pub(crate) const EMPTY_BLOB_SHA: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/// How a changed path differs from the review comparator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl ChangeStatus {
    fn from_git_code(code: &str) -> Self {
        match code.chars().next() {
            Some('A') => Self::Added,
            Some('D') => Self::Deleted,
            Some('R') => Self::Renamed,
            _ => Self::Modified,
        }
    }

    pub(crate) fn as_wire(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
        }
    }
}

/// One changed file as seen by the review surface, before review state is
/// joined on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChangedFile {
    pub path: String,
    pub status: ChangeStatus,
    pub insertions: u32,
    pub deletions: u32,
    /// Blob SHA of the file's current working-tree content, or
    /// [`EMPTY_BLOB_SHA`] when the file is deleted.
    pub current_blob_sha: String,
}

/// Resolves the ref the review diffs against.
///
/// Unlike the whole-branch diff, review deliberately prefers the *local* base
/// branch: the user is reviewing what the agent wrote relative to the branch
/// they will merge into locally, and `origin/<base>` can be arbitrarily stale
/// or ahead. The remote-tracking ref is used only when no local ref exists.
pub(crate) fn review_comparator(worktree: &Path, base_branch: &str) -> String {
    if crate::git_start::is_explicit_ref(base_branch) {
        return base_branch.to_string();
    }
    if rev_exists(worktree, base_branch) {
        return base_branch.to_string();
    }
    let remote = format!("origin/{base_branch}");
    if rev_exists(worktree, &remote) {
        tracing::debug!(
            base = %base_branch,
            "no local base ref for review; falling back to remote-tracking ref"
        );
        return remote;
    }
    base_branch.to_string()
}

fn rev_exists(worktree: &Path, rev: &str) -> bool {
    run_git(
        worktree,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )
    .is_ok()
}

/// Hashes the working-tree content of `path` and stores it in the object
/// database.
///
/// `-w` is required, not incidental: the since-review diff compares a
/// previously checkpointed blob against current content, so the checkpointed
/// bytes must still be retrievable on a later turn. Writing a loose object
/// touches neither the index nor any ref — it is invisible to `git status`
/// and to the agent's commits.
///
/// Returns [`EMPTY_BLOB_SHA`] when the file does not exist, which is how a
/// deletion is checkpointed.
pub(crate) fn current_blob_sha(worktree: &Path, path: &str) -> String {
    if !worktree.join(path).exists() {
        return EMPTY_BLOB_SHA.to_string();
    }
    run_git(worktree, &["hash-object", "-w", "--", path])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| EMPTY_BLOB_SHA.to_string())
}

/// Resolves the merge base between the comparator and the working tree.
///
/// Review diffs are taken against this commit rather than against the
/// comparator ref directly, so that base-branch commits the agent has not
/// merged in do not show up as the user's work to review.
fn merge_base(worktree: &Path, comparator: &str) -> String {
    run_git(worktree, &["merge-base", comparator, "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| comparator.to_string())
}

/// Sets up an isolated index with untracked files intent-added, so review
/// diffs include files the agent created but never staged.
///
/// Returns the guard alongside the `GIT_INDEX_FILE` value to pass to git.
/// `None` when isolation fails, in which case callers fall back to a
/// tracked-only view rather than risk mutating the user's real index.
fn temp_index_env(worktree: &Path) -> Option<(TempPath, String)> {
    let temp = prepare_temp_index(worktree)?;
    let path = temp.0.to_string_lossy().into_owned();
    let _ = run_git_with_env(
        worktree,
        &["add", "-N", "."],
        &[("GIT_INDEX_FILE", path.as_str())],
    );
    Some((temp, path))
}

/// Lists every file changed between `comparator` and the current working tree,
/// combining committed and uncommitted change.
///
/// Diffing against the merge-base commit with a two-dot range gives
/// merge-base-relative semantics *and* includes working-tree state — this is
/// the set of files the user must review, regardless of whether the agent has
/// committed them yet. Untracked files are intent-added into an isolated
/// index first so newly created files are reviewable.
pub(crate) fn list_changed_files(worktree: &Path, comparator: &str) -> Vec<ChangedFile> {
    let range = merge_base(worktree, comparator);
    let temp = temp_index_env(worktree);
    if temp.is_none() {
        tracing::debug!(
            worktree = %worktree.display(),
            "could not isolate git index — untracked files will be missing from the review manifest"
        );
    }
    let env: Vec<(&str, &str)> = temp
        .as_ref()
        .map(|(_, p)| vec![("GIT_INDEX_FILE", p.as_str())])
        .unwrap_or_default();

    let mut files: Vec<ChangedFile> = Vec::new();
    let name_status = run_git_with_env(
        worktree,
        &["diff", "--no-ext-diff", "--name-status", "-M", &range],
        &env,
    )
    .unwrap_or_default();

    for line in name_status.lines() {
        let mut parts = line.split('\t');
        let Some(code) = parts.next() else { continue };
        // A rename line is `R100\told\tnew`; the reviewable path is the new one.
        let Some(path) = parts.next_back() else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        files.push(ChangedFile {
            path: path.to_string(),
            status: ChangeStatus::from_git_code(code),
            insertions: 0,
            deletions: 0,
            current_blob_sha: current_blob_sha(worktree, path),
        });
    }

    let numstat = run_git_with_env(
        worktree,
        &["diff", "--no-ext-diff", "--numstat", "-M", &range],
        &env,
    )
    .unwrap_or_default();
    for line in numstat.lines() {
        let mut parts = line.split('\t');
        let (Some(ins), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next_back())
        else {
            continue;
        };
        if let Some(entry) = files.iter_mut().find(|f| f.path == path) {
            // Binary files report `-` for both counts; zero is the honest answer.
            entry.insertions = ins.parse().unwrap_or(0);
            entry.deletions = del.parse().unwrap_or(0);
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// Full diff of a single file against the review comparator, covering both
/// committed and uncommitted change.
pub(crate) fn file_diff_full(
    worktree: &Path,
    comparator: &str,
    path: &str,
    max_bytes: usize,
    hard_limit: u64,
) -> CappedStdout {
    let temp = temp_index_env(worktree);
    let env: Vec<(&str, &str)> = temp
        .as_ref()
        .map(|(_, p)| vec![("GIT_INDEX_FILE", p.as_str())])
        .unwrap_or_default();
    run_git_capped(
        worktree,
        &[
            "diff",
            "--no-ext-diff",
            &merge_base(worktree, comparator),
            "--",
            path,
        ],
        &env,
        max_bytes,
        hard_limit,
    )
    .unwrap_or_else(|_| empty_capture())
}

/// Diff of what changed in `path` since the user last marked it reviewed.
///
/// This is the iterative-review payload: it compares the checkpointed blob
/// against current content, so a re-review shows only what the agent did after
/// the previous pass.
pub(crate) fn file_diff_since_review(
    worktree: &Path,
    path: &str,
    reviewed_blob_sha: &str,
    max_bytes: usize,
    hard_limit: u64,
) -> CappedStdout {
    let current = current_blob_sha(worktree, path);
    if current == reviewed_blob_sha {
        return empty_capture();
    }

    // `git diff <blob> <blob>` renders without path context, so label the
    // sides with the real path for the UI's diff parser.
    run_git_capped(
        worktree,
        &[
            "diff",
            "--no-ext-diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            reviewed_blob_sha,
            &current,
        ],
        &[],
        max_bytes,
        hard_limit,
    )
    .map(|captured| relabel_blob_diff(&captured, path))
    .unwrap_or_else(|_| empty_capture())
}

/// Rewrites the header of a blob-to-blob diff so it names the file.
///
/// `git diff <sha> <sha>` emits `--- a/<sha>` / `+++ b/<sha>`, which carries no
/// path. The UI parser keys hunks by path, so without this the since-review
/// diff would render against a meaningless header.
///
/// Rewriting stops at the first hunk header. Past it every line is body, and a
/// removed line is its source text behind a `-` — so source beginning `-- `
/// (SQL, Lua, Haskell, Allium comments) reaches here as `--- ` and is
/// indistinguishable from a header by prefix alone. Only position separates the
/// two, so only position is trusted.
fn relabel_blob_diff(captured: &CappedStdout, path: &str) -> CappedStdout {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(captured.stdout.len() + 2 * path.len());
    let mut in_body = false;
    // Splitting on '\n' rather than `lines()` keeps a CRLF file's '\r' and makes
    // the presence of a final newline observable, so every line the rewrite does
    // not touch survives byte-for-byte.
    let mut lines = captured.stdout.split('\n').peekable();
    while let Some(line) = lines.next() {
        let is_last = lines.peek().is_none();
        if in_body {
            out.push_str(line);
        } else if line.starts_with("@@ ") {
            in_body = true;
            out.push_str(line);
        } else if line.starts_with("--- ") {
            let _ = write!(out, "--- a/{path}");
        } else if line.starts_with("+++ ") {
            let _ = write!(out, "+++ b/{path}");
        } else if line.starts_with("diff --git ") {
            let _ = write!(out, "diff --git a/{path} b/{path}");
        } else {
            out.push_str(line);
        }
        if !is_last {
            out.push('\n');
        }
    }
    // Rewriting changes the rendered length, so shift the byte total by the
    // same delta. Otherwise `total_bytes > stdout.len()` would read as
    // truncation and the UI would claim a complete diff was cut short.
    let total_bytes = captured
        .total_bytes
        .saturating_add(out.len() as u64)
        .saturating_sub(captured.stdout.len() as u64);
    CappedStdout {
        stdout: out,
        total_bytes,
        saturated: captured.saturated,
    }
}

fn empty_capture() -> CappedStdout {
    CappedStdout {
        stdout: String::new(),
        total_bytes: 0,
        saturated: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn init_repo(path: &Path) {
        run_git(path, &["init", "--quiet", "--initial-branch=main"]).unwrap();
        run_git(path, &["config", "user.email", "probe@test"]).unwrap();
        run_git(path, &["config", "user.name", "probe"]).unwrap();
    }

    fn commit_all(path: &Path, message: &str) {
        run_git(path, &["add", "."]).unwrap();
        run_git(path, &["commit", "-q", "-m", message]).unwrap();
    }

    fn write(dir: &Path, name: &str, contents: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
    }

    /// Sets up `main` with one committed file, then a feature branch that
    /// modifies it, adds a file, and deletes another.
    fn repo_with_branch_work() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        init_repo(p);
        write(p, "kept.txt", "original\n");
        write(p, "doomed.txt", "delete me\n");
        commit_all(p, "base");

        run_git(p, &["checkout", "-q", "-b", "feature"]).unwrap();
        write(p, "kept.txt", "changed\n");
        write(p, "added.txt", "brand new\n");
        std::fs::remove_file(p.join("doomed.txt")).unwrap();
        tmp
    }

    #[test]
    fn lists_changed_files_across_committed_and_uncommitted() {
        let tmp = repo_with_branch_work();
        let files = list_changed_files(tmp.path(), "main");

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["added.txt", "doomed.txt", "kept.txt"]);

        let by = |name: &str| files.iter().find(|f| f.path == name).unwrap().clone();
        assert_eq!(by("added.txt").status, ChangeStatus::Added);
        assert_eq!(by("doomed.txt").status, ChangeStatus::Deleted);
        assert_eq!(by("kept.txt").status, ChangeStatus::Modified);
        assert_eq!(by("kept.txt").insertions, 1);
        assert_eq!(by("kept.txt").deletions, 1);
        assert_eq!(
            by("doomed.txt").current_blob_sha,
            EMPTY_BLOB_SHA,
            "a deleted file checkpoints as the empty blob"
        );
    }

    #[test]
    fn changed_files_survive_the_agent_committing() {
        let tmp = repo_with_branch_work();
        let before = list_changed_files(tmp.path(), "main");
        commit_all(tmp.path(), "agent commits its work");
        let after = list_changed_files(tmp.path(), "main");

        assert_eq!(
            before, after,
            "the review manifest is comparator-relative, so committing must not change it"
        );
    }

    #[test]
    fn blob_sha_is_stable_across_commit_and_amend() {
        let tmp = repo_with_branch_work();
        let p = tmp.path();
        let reviewed = current_blob_sha(p, "kept.txt");

        commit_all(p, "commit");
        assert_eq!(current_blob_sha(p, "kept.txt"), reviewed, "commit");

        run_git(p, &["commit", "-q", "--amend", "-m", "amended"]).unwrap();
        assert_eq!(current_blob_sha(p, "kept.txt"), reviewed, "amend");

        run_git(p, &["rebase", "-q", "main"]).unwrap();
        assert_eq!(current_blob_sha(p, "kept.txt"), reviewed, "rebase");
    }

    #[test]
    fn since_review_diff_shows_only_post_checkpoint_change() {
        let tmp = repo_with_branch_work();
        let p = tmp.path();
        let reviewed = current_blob_sha(p, "kept.txt");

        // Agent revises the file after the user reviewed it.
        write(p, "kept.txt", "changed\nplus a new line\n");

        let diff = file_diff_since_review(p, "kept.txt", &reviewed, 64 * 1024, 512 * 1024);
        assert!(
            diff.stdout.contains("+plus a new line"),
            "post-review addition must appear: {}",
            diff.stdout
        );
        assert!(
            !diff.stdout.contains("-original"),
            "already-reviewed change must not reappear: {}",
            diff.stdout
        );
        assert!(
            diff.stdout.contains("a/kept.txt"),
            "blob diff must be relabelled with the real path: {}",
            diff.stdout
        );
    }

    #[test]
    fn since_review_diff_is_not_reported_as_truncated() {
        let tmp = repo_with_branch_work();
        let p = tmp.path();
        let reviewed = current_blob_sha(p, "kept.txt");
        write(p, "kept.txt", "changed\nplus a new line\n");

        let diff = file_diff_since_review(p, "kept.txt", &reviewed, 64 * 1024, 512 * 1024);
        assert!(!diff.saturated);
        assert!(
            diff.total_bytes <= diff.stdout.len() as u64,
            "a complete diff must not look truncated after header relabelling \
             (total {} vs rendered {})",
            diff.total_bytes,
            diff.stdout.len()
        );
    }

    #[test]
    fn since_review_diff_is_empty_when_untouched() {
        let tmp = repo_with_branch_work();
        let p = tmp.path();
        let reviewed = current_blob_sha(p, "kept.txt");
        let diff = file_diff_since_review(p, "kept.txt", &reviewed, 64 * 1024, 512 * 1024);
        assert!(diff.stdout.is_empty());
    }

    #[test]
    fn since_review_diff_preserves_body_lines_that_look_like_headers() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        init_repo(p);
        // Source whose comment syntax collides with a diff header prefix.
        write(
            p,
            "schema.sql",
            "-- volunteers own their agreement\nSELECT 1;\n",
        );
        commit_all(p, "base");
        let reviewed = current_blob_sha(p, "schema.sql");

        // After the user reviewed, the agent removes the `-- ` comment (which
        // renders as `--- `) and adds a `++ ` line (which renders as `+++ `).
        write(p, "schema.sql", "SELECT 1;\n++ still not a header\n");

        let diff = file_diff_since_review(p, "schema.sql", &reviewed, 64 * 1024, 512 * 1024);
        assert!(
            diff.stdout.contains("--- volunteers own their agreement"),
            "a removed `-- ` comment must survive header relabelling: {}",
            diff.stdout
        );
        assert!(
            diff.stdout.contains("+++ still not a header"),
            "an added `++ ` line must survive header relabelling: {}",
            diff.stdout
        );
        assert_eq!(
            diff.stdout
                .lines()
                .filter(|l| *l == "--- a/schema.sql")
                .count(),
            1,
            "exactly one old-file header: {}",
            diff.stdout
        );
        assert_eq!(
            diff.stdout
                .lines()
                .filter(|l| *l == "+++ b/schema.sql")
                .count(),
            1,
            "exactly one new-file header: {}",
            diff.stdout
        );
    }

    #[test]
    fn since_review_diff_keeps_crlf_line_endings() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        init_repo(p);
        // core.autocrlf off by default in a fresh repo, so the bytes round-trip.
        write(p, "win.txt", "first\r\nsecond\r\n");
        commit_all(p, "base");
        let reviewed = current_blob_sha(p, "win.txt");

        write(p, "win.txt", "first\r\nsecond\r\nthird\r\n");

        let diff = file_diff_since_review(p, "win.txt", &reviewed, 64 * 1024, 512 * 1024);
        assert!(
            diff.stdout.contains("+third\r\n"),
            "CRLF endings must survive relabelling: {:?}",
            diff.stdout
        );
    }

    #[test]
    fn full_file_diff_is_scoped_to_one_path() {
        let tmp = repo_with_branch_work();
        let diff = file_diff_full(tmp.path(), "main", "kept.txt", 64 * 1024, 512 * 1024);
        assert!(diff.stdout.contains("kept.txt"));
        assert!(
            !diff.stdout.contains("added.txt"),
            "other files must not leak into a per-file diff"
        );
    }

    #[test]
    fn review_plumbing_never_touches_the_index() {
        let tmp = repo_with_branch_work();
        let p = tmp.path();

        // The agent stages something mid-review.
        run_git(p, &["add", "added.txt"]).unwrap();
        let staged_before = run_git(p, &["diff", "--cached", "--name-only"]).unwrap();

        let files = list_changed_files(p, "main");
        for f in &files {
            let _ = current_blob_sha(p, &f.path);
            let _ = file_diff_full(p, "main", &f.path, 64 * 1024, 512 * 1024);
            let _ = file_diff_since_review(p, &f.path, EMPTY_BLOB_SHA, 64 * 1024, 512 * 1024);
        }

        let staged_after = run_git(p, &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(
            staged_before, staged_after,
            "review must leave the user's index exactly as the agent left it"
        );
    }

    #[test]
    fn comparator_prefers_the_local_base_branch() {
        let upstream = TempDir::new().unwrap();
        init_repo(upstream.path());
        write(upstream.path(), "f.txt", "x\n");
        commit_all(upstream.path(), "base");

        let clone = TempDir::new().unwrap();
        run_git(
            std::env::current_dir().unwrap().as_path(),
            &[
                "clone",
                "--quiet",
                upstream.path().to_str().unwrap(),
                clone.path().to_str().unwrap(),
            ],
        )
        .unwrap();

        // Both `main` and `origin/main` resolve here. Review must pick local.
        assert_eq!(review_comparator(clone.path(), "main"), "main");
    }

    #[test]
    fn comparator_falls_back_to_remote_when_no_local_ref() {
        let upstream = TempDir::new().unwrap();
        init_repo(upstream.path());
        write(upstream.path(), "f.txt", "x\n");
        commit_all(upstream.path(), "base");
        run_git(upstream.path(), &["branch", "release"]).unwrap();

        let clone = TempDir::new().unwrap();
        run_git(
            std::env::current_dir().unwrap().as_path(),
            &[
                "clone",
                "--quiet",
                upstream.path().to_str().unwrap(),
                clone.path().to_str().unwrap(),
            ],
        )
        .unwrap();

        // `release` exists only as a remote-tracking ref in the clone.
        assert_eq!(review_comparator(clone.path(), "release"), "origin/release");
    }
}
