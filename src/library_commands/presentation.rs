//! Pure library presentation rules.
//!
//! Command handlers deliberately retain Tauri adaptation, locking, persistence,
//! sync and reader-window lifecycle work in their parent module.

/// 书名的分组首字母：跳过前导标点/书名号，取第一个有效字符的拼音首字母；数字/其它符号归 '#'.
pub(super) fn title_initial(title: &str) -> char {
    for c in title.chars() {
        if c.is_whitespace() || is_skip_punct(c) {
            continue;
        }
        return pinyin_initial(c).unwrap_or('#');
    }
    '#'
}

/// 一个汉字的拼音首字母（GB2312 编码区间法，覆盖绝大多数常用字）；非常用字/非汉字返回 None。
fn pinyin_initial(c: char) -> Option<char> {
    if c.is_ascii_alphabetic() {
        return Some(c.to_ascii_uppercase());
    }
    if !('\u{4e00}'..='\u{9fff}').contains(&c) {
        return None;
    }
    let mut buf = [0u8; 4];
    let s = c.encode_utf8(&mut buf);
    let (bytes, _, _) = encoding_rs::GBK.encode(s);
    if bytes.len() != 2 {
        return None;
    }
    let code = ((bytes[0] as u16) << 8) | (bytes[1] as u16);
    const INITIALS: [(u16, char); 23] = [
        (0xB0A1, 'A'),
        (0xB0C5, 'B'),
        (0xB2C1, 'C'),
        (0xB4EE, 'D'),
        (0xB6EA, 'E'),
        (0xB7A2, 'F'),
        (0xB8C1, 'G'),
        (0xB9FE, 'H'),
        (0xBBF7, 'J'),
        (0xBFA6, 'K'),
        (0xC0AC, 'L'),
        (0xC2E8, 'M'),
        (0xC4C3, 'N'),
        (0xC5B6, 'O'),
        (0xC5BE, 'P'),
        (0xC6DA, 'Q'),
        (0xC8BB, 'R'),
        (0xC8F6, 'S'),
        (0xCBFA, 'T'),
        (0xCDDA, 'W'),
        (0xCEF4, 'X'),
        (0xD1B9, 'Y'),
        (0xD4D1, 'Z'),
    ];
    if code < INITIALS[0].0 || code > 0xD7F9 {
        return None;
    }
    INITIALS
        .iter()
        .take_while(|(start, _)| code >= *start)
        .map(|(_, initial)| *initial)
        .last()
}

fn is_skip_punct(c: char) -> bool {
    matches!(
        c,
        '《' | '》'
            | '「'
            | '」'
            | '『'
            | '』'
            | '【'
            | '】'
            | '('
            | ')'
            | '（'
            | '）'
            | '['
            | ']'
            | '"'
            | '\''
            | '“'
            | '”'
            | '‘'
            | '’'
            | '·'
            | '…'
            | '—'
            | '-'
            | '_'
            | '.'
            | '、'
            | ','
            | '，'
            | '*'
            | '#'
    )
}

#[cfg(test)]
mod tests {
    use super::title_initial;

    #[test]
    fn title_initial_skips_book_punctuation_and_handles_ascii() {
        assert_eq!(title_initial("  《hello》"), 'H');
        assert_eq!(title_initial("【中文】"), 'Z');
        assert_eq!(title_initial("123"), '#');
        assert_eq!(title_initial("---"), '#');
    }
}
