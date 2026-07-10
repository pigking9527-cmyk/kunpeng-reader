use ammonia::{Builder, UrlRelative};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

const CONTENT_TAGS: &[&str] = &[
    "a",
    "abbr",
    "article",
    "aside",
    "b",
    "bdi",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "main",
    "map",
    "mark",
    "nav",
    "ol",
    "p",
    "picture",
    "pre",
    "q",
    "rp",
    "rt",
    "rtc",
    "ruby",
    "s",
    "samp",
    "section",
    "small",
    "source",
    "span",
    "strike",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "tt",
    "u",
    "ul",
    "var",
    "wbr",
];

const DROP_WITH_CONTENT: &[&str] = &[
    "script", "iframe", "object", "embed", "form", "button", "textarea", "select", "option",
    "input", "meta", "base", "frame", "frameset", "template", "noscript", "canvas", "svg", "math",
];

fn safe_url_attribute(element: &str, attribute: &str, value: &str) -> bool {
    if !matches!(attribute, "href" | "src" | "poster" | "cite") {
        return true;
    }
    let normalized: String = value
        .chars()
        .filter(|c| !c.is_ascii_control() && !c.is_ascii_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if normalized.starts_with("data:") {
        return element == "img"
            && normalized.strip_prefix("data:").is_some_and(|v| {
                v.starts_with("image/png;")
                    || v.starts_with("image/jpeg;")
                    || v.starts_with("image/gif;")
                    || v.starts_with("image/webp;")
            });
    }
    !normalized.starts_with("javascript:")
        && !normalized.starts_with("vbscript:")
        && !normalized.starts_with("file:")
        && !normalized.starts_with("blob:")
        && !normalized.starts_with("//")
}

fn content_builder() -> Builder<'static> {
    let tags = CONTENT_TAGS.iter().copied().collect::<HashSet<_>>();
    let clean_content_tags = DROP_WITH_CONTENT
        .iter()
        .copied()
        .chain(["style"])
        .collect::<HashSet<_>>();
    let generic_attributes = ["class", "id", "lang", "title", "dir", "style"]
        .into_iter()
        .collect::<HashSet<_>>();
    let style_properties = [
        "color",
        "background-color",
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "font-variant",
        "line-height",
        "letter-spacing",
        "word-spacing",
        "text-align",
        "text-decoration",
        "text-indent",
        "text-transform",
        "white-space",
        "vertical-align",
        "width",
        "height",
        "max-width",
        "min-width",
        "margin",
        "margin-left",
        "margin-right",
        "margin-top",
        "margin-bottom",
        "padding",
        "padding-left",
        "padding-right",
        "padding-top",
        "padding-bottom",
        "border",
        "border-width",
        "border-style",
        "border-color",
        "border-collapse",
        "list-style",
        "list-style-type",
        "float",
        "clear",
        "display",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    let mut tag_attributes = HashMap::new();
    tag_attributes.insert("a", ["href", "hreflang"].into_iter().collect());
    tag_attributes.insert(
        "img",
        ["src", "alt", "width", "height", "usemap"]
            .into_iter()
            .collect(),
    );
    tag_attributes.insert(
        "source",
        ["src", "srcset", "type", "media"].into_iter().collect(),
    );
    tag_attributes.insert("ol", ["start", "reversed", "type"].into_iter().collect());
    tag_attributes.insert("li", ["value"].into_iter().collect());
    tag_attributes.insert("col", ["span", "width"].into_iter().collect());
    tag_attributes.insert("colgroup", ["span", "width"].into_iter().collect());
    tag_attributes.insert(
        "td",
        ["colspan", "rowspan", "headers", "scope"]
            .into_iter()
            .collect(),
    );
    tag_attributes.insert(
        "th",
        ["colspan", "rowspan", "headers", "scope"]
            .into_iter()
            .collect(),
    );
    tag_attributes.insert("time", ["datetime"].into_iter().collect());

    let mut builder = Builder::empty();
    builder
        .tags(tags)
        .clean_content_tags(clean_content_tags)
        .generic_attributes(generic_attributes)
        .generic_attribute_prefixes(["data-"].into_iter().collect())
        .tag_attributes(tag_attributes)
        .filter_style_properties(style_properties)
        .url_schemes(
            ["http", "https", "mailto", "tel", "reader", "data"]
                .into_iter()
                .collect(),
        )
        .url_relative(UrlRelative::PassThrough)
        .link_rel(Some("noopener noreferrer"))
        .strip_comments(true)
        .attribute_filter(|element, attribute, value| {
            safe_url_attribute(element, attribute, value).then_some(Cow::Borrowed(value))
        });
    builder
}

/// Sanitize any untrusted book body using an HTML5 parser and an explicit allowlist.
pub fn sanitize_book_html(html: &str) -> String {
    content_builder().clean(html).to_string()
}

/// Sanitize the small set of EPUB head assets that the reader supports.
pub fn sanitize_epub_head(html: &str) -> String {
    let mut builder = Builder::empty();
    builder
        .tags(["link", "style"].into_iter().collect())
        .clean_content_tags(DROP_WITH_CONTENT.iter().copied().collect())
        .tag_attributes(HashMap::from([(
            "link",
            ["href", "rel", "type", "media"].into_iter().collect(),
        )]))
        .tag_attribute_values(HashMap::from([(
            "link",
            HashMap::from([("rel", ["stylesheet"].into_iter().collect())]),
        )]))
        .url_schemes(["reader", "http", "https"].into_iter().collect())
        .url_relative(UrlRelative::Deny)
        .strip_comments(true)
        .attribute_filter(|element, attribute, value| {
            if element == "link" && attribute == "rel" && !value.eq_ignore_ascii_case("stylesheet")
            {
                return None;
            }
            safe_url_attribute(element, attribute, value).then_some(Cow::Borrowed(value))
        });
    builder.clean(html).to_string()
}

pub fn sanitize_mobi_html(html: &str) -> String {
    sanitize_book_html(html)
}

fn decode_html_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest.find(';').filter(|end| *end <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "nbsp" => Some(' '),
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => entity[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        if let Some(ch) = decoded {
            out.push(ch);
        } else {
            out.push_str(&rest[..=end]);
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "br"
            | "caption"
            | "dd"
            | "div"
            | "dl"
            | "dt"
            | "figcaption"
            | "figure"
            | "footer"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "summary"
            | "table"
            | "tbody"
            | "td"
            | "tfoot"
            | "th"
            | "thead"
            | "tr"
            | "ul"
    )
}

/// 把可能包含 HTML 的图书简介转换成纯文本。先用解析器移除脚本和危险内容，
/// 再保留块级元素的换行，最后解码常见实体并压缩多余空白。
pub(crate) fn html_to_plain_text(input: &str) -> String {
    if input.trim().is_empty() {
        return String::new();
    }
    let decoded_input = decode_html_entities(input);
    let safe = sanitize_book_html(&decoded_input);
    let mut text = String::with_capacity(safe.len());
    let mut rest = safe.as_str();
    while let Some(start) = rest.find('<') {
        text.push_str(&rest[..start]);
        let Some(end) = rest[start + 1..].find('>') else {
            text.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let raw_tag = &rest[start + 1..start + 1 + end];
        let tag = raw_tag
            .trim_start_matches(|ch: char| ch == '/' || ch.is_whitespace())
            .split(|ch: char| ch.is_whitespace() || ch == '/' || ch == '>')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if is_block_tag(&tag) && !text.ends_with('\n') {
            text.push('\n');
        }
        rest = &rest[start + end + 2..];
    }
    text.push_str(rest);
    decode_html_entities(&text)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::{html_to_plain_text, sanitize_book_html, sanitize_epub_head, sanitize_mobi_html};

    #[test]
    fn removes_script_blocks_and_dangerous_elements() {
        let html = r#"<p>ok</p><script>alert(1)</script><iframe src="x"></iframe><p>tail</p>"#;
        assert_eq!(sanitize_mobi_html(html), "<p>ok</p><p>tail</p>");
    }

    #[test]
    fn removes_event_handlers_and_javascript_urls() {
        let html = r#"<a href="javascript:alert(1)" onclick="x()" title="keep">word</a>"#;
        let out = sanitize_mobi_html(html);
        assert!(out.contains(r#"title="keep""#));
        assert!(out.contains("word</a>"));
        assert!(!out.contains("onclick"));
        assert!(!out.contains("javascript:"));
    }

    #[test]
    fn escapes_kept_attribute_values() {
        let html = r#"<img alt="a < b & c &quot;quoted&quot;" src="cover.jpg">"#;
        let out = sanitize_mobi_html(html);
        assert!(out.contains(r#"alt="a &lt; b &amp; c &quot;quoted&quot;""#));
        assert!(out.contains(r#"src="cover.jpg""#));
    }

    #[test]
    fn strips_srcdoc_and_style_script_expressions() {
        let html = r#"<div srcdoc="<script>x</script>" style="background:expression(alert(1))" class="note">x</div>"#;
        let out = sanitize_mobi_html(html);
        assert!(out.contains(r#"class="note""#));
        assert!(!out.contains("srcdoc"));
        assert!(!out.contains("expression"));
    }

    #[test]
    fn removes_mixed_case_dangerous_blocks_without_touching_safe_text() {
        let html = r#"<p>before</p><ScRiPt type="text/javascript">bad()</ScRiPt><OBJECT data="x"></OBJECT><p>after</p>"#;
        assert_eq!(sanitize_mobi_html(html), "<p>before</p><p>after</p>");
    }

    #[test]
    fn blocks_html_data_urls_but_keeps_safe_image_data() {
        let html = r#"<a href=" data:text/html,<script>x</script>">bad</a><img src="data:image/png;base64,abc" alt="ok">"#;
        let out = sanitize_mobi_html(html);
        assert!(!out.contains("data:text/html"));
        assert!(out.contains(r#"src="data:image/png;base64,abc""#));
        assert!(out.contains(r#"alt="ok""#));
    }

    #[test]
    fn parser_handles_obfuscated_and_malformed_xss() {
        let html = r#"<scr<script>ipt>alert(1)</scr</script>ipt><img src=x onerror=alert(2)><a href="java&#x0A;script:alert(3)">bad</a>"#;
        let out = sanitize_book_html(html);
        assert!(!out.to_ascii_lowercase().contains("onerror"));
        assert!(!out.to_ascii_lowercase().contains("javascript:"));
        assert!(!out.to_ascii_lowercase().contains("<script"));
    }

    #[test]
    fn removes_active_embeds_forms_and_dangerous_urls() {
        let html = r#"<iframe src=x></iframe><object data=x></object><form action=/x><input></form><a href="//evil.test/x">x</a><img src="data:text/html,x">"#;
        let out = sanitize_book_html(html);
        for tag in ["iframe", "object", "form", "input"] {
            assert!(!out.contains(tag));
        }
        assert!(!out.contains("evil.test"));
        assert!(!out.contains("data:text/html"));
    }

    #[test]
    fn head_only_keeps_styles_and_stylesheet_links() {
        let html = r#"<script>x()</script><link rel="preload" href="http://reader.localhost/x"><link rel="stylesheet" href="http://reader.localhost/a.css"><style>p{color:red}</style>"#;
        let out = sanitize_epub_head(html);
        assert!(!out.contains("script"));
        assert!(!out.contains("preload"));
        assert!(out.contains("stylesheet"));
        assert!(out.contains("p{color:red}"));
    }

    #[test]
    fn description_html_becomes_readable_plain_text() {
        let html = r#"<div><h3>内容简介</h3><p>《三国志》&nbsp;记录魏、蜀、吴。</p><h3>编辑推荐</h3></div>"#;
        assert_eq!(
            html_to_plain_text(html),
            "内容简介\n《三国志》 记录魏、蜀、吴。\n编辑推荐"
        );
    }

    #[test]
    fn description_drops_encoded_scripts_and_decodes_entities() {
        let html = "&lt;script&gt;bad()&lt;/script&gt;<p>A &amp; B &#x4E2D;</p>";
        assert_eq!(html_to_plain_text(html), "A & B 中");
    }
}
