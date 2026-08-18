#![allow(clippy::wildcard_enum_match_arm)]
//! Message expansion layer for inline references (REQ-IR-001 through REQ-IR-007)
//!
//! Resolves `@path/to/file` and `/skill-name` tokens in user messages before they
//! reach the LLM, producing a `display_text` (stored in DB, shown in history) and
//! an `llm_text` (delivered to the model with file/skill contents injected).
//!
//! Path (`./`) references are not expanded here — they are autocomplete-only (Task 572).

use crate::resolution_root::{FileResolution, ResolutionRoot};
use crate::system_prompt::discover_skills;

/// The result of expanding a user message.
///
/// `display_text` is the original shorthand typed by the user — it is what gets
/// stored in the DB and shown in conversation history.  `llm_text` is the fully
/// resolved form delivered to the model.
#[derive(Debug, Clone)]
pub struct ExpandedMessage {
    /// Original user text — stored and displayed (REQ-IR-006)
    pub display_text: String,
    /// Fully resolved text delivered to the LLM (REQ-IR-001)
    pub llm_text: String,
    /// If the message triggered a skill invocation, this contains the details.
    /// The chat handler uses this to persist as `MessageContent::Skill` instead
    /// of `MessageContent::User`.
    pub skill_invocation: Option<crate::skills::SkillInvocation>,
}

/// Errors produced during expansion (REQ-IR-007)
#[derive(Debug, Clone, PartialEq)]
pub enum ExpansionError {
    /// `@` reference points to a file that does not exist or cannot be read
    FileNotFound { path: String },
    /// `@` reference points to a binary file
    FileNotText { path: String },
    /// Skill was found but invocation failed (e.g., file read error)
    SkillInvocationFailed { name: String, error: String },
}

impl std::fmt::Display for ExpansionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FileNotFound { path } => write!(f, "File not found: {path}"),
            Self::FileNotText { path } => {
                write!(f, "File is binary and cannot be included: {path}")
            }
            Self::SkillInvocationFailed { name, error } => {
                write!(f, "Skill '{name}' failed: {error}")
            }
        }
    }
}

impl ExpansionError {
    /// Short machine-readable type string for the frontend
    pub fn error_type(&self) -> &'static str {
        match self {
            Self::FileNotFound { .. } => "file_not_found",
            Self::FileNotText { .. } => "file_not_text",
            Self::SkillInvocationFailed { .. } => "skill_invocation_failed",
        }
    }

    /// The reference token that caused the error (`@path` or `/skill-name`)
    pub fn reference(&self) -> String {
        match self {
            Self::FileNotFound { path } | Self::FileNotText { path } => format!("@{path}"),
            Self::SkillInvocationFailed { name, .. } => format!("/{name}"),
        }
    }
}

/// A reference found in user text (e.g., `@src/main.rs` or `/build`).
#[derive(Debug, Clone, PartialEq)]
struct InlineReference {
    /// The sigil character (`'@'`, `'/'`)
    sigil: char,
    /// The token after the sigil (e.g., `"src/main.rs"`, `"build"`)
    token: String,
    /// Byte range in the original text (sigil + token)
    span: std::ops::Range<usize>,
}

/// Sorted, non-overlapping byte ranges covering markdown code regions in
/// `text` — fenced code blocks, indented code blocks, and inline code spans.
/// Used by the tokenizer to skip sigils that fall inside code, so a user
/// pasting a stack trace with `@src/main.rs:42` inside a fence doesn't
/// trigger file expansion.
///
/// Unclosed fences: `pulldown-cmark` auto-closes at EOF, which here means
/// the masked range extends to the end of `text` — conservative by design
/// (any `@` after an unterminated triple-backtick fence is treated as code,
/// not prose).
fn masked_code_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};

    let mut ranges: Vec<std::ops::Range<usize>> = Vec::new();
    let mut block_start: Option<usize> = None;

    for (event, range) in Parser::new(text).into_offset_iter() {
        match event {
            Event::Code(_) => ranges.push(range),
            Event::Start(Tag::CodeBlock(_)) => {
                if block_start.is_none() {
                    block_start = Some(range.start);
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(start) = block_start.take() {
                    ranges.push(start..range.end);
                }
            }
            _ => {}
        }
    }

    ranges.sort_by_key(|r| r.start);
    let mut merged: Vec<std::ops::Range<usize>> = Vec::with_capacity(ranges.len());
    for r in ranges {
        if let Some(last) = merged.last_mut() {
            if r.start <= last.end {
                last.end = last.end.max(r.end);
                continue;
            }
        }
        merged.push(r);
    }
    merged
}

