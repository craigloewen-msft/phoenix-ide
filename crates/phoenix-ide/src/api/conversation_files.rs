#[cfg(not(unix))]
use super::file_content::read_bounded_file;
use super::file_content::{
    is_valid_text, BoundedFileContent, FileContentError, MAX_FILE_CONTENT_BYTES,
};
use super::handlers::{preview_url_for_path, AppError};
use super::types::{
    ConflictErrorResponse, ConversationFileCapability, ConversationFileContentResponse,
    DeleteConversationFileRequest, PutConversationFileRequest, PutConversationFileResponse,
    ReadFileResponse,
};
use super::AppState;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
#[cfg(unix)]
use std::os::fd::OwnedFd;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Component, Path, PathBuf};

pub(crate) const MAX_PUT_BODY_BYTES: usize = MAX_FILE_CONTENT_BYTES * 6 + 64 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct ConversationFileQuery {
    path: String,
}

#[derive(Debug, Clone, Copy)]
enum ResolvePurpose {
    Read,
    Mutation,
}

struct ConversationFileAuthority {
    root: PathBuf,
    mutation_denial: Option<String>,
    #[cfg(unix)]
    root_fd: OwnedFd,
}

fn version_for(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            write!(output, "{byte:02x}").expect("writing to String cannot fail");
            output
        })
}

fn version_conflict() -> AppError {
    AppError::Conflict(Box::new(ConflictErrorResponse::new(
        "File content changed since it was read",
        "file_version_conflict",
    )))
}

async fn conversation_authority(
    state: &AppState,
    conversation_id: &str,
) -> Result<ConversationFileAuthority, AppError> {
    let conversation = state
        .db
        .get_conversation(conversation_id)
        .await
        .map_err(|error| AppError::NotFound(error.to_string()))?;

    if conversation.runtime_role == crate::work_scope::RuntimeRole::Coordinator {
        return Err(AppError::Forbidden(
            "Coordinator conversations have no file environment".to_string(),
        ));
    }

    let lifecycle = state
        .db
        .conversation_work_scope_lifecycle(conversation_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let mutation_denial = if cfg!(not(unix)) {
        Some("File mutations are unsupported on this platform".to_string())
    } else if conversation.archived {
        Some("Archived conversations are read-only".to_string())
    } else if conversation.continued_in_conv_id.is_some() {
        Some("Continued conversations no longer own their file environment".to_string())
    } else if matches!(conversation.conv_mode, crate::db::ConvMode::Explore { .. }) {
        Some("Explore conversations are read-only".to_string())
    } else if lifecycle != Some(phoenix_core::work_scope::WorkScopeLifecycle::Active) {
        Some("Conversation file environment is not active".to_string())
    } else {
        None
    };

    let root = fs::canonicalize(conversation.file_root())
        .map_err(|_| AppError::NotFound("Conversation file root does not exist".to_string()))?;
    if !root.is_dir() {
        return Err(AppError::NotFound(
            "Conversation file root does not exist".to_string(),
        ));
    }
    #[cfg(unix)]
    let root_fd = nix::fcntl::open(
        &root,
        nix::fcntl::OFlag::O_RDONLY | nix::fcntl::OFlag::O_DIRECTORY | nix::fcntl::OFlag::O_CLOEXEC,
        nix::sys::stat::Mode::empty(),
    )
    .map_err(|_| AppError::NotFound("Conversation file root does not exist".to_string()))?;
    Ok(ConversationFileAuthority {
        root,
        mutation_denial,
        #[cfg(unix)]
        root_fd,
    })
}

fn validate_relative_path(path: &str) -> Result<&Path, AppError> {
    let relative = Path::new(path);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AppError::BadRequest(
            "File path must be a non-empty relative path without traversal".to_string(),
        ));
    }
    Ok(relative)
}

fn missing_target(purpose: ResolvePurpose) -> AppError {
    match purpose {
        ResolvePurpose::Read => AppError::NotFound("File does not exist".to_string()),
        ResolvePurpose::Mutation => version_conflict(),
    }
}

#[cfg(unix)]
struct OpenedFile {
    file: fs::File,
    stat: nix::sys::stat::FileStat,
    parent_fd: OwnedFd,
    leaf: OsString,
}

#[cfg(unix)]
fn open_parent_dir(
    authority: &ConversationFileAuthority,
    relative_path: &str,
    purpose: ResolvePurpose,
) -> Result<(OwnedFd, OsString), AppError> {
    let relative = validate_relative_path(relative_path)?;
    let mut components = relative.components().peekable();
    let mut current = nix::unistd::dup(&authority.root_fd).map_err(|_| missing_target(purpose))?;
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(AppError::BadRequest(
                "File path must be a non-empty relative path without traversal".to_string(),
            ));
        };
        if components.peek().is_none() {
            return Ok((current, name.to_os_string()));
        }
        current = nix::fcntl::openat(
            &current,
            Path::new(name),
            nix::fcntl::OFlag::O_RDONLY
                | nix::fcntl::OFlag::O_DIRECTORY
                | nix::fcntl::OFlag::O_CLOEXEC
                | nix::fcntl::OFlag::O_NOFOLLOW,
            nix::sys::stat::Mode::empty(),
        )
        .map_err(|_| missing_target(purpose))?;
    }
    Err(AppError::BadRequest(
        "File path must be a non-empty relative path without traversal".to_string(),
    ))
}

