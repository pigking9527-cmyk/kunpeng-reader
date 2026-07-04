/// 合并页的基础样式 + 分页脚本。
///
/// 具体 HTML/CSS/JS 放在 ui/reader-page-head.html，避免把阅读页注入脚本继续塞进 Rust 大文件。
pub(crate) const READER_PAGE_HEAD: &str = include_str!("../ui/reader-page-head.html");

#[cfg(test)]
mod tests {
    use super::READER_PAGE_HEAD;

    #[test]
    fn reader_page_head_keeps_required_hooks() {
        assert!(READER_PAGE_HEAD.contains("window.addEventListener('message'"));
        assert!(READER_PAGE_HEAD.contains("function showChapter"));
        assert!(READER_PAGE_HEAD.contains("parent.postMessage"));
        assert!(READER_PAGE_HEAD.contains("ttsStart"));
        assert!(READER_PAGE_HEAD.contains("function showTranslateResult"));
        assert!(READER_PAGE_HEAD.contains("function showDictResult"));
        assert!(READER_PAGE_HEAD.contains("function showFootnote"));
        assert!(READER_PAGE_HEAD.contains("function measureAll"));
        assert!(READER_PAGE_HEAD.contains("function renderHlSettings"));
        assert!(READER_PAGE_HEAD.contains("function applyConfiguredMenu"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuActionsV1"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuDisplayModeV1"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuSizeV1"));
        assert!(READER_PAGE_HEAD.contains("translateResult"));
        assert!(READER_PAGE_HEAD.contains("dictResult"));
    }
}
