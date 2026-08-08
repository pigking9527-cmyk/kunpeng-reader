const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const styles = fs.readFileSync(path.join(ui, "styles.css"), "utf8");

test("library AI settings header has no device-only subtitle", () => {
  assert.doesNotMatch(html, /只保存在这台设备。/);
});
const controller = fs.readFileSync(path.join(ui, "library-ai.js"), "utf8");
const entry = fs.readFileSync(path.join(ui, "library-ai-entry.js"), "utf8");
const backend = fs.readFileSync(path.join(ui, "..", "src", "ai_reader.rs"), "utf8");

test("library assistant is mounted inside the main window content area", () => {
  assert.match(html, /id="library-ai-page"/);
  assert.match(html, /id="library-ai-back"/);
  assert.match(html, /<script src="library-ai\.js"><\/script>/);
  assert.match(html, /<script src="library-ai-entry\.js"><\/script>/);
  assert.match(styles, /\.library-ai-page\s*\{/);
  assert.match(styles, /\.library-ai-grid\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /@media \(max-width: 760px\)/);
});

test("library answer length is local while the fixed shell keeps scrolling inside each column", () => {
  assert.match(html, /id="library-ai-answer-settings"/);
  assert.match(html, /id="library-ai-answer-settings-overlay"/);
  assert.match(html, /id="library-ai-answer-settings-panel"/);
  assert.match(html, /id="library-ai-answer-settings"[^>]*data-i18n="answerSettings"/);
  const answerSettingsPanel = html.match(/id="library-ai-answer-settings-panel"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(answerSettingsPanel, /id="library-ai-font-decrease"/);
  assert.match(answerSettingsPanel, /id="library-ai-font-size"/);
  assert.match(answerSettingsPanel, /id="library-ai-font-increase"/);
  assert.match(answerSettingsPanel, /id="library-ai-long-context"/);
  assert.match(answerSettingsPanel, /复杂问题长文精读（BGE-M3）/);
  assert.match(answerSettingsPanel, /role="switch"/);
  assert.doesNotMatch(answerSettingsPanel, /回答、历史记录和引用内容的显示大小/);
  const libraryActions = html.match(/<div class="library-ai-actions">[\s\S]*?<\/div>/)?.[0] || "";
  assert.doesNotMatch(libraryActions, /library-ai-font-controls/);
  assert.match(html, /data-answer-length="short"/);
  assert.match(html, /data-answer-length="medium"/);
  assert.match(html, /data-answer-length="long"/);
  assert.doesNotMatch(html, /data-i18n="libraryDescription"/);
  assert.match(controller, /invoke\("library_answer_settings"\)/);
  assert.match(controller, /invoke\("set_library_answer_length"/);
  assert.match(controller, /function saveLongContext/);
  assert.match(controller, /invoke\("set_semantic_m3_long_context"/);
  assert.match(controller, /function longContextSetupPath/);
  assert.match(controller, /longContextSetupPath/);
  assert.match(controller, /function showLongContextHelp/);
  assert.match(controller, /function renderAnswerLengthSettings/);
  assert.match(controller, /library-ai-answer-settings-overlay/);
  assert.match(backend, /LIBRARY_ANSWER_LENGTH_KEY/);
  assert.match(backend, /LibraryAnswerLength/);
  assert.match(backend, /library_answer_settings/);
  assert.match(backend, /set_library_answer_length/);
  assert.match(styles, /\.library-ai-page\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.library-ai-page\[hidden\]\s*\{[^}]*display:none/s);
  assert.match(styles, /\.library-ai-page-inner\s*\{[^}]*flex-direction:column/s);
  assert.match(styles, /\.library-ai-grid\s*\{[^}]*min-height:0/s);
  assert.match(styles, /\.library-ai-scope\s*\{[^}]*overflow:hidden/s);
  assert.match(styles, /\.library-ai-books\s*\{[^}]*flex:1 1 auto[^}]*overflow:auto/s);
  assert.match(styles, /\.library-ai-workspace\s*\{[^}]*overflow-y:auto/s);
  assert.match(styles, /\.library-ai-answer\s*\{[^}]*flex:0 0 auto[^}]*overflow:visible/s);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.library-ai-page\s*\{[^}]*overflow-y:auto/s);
  assert.match(styles, /\.library-ai-answer-settings-overlay\s*\{[^}]*position:fixed/s);
  assert.match(styles, /\.library-ai-answer-toggle\s*\{[^}]*border-radius:999px/s);
});

test("library assistant opens lazily in the main window and can return to the shelf", () => {
  assert.match(entry, /shell\.hidden = true/);
  assert.match(entry, /page\.hidden = false/);
  assert.match(entry, /initialLoad = assistant\.load\(\)/);
  assert.match(entry, /await initialLoad/);
  assert.match(entry, /await assistant\.refreshBooks\(\)/);
  assert.match(controller, /async function refreshBooks\(\)[\s\S]*?invoke\("list_books"\)/);
  assert.match(controller, /return \{ load, refreshBooks,/);
  assert.match(entry, /page\.hidden = true/);
  assert.match(entry, /shell\.hidden = false/);
  assert.match(entry, /event\.key === "Escape"/);
  assert.doesNotMatch(entry, /open_library_ai_window/);
  assert.match(controller, /function init\(/);
  assert.match(controller, /initialized lazily/);
});

test("library assistant gives multi-stage RAG calls enough time without allowing unbounded answers", () => {
  assert.match(backend, /READING_PROVIDER_RESPONSE_TIMEOUT[^\n]*from_secs\(120\)/);
  assert.match(backend, /READING_PROVIDER_MAX_TOKENS: u16 = 1_600/);
  assert.match(backend, /LIBRARY_SYNTHESIS_PROVIDER_MAX_TOKENS: u16 = 4_096/);
  assert.match(backend, /"max_tokens": provider_max_tokens\(&task\)/);
  assert.match(backend, /fn provider_max_tokens\(task: &str\)/);
  assert.doesNotMatch(backend, /timeout_recv_response\(Some\(std::time::Duration::from_secs\(45\)\)\)/);
});

test("library question Enter submits while Shift+Enter keeps a newline", () => {
  assert.match(controller, /event\.key === "Enter" && !event\.shiftKey && !event\.isComposing && event\.keyCode !== 229/);
  assert.match(controller, /event\.preventDefault\(\);\s*void run\(\);/);
});

test("library question input has a copy-cut-paste-only right-click menu", () => {
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  assert.match(app, /contextmenu", \(e\) => e\.preventDefault\(\)/);
  assert.match(controller, /function showQuestionContextMenu/);
  assert.match(controller, /addAction\(i18n\("copy", "复制"\)/);
  assert.match(controller, /addAction\(i18n\("cut", "剪切"\)/);
  assert.match(controller, /addAction\(i18n\("paste", "粘贴"\)/);
  assert.match(controller, /question\.setRangeText\("", start, end, "start"\)/);
  assert.match(controller, /navigator\?\.clipboard\?\.readText/);
  assert.match(styles, /\.library-ai-question-menu\s*\{/);
});

test("library assistant toolbar toggles back to the shelf when it is already open", () => {
  assert.match(entry, /function toggle\(\) \{\s*if \(page\.hidden\) \{\s*void open\(\);\s*\} else \{\s*close\(\);/s);
  assert.match(entry, /button\.addEventListener\("click", toggle\)/);
});

test("library assistant keeps whole-library as the unselected default and offers scoped selection tools", () => {
  assert.match(html, /id="scope-summary"[^>]*>当前范围：全部书库/);
  assert.match(html, /id="clear-selection"[^>]*>取消限定/);
  assert.match(html, /id="select-visible"[^>]*>全选当前列表/);
  assert.match(html, /id="invert-visible"[^>]*>反选当前列表/);
  assert.doesNotMatch(html, />检索范围<|展示最相关的前 20 本（每本 1 段）/);
  assert.match(controller, /const selectedBookIds = new Set\(\)/);
  assert.match(controller, /const MAX_QUESTION_SOURCES = 20/);
  assert.match(controller, /function selectVisibleBooks\(\)/);
  assert.match(controller, /function invertVisibleBooks\(\)/);
  assert.match(controller, /正在检索全部书库，并筛选可支撑回答的文本证据/);
  assert.match(controller, /selectedBookIdsForRequest = selectedIds\(\)/);
  assert.match(controller, /selectedBookIds: selectedBookIdsForRequest/);
});

test("library assistant supports tag and collection quick filters", () => {
  assert.match(html, /id="tag-filter"/);
  assert.match(html, /id="collection-filter"/);
  assert.match(html, /id="library-ai-book-search"[^>]*data-i18n-placeholder="bookSelectorPlaceholder"/);
  assert.doesNotMatch(html, /library-ai-filter-tip/);
  assert.match(controller, /tagsForBook/);
  assert.match(controller, /book\.tags/);
  assert.match(controller, /book\.modelTags/);
  assert.match(controller, /book\.collections/);
  assert.match(controller, /book\.description, book\.summary, \.\.\.tagsForBook\(book\)/);
  assert.match(controller, /library-ai-book-search"\)\.addEventListener\("input", renderBooks\)/);
  assert.match(controller, /bookCountFiltered/);
  assert.match(styles, /\.library-ai-book-search\s*\{/);
});

test("library assistant can choose one of the locally configured large models", () => {
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  const apiSettings = fs.readFileSync(path.join(ui, "api-settings-ui.js"), "utf8");
  const reader = fs.readFileSync(path.join(ui, "reader.js"), "utf8");
  const readerHtml = fs.readFileSync(path.join(ui, "reader.html"), "utf8");
  const annotations = fs.readFileSync(path.join(ui, "reader-page-annotations.js"), "utf8");
  const translate = fs.readFileSync(path.join(ui, "..", "src", "translate.rs"), "utf8");
  const commands = fs.readFileSync(path.join(ui, "..", "src", "app_commands.rs"), "utf8");
  assert.match(html, /id="api-settings-open"/);
  assert.match(html, /id="api-settings-modal"/);
  assert.match(html, /id="api-ai-profile"/);
  assert.match(html, /id="api-ai-preset"[\s\S]*?DeepSeek[\s\S]*?OpenAI（GPT）[\s\S]*?Anthropic（Claude）[\s\S]*?OpenAI 兼容接口/);
  assert.match(html, /id="api-translation-provider"/);
  assert.match(html, /id="library-ai-model-profile"/);
  assert.match(html, /<script src="api-settings-ui\.js"><\/script>/);
  assert.match(app, /ReaderApiSettingsUI\?\.init\(\{ invoke \}\)/);
  assert.match(apiSettings, /invoke\("ai_reader_profiles"\)/);
  assert.match(apiSettings, /invoke\("save_ai_reader_profile"/);
  assert.match(apiSettings, /invoke\("translation_credentials_status"\)/);
  assert.match(apiSettings, /notifyProfilesChanged/);
  assert.doesNotMatch(apiSettings, /api-ai-new/);
  assert.match(controller, /function renderModelProfiles/);
  assert.match(controller, /select_ai_reader_profile/);
  assert.match(html, /library-ai-head-actions[\s\S]*?id="library-ai-model-profile"/);
  assert.match(readerHtml, /id="ai-reader-profile"/);
  assert.match(reader, /renderAiReaderProfiles/);
  assert.match(annotations, /getTranslationProfiles/);
  assert.match(annotations, /function applyTranslationProfiles/);
  assert.match(backend, /CONFIG_PROFILES_KEY/);
  assert.match(backend, /fn persist_profiles/);
  assert.match(backend, /profile_summary_never_exposes_the_api_key/);
  assert.match(translate, /TRANSLATION_ACTIVE_PROVIDER_KEY/);
  assert.match(translate, /fn translation_credentials_status/);
  assert.match(commands, /translation_credentials_status/);
});

test("library assistant readiness stays quiet when API and local indexes are available", () => {
  assert.match(controller, /function readinessMessage\(aiStatus, semanticStatus\)/);
  assert.match(controller, /invoke\("semantic_status"\)/);
  assert.match(controller, /semanticStatus\?\.semantic_done/);
  assert.match(controller, /if \(apiReady && indexReady\) return ""/);
  assert.match(controller, /配置大模型 API、模型和密钥/);
  assert.match(controller, /为本地图书建立语义索引/);
  assert.doesNotMatch(controller, /智读已配置。建立语义索引后即可检索。/);
});

test("library assistant classifies model tags with progress and can use them independently from manual tags", () => {
  assert.match(html, /id="library-ai-classify"[^>]*>书籍分类/);
  assert.match(html, /id="library-ai-classify-status"[^>]*hidden/);
  assert.doesNotMatch(html, /本地资料不足时，会检索百度和豆瓣读书/);
  assert.match(controller, /start_library_auto_classification/);
  assert.match(controller, /library_profile_status/);
  assert.match(controller, /library_profile_coverage_status/);
  assert.match(controller, /完成：\$\{total\} 本图书的分类/);
  assert.match(controller, /button\.title = label/);
  assert.match(controller, /未覆盖完整八维/);
  assert.match(backend, /LibraryClassification/);
  assert.match(backend, /library_book_classify/);
  assert.match(backend, /model_tags_by_book/);
  assert.match(backend, /boost_results_with_profiles/);
  assert.match(backend, /needsWebSearch/);
  assert.match(backend, /public_catalog_evidence/);
  assert.match(backend, /LIBRARY_WEB_LOOKUP_EVERY_BOOKS/);
  assert.match(backend, /LIBRARY_WEB_LOOKUP_DELAY/);
  assert.match(backend, /PendingLibraryWebClassification/);
  assert.match(backend, /LIBRARY_PROFILE_DIMENSIONS/);
  assert.match(backend, /profile_has_all_dimensions/);
  assert.match(backend, /profile_is_settled/);
  assert.match(backend, /library_classification_checkpoint/);
  assert.match(backend, /enqueue_or_resume/);
  assert.match(backend, /library_profile_coverage_status/);
  assert.match(backend, /豆瓣读书/);
  assert.doesNotMatch(html, /library-ai-tag-mode/);
  assert.doesNotMatch(html, /library-ai-promote-tags/);
  assert.doesNotMatch(controller, /promote_library_dark_tags/);
  assert.doesNotMatch(backend, /promote_library_dark_tags/);
  assert.match(styles, /\.library-ai-classify\s*\{[^}]*white-space:nowrap/s);
  assert.match(styles, /\.library-ai-classify-status\s*\{[^}]*text-overflow:ellipsis/s);
  assert.match(controller, /task\?\.state === "paused"/);
  assert.match(controller, /从已保存的位置继续/);
});

test("common settings can opt into model classification tags without changing their sync behavior", () => {
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  assert.match(html, /id="set-use-model-tags"/);
  assert.match(html, /使用大模型分类的标签/);
  assert.match(app, /library_model_tags_settings/);
  assert.match(app, /set_library_model_tags_enabled/);
  assert.match(app, /library-model-tags-setting-changed/);
  assert.match(backend, /LIBRARY_MODEL_TAGS_ENABLED_KEY/);
  assert.match(backend, /materialize_library_profiles_into_model_tags/);
  assert.match(backend, /大模型标签始终参与问答/);
});

test("book information manages manual tags and shows model tags with an explicit source marker", () => {
  const app = fs.readFileSync(path.join(ui, "app.js"), "utf8");
  const reader = fs.readFileSync(path.join(ui, "reader.js"), "utf8");
  assert.match(app, /bookOrganizationUI\.open\(currentInfoBookId, m\)/);
  assert.match(app, /renderBookInfoTags\(document\.getElementById\("book-info-model-tags"\), \[\], m\.model_tags \|\| m\.modelTags\)/);
  assert.match(reader, /renderBookInfoTags\(document\.getElementById\("info-tags"\), m\.tags, m\.model_tags \|\| m\.modelTags\)/);
  assert.match(app, /info-chip-origin/);
  assert.match(styles, /\.info-chip\.model-tag/);
});

test("question keeps twenty diverse sources while comparison remains bounded", () => {
  assert.match(controller, /const MAX_COMPARE_BOOKS = 8/);
  assert.match(backend, /const MAX_LIBRARY_QUESTION_SOURCES: usize = 20/);
  assert.match(backend, /const MAX_LIBRARY_COMPARE_BOOKS: usize = 8/);
  assert.match(backend, /const MAX_LIBRARY_COMPARE_SOURCES: usize = 8/);
  assert.match(backend, /fn full_library_semantic_scope/);
  assert.match(backend, /library_question_keeps_the_top_twenty_distinct_books/);
  assert.match(backend, /library_question_never_repeats_a_book_when_results_are_duplicated/);
  assert.match(backend, /library_evidence_filter/);
  assert.match(backend, /library_single_book_evidence_filter/);
  assert.match(backend, /library_single_book_question/);
  assert.match(backend, /library_single_book_verify/);
  assert.match(backend, /library_question_verify/);
  assert.match(backend, /library_compare_verify/);
  assert.match(backend, /single_book_depth_search/);
  assert.match(backend, /select_single_book_sources/);
  assert.match(backend, /implicit_single_book_id/);
  assert.match(backend, /explicit_book_titles/);
  assert.match(backend, /parse_deep_source_ids/);
  assert.match(controller, /书内多轮检索、证据筛选与自检/);
  assert.match(controller, /单书深度依据/);
  assert.match(controller, /正在识别题中书名/);
  assert.match(controller, /answer\.singleBook/);
});

test("answer citations render as hoverable, clickable source footnotes", () => {
  assert.match(html, /id="source-preview"/);
  assert.match(html, /id="source-preview-open"/);
  assert.match(controller, /function renderAnswer\(content, sources, \{ hideDirectAnswerHeading = false \} = \{\}\)/);
  assert.match(controller, /const token = \/\\\[来源\\s\*\(\\d\+\)\\\]\|\\\*\\\*\(\[\^\*\\n\]\+\)\\\*\\\*\/g/);
  assert.match(controller, /footnote\.addEventListener\("pointerenter"/);
  assert.match(controller, /showSourcePreview\(source, index, true,/);
  assert.doesNotMatch(controller, /footnote\.title/);
  assert.match(styles, /\.library-ai-footnote\s*\{/);
  assert.match(styles, /\.library-ai-source-preview\s*\{/);
  assert.match(styles, /\.library-ai-source-preview\s*\{[^}]*position:fixed/s);
});

test("library answers render a safe subset of Markdown instead of exposing raw markers", () => {
  assert.match(controller, /function appendAnswerInline\(parent, text, sources\)/);
  assert.match(controller, /heading\[1\]\.length === 1 \? "h3" : "h4"/);
  assert.match(controller, /appendListItem\("ul", bullet\[1\]\)/);
  assert.match(controller, /root\.createElement\("strong"\)/);
  assert.match(styles, /\.library-ai-answer h3/);
  assert.match(styles, /\.library-ai-answer-list/);
  assert.doesNotMatch(controller, /answerEl\.innerHTML/);
});

test("library answer provider accepts compatible response envelopes and retries an empty completion", () => {
  assert.doesNotMatch(backend, /pointer\("\/choices\/0\/message\/reasoning_content"\)/);
  assert.match(backend, /data\/choices\/0\/message\/content/);
  assert.match(backend, /Response\/Choices\/0\/Message\/Content/);
  assert.match(backend, /async fn call_library_answer_with_retry/);
  assert.match(backend, /MAX_READING_RETRY_CONTEXT_CHARS/);
  assert.match(backend, /fn is_final_library_verification/);
  assert.match(backend, /internal-review language/);
});

test("library answers save locally and can sync a de-identified history", () => {
  assert.match(html, /id="library-ai-history"[^>]*>问答记录/);
  assert.match(html, /同步单书智读历史[\s\S]*书库问答请在其设置中选择同步方式/);
  assert.match(controller, /private_sync_library_history_list/);
  assert.match(controller, /private_sync_library_history_merge/);
  assert.match(controller, /private_sync_library_history_delete/);
  assert.match(controller, /删除书库问答记录/);
  assert.match(controller, /HISTORY_SOURCES_KEY/);
  assert.match(controller, /writeLocalHistorySources/);
  assert.match(controller, /historySourcesForDisplay/);
  assert.match(controller, /recoverLegacyHistorySources/);
  assert.match(controller, /library_history_source_preview/);
  assert.match(controller, /contentId \|\| book\.content_id/);
  assert.match(controller, /replace\(\/\[《》〈〉“”‘’「」『』"'\]\//);
  assert.match(controller, /原书未加入本机书架或已从本机书架移除/);
  assert.match(controller, /function portableSourceReference\(source\)/);
  assert.match(controller, /bookTitle/);
  assert.match(controller, /sourceKind/);
  assert.doesNotMatch(controller.match(/function portableSourceReference\(source\)[\s\S]*?\n    }/)[0], /excerpt/);
  assert.doesNotMatch(controller.match(/function portableSourceReference\(source\)[\s\S]*?\n    }/)[0], /bookId/);
  assert.match(controller, /问答已保存到本机/);
  assert.match(controller, /下次同步时上传/);
  assert.match(controller, /HISTORY_LAYOUT_KEY/);
  assert.match(controller, /function applyHistoryLayout\(list, button, save = false\)/);
  assert.match(controller, /historyLayout === "grid" \? "list" : "grid"/);
  assert.match(controller, /icon\.className = grid \? "library-ai-history-grid-icon" : "library-ai-history-list-icon"/);
  assert.match(controller, /i18n\("historyGridToList"/);
  assert.match(controller, /i18n\("historyListToGrid"/);
  assert.match(controller, /localStorage\?\.setItem\(HISTORY_LAYOUT_KEY, historyLayout\)/);
  assert.match(controller, /function historyAnswerSummary\(entry\)/);
  assert.match(controller, /summary\.textContent = historyAnswerSummary\(entry\)/);
  assert.doesNotMatch(controller, /const sourceCount = Array\.isArray\(entry\.sources\)/);
  assert.doesNotMatch(controller, /const at = entry\.at \? new Date\(entry\.at\)/);
  assert.doesNotMatch(controller, /已将书库问答设为/);
  assert.match(controller, /function renderAnswer\(content, sources, \{ hideDirectAnswerHeading = false \} = \{\}\)/);
  assert.match(controller, /hideDirectAnswerHeading && heading\[2\]\.trim\(\) === "直接回答"/);
  assert.match(controller, /renderAnswer\(entry\.content, sources, \{ hideDirectAnswerHeading: true \}\)/);
  assert.doesNotMatch(controller, /renderLibraryHistoryAnswer/);
  assert.match(styles, /\.library-ai-history-list\s*\{/);
  assert.match(styles, /\.library-ai-history-toolbar\s*\{/);
  assert.match(styles, /\.library-ai-history-grid-icon::before\s*\{/);
  assert.match(styles, /\.library-ai-history-list-icon\s*\{/);
  assert.match(styles, /\.library-ai-history-list\.grid\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /\.library-ai-history-summary\s*\{/);
  assert.match(styles, /\.library-ai-history-delete\s*\{/);
  assert.doesNotMatch(styles, /\.library-ai-history-question-detail\s*\{/);
});

test("library answer history exposes its own optional cloud sync modes", () => {
  assert.match(html, /data-library-history-sync="off"/);
  assert.match(html, /data-library-history-sync="recent"/);
  assert.match(html, /data-library-history-sync="manual"/);
  assert.match(controller, /private_sync_set_library_history_mode/);
  assert.match(controller, /private_sync_set_library_history_cloud_saved/);
  assert.match(controller, /cloud\.textContent = "云端"/);
  assert.match(controller, /historySyncMode === "manual"/);
  assert.match(styles, /\.library-ai-history-cloud\s*\{/);
  assert.match(styles, /\.library-ai-history-sync-status\.is-synced/);
  assert.match(styles, /\.library-ai-history-sync-status\.is-local/);
});
test("library assistant no longer creates a separate WebView", () => {
  assert.doesNotMatch(backend, /open_library_ai_window/);
  assert.doesNotMatch(backend, /library-ai\.html/);
});

test("library answer font size is adjusted in place and remembered locally", () => {
  assert.match(html, /id="library-ai-font-decrease"/);
  assert.match(html, /id="library-ai-font-size"/);
  assert.match(html, /id="library-ai-font-increase"/);
  assert.match(controller, /ANSWER_FONT_SIZE_KEY = "libraryAiAnswerFontSizeV1"/);
  assert.match(controller, /function applyAnswerFontSize\(save = false\)/);
  assert.match(controller, /localStorage\?\.setItem\(ANSWER_FONT_SIZE_KEY/);
  assert.match(styles, /--library-ai-answer-font-size/);
  assert.match(styles, /\.library-ai-font-controls\s*\{/);
});
