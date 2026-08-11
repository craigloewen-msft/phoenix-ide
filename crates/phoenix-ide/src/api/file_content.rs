use super::types::{FileViewerKind, TextCategory};
use std::fs;
use std::io::{self, Read};
use std::path::Path;

pub(crate) const MAX_FILE_CONTENT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug)]
pub(crate) enum BoundedFileContent {
    Text {
        content: String,
        category: TextCategory,
    },
    Image {
        bytes: Vec<u8>,
        mime_type: String,
    },
}

impl BoundedFileContent {
    pub(crate) fn bytes(&self) -> &[u8] {
        match self {
            Self::Text { content, .. } => content.as_bytes(),
            Self::Image { bytes, .. } => bytes,
        }
    }
}

#[derive(Debug)]
pub(crate) enum FileContentError {
    Metadata(io::Error),
    TooLarge,
    Unsupported,
    Read(io::Error),
    InvalidText,
}

pub(crate) fn is_valid_text(content: &[u8]) -> bool {
    !content.contains(&0) && std::str::from_utf8(content).is_ok()
}

fn read_bounded_bytes_from_file(file: fs::File) -> Result<Vec<u8>, FileContentError> {
    let metadata = file.metadata().map_err(FileContentError::Metadata)?;
    if metadata.len() > MAX_FILE_CONTENT_BYTES as u64 {
        return Err(FileContentError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(MAX_FILE_CONTENT_BYTES)
            .min(MAX_FILE_CONTENT_BYTES),
    );
    file.take((MAX_FILE_CONTENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(FileContentError::Read)?;
    if bytes.len() > MAX_FILE_CONTENT_BYTES {
        return Err(FileContentError::TooLarge);
    }
    Ok(bytes)
}

pub(crate) fn read_bounded_text(path: &Path) -> Result<String, FileContentError> {
    let file = fs::File::open(path).map_err(FileContentError::Read)?;
    let bytes = read_bounded_bytes_from_file(file)?;
    if !is_valid_text(&bytes) {
        return Err(FileContentError::InvalidText);
    }
    String::from_utf8(bytes).map_err(|_| FileContentError::InvalidText)
}

#[cfg(any(test, not(unix)))]
pub(crate) fn read_bounded_file(path: &Path) -> Result<BoundedFileContent, FileContentError> {
    let file = fs::File::open(path).map_err(FileContentError::Read)?;
    read_bounded_file_handle(file, path)
}

pub(crate) fn read_bounded_file_handle(
    file: fs::File,
    path: &Path,
) -> Result<BoundedFileContent, FileContentError> {
    let viewer = FileViewerKind::for_path(path);
    if matches!(viewer, FileViewerKind::Opaque) {
        return Err(FileContentError::Unsupported);
    }
    let bytes = read_bounded_bytes_from_file(file)?;

    match viewer {
        FileViewerKind::Image => Ok(BoundedFileContent::Image {
            bytes,
            mime_type: mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string(),
        }),
        FileViewerKind::Text { category } if is_valid_text(&bytes) => {
            let content = String::from_utf8(bytes).map_err(|_| FileContentError::InvalidText)?;
            Ok(BoundedFileContent::Text { content, category })
        }
        FileViewerKind::Text { .. } => Err(FileContentError::InvalidText),
        FileViewerKind::Opaque => Err(FileContentError::Unsupported),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_utf8_is_text_and_unknown_binary_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("README");
        fs::write(&text, "hello\n").unwrap();
        assert!(matches!(
            read_bounded_file(&text),
            Ok(BoundedFileContent::Text {
                content,
                category: TextCategory::Unknown,
            }) if content == "hello\n"
        ));

        let binary = dir.path().join("payload");
        fs::write(&binary, [0, 1, 2]).unwrap();
        assert!(matches!(
            read_bounded_file(&binary),
            Err(FileContentError::InvalidText)
        ));
    }
}
