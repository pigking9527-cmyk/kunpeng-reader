use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek};
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub enum DocError {
    Io(std::io::Error),
    Zip(zip::result::ZipError),
    Xml(quick_xml::Error),
    Rbook(String),
    InvalidEpub(&'static str),
}

impl std::fmt::Display for DocError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "I/O error: {error}"),
            Self::Zip(error) => write!(formatter, "ZIP error: {error}"),
            Self::Xml(error) => write!(formatter, "XML error: {error}"),
            Self::Rbook(error) => write!(formatter, "EPUB validation error: {error}"),
            Self::InvalidEpub(reason) => write!(formatter, "invalid EPUB: {reason}"),
        }
    }
}

impl std::error::Error for DocError {}

impl From<std::io::Error> for DocError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<zip::result::ZipError> for DocError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::Zip(error)
    }
}

impl From<quick_xml::Error> for DocError {
    fn from(error: quick_xml::Error) -> Self {
        Self::Xml(error)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EpubVersion {
    Version2_0,
    Version3_0,
    Unknown(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NavPoint {
    pub label: String,
    pub content: PathBuf,
    pub children: Vec<NavPoint>,
    pub play_order: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct MetadataItem {
    pub property: String,
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct SpineItem {
    pub idref: String,
    pub id: Option<String>,
    pub properties: Option<String>,
    pub linear: bool,
}

#[derive(Clone, Debug)]
pub struct ResourceItem {
    pub path: PathBuf,
    pub mime: String,
    pub properties: Option<String>,
}

pub struct EpubDoc<R: Read + Seek> {
    archive: zip::ZipArchive<R>,
    archive_names: Vec<String>,
    pub version: EpubVersion,
    pub spine: Vec<SpineItem>,
    pub resources: HashMap<String, ResourceItem>,
    pub toc: Vec<NavPoint>,
    pub metadata: Vec<MetadataItem>,
    cover_id: Option<String>,
}

impl EpubDoc<BufReader<File>> {
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, DocError> {
        let path = path.as_ref();
        rbook::Epub::open(path).map_err(|error| DocError::Rbook(error.to_string()))?;
        Self::from_reader(BufReader::new(File::open(path)?))
    }
}

impl<R: Read + Seek> EpubDoc<R> {
    pub fn from_reader(reader: R) -> Result<Self, DocError> {
        let mut archive = zip::ZipArchive::new(reader)?;
        let archive_names = archive
            .file_names()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let container = read_archive_entry(&mut archive, &archive_names, "META-INF/container.xml")?;
        let package_path = parse_container_path(&container)?;
        let package_bytes = read_archive_entry(&mut archive, &archive_names, &package_path)?;
        let package_base = Path::new(&package_path)
            .parent()
            .unwrap_or_else(|| Path::new(""));
        let package = parse_package(&package_bytes, package_base)?;

        let mut document = Self {
            archive,
            archive_names,
            version: package.version,
            spine: package.spine,
            resources: package.resources,
            toc: Vec::new(),
            metadata: package.metadata,
            cover_id: package.cover_id,
        };
        if let Some(toc_id) = package.toc_id {
            if let Some(resource) = document.resources.get(&toc_id) {
                let toc_path = resource.path.clone();
                if let Some(bytes) = document.get_resource_by_path(&toc_path) {
                    document.toc = parse_ncx(&bytes, toc_path.parent().unwrap_or(Path::new("")))
                        .unwrap_or_default();
                }
            }
        }
        Ok(document)
    }

    pub fn mdata(&self, property: &str) -> Option<&MetadataItem> {
        self.metadata
            .iter()
            .find(|item| item.property.eq_ignore_ascii_case(property))
    }

    pub fn get_cover(&mut self) -> Option<(Vec<u8>, String)> {
        let cover_id = self.cover_id.clone().or_else(|| {
            self.resources.iter().find_map(|(id, resource)| {
                resource
                    .properties
                    .as_deref()
                    .is_some_and(|properties| {
                        properties
                            .split_whitespace()
                            .any(|value| value == "cover-image")
                    })
                    .then(|| id.clone())
            })
        })?;
        self.get_resource(&cover_id)
    }

    pub fn get_resource_by_path<P: AsRef<Path>>(&mut self, path: P) -> Option<Vec<u8>> {
        let normalized = normalize_archive_path(path.as_ref())?;
        read_archive_entry(&mut self.archive, &self.archive_names, &normalized).ok()
    }

    pub fn get_resource(&mut self, id: &str) -> Option<(Vec<u8>, String)> {
        let resource = self.resources.get(id)?.clone();
        let bytes = self.get_resource_by_path(resource.path)?;
        Some((bytes, resource.mime))
    }

    pub fn get_resource_str_by_path<P: AsRef<Path>>(&mut self, path: P) -> Option<String> {
        let bytes = self.get_resource_by_path(path)?;
        Some(decode_book_text(&bytes))
    }

    pub fn get_resource_str(&mut self, id: &str) -> Option<(String, String)> {
        let resource = self.resources.get(id)?.clone();
        let text = self.get_resource_str_by_path(resource.path)?;
        Some((text, resource.mime))
    }

    pub fn get_resource_mime_by_path<P: AsRef<Path>>(&self, path: P) -> Option<String> {
        let normalized = normalize_archive_path(path.as_ref())?;
        self.resources.values().find_map(|resource| {
            (normalize_archive_path(&resource.path).as_deref() == Some(normalized.as_str()))
                .then(|| resource.mime.clone())
        })
    }
}

#[derive(Default)]
struct ParsedPackage {
    version: EpubVersion,
    resources: HashMap<String, ResourceItem>,
    spine: Vec<SpineItem>,
    metadata: Vec<MetadataItem>,
    cover_id: Option<String>,
    toc_id: Option<String>,
}

impl Default for EpubVersion {
    fn default() -> Self {
        Self::Unknown("unknown".to_string())
    }
}

fn parse_container_path(xml: &[u8]) -> Result<String, DocError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer)? {
            Event::Start(element) | Event::Empty(element)
                if local_name(element.name().as_ref()) == b"rootfile" =>
            {
                return attribute(&reader, &element, b"full-path")
                    .and_then(|value| normalize_archive_path(Path::new(&value)))
                    .ok_or(DocError::InvalidEpub("container has no safe rootfile path"));
            }
            Event::Eof => return Err(DocError::InvalidEpub("container has no rootfile")),
            _ => {}
        }
        buffer.clear();
    }
}

fn parse_package(xml: &[u8], package_base: &Path) -> Result<ParsedPackage, DocError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut parsed = ParsedPackage::default();
    let mut buffer = Vec::new();
    let mut in_metadata = false;
    let mut metadata_name: Option<String> = None;
    let mut metadata_text = String::new();

    loop {
        match reader.read_event_into(&mut buffer)? {
            Event::Start(element) => {
                let name = local_name(element.name().as_ref()).to_vec();
                match name.as_slice() {
                    b"package" => {
                        let version = attribute(&reader, &element, b"version").unwrap_or_default();
                        parsed.version = if version.starts_with('3') {
                            EpubVersion::Version3_0
                        } else if version.starts_with('2') {
                            EpubVersion::Version2_0
                        } else {
                            EpubVersion::Unknown(version)
                        };
                    }
                    b"metadata" => in_metadata = true,
                    b"item" => insert_manifest_item(&reader, &element, package_base, &mut parsed),
                    b"spine" => parsed.toc_id = attribute(&reader, &element, b"toc"),
                    b"itemref" => insert_spine_item(&reader, &element, &mut parsed),
                    b"meta" if in_metadata => {
                        let property = attribute(&reader, &element, b"property")
                            .or_else(|| attribute(&reader, &element, b"name"));
                        let content = attribute(&reader, &element, b"content");
                        if property.as_deref() == Some("cover") {
                            parsed.cover_id = content.clone();
                        }
                        if let (Some(property), Some(value)) = (property, content) {
                            parsed.metadata.push(MetadataItem { property, value });
                        }
                    }
                    name if in_metadata
                        && matches!(
                            name,
                            b"title" | b"creator" | b"description" | b"identifier" | b"language"
                        ) =>
                    {
                        metadata_name = Some(String::from_utf8_lossy(name).into_owned());
                        metadata_text.clear();
                    }
                    _ => {}
                }
            }
            Event::Empty(element) => match local_name(element.name().as_ref()) {
                b"item" => insert_manifest_item(&reader, &element, package_base, &mut parsed),
                b"itemref" => insert_spine_item(&reader, &element, &mut parsed),
                b"meta" if in_metadata => {
                    let property = attribute(&reader, &element, b"property")
                        .or_else(|| attribute(&reader, &element, b"name"));
                    let content = attribute(&reader, &element, b"content");
                    if property.as_deref() == Some("cover") {
                        parsed.cover_id = content.clone();
                    }
                    if let (Some(property), Some(value)) = (property, content) {
                        parsed.metadata.push(MetadataItem { property, value });
                    }
                }
                _ => {}
            },
            Event::Text(text) if metadata_name.is_some() => {
                metadata_text.push_str(&text.decode().unwrap_or_default());
            }
            Event::CData(text) if metadata_name.is_some() => {
                metadata_text.push_str(&String::from_utf8_lossy(text.as_ref()));
            }
            Event::End(element) => {
                let qualified_name = element.name();
                let name = local_name(qualified_name.as_ref());
                if name == b"metadata" {
                    in_metadata = false;
                }
                if metadata_name
                    .as_deref()
                    .is_some_and(|current| current.as_bytes() == name)
                {
                    let property = metadata_name.take().unwrap_or_default();
                    parsed.metadata.push(MetadataItem {
                        property,
                        value: metadata_text.trim().to_string(),
                    });
                    metadata_text.clear();
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }

    if parsed.resources.is_empty() || parsed.spine.is_empty() {
        return Err(DocError::InvalidEpub("package manifest or spine is empty"));
    }
    Ok(parsed)
}

fn insert_manifest_item<B: BufRead>(
    reader: &Reader<B>,
    element: &BytesStart<'_>,
    base: &Path,
    parsed: &mut ParsedPackage,
) {
    let (Some(id), Some(href), Some(mime)) = (
        attribute(reader, element, b"id"),
        attribute(reader, element, b"href"),
        attribute(reader, element, b"media-type"),
    ) else {
        return;
    };
    let href_without_fragment = href.split('#').next().unwrap_or(&href);
    let Some(path) = normalize_archive_path(&base.join(href_without_fragment)) else {
        return;
    };
    let properties = attribute(reader, element, b"properties");
    if properties
        .as_deref()
        .is_some_and(|value| value.split_whitespace().any(|item| item == "cover-image"))
    {
        parsed.cover_id = Some(id.clone());
    }
    parsed.resources.insert(
        id,
        ResourceItem {
            path: PathBuf::from(path),
            mime,
            properties,
        },
    );
}

fn insert_spine_item<B: BufRead>(
    reader: &Reader<B>,
    element: &BytesStart<'_>,
    parsed: &mut ParsedPackage,
) {
    let Some(idref) = attribute(reader, element, b"idref") else {
        return;
    };
    parsed.spine.push(SpineItem {
        idref,
        id: attribute(reader, element, b"id"),
        properties: attribute(reader, element, b"properties"),
        linear: attribute(reader, element, b"linear").as_deref() != Some("no"),
    });
}

fn parse_ncx(xml: &[u8], base: &Path) -> Result<Vec<NavPoint>, DocError> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut stack: Vec<NavPoint> = Vec::new();
    let mut roots = Vec::new();
    let mut collecting_label = false;
    loop {
        match reader.read_event_into(&mut buffer)? {
            Event::Start(element) if local_name(element.name().as_ref()) == b"navPoint" => {
                stack.push(NavPoint {
                    label: String::new(),
                    content: PathBuf::new(),
                    children: Vec::new(),
                    play_order: attribute(&reader, &element, b"playOrder")
                        .and_then(|value| value.parse().ok()),
                });
            }
            Event::Start(element)
                if local_name(element.name().as_ref()) == b"text" && !stack.is_empty() =>
            {
                collecting_label = true
            }
            Event::Empty(element)
                if local_name(element.name().as_ref()) == b"content" && !stack.is_empty() =>
            {
                if let Some(src) = attribute(&reader, &element, b"src") {
                    let target = src.split('#').next().unwrap_or(&src);
                    stack.last_mut().unwrap().content = base.join(target);
                }
            }
            Event::Text(text) if collecting_label => {
                if let Some(point) = stack.last_mut() {
                    point.label.push_str(&text.decode().unwrap_or_default());
                }
            }
            Event::End(element) if local_name(element.name().as_ref()) == b"text" => {
                collecting_label = false
            }
            Event::End(element) if local_name(element.name().as_ref()) == b"navPoint" => {
                if let Some(point) = stack.pop() {
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(point);
                    } else {
                        roots.push(point);
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(roots)
}

fn attribute<B: BufRead>(
    _reader: &Reader<B>,
    element: &BytesStart<'_>,
    wanted: &[u8],
) -> Option<String> {
    element
        .attributes()
        .with_checks(false)
        .filter_map(Result::ok)
        .find_map(|attr| {
            (local_name(attr.key.as_ref()) == wanted)
                .then(|| {
                    attr.normalized_value(XmlVersion::default())
                        .ok()
                        .map(|value| value.into_owned())
                })
                .flatten()
        })
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

fn normalize_archive_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn read_archive_entry<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    names: &[String],
    requested: &str,
) -> Result<Vec<u8>, DocError> {
    let normalized = normalize_archive_path(Path::new(requested))
        .ok_or(DocError::InvalidEpub("unsafe archive path"))?;
    let actual = if archive.index_for_name(&normalized).is_some() {
        normalized
    } else {
        names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(&normalized))
            .cloned()
            .ok_or(zip::result::ZipError::FileNotFound)?
    };
    let mut entry = archive.by_name(&actual)?;
    if entry.is_dir() || entry.size() > 128 * 1024 * 1024 {
        return Err(DocError::InvalidEpub("archive entry is not a bounded file"));
    }
    let mut bytes = Vec::with_capacity(entry.size().min(1024 * 1024) as usize);
    entry.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn decode_book_text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec())
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

#[cfg(test)]
mod tests {
    use super::EpubDoc;
    use std::io::Write;

    #[test]
    fn parses_epub3_metadata_spine_cover_and_resource() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        {
            let mut zip = zip::ZipWriter::new(temp.reopen().unwrap());
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("mimetype", options).unwrap();
            zip.write_all(b"application/epub+zip").unwrap();
            zip.start_file("META-INF/container.xml", options).unwrap();
            zip.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
            zip.start_file("OPS/book.opf", options).unwrap();
            zip.write_all(r#"<?xml version="1.0"?><package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">test</dc:identifier><dc:title>测试书</dc:title><dc:creator>作者</dc:creator><dc:language>zh</dc:language><meta property="dcterms:modified">2026-08-12T00:00:00Z</meta></metadata><manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#.as_bytes()).unwrap();
            zip.start_file("OPS/cover.png", options).unwrap();
            zip.write_all(b"png").unwrap();
            zip.start_file("OPS/text/c1.xhtml", options).unwrap();
            zip.write_all(b"<html><body>Hello</body></html>").unwrap();
            zip.finish().unwrap();
        }
        let mut doc = EpubDoc::new(temp.path()).unwrap();
        assert_eq!(doc.mdata("title").unwrap().value, "测试书");
        assert_eq!(doc.mdata("creator").unwrap().value, "作者");
        assert_eq!(doc.spine[0].idref, "c1");
        assert_eq!(doc.get_cover().unwrap().0, b"png");
        assert!(doc.get_resource_str("c1").unwrap().0.contains("Hello"));
    }
}
