use crate::{epub_toc, pdf_support};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

fn temp_file(name: &str, ext: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    path.push(format!(
        "kunpeng-smoke-{}-{stamp}.{ext}",
        name.replace(|c: char| !c.is_ascii_alphanumeric(), "-")
    ));
    path
}

fn write_zip_file<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, path: &str, body: &str) {
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file(path, options).unwrap();
    zip.write_all(body.as_bytes()).unwrap();
}

#[test]
fn smoke_generated_epub_opens_and_epub3_nav_resolves_chapters() {
    let path = temp_file("book", "epub");
    {
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        write_zip_file(&mut zip, "mimetype", "application/epub+zip");
        write_zip_file(
            &mut zip,
            "META-INF/container.xml",
            r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#,
        );
        let package_opf = concat!(
            r#"<?xml version="1.0" encoding="utf-8"?>"#,
            "\n",
            r#"<package xmlns="http"#,
            r#"://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">"#,
            "\n",
            r#"  <metadata xmlns:dc="http"#,
            r#"://purl.org/dc/elements/1.1/"><dc:title>Smoke EPUB</dc:title></metadata>"#,
            "\n",
            r#"  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"#,
        );
        write_zip_file(&mut zip, "OPS/package.opf", package_opf);
        write_zip_file(
            &mut zip,
            "OPS/nav.xhtml",
            r#"<html xmlns="http://www.w3.org/1999/xhtml"><body>
<nav epub:type="toc"><ol>
  <li><a href="chapter1.xhtml#top">第一章</a></li>
  <li><a href="chapter2.xhtml">第二章</a></li>
</ol></nav>
</body></html>"#,
        );
        write_zip_file(
            &mut zip,
            "OPS/chapter1.xhtml",
            r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="top">第一章</h1><p>正文。</p></body></html>"#,
        );
        write_zip_file(
            &mut zip,
            "OPS/chapter2.xhtml",
            r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1><p>更多正文。</p></body></html>"#,
        );
        zip.finish().unwrap();
    }

    let mut doc = epub::doc::EpubDoc::new(&path).unwrap();
    let chapter_map = HashMap::from([
        ("OPS/chapter1.xhtml".to_string(), 0),
        ("OPS/chapter2.xhtml".to_string(), 1),
    ]);
    let toc = epub_toc::epub3_nav_toc(&mut doc, &chapter_map);
    let _ = std::fs::remove_file(&path);

    assert_eq!(toc.len(), 2);
    assert_eq!(toc[0].label, "第一章");
    assert_eq!(toc[0].chapter, 0);
    assert_eq!(toc[0].frag, "top");
    assert_eq!(toc[1].label, "第二章");
    assert_eq!(toc[1].chapter, 1);
}

#[test]
fn smoke_generated_pdf_loads_info_author() {
    use lopdf::{dictionary, Document, Object};

    let path = temp_file("meta", "pdf");
    let mut doc = Document::with_version("1.4");
    let pages_id = doc.add_object(dictionary! {
        "Type" => Object::Name(b"Pages".to_vec()),
        "Kids" => Object::Array(vec![]),
        "Count" => Object::Integer(0),
    });
    let catalog_id = doc.add_object(dictionary! {
        "Type" => Object::Name(b"Catalog".to_vec()),
        "Pages" => Object::Reference(pages_id),
    });
    let info_id = doc.add_object(dictionary! {
        "Author" => Object::string_literal("Smoke Author"),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc.trailer.set("Info", Object::Reference(info_id));
    doc.save(&path).unwrap();

    let author = pdf_support::pdf_author(&path);
    let _ = std::fs::remove_file(&path);

    assert_eq!(author, "Smoke Author");
}
