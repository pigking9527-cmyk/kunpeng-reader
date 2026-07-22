//! Manages the zip component part of the epub doc.
//!
//! Provides easy methods to navigate through the epub parts and to get
//! the content as string.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use std::io::{Read, Seek};

/// Epub archive struct. Here it's stored the file path and the list of
/// files in the zip archive.
#[derive(Clone, Debug)]
pub struct EpubArchive<R: Read + Seek> {
    zip: zip::ZipArchive<R>,
    pub path: PathBuf,
    pub files: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("I/O Error: {0}")]
    IO(#[from] std::io::Error),
    #[error("Zip Error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Invalid UTF-8: {0}")]
    Utf8(#[from] std::str::Utf8Error),
    #[error("Invalid UTF-8 Path")]
    PathUtf8,
}
impl From<std::string::FromUtf8Error> for ArchiveError {
    fn from(e: std::string::FromUtf8Error) -> Self {
        Self::Utf8(e.utf8_error())
    }
}

impl EpubArchive<BufReader<File>> {
    /// Opens the epub file in `path`.
    ///
    /// # Errors
    ///
    /// Returns an error if the zip is broken or if the file doesn't
    /// exists.
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, ArchiveError> {
        let path = path.as_ref();
        let file = File::open(path)?;
        let mut archive = Self::from_reader(BufReader::new(file))?;
        archive.path = path.to_path_buf();
        Ok(archive)
    }
}

impl<R: Read + Seek> EpubArchive<R> {
    /// Opens the epub contained in `reader`.
    ///
    /// # Errors
    ///
    /// Returns an error if the zip is broken.
    pub fn from_reader(reader: R) -> Result<Self, ArchiveError> {
        let zip = zip::ZipArchive::new(reader)?;

        let files: Vec<String> = zip.file_names().map(String::from).collect();

        Ok(Self {
            zip,
            path: PathBuf::new(),
            files,
        })
    }

    /// Returns the content of the file by the `name` as `Vec<u8>`.
    ///
    /// # Errors
    ///
    /// Returns an error if the name doesn't exists in the zip archive.
    pub fn get_entry<P: AsRef<Path>>(&mut self, name: P) -> Result<Vec<u8>, ArchiveError> {
        let mut entry: Vec<u8> = vec![];

        let name = name.as_ref().to_str().ok_or(ArchiveError::PathUtf8)?;

        match self.zip.by_name(name) {
            Ok(mut zipfile) => {
                zipfile.read_to_end(&mut entry)?;
                return Ok(entry);
            }
            Err(zip::result::ZipError::FileNotFound) => {}
            Err(e) => {
                return Err(e.into());
            }
        };

        // Some legacy EPUBs were produced on Windows and spell the OPF/resource
        // path with a different ASCII case than the entry stored in the ZIP
        // (for example `ops/fb.opf` in container.xml but `OPS/fb.opf` in the
        // archive). ZIP paths are case-sensitive, whereas the original authoring
        // environment often was not. Keep the exact-name lookup above preferred,
        // then accept an unambiguous ASCII-case equivalent as a compatibility
        // fallback before trying a percent-decoded resource name.
        if let Some(actual_name) = self
            .files
            .iter()
            .find(|candidate| candidate.eq_ignore_ascii_case(name))
        {
            let mut zipfile = self.zip.by_name(actual_name)?;
            zipfile.read_to_end(&mut entry)?;
            return Ok(entry);
        }

        // try percent encoding
        let name = percent_encoding::percent_decode(name.as_bytes()).decode_utf8()?;
        let mut zipfile = self.zip.by_name(&name)?;
        zipfile.read_to_end(&mut entry)?;
        Ok(entry)
    }

    /// Returns the content of the file by the `name` as `String`.
    ///
    /// # Errors
    ///
    /// Returns an error if the name doesn't exists in the zip archive.
    pub fn get_entry_as_str<P: AsRef<Path>>(&mut self, name: P) -> Result<String, ArchiveError> {
        let content = self.get_entry(name)?;
        String::from_utf8(content).map_err(ArchiveError::from)
    }

    /// Returns the content of container file "META-INF/container.xml".
    ///
    /// # Errors
    ///
    /// Returns an error if the epub doesn't have the container file.
    pub fn get_container_file(&mut self) -> Result<Vec<u8>, ArchiveError> {
        let content = self.get_entry("META-INF/container.xml")?;
        Ok(content)
    }
}

#[cfg(test)]
mod tests {
    use super::EpubArchive;
    use std::io::{Cursor, Write};

    #[test]
    fn reads_entry_when_archive_path_only_differs_in_ascii_case() {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut bytes);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("OPS/fb.opf", options).unwrap();
            zip.write_all(b"ok").unwrap();
            zip.finish().unwrap();
        }
        bytes.set_position(0);

        let mut archive = EpubArchive::from_reader(bytes).unwrap();
        assert_eq!(archive.get_entry("ops/fb.opf").unwrap(), b"ok");
    }
}