/// Returns `true` if byte position `pos` falls inside any of the
/// (sorted, non-overlapping) `ranges`. O(log n).
fn position_in_ranges(pos: usize, ranges: &[std::ops::Range<usize>]) -> bool {
    ranges
        .binary_search_by(|r| {
            if pos < r.start {
                std::cmp::Ordering::Greater
            } else if pos >= r.end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// Scan `text` for inline references. A reference is a sigil character followed by
/// a non-empty token (runs until whitespace or end of string).
///
/// The sigil must be at the start of the text or preceded by whitespace.
/// This prevents matching email addresses (`user@domain`), embedded paths
/// (`foo/bar` when `/` is a sigil), etc.
///
/// Sigils inside markdown code regions (fenced, indented, inline backticks)
/// are skipped — see `masked_code_ranges`. Invariant: `NoExpansionInsideCode`
/// in `specs/inline-references/inline-references.allium`.
fn tokenize_references(text: &str, sigils: &[char]) -> Vec<InlineReference> {
    let masked = masked_code_ranges(text);
    let mut refs = Vec::new();

    for (i, ch) in text.char_indices() {
        if !sigils.contains(&ch) {
            continue;
        }

        // Must be at start of text or preceded by whitespace.
        if i > 0 {
            // Safety: `i` is from `char_indices()` on `text`, so it is a valid
            // char boundary. Slicing `text[..i]` is safe.
            #[allow(clippy::string_slice)]
            let prev_char = text[..i].chars().next_back().unwrap_or(ch);
            if !prev_char.is_whitespace() {
                continue;
            }
        }

        if position_in_ranges(i, &masked) {
            continue;
        }

        // Collect the token after the sigil.
        let token_start = i + ch.len_utf8();
        let mut token_end = token_start;
        // Safety: `token_start` is `i + ch.len_utf8()` where `i` is from
        // `char_indices()` on `text` and `ch` is the char at that index, so
        // `token_start` is a valid UTF-8 boundary. `token_end` is computed
        // from `char_indices()` on the same `text` slice.
        #[allow(clippy::string_slice)]
        for (j, c) in text[token_start..].char_indices() {
            if c.is_whitespace() {
                break;
            }
            token_end = token_start + j + c.len_utf8();
        }

        // Safety: `token_start` and `token_end` are from `char_indices()` on `text`.
        #[allow(clippy::string_slice)]
        let token = &text[token_start..token_end];
        if !token.is_empty() {
            refs.push(InlineReference {
                sigil: ch,
                token: token.to_string(),
                span: i..token_end,
            });
        }
    }

    refs
}

/// Known file extensions that indicate an @ token is an intentional file reference.
/// A token like @AGENTS.md is a file reference; @username is not.
const PATH_LIKE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "md", "json", "yaml", "yml", "toml", "txt", "css",
    "scss", "html", "htm", "sh", "bash", "sql", "xml", "allium", "cfg", "conf", "env", "lock",
    "mod", "sum", "c", "h", "cpp", "hpp", "java", "kt", "swift", "rb", "php", "ex", "exs", "hs",
    "ml", "zig", "scala", "proto", "graphql", "vue", "svelte", "csv", "log",
];

/// Determine whether a token after @ looks like an intentional file path reference.
/// Path references must have a path-token shape before slash/extension heuristics apply.
fn looks_like_file_path(token: &str) -> bool {
    if !has_path_token_shape(token) {
        return false;
    }

    if token.contains('/') {
        return true;
    }

    if let Some(ext) = token.rsplit('.').next() {
        if ext != token {
            let ext = ext.to_ascii_lowercase();
            return PATH_LIKE_EXTENSIONS.contains(&ext.as_str());
        }
    }

    false
}

fn has_path_token_shape(token: &str) -> bool {
    if token.is_empty() || token.contains("//") {
        return false;
    }

    if !token.chars().all(is_path_token_char) {
        return false;
    }

    if token.ends_with('/')
        || token.ends_with('.')
        || token.ends_with(',')
        || token.ends_with('\'')
        || token.ends_with(':')
        || token.ends_with('!')
    {
        return false;
    }

    if token.starts_with('/') {
        return token
            .split('/')
            .skip(1)
            .all(|component| !component.is_empty() && path_component_has_valid_groups(component));
    }

    token
        .split('/')
        .all(|component| !component.is_empty() && path_component_has_valid_groups(component))
}

fn path_component_has_valid_groups(component: &str) -> bool {
    let mut stack = Vec::new();
    let mut previous_open = None;

    for c in component.chars() {
        match c {
            '(' | '[' => stack.push(c),
            ')' => {
                if stack.last() != Some(&'(') || previous_open == Some('(') {
                    return false;
                }
                stack.pop();
            }
            ']' => {
                if stack.last() != Some(&'[') || previous_open == Some('[') {
                    return false;
                }
                stack.pop();
            }
            _ => {}
        }
        previous_open = matches!(c, '(' | '[').then_some(c);
    }

    stack.is_empty()
}

fn is_path_token_char(c: char) -> bool {
    !c.is_control()
        && !matches!(
            c,
            '"' | '`' | ';' | '<' | '>' | '{' | '}' | '\\' | '|' | '?'
        )
}

/// Expand all inline references in `text` against `root`.
///
/// Tokenizes the ORIGINAL text once for both `@` and `/` sigils, then:
/// 1. Checks for skill invocations (`/` sigil, validated against discovered skills).
///    Skill expansion replaces the entire message, so it takes priority and file
///    references in the original text are not expanded.
/// 2. If no skill matched, expands `@file` references by inlining file contents.
///
/// Tokenizing the original text (not skill-expanded text) prevents skill output
/// from accidentally introducing `@` tokens that trigger file expansion.
///
/// `root` is the conversation's [`ResolutionRoot`] — the same value the
/// composer's autocomplete discovered candidates against, so a reference that
/// autocompleted will resolve here.
///
/// Returns `Ok(ExpandedMessage)` when all references resolve successfully.
/// Returns the first `Err(ExpansionError)` encountered when any reference fails.
pub fn expand(text: &str, root: &ResolutionRoot) -> Result<ExpandedMessage, ExpansionError> {
    let refs = tokenize_references(text, &['/', '@']);

    // --- Skill expansion (REQ-IR-002, REQ-IR-003) ----------------------------
    // Check for skill invocation first. Skill expansion replaces the entire
    // message, so it takes priority over file references.
    if let Some(skill_ref) = refs.iter().find(|r| r.sigil == '/') {
        // `skills_view` materializes a branch's committed `SKILL.md` files for a
        // GitTree root; keep it alive through `invoke_skill`, which reads them
        // back from the same paths.
        let skills_view = root.skills_view();
        let skills = discover_skills(&skills_view.dir);
        if skills.iter().any(|s| s.name == skill_ref.token) {
            // Safety: `skill_ref.span.end` is produced by the tokenizer from
            // `char_indices()` on `text`, so it is always a valid UTF-8
            // boundary.
            #[allow(clippy::string_slice)]
            let arguments = text[skill_ref.span.end..].trim_start();
            match crate::skills::invoke_skill(&skill_ref.token, arguments, &skills) {
                Ok(invocation) => {
                    return Ok(ExpandedMessage {
                        display_text: text.to_string(),
                        llm_text: invocation.body.clone(),
                        skill_invocation: Some(invocation),
                    });
                }
                Err(e) => {
                    return Err(ExpansionError::SkillInvocationFailed {
                        name: skill_ref.token.clone(),
                        error: e,
                    });
                }
            }
        }
    }

    // --- File reference expansion (REQ-IR-001, REQ-IR-007) ---------------------
    // Collect (span, replacement) for each resolvable `@reference`, then splice
    // them into the original text by span in reverse order. Splicing by the
    // tokenizer's recorded spans — rather than a global string replace — means
    // only the occurrences the tokenizer accepted are expanded: an identical
    // literal sitting inside a masked code region (which the tokenizer skipped)
    // is left untouched (`NoExpansionInsideCode`).
    let mut replacements: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    for file_ref in refs.iter().filter(|r| r.sigil == '@') {
        // ClassifyAtReference: only treat path-like tokens as file references.
        // Bare words (@username, @param) pass through as literal text.
        if !looks_like_file_path(&file_ref.token) {
            continue;
        }

        let file_text = match root.read_file(&file_ref.token) {
            FileResolution::Text(text) => text,
            FileResolution::Binary => {
                return Err(ExpansionError::FileNotText {
                    path: file_ref.token.clone(),
                });
            }
            FileResolution::NotFound => {
                return Err(ExpansionError::FileNotFound {
                    path: file_ref.token.clone(),
                });
            }
        };

        let block = format!("<file path=\"{}\">\n{file_text}\n</file>", file_ref.token);
        replacements.push((file_ref.span.clone(), block));
    }

    let mut llm_text = text.to_string();
    // Reverse so each splice leaves earlier spans' byte offsets valid.
    for (span, block) in replacements.into_iter().rev() {
        llm_text.replace_range(span, &block);
    }

    Ok(ExpandedMessage {
        display_text: text.to_string(),
        llm_text,
        skill_invocation: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    /// Wrap a temp dir as a working-directory resolution root for tests.
    fn root(dir: &Path) -> ResolutionRoot {
        ResolutionRoot::working_dir(dir)
    }

    fn make_tmp() -> TempDir {
        TempDir::new().unwrap()
    }

    // -------------------------------------------------------------------------
    // tokenize_references — @ sigil
    // -------------------------------------------------------------------------
    #[test]
    fn test_tokenize_single_at_ref() {
        let refs = tokenize_references("look at @src/main.rs please", &['@']);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].sigil, '@');
        assert_eq!(refs[0].token, "src/main.rs");
    }
    #[test]
    fn test_tokenize_email_not_treated_as_ref() {
        // @ embedded in an email address should not be treated as a file reference
        let refs = tokenize_references("contact user@example.com for help", &['@']);
        assert!(
            refs.is_empty(),
            "email @ should not be a reference: {refs:?}"
        );
    }
    // -------------------------------------------------------------------------
    // tokenize_references — markdown code masking (NoExpansionInsideCode)
    // -------------------------------------------------------------------------
    #[test]
    fn test_tokenize_skips_sigil_in_fenced_block() {
        let text = "trace:\n```\n@src/main.rs:42\n```";
        let refs = tokenize_references(text, &['@']);
        assert!(
            refs.is_empty(),
            "@ inside fenced block should not tokenize: {refs:?}"
        );
    }
    #[test]
    fn test_tokenize_skips_sigil_in_indented_block() {
        let text = "trace:\n\n    @src/main.rs:42\n\ndone";
        let refs = tokenize_references(text, &['@']);
        assert!(
            refs.is_empty(),
            "@ inside indented code should not tokenize: {refs:?}"
        );
    }
    #[test]
    fn test_tokenize_mixed_inside_and_outside_code() {
        let text = "see @real.rs first\n```\n@fake.rs\n```\nand @final.rs";
        let refs = tokenize_references(text, &['@']);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].token, "real.rs");
        assert_eq!(refs[1].token, "final.rs");
    }

    #[test]
    fn test_tokenize_unclosed_fence_masks_to_eof() {
        // pulldown-cmark auto-closes unclosed fences at EOF — every sigil
        // after the opener is masked. Conservative; safer than letting the
        // parser misinterpret what the user "really meant."
        let text = "starting code:\n```\n@trace.rs:42\nmore @other.rs after";
        let refs = tokenize_references(text, &['@']);
        assert!(
            refs.is_empty(),
            "everything after unclosed fence should be masked: {refs:?}"
        );
    }
    // -------------------------------------------------------------------------
    // expand — success path
    // -------------------------------------------------------------------------
    #[test]
    fn test_expand_single_file_ref() {
        let tmp = make_tmp();
        fs::write(tmp.path().join("hello.txt"), "contents here").unwrap();

        let result = expand("check @hello.txt please", &root(tmp.path())).unwrap();
        assert_eq!(result.display_text, "check @hello.txt please");
        assert!(result.llm_text.contains("<file path=\"hello.txt\">"));
        assert!(result.llm_text.contains("contents here"));
        assert!(result.llm_text.contains("</file>"));
        assert!(result.skill_invocation.is_none());
    }
    #[test]
    fn test_expand_leaves_same_ref_inside_code_fence_untouched() {
        // A real `@hello.txt` reference plus the identical literal inside a
        // fenced code block: only the real (tokenized) one expands; the masked
        // copy must survive verbatim (NoExpansionInsideCode).
        let tmp = make_tmp();
        fs::write(tmp.path().join("hello.txt"), "REALCONTENT").unwrap();

        let input = "see @hello.txt\n```\ntrace @hello.txt here\n```";
        let result = expand(input, &root(tmp.path())).unwrap();

        // Exactly one expansion (the reference outside the fence).
        assert_eq!(
            result.llm_text.matches("<file path=\"hello.txt\">").count(),
            1,
            "only the out-of-code reference should expand: {}",
            result.llm_text
        );
        assert!(result.llm_text.contains("REALCONTENT"));
        // The in-fence occurrence is preserved verbatim, not turned into a block.
        assert!(
            result.llm_text.contains("trace @hello.txt here"),
            "fenced occurrence must survive: {}",
            result.llm_text
        );
    }

    // -------------------------------------------------------------------------
    // expand — error path (REQ-IR-007)
    // -------------------------------------------------------------------------

    #[test]
    fn test_expand_missing_file_error() {
        let tmp = make_tmp();
        let err = expand("check @missing.rs", &root(tmp.path())).unwrap_err();
        assert_eq!(
            err,
            ExpansionError::FileNotFound {
                path: "missing.rs".to_string()
            }
        );
    }

    #[test]
    fn test_expand_binary_file_error() {
        let tmp = make_tmp();
        // Write a file with a null byte -- triggers binary detection.
        // Uses .txt extension so ClassifyAtReference treats it as a file reference.
        fs::write(tmp.path().join("bin.txt"), b"hello\x00world").unwrap();

        let err = expand("check @bin.txt", &root(tmp.path())).unwrap_err();
        assert_eq!(
            err,
            ExpansionError::FileNotText {
                path: "bin.txt".to_string()
            }
        );
    }
    // -------------------------------------------------------------------------
    // Skill helpers
    // -------------------------------------------------------------------------

    fn write_skill(dir: &Path, skill_dir: &str, name: &str, description: &str, body: &str) {
        let skill_path = dir.join(".claude/skills").join(skill_dir);
        fs::create_dir_all(&skill_path).unwrap();
        fs::write(
            skill_path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}"),
        )
        .unwrap();
    }

    // -------------------------------------------------------------------------
    // tokenize_references — / sigil
    // -------------------------------------------------------------------------
    #[test]
    fn test_tokenize_slash_not_preceded_by_whitespace() {
        // `/build` embedded in a word (e.g. "foo/build") should not match
        let refs = tokenize_references("foo/build bar", &['/']);
        assert!(refs.is_empty());
    }

    // -------------------------------------------------------------------------
    // tokenize_references — mixed sigils
    // -------------------------------------------------------------------------

    #[test]
    fn test_tokenize_mixed_sigils() {
        let refs = tokenize_references("use /build on @src/main.rs", &['/', '@']);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].sigil, '/');
        assert_eq!(refs[0].token, "build");
        assert_eq!(refs[1].sigil, '@');
        assert_eq!(refs[1].token, "src/main.rs");
    }

    // -------------------------------------------------------------------------
    // expand with skills (REQ-IR-002, REQ-IR-003)
    // -------------------------------------------------------------------------

    #[test]
    fn test_expand_skill_prefix_only() {
        let tmp = make_tmp();
        write_skill(
            tmp.path(),
            "writing-style",
            "writing-style",
            "Apply writing style",
            "Write in a formal tone.",
        );

        let result = expand("/writing-style", &root(tmp.path())).unwrap();
        assert_eq!(result.display_text, "/writing-style");
        assert!(result.llm_text.contains("Write in a formal tone."));
        // No text after the token — arguments is empty, so append fallback does not fire
        assert!(!result.llm_text.contains("ARGUMENTS:"));
        // Skill invocation is populated
        let invocation = result.skill_invocation.as_ref().unwrap();
        assert_eq!(invocation.name, "writing-style");
        assert!(invocation.body.contains("Write in a formal tone."));
    }

    #[test]
    fn test_expand_skill_with_arguments_placeholder() {
        let tmp = make_tmp();
        write_skill(
            tmp.path(),
            "review",
            "review",
            "Code review skill",
            "Please review $ARGUMENTS carefully.",
        );

        let result = expand("/review src/main.rs", &root(tmp.path())).unwrap();
        assert_eq!(result.display_text, "/review src/main.rs");
        // $ARGUMENTS is replaced with only the text after the skill token
        assert!(result
            .llm_text
            .contains("Please review src/main.rs carefully."));
        let invocation = result.skill_invocation.as_ref().unwrap();
        assert_eq!(invocation.name, "review");
    }

    #[test]
    fn test_expand_skill_with_arguments_no_placeholder_appends() {
        let tmp = make_tmp();
        write_skill(
            tmp.path(),
            "deploy",
            "deploy",
            "Deploy skill",
            "Run the deployment steps.",
        );

        let result = expand("/deploy staging", &root(tmp.path())).unwrap();
        assert_eq!(result.display_text, "/deploy staging");
        assert!(result.llm_text.contains("Run the deployment steps."));
        // Only the text after the skill token is appended as ARGUMENTS
        assert!(result.llm_text.contains("ARGUMENTS: staging"));
    }
    #[test]
    fn test_expand_file_path_not_skill() {
        // /usr/bin/ls should not trigger skill expansion
        let tmp = make_tmp();
        let result = expand("run /usr/bin/ls please", &root(tmp.path())).unwrap();
        assert_eq!(result.display_text, "run /usr/bin/ls please");
        assert_eq!(result.llm_text, "run /usr/bin/ls please");
    }

    #[test]
    fn test_expand_skill_not_found_error() {
        let tmp = make_tmp();
        // With no skills defined, /nonexistent should pass through as plain text
        // (tokenizer finds it but expand validates against known skills)
        let result = expand("/nonexistent", &root(tmp.path())).unwrap();
        assert_eq!(result.llm_text, "/nonexistent");
    }
    // --- ClassifyAtReference / AtTokenPassThrough (REQ-IR-007) ----
    #[test]
    fn test_pasted_fastapi_route_snippet_passes_through() {
        let tmp = make_tmp();
        let input = r#"Can you review this route?

@app.get("/.well-known/api-catalog", include_in_schema=False)
def api_catalog():
    return {"ok": True}
"#;
        let result = expand(input, &root(tmp.path())).unwrap();
        assert_eq!(result.llm_text, input);
    }
    #[test]
    fn test_framework_route_paths_expand() {
        let tmp = make_tmp();
        fs::create_dir_all(tmp.path().join("app/routes/[slug]")).unwrap();
        fs::create_dir_all(tmp.path().join("app/routes/(auth)")).unwrap();
        fs::create_dir_all(tmp.path().join("app/shop/[[...slug]]")).unwrap();
        fs::create_dir_all(tmp.path().join("docs")).unwrap();
        fs::create_dir_all(tmp.path().join("data")).unwrap();
        fs::write(tmp.path().join("app/routes/[slug].tsx"), "slug route").unwrap();
        fs::write(tmp.path().join("app/routes/[slug]/$id.tsx"), "id route").unwrap();
        fs::write(
            tmp.path().join("app/routes/(auth)/login.tsx"),
            "login route",
        )
        .unwrap();
        fs::write(
            tmp.path().join("app/shop/[[...slug]]/page.tsx"),
            "shop route",
        )
        .unwrap();
        fs::create_dir_all(tmp.path().join("fixtures")).unwrap();
        fs::write(tmp.path().join("docs/café.md"), "unicode doc").unwrap();
        fs::write(tmp.path().join("docs/what's-new.md"), "apostrophe doc").unwrap();
        fs::write(tmp.path().join("docs/important!.md"), "important doc").unwrap();
        fs::write(tmp.path().join("data/foo,bar.csv"), "comma data").unwrap();
        fs::write(
            tmp.path().join("fixtures/2026-06-23T12:00:00Z.json"),
            "timestamp fixture",
        )
        .unwrap();

        let result = expand(
            "see @app/routes/[slug].tsx and @app/routes/[slug]/$id.tsx and @app/routes/(auth)/login.tsx and @app/shop/[[...slug]]/page.tsx and @docs/café.md and @docs/what's-new.md and @docs/important!.md and @data/foo,bar.csv and @fixtures/2026-06-23T12:00:00Z.json",
            &root(tmp.path()),
        )
        .unwrap();

        assert!(result.llm_text.contains("slug route"));
        assert!(result.llm_text.contains("id route"));
        assert!(result.llm_text.contains("login route"));
        assert!(result.llm_text.contains("shop route"));
        assert!(result.llm_text.contains("unicode doc"));
        assert!(result.llm_text.contains("apostrophe doc"));
        assert!(result.llm_text.contains("important doc"));
        assert!(result.llm_text.contains("comma data"));
        assert!(result.llm_text.contains("timestamp fixture"));
    }
    #[test]
    fn test_bazel_label_passes_through() {
        let tmp = make_tmp();
        let result = expand(
            "build @+go_fast+go_fast//:go_fast.exe target",
            &root(tmp.path()),
        )
        .unwrap();
        assert_eq!(
            result.llm_text,
            "build @+go_fast+go_fast//:go_fast.exe target"
        );
    }
    #[test]
    fn test_url_after_at_passes_through() {
        let tmp = make_tmp();
        let result = expand("see @https://example.com/docs", &root(tmp.path())).unwrap();
        assert_eq!(result.llm_text, "see @https://example.com/docs");
    }
}
