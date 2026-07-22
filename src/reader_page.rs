/// 合并页的基础样式 + 分页脚本。
///
/// 注入页按职责拆分；编译期拼接为一个文档头，不增加运行时请求。
pub(crate) const READER_PAGE_HEAD: &str = concat!(
    include_str!("../ui/reader-page-style.html"),
    "<script>",
    include_str!("../ui/reader-page-layout.js"),
    include_str!("../ui/reader-page-pagination.js"),
    include_str!("../ui/reader-page-measurement.js"),
    include_str!("../ui/reader-page-annotations.js"),
    include_str!("../ui/reader-page-runtime.js"),
    "</script>
"
);

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
        assert!(READER_PAGE_HEAD.contains("styleMode"));
        assert!(READER_PAGE_HEAD.contains("function showDictResult"));
        assert!(READER_PAGE_HEAD.contains("function showFootnote"));
        assert!(READER_PAGE_HEAD.contains("function measureAll"));
        assert!(READER_PAGE_HEAD.contains("function pageCountSig"));
        assert!(READER_PAGE_HEAD.contains("function renderHlSettings"));
        assert!(READER_PAGE_HEAD.contains("function applyConfiguredMenu"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuActionsV1"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuDisplayModeV1"));
        assert!(READER_PAGE_HEAD.contains("highlightMenuSizeV1"));
        assert!(READER_PAGE_HEAD.contains("semanticSearch"));
        assert!(READER_PAGE_HEAD.contains("translateResult"));
        assert!(READER_PAGE_HEAD.contains("dictResult"));
        let layout = READER_PAGE_HEAD.find("function showChapter").unwrap();
        let pagination = READER_PAGE_HEAD.find("// ---- 分页几何").unwrap();
        let measurement = READER_PAGE_HEAD.find("// ---- 全书页数").unwrap();
        let annotations = READER_PAGE_HEAD.find("// ---- 高亮/批注 ----").unwrap();
        let runtime = READER_PAGE_HEAD.find("// ---- 朗读").unwrap();
        assert!(
            layout < pagination
                && pagination < measurement
                && measurement < annotations
                && annotations < runtime
        );
    }
}
