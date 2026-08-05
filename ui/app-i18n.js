// 主窗口本地化的单一入口。新增界面只需加 data-i18n，不把语言选择变成
// 只有下拉框、没有实际界面变化的假设置。
(function (global) {
  const STORAGE_KEY = "appLanguageV1";
  const LANGUAGES = [
    ["system", "跟随系统"], ["zh-CN", "简体中文"], ["zh-TW", "繁體中文"],
    ["en", "English"], ["ja", "日本語"], ["ko", "한국어"],
    ["fr", "Français"], ["de", "Deutsch"], ["es", "Español"],
    ["ru", "Русский"], ["pt-BR", "Português (Brasil)"],
  ];
  const COPY = {
    "zh-CN": { commonSettings: "常用设置", language: "语言", followSystem: "跟随系统", displayProgress: "显示阅读进度", displayRating: "显示评分", displayTitle: "显示书名", animation: "动画", autoImport: "自动导入目录", semanticIndex: "语义索引", modelTags: "使用大模型分类的标签", modelAndTranslation: "大模型与翻译 API", singleClickOpen: "单击打开图书", dictionary: "词典", news: "资讯", settings: "设置", menu: "菜单", readingStats: "阅读统计", libraryQa: "书库问答", importBooks: "导入书籍", about: "关于", randomBook: "随机打开一本书", notes: "笔记汇总", libraryHealth: "书库体检", selectAll: "全选（批量删除）" },
    "zh-TW": { commonSettings: "常用設定", language: "語言", followSystem: "跟隨系統", displayProgress: "顯示閱讀進度", displayRating: "顯示評分", displayTitle: "顯示書名", animation: "動畫", autoImport: "自動匯入目錄", semanticIndex: "語意索引", modelTags: "使用大模型分類的標籤", modelAndTranslation: "大模型與翻譯 API", singleClickOpen: "單擊開啟圖書", dictionary: "詞典", news: "資訊", settings: "設定", menu: "選單", readingStats: "閱讀統計", libraryQa: "書庫問答", importBooks: "匯入書籍", about: "關於", randomBook: "隨機開啟一本書", notes: "筆記彙總", libraryHealth: "書庫健檢", selectAll: "全選（批量刪除）" },
    en: { commonSettings: "General settings", language: "Language", followSystem: "Follow system", displayProgress: "Show reading progress", displayRating: "Show rating", displayTitle: "Show title", animation: "Animation", autoImport: "Auto-import folders", semanticIndex: "Semantic index", modelTags: "Use AI classification tags", modelAndTranslation: "AI & translation API", singleClickOpen: "Open books with one click", dictionary: "Dictionary", news: "News", settings: "Settings", menu: "Menu", readingStats: "Reading statistics", libraryQa: "Library Q&A", importBooks: "Import books", about: "About", randomBook: "Open a random book", notes: "Notes", libraryHealth: "Library health", selectAll: "Select all (bulk delete)" },
    ja: { commonSettings: "一般設定", language: "言語", followSystem: "システムに従う", displayProgress: "読書進捗を表示", displayRating: "評価を表示", displayTitle: "書名を表示", animation: "アニメーション", autoImport: "フォルダーを自動取り込み", semanticIndex: "セマンティック索引", modelTags: "AI分類タグを使用", modelAndTranslation: "AI・翻訳 API", singleClickOpen: "ワンクリックで本を開く", dictionary: "辞書", news: "ニュース", settings: "設定", menu: "メニュー", readingStats: "読書統計", libraryQa: "ライブラリ Q&A", importBooks: "本をインポート", about: "情報", randomBook: "ランダムに本を開く", notes: "ノート", libraryHealth: "ライブラリ診断", selectAll: "すべて選択（削除）" },
    ko: { commonSettings: "일반 설정", language: "언어", followSystem: "시스템 따르기", displayProgress: "읽기 진행률 표시", displayRating: "평점 표시", displayTitle: "책 제목 표시", animation: "애니메이션", autoImport: "폴더 자동 가져오기", semanticIndex: "시맨틱 색인", modelTags: "AI 분류 태그 사용", modelAndTranslation: "AI 및 번역 API", singleClickOpen: "한 번 클릭해 책 열기", dictionary: "사전", news: "뉴스", settings: "설정", menu: "메뉴", readingStats: "독서 통계", libraryQa: "라이브러리 Q&A", importBooks: "책 가져오기", about: "정보", randomBook: "무작위 책 열기", notes: "노트", libraryHealth: "라이브러리 점검", selectAll: "모두 선택 (일괄 삭제)" },
    fr: { commonSettings: "Paramètres généraux", language: "Langue", followSystem: "Suivre le système", displayProgress: "Afficher la progression", displayRating: "Afficher la note", displayTitle: "Afficher le titre", animation: "Animations", autoImport: "Importer les dossiers automatiquement", semanticIndex: "Index sémantique", modelTags: "Utiliser les étiquettes IA", modelAndTranslation: "API IA et traduction", singleClickOpen: "Ouvrir les livres en un clic", dictionary: "Dictionnaire", news: "Actualités", settings: "Paramètres", menu: "Menu", readingStats: "Statistiques de lecture", libraryQa: "Questions-réponses", importBooks: "Importer des livres", about: "À propos", randomBook: "Ouvrir un livre au hasard", notes: "Notes", libraryHealth: "État de la bibliothèque", selectAll: "Tout sélectionner (suppression)" },
    de: { commonSettings: "Allgemeine Einstellungen", language: "Sprache", followSystem: "Systemsprache verwenden", displayProgress: "Lesefortschritt anzeigen", displayRating: "Bewertung anzeigen", displayTitle: "Buchtitel anzeigen", animation: "Animation", autoImport: "Ordner automatisch importieren", semanticIndex: "Semantischer Index", modelTags: "KI-Klassifizierungs-Tags verwenden", modelAndTranslation: "KI- und Übersetzungs-API", singleClickOpen: "Bücher mit einem Klick öffnen", dictionary: "Wörterbuch", news: "Nachrichten", settings: "Einstellungen", menu: "Menü", readingStats: "Lesestatistik", libraryQa: "Bibliotheksfragen", importBooks: "Bücher importieren", about: "Über", randomBook: "Zufälliges Buch öffnen", notes: "Notizen", libraryHealth: "Bibliotheksprüfung", selectAll: "Alles auswählen (löschen)" },
    es: { commonSettings: "Ajustes generales", language: "Idioma", followSystem: "Seguir al sistema", displayProgress: "Mostrar progreso de lectura", displayRating: "Mostrar valoración", displayTitle: "Mostrar título", animation: "Animación", autoImport: "Importar carpetas automáticamente", semanticIndex: "Índice semántico", modelTags: "Usar etiquetas de clasificación con IA", modelAndTranslation: "API de IA y traducción", singleClickOpen: "Abrir libros con un clic", dictionary: "Diccionario", news: "Noticias", settings: "Ajustes", menu: "Menú", readingStats: "Estadísticas de lectura", libraryQa: "Preguntas de biblioteca", importBooks: "Importar libros", about: "Acerca de", randomBook: "Abrir un libro al azar", notes: "Notas", libraryHealth: "Diagnóstico de biblioteca", selectAll: "Seleccionar todo (eliminar)" },
    ru: { commonSettings: "Общие настройки", language: "Язык", followSystem: "Как в системе", displayProgress: "Показывать прогресс", displayRating: "Показывать оценку", displayTitle: "Показывать название", animation: "Анимация", autoImport: "Автоимпорт папок", semanticIndex: "Семантический индекс", modelTags: "Использовать теги ИИ", modelAndTranslation: "ИИ и API перевода", singleClickOpen: "Открывать книги одним щелчком", dictionary: "Словарь", news: "Новости", settings: "Настройки", menu: "Меню", readingStats: "Статистика чтения", libraryQa: "Вопросы к библиотеке", importBooks: "Импортировать книги", about: "О программе", randomBook: "Открыть случайную книгу", notes: "Заметки", libraryHealth: "Проверка библиотеки", selectAll: "Выбрать все (удалить)" },
    "pt-BR": { commonSettings: "Configurações gerais", language: "Idioma", followSystem: "Seguir o sistema", displayProgress: "Mostrar progresso de leitura", displayRating: "Mostrar avaliação", displayTitle: "Mostrar título", animation: "Animação", autoImport: "Importar pastas automaticamente", semanticIndex: "Índice semântico", modelTags: "Usar etiquetas de classificação por IA", modelAndTranslation: "API de IA e tradução", singleClickOpen: "Abrir livros com um clique", dictionary: "Dicionário", news: "Notícias", settings: "Configurações", menu: "Menu", readingStats: "Estatísticas de leitura", libraryQa: "Perguntas da biblioteca", importBooks: "Importar livros", about: "Sobre", randomBook: "Abrir um livro aleatório", notes: "Notas", libraryHealth: "Saúde da biblioteca", selectAll: "Selecionar tudo (excluir)" },
  };
  function selectedLanguage() { return localStorage.getItem(STORAGE_KEY) || "system"; }
  function resolvedLanguage() {
    const selected = selectedLanguage();
    if (selected !== "system") return selected;
    const system = String(navigator.language || "zh-CN").toLowerCase();
    if (system.startsWith("zh-tw") || system.startsWith("zh-hk") || system.startsWith("zh-mo")) return "zh-TW";
    const exact = LANGUAGES.map((item) => item[0]).find((item) => item.toLowerCase() === system);
    return exact || (system.split("-")[0] === "zh" ? "zh-CN" : system.split("-")[0]);
  }
  function t(key) { return (COPY[resolvedLanguage()] || COPY.en)[key] || COPY["zh-CN"][key] || key; }
  function apply(root) {
    const language = resolvedLanguage();
    document.documentElement.lang = language;
    (root || document).querySelectorAll?.("[data-i18n]").forEach((element) => { element.textContent = t(element.dataset.i18n); });
    (root || document).querySelectorAll?.("[data-i18n-title]").forEach((element) => { element.title = t(element.dataset.i18nTitle); });
    (root || document).querySelectorAll?.("[data-i18n-aria]").forEach((element) => { element.setAttribute("aria-label", t(element.dataset.i18nAria)); });
  }
  function populate(select) {
    if (!select) return;
    select.replaceChildren(...LANGUAGES.map(([value, label]) => {
      const option = document.createElement("option"); option.value = value; option.textContent = value === "system" ? t("followSystem") : label; return option;
    }));
    select.value = selectedLanguage();
  }
  function setLanguage(value) {
    localStorage.setItem(STORAGE_KEY, LANGUAGES.some(([id]) => id === value) ? value : "system");
    apply(document);
    document.querySelectorAll(".app-language-select").forEach(populate);
    global.dispatchEvent(new CustomEvent("app-language-changed", { detail: { selected: selectedLanguage(), resolved: resolvedLanguage() } }));
  }
  global.ReaderAppI18n = { STORAGE_KEY, apply, populate, selectedLanguage, resolvedLanguage, setLanguage, t };
  document.addEventListener("DOMContentLoaded", () => apply(document), { once: true });
})(window);