#[cfg(unix)]
fn open_confined_file(
    authority: &ConversationFileAuthority,
    relative_path: &str,
    purpose: ResolvePurpose,
) -> Result<OpenedFile, AppError> {
    let (parent_fd, leaf) = open_parent_dir(authority, relative_path, purpose)?;
    let fd = nix::fcntl::openat(
        &parent_fd,
        Path::new(&leaf),
        nix::fcntl::OFlag::O_RDONLY | nix::fcntl::OFlag::O_CLOEXEC | nix::fcntl::OFlag::O_NOFOLLOW,
        nix::sys::stat::Mode::empty(),
    )
    .map_err(|_| missing_target(purpose))?;
    let stat = nix::sys::stat::fstat(&fd).map_err(|_| missing_target(purpose))?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(AppError::BadRequest(
            "File path must name a regular file".to_string(),
        ));
    }
    Ok(OpenedFile {
        file: fs::File::from(fd),
        stat,
        parent_fd,
        leaf,
    })
}

fn resolve_file_target(
    authority: &ConversationFileAuthority,
    relative_path: &str,
    purpose: ResolvePurpose,
) -> Result<PathBuf, AppError> {
    #[cfg(unix)]
    {
        let _opened = open_confined_file(authority, relative_path, purpose)?;
    }
    let relative = validate_relative_path(relative_path)?;
    let requested = authority.root.join(relative);
    let leaf_metadata = fs::symlink_metadata(&requested).map_err(|_| missing_target(purpose))?;
    if leaf_metadata.file_type().is_symlink() {
        return Err(AppError::BadRequest(
            "File path must not name a symbolic link".to_string(),
        ));
    }

    let target = fs::canonicalize(&requested).map_err(|_| missing_target(purpose))?;
    if target == authority.root || !target.starts_with(&authority.root) {
        return Err(AppError::NotFound("File does not exist".to_string()));
    }
    if !leaf_metadata.is_file() || target.is_dir() {
        return Err(AppError::BadRequest(
            "File path must name a regular file".to_string(),
        ));
    }
    Ok(target)
}

fn map_read_error(error: FileContentError, purpose: ResolvePurpose) -> AppError {
    if matches!(purpose, ResolvePurpose::Mutation) {
        return match error {
            FileContentError::Unsupported | FileContentError::InvalidText => version_conflict(),
            FileContentError::TooLarge => {
                AppError::BadRequest("File too large (max 10MB)".to_string())
            }
            FileContentError::Metadata(error) | FileContentError::Read(error) => {
                AppError::Internal(format!("Cannot inspect file content: {error}"))
            }
        };
    }
    match error {
        FileContentError::Metadata(error) => {
            AppError::BadRequest(format!("Cannot read file metadata: {error}"))
        }
        FileContentError::Read(error) => AppError::BadRequest(format!("Cannot read file: {error}")),
        FileContentError::TooLarge => AppError::BadRequest("File too large (max 10MB)".to_string()),
        FileContentError::Unsupported | FileContentError::InvalidText => {
            AppError::BadRequest("File appears to be binary or has invalid encoding".to_string())
        }
    }
}

#[cfg(not(unix))]
fn read_target(path: &Path, purpose: ResolvePurpose) -> Result<BoundedFileContent, AppError> {
    read_bounded_file(path).map_err(|error| map_read_error(error, purpose))
}

#[cfg(unix)]
struct ConfinedRead {
    content: BoundedFileContent,
    stat: nix::sys::stat::FileStat,
    parent_fd: OwnedFd,
    leaf: OsString,
}

#[cfg(unix)]
fn read_confined_target(
    authority: &ConversationFileAuthority,
    relative_path: &str,
    purpose: ResolvePurpose,
) -> Result<ConfinedRead, AppError> {
    let opened = open_confined_file(authority, relative_path, purpose)?;
    let content =
        super::file_content::read_bounded_file_handle(opened.file, Path::new(relative_path))
            .map_err(|error| map_read_error(error, purpose))?;
    Ok(ConfinedRead {
        content,
        stat: opened.stat,
        parent_fd: opened.parent_fd,
        leaf: opened.leaf,
    })
}

#[cfg(unix)]
struct AnchoredTemporary {
    parent_fd: OwnedFd,
    name: OsString,
    file: fs::File,
    cleanup_entry: bool,
}

#[cfg(unix)]
impl AnchoredTemporary {
    fn new(parent_fd: &OwnedFd) -> Result<Self, AppError> {
        let parent_fd = nix::unistd::dup(parent_fd).map_err(|error| {
            AppError::Internal(format!("Cannot duplicate directory handle: {error}"))
        })?;
        for _ in 0..8 {
            let name = OsString::from(format!(".phoenix-file-edit-{}", uuid::Uuid::new_v4()));
            match nix::fcntl::openat(
                &parent_fd,
                Path::new(&name),
                nix::fcntl::OFlag::O_RDWR
                    | nix::fcntl::OFlag::O_CREAT
                    | nix::fcntl::OFlag::O_EXCL
                    | nix::fcntl::OFlag::O_CLOEXEC
                    | nix::fcntl::OFlag::O_NOFOLLOW,
                nix::sys::stat::Mode::from_bits_truncate(0o600),
            ) {
                Ok(fd) => {
                    return Ok(Self {
                        parent_fd,
                        name,
                        file: fs::File::from(fd),
                        cleanup_entry: true,
                    });
                }
                Err(nix::errno::Errno::EEXIST) => {}
                Err(error) => {
                    return Err(AppError::Internal(format!(
                        "Cannot create temporary file: {error}"
                    )));
                }
            }
        }
        Err(AppError::Internal(
            "Cannot allocate a unique temporary file".to_string(),
        ))
    }

