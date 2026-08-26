use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use std::sync::OnceLock;

static SIMPLIFIED_TO_TRADITIONAL: OnceLock<Option<OpenCC>> = OnceLock::new();
static TRADITIONAL_TO_SIMPLIFIED: OnceLock<Option<OpenCC>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReaderTextConversion {
    Original,
    ToSimplified,
    ToTraditional,
}

impl ReaderTextConversion {
    pub(super) fn parse(value: &str) -> Self {
        match value {
            "t2s" => Self::ToSimplified,
            "s2t" => Self::ToTraditional,
            _ => Self::Original,
        }
    }

    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::ToSimplified => "t2s",
            Self::ToTraditional => "s2t",
        }
    }

    pub(super) const fn cache_tag(self) -> u8 {
        match self {
            Self::Original => 0,
            Self::ToSimplified => 1,
            Self::ToTraditional => 2,
        }
    }

    pub(super) const fn from_cache_tag(value: u8) -> Self {
        match value {
            1 => Self::ToSimplified,
            2 => Self::ToTraditional,
            _ => Self::Original,
        }
    }
}

fn reader_text_converter(mode: ReaderTextConversion) -> Option<&'static OpenCC> {
    match mode {
        ReaderTextConversion::Original => None,
        ReaderTextConversion::ToTraditional => SIMPLIFIED_TO_TRADITIONAL
            .get_or_init(|| OpenCC::from_config(BuiltinConfig::S2t).ok())
            .as_ref(),
        ReaderTextConversion::ToSimplified => TRADITIONAL_TO_SIMPLIFIED
            .get_or_init(|| OpenCC::from_config(BuiltinConfig::T2s).ok())
            .as_ref(),
    }
}

/// Converts visible HTML text while deliberately leaving markup and resource URLs intact.
/// Chapter HTML is sanitised before this runs, but raw style/script contents remain unchanged.
pub(super) fn convert_reader_html_text(html: &str, mode: ReaderTextConversion) -> String {
    let Some(converter) = reader_text_converter(mode) else {
        return html.to_owned();
    };
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    let mut raw_text_tag: Option<&str> = None;
    while let Some(relative_start) = html[cursor..].find('<') {
        let start = cursor + relative_start;
        if raw_text_tag.is_none() {
            out.push_str(&converter.convert(&html[cursor..start]));
        } else {
            out.push_str(&html[cursor..start]);
        }
        let Some(relative_end) = html[start..].find('>') else {
            if raw_text_tag.is_none() {
                out.push_str(&converter.convert(&html[start..]));
            } else {
                out.push_str(&html[start..]);
            }
            return out;
        };
        let end = start + relative_end + 1;
        let tag = &html[start..end];
        let tag_name = tag
            .trim_start_matches('<')
            .trim_start_matches('/')
            .trim_start()
            .split(|ch: char| ch.is_whitespace() || ch == '>' || ch == '/')
            .next()
            .unwrap_or("");
        let closes_tag = tag.trim_start_matches('<').trim_start().starts_with('/');
        if let Some(raw) = raw_text_tag {
            if closes_tag && tag_name.eq_ignore_ascii_case(raw) {
                raw_text_tag = None;
            }
        } else if !closes_tag
            && (tag_name.eq_ignore_ascii_case("style") || tag_name.eq_ignore_ascii_case("script"))
        {
            raw_text_tag = Some(if tag_name.eq_ignore_ascii_case("style") {
                "style"
            } else {
                "script"
            });
        }
        out.push_str(tag);
        cursor = end;
    }
    if raw_text_tag.is_none() {
        out.push_str(&converter.convert(&html[cursor..]));
    } else {
        out.push_str(&html[cursor..]);
    }
    out
}