    fn preserve_entry(&mut self) {
        self.cleanup_entry = false;
    }

    fn cleanup_entry(&mut self) {
        self.cleanup_entry = true;
    }

    fn old_target_metadata(&self) -> Result<fs::Metadata, AppError> {
        let fd = nix::fcntl::openat(
            &self.parent_fd,
            Path::new(&self.name),
            nix::fcntl::OFlag::O_RDONLY
                | nix::fcntl::OFlag::O_CLOEXEC
                | nix::fcntl::OFlag::O_NOFOLLOW,
            nix::sys::stat::Mode::empty(),
        )
        .map_err(|_| version_conflict())?;
        fs::File::from(fd)
            .metadata()
            .map_err(|_| version_conflict())
    }
}

#[cfg(unix)]
impl Drop for AnchoredTemporary {
    fn drop(&mut self) {
        if !self.cleanup_entry {
            tracing::error!(
                entry = %self.name.to_string_lossy(),
                "preserving temporary entry because it may contain user data"
            );
            return;
        }
        let _ = nix::unistd::unlinkat(
            &self.parent_fd,
            Path::new(&self.name),
            nix::unistd::UnlinkatFlags::NoRemoveDir,
        );
    }
}

#[cfg(target_os = "linux")]
fn exchange_entries(
    left_dir: &OwnedFd,
    left_name: &Path,
    right_dir: &OwnedFd,
    right_name: &Path,
) -> Result<(), AppError> {
    nix::fcntl::renameat2(
        left_dir,
        left_name,
        right_dir,
        right_name,
        nix::fcntl::RenameFlags::RENAME_EXCHANGE,
    )
    .map_err(|_| version_conflict())
}

#[cfg(target_os = "macos")]
fn exchange_entries(
    left_dir: &OwnedFd,
    left_name: &Path,
    right_dir: &OwnedFd,
    right_name: &Path,
) -> Result<(), AppError> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    let left_name = CString::new(left_name.as_os_str().as_bytes())
        .map_err(|_| AppError::BadRequest("File path contains a NUL byte".to_string()))?;
    let right_name = CString::new(right_name.as_os_str().as_bytes())
        .map_err(|_| AppError::BadRequest("File path contains a NUL byte".to_string()))?;
    let result = unsafe {
        libc::renameatx_np(
            left_dir.as_raw_fd(),
            left_name.as_ptr(),
            right_dir.as_raw_fd(),
            right_name.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(version_conflict())
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn exchange_entries(
    _left_dir: &OwnedFd,
    _left_name: &Path,
    _right_dir: &OwnedFd,
    _right_name: &Path,
) -> Result<(), AppError> {
    Err(AppError::Internal(
        "Atomic conditional file replacement is unsupported on this platform".to_string(),
    ))
}

pub(crate) async fn get_conversation_file(
    State(state): State<AppState>,
    AxumPath(conversation_id): AxumPath<String>,
    Query(query): Query<ConversationFileQuery>,
) -> Result<Json<ConversationFileContentResponse>, AppError> {
    let authority = conversation_authority(&state, &conversation_id).await?;
    let target = resolve_file_target(&authority, &query.path, ResolvePurpose::Read)?;
    #[cfg(unix)]
    let content = read_confined_target(&authority, &query.path, ResolvePurpose::Read)?.content;
    #[cfg(not(unix))]
    let content = read_target(&target, ResolvePurpose::Read)?;
    let version = version_for(content.bytes());
    let read_only_reason = authority.mutation_denial;
    let (content, capability) = match content {
        BoundedFileContent::Text { content, category } => (
            ReadFileResponse::Text {
                content,
                encoding: "utf-8".to_string(),
                category,
            },
            read_only_reason.map_or_else(
                || ConversationFileCapability::MutableText {
                    version: version.clone(),
                },
                |reason| ConversationFileCapability::ReadOnly { reason },
            ),
        ),
        BoundedFileContent::Image { mime_type, .. } => (
            ReadFileResponse::Image {
                mime_type,
                url: preview_url_for_path(&target),
            },
            read_only_reason.map_or_else(
                || ConversationFileCapability::DeleteOnly {
                    version: version.clone(),
                },
                |reason| ConversationFileCapability::ReadOnly { reason },
            ),
        ),
    };

    Ok(Json(ConversationFileContentResponse {
        content,
        capability,
    }))
}

fn validate_submitted_text(content: &str) -> Result<(), AppError> {
    let submitted = content.as_bytes();
    if submitted.len() > MAX_FILE_CONTENT_BYTES {
        return Err(AppError::BadRequest(
            "File too large (max 10MB)".to_string(),
        ));
    }
    if !is_valid_text(submitted) {
        return Err(AppError::BadRequest(
            "Replacement content must be valid UTF-8 text without NUL bytes".to_string(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn confined_path_matches(
    authority: &ConversationFileAuthority,
    relative_path: &str,
    expected: &fs::Metadata,
) -> bool {
    open_confined_file(authority, relative_path, ResolvePurpose::Mutation).is_ok_and(|opened| {
        opened.stat.st_dev == expected.dev() && opened.stat.st_ino == expected.ino()
    })
}

#[cfg(unix)]
fn install_replacement(
    authority: &ConversationFileAuthority,
    relative_path: &str,
    current: &ConfinedRead,
    mut replacement: AnchoredTemporary,
) -> Result<(), AppError> {
    exchange_entries(
        &replacement.parent_fd,
        Path::new(&replacement.name),
        &current.parent_fd,
        Path::new(&current.leaf),
    )?;
    replacement.preserve_entry();
    let exchanged = replacement.old_target_metadata().map_err(|_| {
        AppError::Internal(format!(
            "Save verification failed; original data was preserved as {}",
            replacement.name.to_string_lossy()
        ))
    })?;
    let submitted = replacement.file.metadata().map_err(|_| {
        AppError::Internal(format!(
            "Save verification failed; original data was preserved as {}",
            replacement.name.to_string_lossy()
        ))
    })?;
    if current.stat.st_dev != exchanged.dev()
        || current.stat.st_ino != exchanged.ino()
        || !confined_path_matches(authority, relative_path, &submitted)
    {
        if exchange_entries(
            &replacement.parent_fd,
            Path::new(&replacement.name),
            &current.parent_fd,
            Path::new(&current.leaf),
        )
        .is_err()
        {
            return Err(AppError::Internal(format!(
                "File changed during save and rollback failed; original data was preserved as {}",
                replacement.name.to_string_lossy()
            )));
        }
        replacement.cleanup_entry();
        return Err(version_conflict());
    }
    replacement.cleanup_entry();
    drop(replacement);
    Ok(())
}

pub(crate) async fn put_conversation_file(
    State(state): State<AppState>,
    AxumPath(conversation_id): AxumPath<String>,
    Json(request): Json<PutConversationFileRequest>,
) -> Result<Json<PutConversationFileResponse>, AppError> {
    let admission = state.runtime.conversation_admission(&conversation_id).await;
    let _admission_guard = admission.lock().await;
    validate_submitted_text(&request.content)?;
    let submitted = request.content.as_bytes();

    let authority = conversation_authority(&state, &conversation_id).await?;
    if let Some(reason) = authority.mutation_denial.as_ref() {
        return Err(AppError::Forbidden(reason.clone()));
    }
    let initial_target = resolve_file_target(&authority, &request.path, ResolvePurpose::Mutation)?;
    #[cfg(unix)]
    let initial_content =
        read_confined_target(&authority, &request.path, ResolvePurpose::Mutation)?.content;
    #[cfg(not(unix))]
    let initial_content = read_target(&initial_target, ResolvePurpose::Mutation)?;
    match initial_content {
        BoundedFileContent::Text { .. } => {}
        BoundedFileContent::Image { .. } => {
            return Err(AppError::BadRequest(
                "Only UTF-8 text files can be replaced".to_string(),
            ));
        }
    }

    #[cfg(unix)]
    let mut replacement = AnchoredTemporary::new(
        &open_parent_dir(&authority, &request.path, ResolvePurpose::Mutation)?.0,
    )?;
    #[cfg(not(unix))]
    let mut replacement = {
        let parent = initial_target
            .parent()
            .ok_or_else(|| AppError::Internal("File has no parent directory".to_string()))?;
        tempfile::NamedTempFile::new_in(parent).map_err(|error| {
            AppError::Internal(format!("Cannot create replacement file: {error}"))
        })?
    };
    #[cfg(unix)]
    replacement
        .file
        .write_all(submitted)
        .and_then(|()| replacement.file.flush())
        .and_then(|()| replacement.file.sync_all())
        .map_err(|error| AppError::Internal(format!("Cannot write replacement file: {error}")))?;
    #[cfg(not(unix))]
    replacement
        .write_all(submitted)
        .and_then(|()| replacement.flush())
        .and_then(|()| replacement.as_file().sync_all())
        .map_err(|error| AppError::Internal(format!("Cannot write replacement file: {error}")))?;

    let current_target = resolve_file_target(&authority, &request.path, ResolvePurpose::Mutation)?;
    if current_target != initial_target {
        return Err(version_conflict());
    }
    #[cfg(unix)]
    let current = read_confined_target(&authority, &request.path, ResolvePurpose::Mutation)?;
    #[cfg(not(unix))]
    let current = read_target(&current_target, ResolvePurpose::Mutation)?;
    if !matches!(current.content, BoundedFileContent::Text { .. })
        || version_for(current.content.bytes()) != request.expected_version
    {
        return Err(version_conflict());
    }

    #[cfg(unix)]
    let permissions = fs::Permissions::from_mode(current.stat.st_mode as u32 & 0o777);
    #[cfg(not(unix))]
    let permissions = fs::metadata(&current_target)
        .map_err(|_| version_conflict())?
        .permissions();
    #[cfg(unix)]
    replacement
        .file
        .set_permissions(permissions)
        .and_then(|()| replacement.file.sync_all())
        .map_err(|error| {
            AppError::Internal(format!("Cannot preserve file permissions: {error}"))
        })?;
    #[cfg(not(unix))]
    replacement
        .as_file()
        .set_permissions(permissions)
        .and_then(|()| replacement.as_file().sync_all())
        .map_err(|error| {
            AppError::Internal(format!("Cannot preserve file permissions: {error}"))
        })?;
    #[cfg(all(test, unix))]
    tests::run_before_file_mutation();
    #[cfg(unix)]
    install_replacement(&authority, &request.path, &current, replacement)?;
    #[cfg(not(unix))]
    replacement.persist(&current_target).map_err(|error| {
        AppError::Internal(format!("Cannot atomically replace file: {}", error.error))
    })?;

    Ok(Json(PutConversationFileResponse {
        version: version_for(submitted),
    }))
}

pub(crate) async fn delete_conversation_file(
    State(state): State<AppState>,
    AxumPath(conversation_id): AxumPath<String>,
    Json(request): Json<DeleteConversationFileRequest>,
) -> Result<StatusCode, AppError> {
    let admission = state.runtime.conversation_admission(&conversation_id).await;
    let _admission_guard = admission.lock().await;
    let authority = conversation_authority(&state, &conversation_id).await?;
    if let Some(reason) = authority.mutation_denial.as_ref() {
        return Err(AppError::Forbidden(reason.clone()));
    }
    let initial_target = resolve_file_target(&authority, &request.path, ResolvePurpose::Mutation)?;
    #[cfg(unix)]
    let initial = read_confined_target(&authority, &request.path, ResolvePurpose::Mutation)?;
    #[cfg(not(unix))]
    let initial = read_target(&initial_target, ResolvePurpose::Mutation)?;
    if version_for(initial.content.bytes()) != request.expected_version {
        return Err(version_conflict());
    }

    let current_target = resolve_file_target(&authority, &request.path, ResolvePurpose::Mutation)?;
    if current_target != initial_target {
        return Err(version_conflict());
    }
    #[cfg(unix)]
    let current = read_confined_target(&authority, &request.path, ResolvePurpose::Mutation)?;
    #[cfg(not(unix))]
    let current = read_target(&current_target, ResolvePurpose::Mutation)?;
    if version_for(current.content.bytes()) != request.expected_version {
        return Err(version_conflict());
    }

    #[cfg(all(test, unix))]
    tests::run_before_file_mutation();
    #[cfg(unix)]
    {
        let mut tombstone = AnchoredTemporary::new(&current.parent_fd)?;
        exchange_entries(
            &tombstone.parent_fd,
            Path::new(&tombstone.name),
            &current.parent_fd,
            Path::new(&current.leaf),
        )?;
        tombstone.preserve_entry();
        let exchanged = tombstone.old_target_metadata().map_err(|_| {
            AppError::Internal(format!(
                "Delete verification failed; original data was preserved as {}",
                tombstone.name.to_string_lossy()
            ))
        })?;
        let marker = tombstone.file.metadata().map_err(|_| {
            AppError::Internal(format!(
                "Delete verification failed; original data was preserved as {}",
                tombstone.name.to_string_lossy()
            ))
        })?;
        if current.stat.st_dev != exchanged.dev()
            || current.stat.st_ino != exchanged.ino()
            || !confined_path_matches(&authority, &request.path, &marker)
        {
            if exchange_entries(
                &tombstone.parent_fd,
                Path::new(&tombstone.name),
                &current.parent_fd,
                Path::new(&current.leaf),
            )
            .is_err()
            {
                return Err(AppError::Internal(format!(
                    "File changed during delete and rollback failed; original data was preserved as {}",
                    tombstone.name.to_string_lossy()
                )));
            }
            tombstone.cleanup_entry();
            return Err(version_conflict());
        }
        nix::unistd::unlinkat(
            &current.parent_fd,
            Path::new(&current.leaf),
            nix::unistd::UnlinkatFlags::NoRemoveDir,
        )
        .map_err(|_| {
            AppError::Internal(format!(
                "Delete committed but cleanup failed; original data was preserved as {}",
                tombstone.name.to_string_lossy()
            ))
        })?;
        tombstone.cleanup_entry();
        drop(tombstone);
    }
    #[cfg(not(unix))]
    fs::remove_file(&current_target).map_err(|_| version_conflict())?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_qa::ChainQa;
    use crate::db::{ConvMode, Database};
    use crate::platform::PlatformCapability;
    use crate::runtime::RuntimeManager;
    use crate::tools::mcp::McpClientManager;
    use phoenix_llm::ModelRegistry;
    use std::sync::Arc;
    #[cfg(unix)]
    use std::sync::{Mutex, OnceLock};

    #[cfg(unix)]
    type MutationHook = Box<dyn FnOnce() + Send>;
    #[cfg(unix)]
    static BEFORE_FILE_MUTATION: OnceLock<Mutex<Option<MutationHook>>> = OnceLock::new();

    #[cfg(unix)]
    fn set_before_file_mutation(action: impl FnOnce() + Send + 'static) {
        *BEFORE_FILE_MUTATION
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("mutation hook lock") = Some(Box::new(action));
    }

    #[cfg(unix)]
    pub(super) fn run_before_file_mutation() {
        if let Some(action) = BEFORE_FILE_MUTATION
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("mutation hook lock")
            .take()
        {
            action();
        }
    }

    async fn state_with_conversation(root: &Path, mode: &ConvMode) -> AppState {
        let db = Database::open_in_memory().await.expect("open db");
        db.create_conversation_with_project(
            "c-files",
            "files-test",
            &root.to_string_lossy(),
            true,
            None,
            None,
            None,
            mode,
            None,
            None,
            None,
            phoenix_core::llm_language::LlmLanguage::default(),
        )
        .await
        .expect("seed conversation");
        let llm_registry = Arc::new(ModelRegistry::new_empty());
        let platform = PlatformCapability::None {
            details: "test".into(),
        };
        let mcp_manager = Arc::new(McpClientManager::new());
        let runtime = Arc::new(RuntimeManager::new(
            db.clone(),
            llm_registry.clone(),
            platform.clone(),
            mcp_manager.clone(),
            None,
        ));
        let terminals = runtime.terminals.clone();
        let message_retriever: Arc<dyn crate::db::MessageRetriever> =
            Arc::new(crate::db::Fts5Retriever::new(db.pool().clone()));
        let chain_qa = ChainQa::new(db.clone(), llm_registry.clone(), message_retriever.clone());
        let sessions = super::super::auth::SessionStore::new(db.clone(), String::new());
        AppState {
            runtime,
            llm_registry,
            db,
            platform,
            mcp_manager,
            credential_helper: None,
            password: None,
            sessions,
            login_throttle: super::super::auth::LoginThrottle::new(),
            terminals,
            chain_qa,
            message_retriever,
            codex_login: super::super::codex_login::CodexLoginManager::new(),
            deployment: Arc::new(super::super::deployment::DeploymentConfig::for_tests()),
            runtime_env: Arc::new(phoenix_core::runtime_env::PhoenixRuntimeEnvironment::detect()),
            suggest_token: String::new(),
            discovery: crate::discovery::start(crate::discovery::DiscoveryConfig {
                enabled: false,
                ..crate::discovery::DiscoveryConfig::from_env()
            }),
            resource_monitor: crate::api::resource_monitor::ResourceMonitor::new(),
        }
    }

    async fn direct_state(root: &Path) -> AppState {
        state_with_conversation(root, &ConvMode::Direct).await
    }

    async fn get_text(state: AppState, path: &str) -> (String, String) {
        let Json(response) = get_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Query(ConversationFileQuery {
                path: path.to_string(),
            }),
        )
        .await
        .expect("read file");
        let content = match response.content {
            ReadFileResponse::Text { content, .. } => content,
            ReadFileResponse::Image { .. } => panic!("expected text"),
        };
        let version = match response.capability {
            ConversationFileCapability::MutableText { version } => version,
            other @ (ConversationFileCapability::DeleteOnly { .. }
            | ConversationFileCapability::ReadOnly { .. }) => {
                panic!("expected mutable text, got {other:?}")
            }
        };
        (content, version)
    }

    #[cfg(unix)]
    #[test]
    fn exchanged_temporary_preserves_entry_that_may_hold_original_data() {
        let root = tempfile::tempdir().expect("root");
        let root_fd = nix::fcntl::open(
            root.path(),
            nix::fcntl::OFlag::O_RDONLY
                | nix::fcntl::OFlag::O_DIRECTORY
                | nix::fcntl::OFlag::O_CLOEXEC,
            nix::sys::stat::Mode::empty(),
        )
        .expect("open root");
        fs::write(root.path().join("target.txt"), "original\n").expect("target");
        let mut temporary = AnchoredTemporary::new(&root_fd).expect("temporary");
        temporary
            .file
            .write_all(b"replacement\n")
            .expect("write replacement");
        exchange_entries(
            &temporary.parent_fd,
            Path::new(&temporary.name),
            &root_fd,
            Path::new("target.txt"),
        )
        .expect("exchange");
        temporary.preserve_entry();
        let preserved_name = temporary.name.clone();
        drop(temporary);

        assert_eq!(
            fs::read_to_string(root.path().join("target.txt")).unwrap(),
            "replacement\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join(&preserved_name)).unwrap(),
            "original\n"
        );
        fs::remove_file(root.path().join(preserved_name)).expect("cleanup preserved data");
    }

    #[tokio::test]
    async fn active_direct_text_read_is_mutable_and_versioned() {
        let root = tempfile::tempdir().expect("root");
        fs::write(root.path().join("notes.txt"), "hello\n").expect("write");
        let (content, version) = get_text(direct_state(root.path()).await, "notes.txt").await;
        assert_eq!(content, "hello\n");
        assert_eq!(version.len(), 64);
        assert!(version.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn active_direct_image_read_is_delete_only_and_versioned() {
        let root = tempfile::tempdir().expect("root");
        fs::write(root.path().join("image.png"), [0x89, b'P', b'N', b'G', 0]).expect("write");
        let Json(response) = get_conversation_file(
            State(direct_state(root.path()).await),
            AxumPath("c-files".to_string()),
            Query(ConversationFileQuery {
                path: "image.png".to_string(),
            }),
        )
        .await
        .expect("read image");
        assert!(matches!(response.content, ReadFileResponse::Image { .. }));
        assert!(matches!(
            response.capability,
            ConversationFileCapability::DeleteOnly { version } if version.len() == 64
        ));
    }

    #[tokio::test]
    async fn explore_read_remains_available_but_read_only() {
        let root = tempfile::tempdir().expect("root");
        fs::write(root.path().join("notes.txt"), "hello\n").expect("write");
        let state = state_with_conversation(
            root.path(),
            &ConvMode::Explore {
                worktree_path: None,
                next_taskmd_id_hint: None,
            },
        )
        .await;
        let Json(response) = get_conversation_file(
            State(state.clone()),
            AxumPath("c-files".to_string()),
            Query(ConversationFileQuery {
                path: "notes.txt".to_string(),
            }),
        )
        .await
        .expect("read file");
        assert!(matches!(
            response.capability,
            ConversationFileCapability::ReadOnly { .. }
        ));
        let error = put_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Json(PutConversationFileRequest {
                path: "notes.txt".to_string(),
                content: "changed\n".to_string(),
                expected_version: "unused".to_string(),
            }),
        )
        .await
        .expect_err("Explore mutation must fail");
        assert!(matches!(error, AppError::Forbidden(_)));
        assert_eq!(
            fs::read_to_string(root.path().join("notes.txt")).unwrap(),
            "hello\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_replaces_text_preserves_mode_and_rejects_stale_version() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("root");
        let path = root.path().join("script.sh");
        fs::write(&path, "echo old\n").expect("write");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o6755)).expect("chmod");
        let state = direct_state(root.path()).await;
        let (_, version) = get_text(state.clone(), "script.sh").await;

        let Json(saved) = put_conversation_file(
            State(state.clone()),
            AxumPath("c-files".to_string()),
            Json(PutConversationFileRequest {
                path: "script.sh".to_string(),
                content: "echo new\n".to_string(),
                expected_version: version.clone(),
            }),
        )
        .await
        .expect("save");
        assert_ne!(saved.version, version);
        assert_eq!(fs::read_to_string(&path).unwrap(), "echo new\n");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );

        let error = put_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Json(PutConversationFileRequest {
                path: "script.sh".to_string(),
                content: "clobber\n".to_string(),
                expected_version: version,
            }),
        )
        .await
        .expect_err("stale save must conflict");
        assert!(matches!(error, AppError::Conflict(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "echo new\n");
    }

    #[tokio::test]
    async fn delete_requires_current_version_and_removes_only_the_file() {
        let root = tempfile::tempdir().expect("root");
        let path = root.path().join("doomed.txt");
        fs::write(&path, "one\n").expect("write");
        let state = direct_state(root.path()).await;
        let (_, version) = get_text(state.clone(), "doomed.txt").await;
        fs::write(&path, "two\n").expect("external edit");

        let error = delete_conversation_file(
            State(state.clone()),
            AxumPath("c-files".to_string()),
            Json(DeleteConversationFileRequest {
                path: "doomed.txt".to_string(),
                expected_version: version,
            }),
        )
        .await
        .expect_err("stale delete must conflict");
        assert!(matches!(error, AppError::Conflict(_)));
        assert!(path.exists());

        let (_, latest) = get_text(state.clone(), "doomed.txt").await;
        let status = delete_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Json(DeleteConversationFileRequest {
                path: "doomed.txt".to_string(),
                expected_version: latest,
            }),
        )
        .await
        .expect("delete");
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(!path.exists());
        assert!(root.path().exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_parent_swap_after_version_check_returns_conflict_and_rolls_back() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let parent = root.path().join("nested");
        let moved = outside.path().join("moved-nested");
        fs::create_dir(&parent).expect("parent");
        fs::write(parent.join("race.txt"), "observed\n").expect("write");
        let state = direct_state(root.path()).await;
        let (_, version) = get_text(state.clone(), "nested/race.txt").await;
        let parent_for_hook = parent.clone();
        let moved_for_hook = moved.clone();
        set_before_file_mutation(move || {
            fs::rename(&parent_for_hook, &moved_for_hook).expect("move observed parent");
            fs::create_dir(&parent_for_hook).expect("replacement parent");
            fs::write(parent_for_hook.join("race.txt"), "new target\n").expect("new target");
        });

        let error = put_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Json(PutConversationFileRequest {
                path: "nested/race.txt".to_string(),
                content: "submitted\n".to_string(),
                expected_version: version,
            }),
        )
        .await
        .expect_err("moved parent must conflict");
        assert!(matches!(error, AppError::Conflict(_)));
        assert_eq!(
            fs::read_to_string(parent.join("race.txt")).unwrap(),
            "new target\n"
        );
        assert_eq!(
            fs::read_to_string(moved.join("race.txt")).unwrap(),
            "observed\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_parent_swap_after_version_check_returns_conflict_and_rolls_back() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let parent = root.path().join("nested");
        let moved = outside.path().join("moved-nested");
        fs::create_dir(&parent).expect("parent");
        fs::write(parent.join("race.txt"), "observed\n").expect("write");
        let state = direct_state(root.path()).await;
        let (_, version) = get_text(state.clone(), "nested/race.txt").await;
        let parent_for_hook = parent.clone();
        let moved_for_hook = moved.clone();
        set_before_file_mutation(move || {
            fs::rename(&parent_for_hook, &moved_for_hook).expect("move observed parent");
            fs::create_dir(&parent_for_hook).expect("replacement parent");
            fs::write(parent_for_hook.join("race.txt"), "new target\n").expect("new target");
        });

        let error = delete_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Json(DeleteConversationFileRequest {
                path: "nested/race.txt".to_string(),
                expected_version: version,
            }),
        )
        .await
        .expect_err("moved parent must conflict");
        assert!(matches!(error, AppError::Conflict(_)));
        assert_eq!(
            fs::read_to_string(parent.join("race.txt")).unwrap(),
            "new target\n"
        );
        assert_eq!(
            fs::read_to_string(moved.join("race.txt")).unwrap(),
            "observed\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_path_swap_after_version_check_returns_conflict_and_preserves_new_target() {
        let root = tempfile::tempdir().expect("root");
        let path = root.path().join("race.txt");
        let displaced = root.path().join("displaced.txt");
        fs::write(&path, "observed\n").expect("write");
        let state = direct_state(root.path()).await;
        let (_, version) = get_text(state.clone(), "race.txt").await;
        let path_for_hook = path.clone();
        let displaced_for_hook = displaced.clone();
        set_before_file_mutation(move || {
            fs::rename(&path_for_hook, &displaced_for_hook).expect("displace observed file");
            fs::write(&path_for_hook, "new target\n").expect("write replacement target");
        });

        let error = put_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Json(PutConversationFileRequest {
                path: "race.txt".to_string(),
                content: "submitted\n".to_string(),
                expected_version: version,
            }),
        )
        .await
        .expect_err("swapped path must conflict");
        assert!(matches!(error, AppError::Conflict(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "new target\n");
        assert_eq!(fs::read_to_string(displaced).unwrap(), "observed\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_path_swap_after_version_check_returns_conflict_and_preserves_new_target() {
        let root = tempfile::tempdir().expect("root");
        let path = root.path().join("race-delete.txt");
        let displaced = root.path().join("displaced-delete.txt");
        fs::write(&path, "observed\n").expect("write");
        let state = direct_state(root.path()).await;
        let (_, version) = get_text(state.clone(), "race-delete.txt").await;
        let path_for_hook = path.clone();
        let displaced_for_hook = displaced.clone();
        set_before_file_mutation(move || {
            fs::rename(&path_for_hook, &displaced_for_hook).expect("displace observed file");
            fs::write(&path_for_hook, "new target\n").expect("write replacement target");
        });

        let error = delete_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Json(DeleteConversationFileRequest {
                path: "race-delete.txt".to_string(),
                expected_version: version,
            }),
        )
        .await
        .expect_err("swapped path must conflict");
        assert!(matches!(error, AppError::Conflict(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "new target\n");
        assert_eq!(fs::read_to_string(displaced).unwrap(), "observed\n");
    }

    #[tokio::test]
    async fn text_replacement_rejects_image_and_nul_content() {
        let root = tempfile::tempdir().expect("root");
        fs::write(root.path().join("image.png"), [0x89, b'P', b'N', b'G', 0]).expect("write image");
        fs::write(root.path().join("notes.txt"), "hello\n").expect("write text");
        let state = direct_state(root.path()).await;
        let (_, text_version) = get_text(state.clone(), "notes.txt").await;

        let image_error = put_conversation_file(
            State(state.clone()),
            AxumPath("c-files".to_string()),
            Json(PutConversationFileRequest {
                path: "image.png".to_string(),
                content: "not an image".to_string(),
                expected_version: "unused".to_string(),
            }),
        )
        .await
        .expect_err("image replacement must fail");
        assert!(matches!(image_error, AppError::BadRequest(_)));

        let nul_error = put_conversation_file(
            State(state),
            AxumPath("c-files".to_string()),
            Json(PutConversationFileRequest {
                path: "notes.txt".to_string(),
                content: "hello\0world".to_string(),
                expected_version: text_version,
            }),
        )
        .await
        .expect_err("NUL text must fail");
        assert!(matches!(nul_error, AppError::BadRequest(_)));
        assert_eq!(
            fs::read_to_string(root.path().join("notes.txt")).unwrap(),
            "hello\n"
        );
    }

    #[tokio::test]
    async fn traversal_absolute_directory_and_outside_paths_are_rejected() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        fs::create_dir(root.path().join("dir")).expect("dir");
        fs::write(outside.path().join("secret.txt"), "secret\n").expect("secret");
        let state = direct_state(root.path()).await;

        for path in ["../secret.txt", "/etc/passwd", "dir"] {
            let error = get_conversation_file(
                State(state.clone()),
                AxumPath("c-files".to_string()),
                Query(ConversationFileQuery {
                    path: path.to_string(),
                }),
            )
            .await
            .expect_err("unsafe target must fail");
            assert!(matches!(
                error,
                AppError::BadRequest(_) | AppError::NotFound(_)
            ));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_leaf_and_symlinked_ancestor_escape_are_rejected() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "secret\n").expect("secret");
        std::os::unix::fs::symlink(&secret, root.path().join("leaf.txt")).expect("leaf link");
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).expect("dir link");
        let state = direct_state(root.path()).await;

        for path in ["leaf.txt", "escape/secret.txt"] {
            let error = get_conversation_file(
                State(state.clone()),
                AxumPath("c-files".to_string()),
                Query(ConversationFileQuery {
                    path: path.to_string(),
                }),
            )
            .await
            .expect_err("symlink target must fail");
            assert!(matches!(
                error,
                AppError::BadRequest(_) | AppError::NotFound(_)
            ));
        }
    }
}
