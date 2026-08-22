// 主窗口本地化的单一入口。新增界面只需加 data-i18n，不把语言选择变成
// 只有下拉框、没有实际界面变化的假设置。

import { ABOUT_FEEDBACK_COPY } from "./about-feedback-catalog.ts";
import { SETTINGS_COPY } from "./settings-catalog.ts";
import { SETTINGS_SUBPAGE_COPY } from "./settings-subpage-catalog.ts";

export type AppLanguage =
  | "system"
  | "zh-CN"
  | "zh-TW"
  | "en"
  | "ja"
  | "ko"
  | "fr"
  | "de"
  | "es"
  | "ru"
  | "pt-BR";

type LocaleCopy = Record<string, string>;
type MutableCopy = Record<string, LocaleCopy>;
type LocaleCatalog = Record<string, LocaleCopy>;

interface StatsCatalog {
  readonly applyChart: (copy: MutableCopy) => void;
  readonly applyDetail: (copy: MutableCopy) => void;
  readonly applyHeatmap: (copy: MutableCopy) => void;
}

interface CopyCatalog {
  readonly apply: (copy: MutableCopy) => void;
}

interface AppI18nRuntime extends Window {
  readonly CustomEvent: RuntimeCustomEventConstructor;
  ReaderAppI18n?: AppI18nApi;
  readonly ReaderAppI18nRerankerCatalog?: Record<string, Readonly<LocaleCopy>>;
  readonly ReaderAppI18nStatsCatalog?: StatsCatalog;
  readonly ReaderAppI18nNewsSurfaceCatalog?: CopyCatalog;
  readonly ReaderAppI18nSemanticRuntimeCatalog?: CopyCatalog;
}

type RuntimeCustomEventConstructor = new <TDetail>(
  type: string,
  eventInitDict?: CustomEventInit<TDetail>,
) => CustomEvent<TDetail>;

function localeCopy(copy: MutableCopy, locale: string): LocaleCopy {
  const value = copy[locale];
  if (!value) throw new Error(`Missing app i18n locale: ${locale}`);
  return value;
}

function asLocaleCatalog(value: object): LocaleCatalog {
  return value as LocaleCatalog;
}

export interface AppI18nApi {
  readonly STORAGE_KEY: "appLanguageV1";
  readonly apply: (root?: Document | Element | null) => void;
  readonly populate: (select: HTMLSelectElement | null | undefined) => void;
  readonly selectedLanguage: () => string;
  readonly resolvedLanguage: () => string;
  readonly setLanguage: (value: string) => void;
  readonly t: (key: string) => string;
  readonly missingKeys: (language: string) => string[];
}

function runtimeFrom(target: unknown): AppI18nRuntime | null {
  if (typeof target !== "object" || target === null) return null;
  const runtime = target as Partial<AppI18nRuntime>;
  return runtime.document && runtime.localStorage && runtime.navigator
    ? (target as AppI18nRuntime)
    : null;
}

export function installAppI18n(
  target: unknown = globalThis,
): AppI18nApi | null {
  const global = runtimeFrom(target);
  if (!global) return null;
  const host: AppI18nRuntime = global;
  const { document, localStorage, navigator } = host;
  const STORAGE_KEY = "appLanguageV1";
  const LANGUAGES: readonly (readonly [AppLanguage, string])[] = [
    ["system", "跟随系统"],
    ["zh-CN", "简体中文"],
    ["zh-TW", "繁體中文"],
    ["en", "English"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["fr", "Français"],
    ["de", "Deutsch"],
    ["es", "Español"],
    ["ru", "Русский"],
    ["pt-BR", "Português (Brasil)"],
  ];
  const COPY: MutableCopy = {
    "zh-CN": {
      commonSettings: "常用设置",
      language: "语言",
      followSystem: "跟随系统",
      displayProgress: "显示阅读进度",
      displayRating: "显示评分",
      displayTitle: "显示书名",
      animation: "动画",
      autoImport: "自动导入",
      semanticIndex: "语义索引",
      modelTags: "使用大模型分类的标签",
      modelAndTranslation: "大模型与翻译 API",
      singleClickOpen: "单击打开图书",
      dictionary: "词典",
      news: "资讯",
      settings: "设置",
      menu: "菜单",
      readingStats: "阅读统计",
      libraryQa: "书库问答",
      importBooks: "导入书籍",
      about: "关于",
      randomBook: "随机打开一本书",
      notes: "笔记汇总",
      libraryHealth: "书库体检",
      selectAll: "全选（批量删除）",
      exitApp: "退出应用",
      exitAppFailed: "无法退出应用，请重试。",
    },
    "zh-TW": {
      commonSettings: "常用設定",
      language: "語言",
      followSystem: "跟隨系統",
      displayProgress: "顯示閱讀進度",
      displayRating: "顯示評分",
      displayTitle: "顯示書名",
      animation: "動畫",
      autoImport: "自動匯入",
      semanticIndex: "語意索引",
      modelTags: "使用大模型分類的標籤",
      modelAndTranslation: "大模型與翻譯 API",
      singleClickOpen: "單擊開啟圖書",
      dictionary: "詞典",
      news: "資訊",
      settings: "設定",
      menu: "選單",
      readingStats: "閱讀統計",
      libraryQa: "書庫問答",
      importBooks: "匯入書籍",
      about: "關於",
      randomBook: "隨機開啟一本書",
      notes: "筆記彙總",
      libraryHealth: "書庫健檢",
      selectAll: "全選（批量刪除）",
      exitApp: "結束應用程式",
      exitAppFailed: "無法結束應用程式，請重試。",
    },
    en: {
      commonSettings: "General settings",
      language: "Language",
      followSystem: "Follow system",
      displayProgress: "Show reading progress",
      displayRating: "Show rating",
      displayTitle: "Show title",
      animation: "Animation",
      autoImport: "Auto import",
      semanticIndex: "Semantic index",
      modelTags: "Use AI classification tags",
      modelAndTranslation: "AI & translation API",
      singleClickOpen: "Open books with one click",
      dictionary: "Dictionary",
      news: "News",
      settings: "Settings",
      menu: "Menu",
      readingStats: "Reading statistics",
      libraryQa: "Library Q&A",
      importBooks: "Import books",
      about: "About",
      randomBook: "Open a random book",
      notes: "Notes",
      libraryHealth: "Library health",
      selectAll: "Select all (bulk delete)",
      exitApp: "Quit application",
      exitAppFailed: "Unable to quit the application. Please try again.",
    },
    ja: {
      commonSettings: "一般設定",
      language: "言語",
      followSystem: "システムに従う",
      displayProgress: "読書進捗を表示",
      displayRating: "評価を表示",
      displayTitle: "書名を表示",
      animation: "アニメーション",
      autoImport: "自動取り込み",
      semanticIndex: "セマンティック索引",
      modelTags: "AI分類タグを使用",
      modelAndTranslation: "AI・翻訳 API",
      singleClickOpen: "ワンクリックで本を開く",
      dictionary: "辞書",
      news: "ニュース",
      settings: "設定",
      menu: "メニュー",
      readingStats: "読書統計",
      libraryQa: "ライブラリ Q&A",
      importBooks: "本をインポート",
      about: "情報",
      randomBook: "ランダムに本を開く",
      notes: "ノート",
      libraryHealth: "ライブラリ診断",
      selectAll: "すべて選択（削除）",
      exitApp: "アプリを終了",
      exitAppFailed: "アプリを終了できません。もう一度お試しください。",
    },
    ko: {
      commonSettings: "일반 설정",
      language: "언어",
      followSystem: "시스템 따르기",
      displayProgress: "읽기 진행률 표시",
      displayRating: "평점 표시",
      displayTitle: "책 제목 표시",
      animation: "애니메이션",
      autoImport: "자동 가져오기",
      semanticIndex: "시맨틱 색인",
      modelTags: "AI 분류 태그 사용",
      modelAndTranslation: "AI 및 번역 API",
      singleClickOpen: "한 번 클릭해 책 열기",
      dictionary: "사전",
      news: "뉴스",
      settings: "설정",
      menu: "메뉴",
      readingStats: "독서 통계",
      libraryQa: "라이브러리 Q&A",
      importBooks: "책 가져오기",
      about: "정보",
      randomBook: "무작위 책 열기",
      notes: "노트",
      libraryHealth: "라이브러리 점검",
      selectAll: "모두 선택 (일괄 삭제)",
      exitApp: "앱 종료",
      exitAppFailed: "앱을 종료할 수 없습니다. 다시 시도하세요.",
    },
    fr: {
      commonSettings: "Paramètres généraux",
      language: "Langue",
      followSystem: "Suivre le système",
      displayProgress: "Afficher la progression",
      displayRating: "Afficher la note",
      displayTitle: "Afficher le titre",
      animation: "Animations",
      autoImport: "Import automatique",
      semanticIndex: "Index sémantique",
      modelTags: "Utiliser les étiquettes IA",
      modelAndTranslation: "API IA et traduction",
      singleClickOpen: "Ouvrir les livres en un clic",
      dictionary: "Dictionnaire",
      news: "Actualités",
      settings: "Paramètres",
      menu: "Menu",
      readingStats: "Statistiques de lecture",
      libraryQa: "Questions-réponses",
      importBooks: "Importer des livres",
      about: "À propos",
      randomBook: "Ouvrir un livre au hasard",
      notes: "Notes",
      libraryHealth: "État de la bibliothèque",
      selectAll: "Tout sélectionner (suppression)",
      exitApp: "Quitter l’application",
      exitAppFailed: "Impossible de quitter l’application. Réessayez.",
    },
    de: {
      commonSettings: "Allgemeine Einstellungen",
      language: "Sprache",
      followSystem: "Systemsprache verwenden",
      displayProgress: "Lesefortschritt anzeigen",
      displayRating: "Bewertung anzeigen",
      displayTitle: "Buchtitel anzeigen",
      animation: "Animation",
      autoImport: "Automatisch importieren",
      semanticIndex: "Semantischer Index",
      modelTags: "KI-Klassifizierungs-Tags verwenden",
      modelAndTranslation: "KI- und Übersetzungs-API",
      singleClickOpen: "Bücher mit einem Klick öffnen",
      dictionary: "Wörterbuch",
      news: "Nachrichten",
      settings: "Einstellungen",
      menu: "Menü",
      readingStats: "Lesestatistik",
      libraryQa: "Bibliotheksfragen",
      importBooks: "Bücher importieren",
      about: "Über",
      randomBook: "Zufälliges Buch öffnen",
      notes: "Notizen",
      libraryHealth: "Bibliotheksprüfung",
      selectAll: "Alles auswählen (löschen)",
      exitApp: "Anwendung beenden",
      exitAppFailed:
        "Die Anwendung konnte nicht beendet werden. Bitte erneut versuchen.",
    },
    es: {
      commonSettings: "Ajustes generales",
      language: "Idioma",
      followSystem: "Seguir al sistema",
      displayProgress: "Mostrar progreso de lectura",
      displayRating: "Mostrar valoración",
      displayTitle: "Mostrar título",
      animation: "Animación",
      autoImport: "Importación automática",
      semanticIndex: "Índice semántico",
      modelTags: "Usar etiquetas de clasificación con IA",
      modelAndTranslation: "API de IA y traducción",
      singleClickOpen: "Abrir libros con un clic",
      dictionary: "Diccionario",
      news: "Noticias",
      settings: "Ajustes",
      menu: "Menú",
      readingStats: "Estadísticas de lectura",
      libraryQa: "Preguntas de biblioteca",
      importBooks: "Importar libros",
      about: "Acerca de",
      randomBook: "Abrir un libro al azar",
      notes: "Notas",
      libraryHealth: "Diagnóstico de biblioteca",
      selectAll: "Seleccionar todo (eliminar)",
      exitApp: "Salir de la aplicación",
      exitAppFailed: "No se pudo salir de la aplicación. Inténtalo de nuevo.",
    },
    ru: {
      commonSettings: "Общие настройки",
      language: "Язык",
      followSystem: "Как в системе",
      displayProgress: "Показывать прогресс",
      displayRating: "Показывать оценку",
      displayTitle: "Показывать название",
      animation: "Анимация",
      autoImport: "Автоимпорт",
      semanticIndex: "Семантический индекс",
      modelTags: "Использовать теги ИИ",
      modelAndTranslation: "ИИ и API перевода",
      singleClickOpen: "Открывать книги одним щелчком",
      dictionary: "Словарь",
      news: "Новости",
      settings: "Настройки",
      menu: "Меню",
      readingStats: "Статистика чтения",
      libraryQa: "Вопросы к библиотеке",
      importBooks: "Импортировать книги",
      about: "О программе",
      randomBook: "Открыть случайную книгу",
      notes: "Заметки",
      libraryHealth: "Проверка библиотеки",
      selectAll: "Выбрать все (удалить)",
      exitApp: "Выйти из приложения",
      exitAppFailed: "Не удалось выйти из приложения. Повторите попытку.",
    },
    "pt-BR": {
      commonSettings: "Configurações gerais",
      language: "Idioma",
      followSystem: "Seguir o sistema",
      displayProgress: "Mostrar progresso de leitura",
      displayRating: "Mostrar avaliação",
      displayTitle: "Mostrar título",
      animation: "Animação",
      autoImport: "Importação automática",
      semanticIndex: "Índice semântico",
      modelTags: "Usar etiquetas de classificação por IA",
      modelAndTranslation: "API de IA e tradução",
      singleClickOpen: "Abrir livros com um clique",
      dictionary: "Dicionário",
      news: "Notícias",
      settings: "Configurações",
      menu: "Menu",
      readingStats: "Estatísticas de leitura",
      libraryQa: "Perguntas da biblioteca",
      importBooks: "Importar livros",
      about: "Sobre",
      randomBook: "Abrir um livro aleatório",
      notes: "Notas",
      libraryHealth: "Saúde da biblioteca",
      selectAll: "Selecionar tudo (excluir)",
      exitApp: "Sair do aplicativo",
      exitAppFailed: "Não foi possível sair do aplicativo. Tente novamente.",
    },
  };
  // ABOUT_FEEDBACK_COPY lives in a typed static catalog module and is bundled into this classic IIFE.
  Object.entries(ABOUT_FEEDBACK_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const STARTUP_ENHANCEMENT_COPY = {
    "zh-CN": {
      startupEnhancement: "启动增强",
      startupEnhancementSettings: "启动增强设置",
      launchAtLogin: "开机自启",
      continueProcessAfterClose: "关闭后继续运行进程",
      continueHighCostAfterClose: "关闭后继续进行语义索引等高消耗任务",
      startupEnhancementNote:
        "开启后，关闭窗口会隐藏软件并保留进程，以便下次快速打开；关闭此项时会立即彻底退出。",
      startupEnhancementHighCostNote:
        "关闭高消耗任务后，语义索引、全文索引和书籍分类等任务会在隐藏窗口时保存检查点并暂停，不会自动续建。",
    },
    "zh-TW": {
      startupEnhancement: "啟動增強",
      startupEnhancementSettings: "啟動增強設定",
      launchAtLogin: "開機自動啟動",
      continueProcessAfterClose: "關閉後繼續執行程序",
      continueHighCostAfterClose: "關閉後繼續進行語意索引等高耗用工作",
      startupEnhancementNote:
        "開啟後，關閉視窗會隱藏軟體並保留程序，以便下次快速開啟；關閉此項時會立即完整退出。",
      startupEnhancementHighCostNote:
        "關閉高耗用工作後，語意索引、全文索引和書籍分類等工作會在隱藏視窗時儲存檢查點並暫停，不會自動續建。",
    },
    en: {
      startupEnhancement: "Startup boost",
      startupEnhancementSettings: "Startup boost settings",
      launchAtLogin: "Launch at sign-in",
      continueProcessAfterClose: "Keep the process running after closing",
      continueHighCostAfterClose:
        "Continue semantic indexing and other intensive tasks after closing",
      startupEnhancementNote:
        "When enabled, closing hides the app and keeps its process for a fast reopen. Turning it off exits completely when the window closes.",
      startupEnhancementHighCostNote:
        "When intensive background work is disabled, semantic indexing, full-text indexing, and book classification save a checkpoint and pause while the window is hidden. They do not resume automatically.",
    },
    ja: {
      startupEnhancement: "起動ブースト",
      startupEnhancementSettings: "起動ブースト設定",
      launchAtLogin: "ログイン時に起動",
      continueProcessAfterClose: "閉じた後もプロセスを実行する",
      continueHighCostAfterClose:
        "閉じた後もセマンティック索引などの高負荷処理を続ける",
      startupEnhancementNote:
        "有効にすると、ウィンドウを閉じてもアプリを非表示にしてプロセスを保持し、次回すばやく開きます。無効の場合は完全に終了します。",
      startupEnhancementHighCostNote:
        "高負荷処理を無効にすると、セマンティック索引、全文索引、書籍分類などはチェックポイントを保存して一時停止し、自動再開しません。",
    },
    ko: {
      startupEnhancement: "시작 부스트",
      startupEnhancementSettings: "시작 부스트 설정",
      launchAtLogin: "로그인 시 자동 시작",
      continueProcessAfterClose: "닫은 후에도 프로세스 실행",
      continueHighCostAfterClose: "닫은 후에도 의미 색인 등 고부하 작업 계속",
      startupEnhancementNote:
        "켜면 창을 닫아도 앱을 숨기고 프로세스를 유지해 다음 실행을 빠르게 합니다. 끄면 창을 닫을 때 완전히 종료합니다.",
      startupEnhancementHighCostNote:
        "고부하 작업을 끄면 의미 색인, 전체 텍스트 색인, 도서 분류 등이 체크포인트를 저장하고 일시 중지되며 자동 재개되지 않습니다.",
    },
    fr: {
      startupEnhancement: "Démarrage accéléré",
      startupEnhancementSettings: "Paramètres du démarrage accéléré",
      launchAtLogin: "Lancer à la connexion",
      continueProcessAfterClose: "Garder le processus actif après la fermeture",
      continueHighCostAfterClose:
        "Continuer l’indexation sémantique et les tâches intensives après la fermeture",
      startupEnhancementNote:
        "Une fois activé, fermer la fenêtre masque l’application et conserve son processus pour une réouverture rapide. Désactivé, la fermeture quitte complètement.",
      startupEnhancementHighCostNote:
        "Si les tâches intensives sont désactivées, l’indexation sémantique, l’indexation plein texte et la classification enregistrent un point de reprise et se mettent en pause sans redémarrage automatique.",
    },
    de: {
      startupEnhancement: "Startbeschleunigung",
      startupEnhancementSettings: "Einstellungen zur Startbeschleunigung",
      launchAtLogin: "Beim Anmelden starten",
      continueProcessAfterClose: "Prozess nach dem Schließen weiter ausführen",
      continueHighCostAfterClose:
        "Semantische Indizierung und andere intensive Aufgaben nach dem Schließen fortsetzen",
      startupEnhancementNote:
        "Wenn aktiviert, wird die App beim Schließen ausgeblendet und der Prozess für ein schnelles erneutes Öffnen beibehalten. Wenn deaktiviert, wird sie vollständig beendet.",
      startupEnhancementHighCostNote:
        "Sind intensive Aufgaben deaktiviert, speichern semantische Indizierung, Volltextindex und Buchklassifizierung einen Prüfpunkt und pausieren ohne automatische Fortsetzung.",
    },
    es: {
      startupEnhancement: "Inicio acelerado",
      startupEnhancementSettings: "Ajustes de inicio acelerado",
      launchAtLogin: "Iniciar al iniciar sesión",
      continueProcessAfterClose: "Mantener el proceso activo después de cerrar",
      continueHighCostAfterClose:
        "Continuar la indexación semántica y otras tareas intensivas después de cerrar",
      startupEnhancementNote:
        "Al activarlo, cerrar oculta la aplicación y mantiene el proceso para volver a abrirla rápidamente. Al desactivarlo, se cierra por completo.",
      startupEnhancementHighCostNote:
        "Si se desactivan las tareas intensivas, la indexación semántica, el índice de texto completo y la clasificación guardan un punto de control y se pausan sin reanudarse automáticamente.",
    },
    ru: {
      startupEnhancement: "Ускоренный запуск",
      startupEnhancementSettings: "Настройки ускоренного запуска",
      launchAtLogin: "Запускать при входе в систему",
      continueProcessAfterClose: "Оставлять процесс запущенным после закрытия",
      continueHighCostAfterClose:
        "Продолжать семантическую индексацию и другие ресурсоёмкие задачи после закрытия",
      startupEnhancementNote:
        "Если включено, закрытие скрывает приложение и сохраняет процесс для быстрого повторного открытия. Если выключено, приложение завершается полностью.",
      startupEnhancementHighCostNote:
        "Если ресурсоёмкие задачи выключены, семантический и полнотекстовый индексы, а также классификация сохраняют контрольную точку и приостанавливаются без автоматического продолжения.",
    },
    "pt-BR": {
      startupEnhancement: "Inicialização rápida",
      startupEnhancementSettings: "Configurações de inicialização rápida",
      launchAtLogin: "Iniciar ao entrar",
      continueProcessAfterClose: "Manter o processo em execução após fechar",
      continueHighCostAfterClose:
        "Continuar a indexação semântica e outras tarefas intensivas após fechar",
      startupEnhancementNote:
        "Quando ativado, fechar oculta o aplicativo e mantém o processo para uma reabertura rápida. Quando desativado, o aplicativo é encerrado completamente.",
      startupEnhancementHighCostNote:
        "Com as tarefas intensivas desativadas, a indexação semântica, o índice de texto completo e a classificação salvam um ponto de controle e pausam sem retomada automática.",
    },
  };
  Object.entries(STARTUP_ENHANCEMENT_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const LOGIN_BACKGROUND_COPY = {
    "zh-CN": {
      launchAtLoginBackground: "开机自启后静默后台运行（不显示界面）",
    },
    "zh-TW": {
      launchAtLoginBackground: "開機自動啟動後於背景靜默執行（不顯示介面）",
    },
    en: {
      launchAtLoginBackground:
        "Start silently in the background after sign-in (do not show a window)",
    },
    ja: {
      launchAtLoginBackground:
        "ログイン時の自動起動後はバックグラウンドで静かに実行（ウィンドウを表示しない）",
    },
    ko: {
      launchAtLoginBackground:
        "로그인 시 자동 시작 후 백그라운드에서 조용히 실행(창을 표시하지 않음)",
    },
    fr: {
      launchAtLoginBackground:
        "Démarrer discrètement en arrière-plan à la connexion (ne pas afficher de fenêtre)",
    },
    de: {
      launchAtLoginBackground:
        "Nach der Anmeldung unauffällig im Hintergrund starten (kein Fenster anzeigen)",
    },
    es: {
      launchAtLoginBackground:
        "Iniciar silenciosamente en segundo plano al iniciar sesión (no mostrar ventana)",
    },
    ru: {
      launchAtLoginBackground:
        "Тихо запускать в фоне при входе (не показывать окно)",
    },
    "pt-BR": {
      launchAtLoginBackground:
        "Iniciar silenciosamente em segundo plano ao entrar (não mostrar janela)",
    },
  };
  Object.entries(LOGIN_BACKGROUND_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const END_RECOMMENDATION_COPY = {
    "zh-CN": "读后推荐",
    "zh-TW": "讀後推薦",
    en: "Post-reading recommendations",
    ja: "読了後に本をおすすめ",
    ko: "완독 후 도서 추천",
    fr: "Recommander des livres après lecture",
    de: "Bücher nach dem Lesen empfehlen",
    es: "Recomendar libros al terminar",
    ru: "Рекомендовать книги после прочтения",
    "pt-BR": "Recomendar livros ao terminar",
  };
  Object.entries(END_RECOMMENDATION_COPY).forEach(([locale, label]) => {
    localeCopy(COPY, locale).endRecommendations = label;
  });
  Object.assign(localeCopy(COPY, "zh-CN"), {
    newsTitle: "今日资讯",
    newsDescription: "按时间归并的轻量资讯流，只在你打开时加载。",
    backToShelf: "返回书架",
    manageSources: "管理来源",
    refresh: "刷新",
    sourceSettings: "资讯来源设置",
    sourceSettingsHint: "勾选想看的来源；选择会同步到已登录设备。",
    sourceSearch: "搜索来源、分类或关键词",
    restoreRecommended: "恢复推荐",
    doneAndRefresh: "完成并刷新",
    layout: "布局",
    listLayout: "横排布局",
    gridLayout: "方格布局",
    mixedOrder: "混合",
    bySourceOrder: "按来源",
    newsCategoryAll: "全部",
    newsSourceSummary: "显示 {count} 个来源",
    newsRecommendedSources: "使用推荐来源",
    newsSelectedSources: "已选 {count} / {max}",
    noMatchingSources: "没有找到匹配的内置来源。",
    maxSources: "最多选择 {max} 个来源。",
    chooseSource: "至少选择一个来源，或使用“恢复推荐”。",
    openWebPage: "打开网页 →",
    noNewsInCategory: "这个分类暂时没有资讯。",
    noNews: "暂无资讯。请刷新，或在“管理来源”中调整显示内容。",
    loadingNews: "加载中…",
    refreshingNews: "刷新中…",
    newsUpdatedAt: "更新于 {time}",
    libraryDescription:
      "先在本机语义索引中检索，再只把命中的少量段落发送到你已配置的智读服务。每条回答都可跳回原书章节。",
    bookClassification: "书籍分类",
    questionHistory: "问答记录",
    localSearchCitations: "本地检索 · 可追溯引文",
    searchScope: "检索范围",
    libraryQuestion: "书库问答",
    crossBookCompare: "跨书对比",
    yourQuestion: "你的问题",
    startQuestion: "开始问答",
    answerPlaceholder:
      "选择范围并输入问题后开始。若没有结果，请先在主窗口的设置中建立语义索引。",
    questionPlaceholder:
      "例如：这些书如何解释清末财政困境？\n跨书对比时：比较选中作品对同一主题的观点与依据。",
    allTags: "全部标签",
    allCollections: "全部收藏夹",
    clearFilters: "清除筛选",
    cancelLimit: "取消限定",
    clearSelection: "清空选择",
    selectVisible: "全选当前列表",
    invertVisible: "反选当前列表",
    noBooks: "书架中还没有图书。",
    noFilteredBooks: "没有符合当前标签和收藏夹的图书。",
    unnamedQuestion: "未命名问答",
    noQuestionHistory: "还没有保存的书库问答。完成一次问答后会自动保存到这里。",
    loadingLibrary: "正在读取书架与智读配置…",
    askInProgress: "检索并问答中…",
    enterQuestion: "请输入问题。",
    libraryQuestionFailed: "书库问答失败。",
    libraryHistory: "问答记录",
    returnToAnswer: "返回本次回答",
    delete: "删除",
    copy: "复制",
    cut: "剪切",
    paste: "粘贴",
  });
  Object.assign(localeCopy(COPY, "zh-TW"), {
    newsTitle: "今日資訊",
    newsDescription: "依時間彙整的輕量資訊流，只在你開啟時載入。",
    backToShelf: "返回書架",
    manageSources: "管理來源",
    refresh: "重新整理",
    sourceSettings: "資訊來源設定",
    sourceSettingsHint: "勾選想看的來源；選擇會同步到已登入裝置。",
    sourceSearch: "搜尋來源、分類或關鍵字",
    restoreRecommended: "恢復推薦",
    doneAndRefresh: "完成並重新整理",
    layout: "版面",
    listLayout: "橫排版面",
    gridLayout: "方格版面",
    mixedOrder: "混合",
    bySourceOrder: "依來源",
    newsCategoryAll: "全部",
    newsSourceSummary: "顯示 {count} 個來源",
    newsRecommendedSources: "使用推薦來源",
    newsSelectedSources: "已選 {count} / {max}",
    noMatchingSources: "沒有找到相符的內建來源。",
    maxSources: "最多選擇 {max} 個來源。",
    openWebPage: "開啟網頁 →",
    noNewsInCategory: "這個分類暫時沒有資訊。",
    noNews: "暫無資訊。請重新整理，或在「管理來源」中調整顯示內容。",
    loadingNews: "載入中…",
    refreshingNews: "重新整理中…",
    newsUpdatedAt: "更新於 {time}",
    libraryDescription:
      "先在本機語意索引中檢索，再只把命中的少量段落傳送到你已設定的智讀服務。每則回答都可跳回原書章節。",
    bookClassification: "書籍分類",
    questionHistory: "問答記錄",
    localSearchCitations: "本機檢索 · 可追溯引文",
    searchScope: "檢索範圍",
    libraryQuestion: "書庫問答",
    crossBookCompare: "跨書比較",
    yourQuestion: "你的問題",
    startQuestion: "開始問答",
    answerPlaceholder:
      "選擇範圍並輸入問題後開始。若沒有結果，請先在主視窗的設定中建立語意索引。",
    questionPlaceholder:
      "例如：這些書如何解釋清末財政困境？\n跨書比較時：比較選中作品對同一主題的觀點與依據。",
    allTags: "全部標籤",
    allCollections: "全部收藏夾",
    clearFilters: "清除篩選",
    cancelLimit: "取消限定",
    clearSelection: "清空選擇",
    selectVisible: "全選目前列表",
    invertVisible: "反選目前列表",
    loadingLibrary: "正在讀取書架與智讀設定…",
    askInProgress: "檢索並問答中…",
    enterQuestion: "請輸入問題。",
    libraryQuestionFailed: "書庫問答失敗。",
    libraryHistory: "問答記錄",
    returnToAnswer: "返回本次回答",
    delete: "刪除",
    copy: "複製",
    cut: "剪下",
    paste: "貼上",
  });
  Object.assign(localeCopy(COPY, "en"), {
    newsTitle: "Today’s news",
    newsDescription:
      "A lightweight, time-ordered news feed that loads only when you open it.",
    backToShelf: "Back to shelf",
    manageSources: "Manage sources",
    refresh: "Refresh",
    sourceSettings: "News sources",
    sourceSettingsHint:
      "Choose the sources you want. Your selection syncs to signed-in devices.",
    sourceSearch: "Search sources, categories, or keywords",
    restoreRecommended: "Restore recommended",
    doneAndRefresh: "Done and refresh",
    layout: "Layout",
    listLayout: "List layout",
    gridLayout: "Grid layout",
    mixedOrder: "Mixed",
    bySourceOrder: "By source",
    newsCategoryAll: "All",
    newsSourceSummary: "Showing {count} sources",
    newsRecommendedSources: "Using recommended sources",
    newsSelectedSources: "Selected {count} / {max}",
    noMatchingSources: "No matching built-in sources.",
    maxSources: "You can select up to {max} sources.",
    chooseSource: "Select at least one source, or restore the recommended set.",
    openWebPage: "Open webpage →",
    noNewsInCategory: "No news in this category yet.",
    noNews: "No news yet. Refresh, or change the sources in Manage sources.",
    loadingNews: "Loading…",
    refreshingNews: "Refreshing…",
    newsUpdatedAt: "Updated {time}",
    libraryDescription:
      "Search the local semantic index first, then send only a few matched passages to your configured AI reading service. Every answer can return to the original chapter.",
    bookClassification: "Book classification",
    questionHistory: "Question history",
    localSearchCitations: "Local search · traceable citations",
    searchScope: "Search scope",
    libraryQuestion: "Library Q&A",
    crossBookCompare: "Cross-book comparison",
    yourQuestion: "Your question",
    startQuestion: "Ask",
    answerPlaceholder:
      "Choose a scope and enter a question. If there are no results, build a semantic index in the main settings first.",
    questionPlaceholder:
      "For example: How do these books explain the late Qing fiscal crisis?\nFor comparison: compare the selected works’ views and evidence on one topic.",
    allTags: "All tags",
    allCollections: "All collections",
    clearFilters: "Clear filters",
    cancelLimit: "Remove limit",
    clearSelection: "Clear selection",
    selectVisible: "Select visible",
    invertVisible: "Invert visible",
    noBooks: "There are no books on the shelf.",
    noFilteredBooks: "No books match the current tags and collections.",
    unnamedQuestion: "Untitled question",
    noQuestionHistory:
      "There is no saved Library Q&A yet. Questions are saved automatically after a successful answer.",
    loadingLibrary: "Loading shelf and AI-reading settings…",
    askInProgress: "Searching and answering…",
    enterQuestion: "Enter a question.",
    libraryQuestionFailed: "Library Q&A failed.",
    libraryHistory: "Question history",
    returnToAnswer: "Return to current answer",
    delete: "Delete",
    copy: "Copy",
    cut: "Cut",
    paste: "Paste",
  });
  // SETTINGS_COPY lives in a typed static catalog module and is bundled into this classic IIFE.
  Object.entries(SETTINGS_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const SETTINGS_LAYOUT_COPY = {
    en: {
      settingsLayoutIntro:
        "Grouped by use case; one category is shown at a time",
      settingsCategories: "Settings categories",
      settingsBasic: "Basic",
      settingsBasicHint: "Language, startup, and global visual behavior",
      settingsShelfImport: "Shelf & import",
      settingsShelfImportHint:
        "Shelf information density, opening behavior, and automatic import",
      settingsReadingInteraction: "Reading & interaction",
      settingsReadingInteractionHint:
        "Input methods, reading aids, and content extensions",
      settingsSmart: "Smart features",
      settingsSmartHint: "Models, indexes, and AI classification",
      settingsDataSystem: "Data & system",
      settingsDataSystemHint:
        "Recovery points, migration, and low-frequency system actions",
      settingsDetail: "Details",
      settingsManageFolders: "Manage folders",
      settingsManage: "Manage",
      settingsFilter: "Filters",
      settingsConfigure: "Configure",
      settingsManageIndex: "Manage index",
      settingsManageServices: "Manage services",
      settingsShelfPreview: "Shelf card preview",
      settingsPreviewBook: "Book title",
      gesture: "Mouse gestures",
    },
    "zh-CN": {
      settingsLayoutIntro: "按使用场景分类，每次只显示一类设置",
      settingsCategories: "设置分类",
      settingsBasic: "基础",
      settingsBasicHint: "软件语言、启动和全局视觉体验",
      settingsShelfImport: "书架与导入",
      settingsShelfImportHint: "控制书架信息密度、打开方式和自动收书",
      settingsReadingInteraction: "阅读与交互",
      settingsReadingInteractionHint: "输入方式、阅读辅助和内容扩展",
      settingsSmart: "智能功能",
      settingsSmartHint: "模型、索引和智能分类集中管理",
      settingsDataSystem: "数据与系统",
      settingsDataSystemHint: "恢复点、迁移和低频系统操作",
      settingsDetail: "详细设置",
      settingsManageFolders: "管理目录",
      settingsManage: "管理",
      settingsFilter: "筛选条件",
      settingsConfigure: "配置",
      settingsManageIndex: "管理索引",
      settingsManageServices: "管理服务",
      settingsShelfPreview: "书架卡片预览",
      settingsPreviewBook: "图书标题",
      gesture: "鼠标手势",
    },
    "zh-TW": {
      settingsLayoutIntro: "依使用情境分類，每次只顯示一類設定",
      settingsCategories: "設定分類",
      settingsBasic: "基礎",
      settingsBasicHint: "軟體語言、啟動與全域視覺體驗",
      settingsShelfImport: "書架與匯入",
      settingsShelfImportHint: "控制書架資訊密度、開啟方式與自動匯入",
      settingsReadingInteraction: "閱讀與互動",
      settingsReadingInteractionHint: "輸入方式、閱讀輔助與內容擴充",
      settingsSmart: "智慧功能",
      settingsSmartHint: "集中管理模型、索引與 AI 分類",
      settingsDataSystem: "資料與系統",
      settingsDataSystemHint: "恢復點、遷移與低頻系統操作",
      settingsDetail: "詳細設定",
      settingsManageFolders: "管理目錄",
      settingsManage: "管理",
      settingsFilter: "篩選條件",
      settingsConfigure: "設定",
      settingsManageIndex: "管理索引",
      settingsManageServices: "管理服務",
      settingsShelfPreview: "書架卡片預覽",
      settingsPreviewBook: "圖書標題",
      gesture: "滑鼠手勢",
    },
    ja: {
      settingsLayoutIntro: "用途別に分類し、1つのカテゴリだけを表示します",
      settingsCategories: "設定カテゴリ",
      settingsBasic: "基本",
      settingsBasicHint: "言語、起動、全体の表示動作",
      settingsShelfImport: "本棚と取り込み",
      settingsShelfImportHint: "本棚の情報量、開き方、自動取り込み",
      settingsReadingInteraction: "読書と操作",
      settingsReadingInteractionHint: "入力方法、読書補助、コンテンツ拡張",
      settingsSmart: "スマート機能",
      settingsSmartHint: "モデル、索引、AI分類をまとめて管理",
      settingsDataSystem: "データとシステム",
      settingsDataSystemHint: "復元ポイント、移行、低頻度のシステム操作",
      settingsDetail: "詳細設定",
      settingsManageFolders: "フォルダー管理",
      settingsManage: "管理",
      settingsFilter: "絞り込み",
      settingsConfigure: "設定",
      settingsManageIndex: "索引を管理",
      settingsManageServices: "サービス管理",
      settingsShelfPreview: "本棚カードのプレビュー",
      settingsPreviewBook: "書名",
      gesture: "マウスジェスチャー",
    },
    ko: {
      settingsLayoutIntro: "사용 목적별로 분류해 한 번에 한 범주만 표시합니다",
      settingsCategories: "설정 범주",
      settingsBasic: "기본",
      settingsBasicHint: "언어, 시작 및 전체 시각 동작",
      settingsShelfImport: "책장 및 가져오기",
      settingsShelfImportHint: "책장 정보 밀도, 열기 방식 및 자동 가져오기",
      settingsReadingInteraction: "읽기 및 상호작용",
      settingsReadingInteractionHint: "입력 방식, 읽기 보조 및 콘텐츠 확장",
      settingsSmart: "스마트 기능",
      settingsSmartHint: "모델, 색인 및 AI 분류 통합 관리",
      settingsDataSystem: "데이터 및 시스템",
      settingsDataSystemHint:
        "복구 지점, 마이그레이션 및 낮은 빈도의 시스템 작업",
      settingsDetail: "세부 설정",
      settingsManageFolders: "폴더 관리",
      settingsManage: "관리",
      settingsFilter: "필터 조건",
      settingsConfigure: "설정",
      settingsManageIndex: "색인 관리",
      settingsManageServices: "서비스 관리",
      settingsShelfPreview: "책장 카드 미리보기",
      settingsPreviewBook: "책 제목",
      gesture: "마우스 제스처",
    },
  };
  Object.keys(COPY).forEach((locale) =>
    Object.assign(
      localeCopy(COPY, locale),
      SETTINGS_LAYOUT_COPY.en,
      asLocaleCatalog(SETTINGS_LAYOUT_COPY)[locale] || {},
    ),
  );
  const SETTINGS_NAVIGATION_COPY = {
    "zh-CN": {
      settingsCollapseNavigation: "收起分类",
      settingsExpandNavigation: "展开分类",
    },
    "zh-TW": {
      settingsCollapseNavigation: "收起分類",
      settingsExpandNavigation: "展開分類",
    },
    en: {
      settingsCollapseNavigation: "Collapse categories",
      settingsExpandNavigation: "Expand categories",
    },
    ja: {
      settingsCollapseNavigation: "カテゴリを折りたたむ",
      settingsExpandNavigation: "カテゴリを展開",
    },
    ko: {
      settingsCollapseNavigation: "범주 접기",
      settingsExpandNavigation: "범주 펼치기",
    },
    fr: {
      settingsCollapseNavigation: "Réduire les catégories",
      settingsExpandNavigation: "Développer les catégories",
    },
    de: {
      settingsCollapseNavigation: "Kategorien einklappen",
      settingsExpandNavigation: "Kategorien ausklappen",
    },
    es: {
      settingsCollapseNavigation: "Contraer categorías",
      settingsExpandNavigation: "Expandir categorías",
    },
    ru: {
      settingsCollapseNavigation: "Свернуть категории",
      settingsExpandNavigation: "Развернуть категории",
    },
    "pt-BR": {
      settingsCollapseNavigation: "Recolher categorias",
      settingsExpandNavigation: "Expandir categorias",
    },
  };
  Object.entries(SETTINGS_NAVIGATION_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const RECOVERY_CREATE_SHORT_COPY = {
    "zh-CN": "创建",
    "zh-TW": "建立",
    en: "Create",
    ja: "作成",
    ko: "만들기",
    fr: "Créer",
    de: "Erstellen",
    es: "Crear",
    ru: "Создать",
    "pt-BR": "Criar",
  };
  Object.entries(RECOVERY_CREATE_SHORT_COPY).forEach(([locale, label]) => {
    localeCopy(COPY, locale).recoveryCreateShort = label;
  });
  const DATA_PACKAGE_COMPACT_COPY = {
    "zh-CN": ["导出数据包", "导入数据包"],
    "zh-TW": ["匯出資料包", "匯入資料包"],
    en: ["Export data", "Import data"],
    ja: ["データを書き出す", "データを読み込む"],
    ko: ["데이터 내보내기", "데이터 가져오기"],
    fr: ["Exporter", "Importer"],
    de: ["Exportieren", "Importieren"],
    es: ["Exportar", "Importar"],
    ru: ["Экспорт", "Импорт"],
    "pt-BR": ["Exportar", "Importar"],
  };
  Object.entries(DATA_PACKAGE_COMPACT_COPY).forEach(([locale, labels]) => {
    const target = localeCopy(COPY, locale);
    const [dataExport, dataImport] = labels;
    if (dataExport === undefined || dataImport === undefined) {
      throw new Error(`Invalid compact data package copy: ${locale}`);
    }
    target.dataExport = dataExport;
    target.dataImport = dataImport;
  });
  const RECOVERY_DIALOG_COPY = {
    "zh-CN": [
      "恢复这个恢复点？",
      "软件会先自动创建当前数据的保护恢复点，再恢复书架、阅读数据、软件设置、手势和阅读背景图。请先关闭所有阅读窗口。",
      "恢复",
      "取消",
      "恢复失败",
      "创建恢复点失败",
      "恢复完成",
      "数据已恢复，书架将重新加载。",
    ],
    "zh-TW": [
      "恢復這個恢復點？",
      "軟體會先自動建立目前資料的保護恢復點，再恢復書架、閱讀資料、軟體設定、手勢和閱讀背景圖。請先關閉所有閱讀視窗。",
      "恢復",
      "取消",
      "恢復失敗",
      "建立恢復點失敗",
      "恢復完成",
      "資料已恢復，書架將重新載入。",
    ],
    en: [
      "Restore this recovery point?",
      "The app will first protect the current data, then restore the shelf, reading data, settings, gestures, and reading backgrounds. Close all reader windows first.",
      "Restore",
      "Cancel",
      "Restore failed",
      "Could not create recovery point",
      "Restore complete",
      "Your data has been restored. The shelf will now reload.",
    ],
    ja: [
      "この復元ポイントに戻しますか？",
      "現在のデータを保護してから、本棚、読書データ、設定、ジェスチャー、背景を復元します。先にすべての読書ウィンドウを閉じてください。",
      "復元",
      "キャンセル",
      "復元に失敗しました",
      "復元ポイントを作成できませんでした",
      "復元完了",
      "データを復元しました。本棚を再読み込みします。",
    ],
    ko: [
      "이 복구 지점으로 복원할까요?",
      "현재 데이터를 먼저 보호한 뒤 책장, 읽기 데이터, 설정, 제스처와 읽기 배경을 복원합니다. 모든 읽기 창을 먼저 닫으세요.",
      "복원",
      "취소",
      "복원 실패",
      "복구 지점 생성 실패",
      "복원 완료",
      "데이터를 복원했습니다. 책장을 다시 불러옵니다.",
    ],
    fr: [
      "Restaurer ce point ?",
      "L’application protégera d’abord les données actuelles, puis restaurera la bibliothèque, les données de lecture, les réglages, les gestes et les arrière-plans. Fermez d’abord toutes les fenêtres de lecture.",
      "Restaurer",
      "Annuler",
      "Échec de la restauration",
      "Échec de la création du point",
      "Restauration terminée",
      "Les données ont été restaurées. La bibliothèque va être rechargée.",
    ],
    de: [
      "Diesen Punkt wiederherstellen?",
      "Die App schützt zuerst die aktuellen Daten und stellt dann Bibliothek, Lesedaten, Einstellungen, Gesten und Hintergründe wieder her. Schließen Sie zuerst alle Lesefenster.",
      "Wiederherstellen",
      "Abbrechen",
      "Wiederherstellung fehlgeschlagen",
      "Punkt konnte nicht erstellt werden",
      "Wiederherstellung abgeschlossen",
      "Die Daten wurden wiederhergestellt. Die Bibliothek wird neu geladen.",
    ],
    es: [
      "¿Restaurar este punto?",
      "La aplicación protegerá primero los datos actuales y después restaurará la biblioteca, los datos de lectura, los ajustes, los gestos y los fondos. Cierra antes todas las ventanas de lectura.",
      "Restaurar",
      "Cancelar",
      "Error al restaurar",
      "No se pudo crear el punto",
      "Restauración completada",
      "Los datos se han restaurado. La biblioteca se volverá a cargar.",
    ],
    ru: [
      "Восстановить эту точку?",
      "Приложение сначала защитит текущие данные, затем восстановит библиотеку, данные чтения, настройки, жесты и фон. Сначала закройте все окна чтения.",
      "Восстановить",
      "Отмена",
      "Ошибка восстановления",
      "Не удалось создать точку",
      "Восстановление завершено",
      "Данные восстановлены. Библиотека будет перезагружена.",
    ],
    "pt-BR": [
      "Restaurar este ponto?",
      "O aplicativo primeiro protegerá os dados atuais e depois restaurará a biblioteca, os dados de leitura, as configurações, os gestos e os fundos. Feche antes todas as janelas de leitura.",
      "Restaurar",
      "Cancelar",
      "Falha na restauração",
      "Falha ao criar o ponto",
      "Restauração concluída",
      "Os dados foram restaurados. A biblioteca será recarregada.",
    ],
  };
  Object.entries(RECOVERY_DIALOG_COPY).forEach(([locale, values]) => {
    const target = localeCopy(COPY, locale);
    const [
      confirmTitle,
      confirmMessage,
      confirmAction,
      dialogCancel,
      failedTitle,
      createFailedTitle,
      succeededTitle,
      succeededMessage,
    ] = values;
    if (
      [
        confirmTitle,
        confirmMessage,
        confirmAction,
        dialogCancel,
        failedTitle,
        createFailedTitle,
        succeededTitle,
        succeededMessage,
      ].some((value) => value === undefined)
    ) {
      throw new Error(`Invalid recovery dialog copy: ${locale}`);
    }
    target.recoveryConfirmTitle = confirmTitle!;
    target.recoveryConfirmMessage = confirmMessage!;
    target.recoveryConfirmAction = confirmAction!;
    target.recoveryDialogCancel = dialogCancel!;
    target.recoveryFailedTitle = failedTitle!;
    target.recoveryCreateFailedTitle = createFailedTitle!;
    target.recoverySucceededTitle = succeededTitle!;
    target.recoverySucceededMessage = succeededMessage!;
  });
  // 打开 Windows 默认应用设置后，使用轻提示而非阻塞式系统对话框。
  // 这里独立于设置面板文案，确保十种应用语言均有可读提示。
  const DEFAULT_APPS_NOTICE_COPY = {
    "zh-CN": {
      defaultOpenToast:
        "已打开 Windows 默认应用设置。请在“按文件类型选择默认值”中，分别将 .epub 和 .pdf 设为由“鲲鹏阅读器”打开。",
      defaultOpenFailed: "打开 Windows 默认应用设置失败：{error}",
    },
    "zh-TW": {
      defaultOpenToast:
        "已開啟 Windows 預設應用程式設定。請在「依檔案類型選擇預設值」中，分別將 .epub 和 .pdf 設為由「鯤鵬閱讀器」開啟。",
      defaultOpenFailed: "無法開啟 Windows 預設應用程式設定：{error}",
    },
    en: {
      defaultOpenToast:
        "Windows Default apps is open. Under “Choose defaults by file type”, set .epub and .pdf to open with Kunpeng Reader.",
      defaultOpenFailed: "Could not open Windows Default apps: {error}",
    },
    ja: {
      defaultOpenToast:
        "Windows の既定のアプリ設定を開きました。「ファイルの種類ごとに既定値を選ぶ」で .epub と .pdf を鯤鵬閲覧器で開くよう設定してください。",
      defaultOpenFailed:
        "Windows の既定のアプリ設定を開けませんでした: {error}",
    },
    ko: {
      defaultOpenToast:
        "Windows 기본 앱 설정을 열었습니다. “파일 형식별 기본값 선택”에서 .epub 및 .pdf를 쿤펑 리더로 열도록 설정하세요.",
      defaultOpenFailed: "Windows 기본 앱 설정을 열 수 없습니다: {error}",
    },
    fr: {
      defaultOpenToast:
        "Les applications par défaut de Windows sont ouvertes. Dans « Choisir les valeurs par défaut par type de fichier », associez .epub et .pdf à Kunpeng Reader.",
      defaultOpenFailed:
        "Impossible d’ouvrir les applications par défaut de Windows : {error}",
    },
    de: {
      defaultOpenToast:
        "Die Windows-Standard-Apps wurden geöffnet. Legen Sie unter „Standardwerte nach Dateityp auswählen“ .epub und .pdf für Kunpeng Reader fest.",
      defaultOpenFailed:
        "Windows-Standard-Apps konnten nicht geöffnet werden: {error}",
    },
    es: {
      defaultOpenToast:
        "Se abrieron las aplicaciones predeterminadas de Windows. En «Elegir valores predeterminados por tipo de archivo», configure .epub y .pdf para abrirse con Kunpeng Reader.",
      defaultOpenFailed:
        "No se pudieron abrir las aplicaciones predeterminadas de Windows: {error}",
    },
    ru: {
      defaultOpenToast:
        "Открыты приложения Windows по умолчанию. В разделе «Выбор значений по умолчанию по типу файла» назначьте Kunpeng Reader для .epub и .pdf.",
      defaultOpenFailed:
        "Не удалось открыть приложения Windows по умолчанию: {error}",
    },
    "pt-BR": {
      defaultOpenToast:
        "Os Aplicativos padrão do Windows foram abertos. Em “Escolher padrões por tipo de arquivo”, defina .epub e .pdf para abrir com o Kunpeng Reader.",
      defaultOpenFailed:
        "Não foi possível abrir os Aplicativos padrão do Windows: {error}",
    },
  };
  Object.entries(DEFAULT_APPS_NOTICE_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const ACCOUNT_SEARCH_COPY = {
    "zh-CN": {
      syncTitle: "同步",
      accountLabel: "账号",
      password: "密码",
      register: "注册",
      login: "登录",
      recoverPassword: "找回密码",
      boundEmail: "已绑定的邮箱",
      emailCode: "邮箱验证码",
      newLoginPassword: "新登录密码（至少 8 个字符）",
      resetAndLogin: "确认重置并登录",
      accountPrefix: "账号：",
      syncNow: "同步",
      accountSecurity: "账户安全",
      logout: "退出登录",
      syncContent: "同步内容",
      syncProgress: "阅读进度与续读位置",
      syncReadingData: "书签、高亮、批注、评分、标签与收藏夹",
      syncVocabulary: "生词本",
      syncStatistics: "阅读统计",
      syncTags: "大模型书籍分类标签",
      syncApi: "大模型与翻译 API 配置（不含密钥）",
      syncHistory: "智读与书库问答记录（可选）",
      syncSecrets: "加密 API Key 与翻译密钥（可选）",
      smartReading: "智读、书库问答与翻译",
      smartReadingHelp:
        "分类标签和配置默认同步；问答记录与加密密钥可在同步设置中开启。",
      syncSettings: "同步设置",
      lastSync: "最近同步：{time}",
      lastSyncNever: "尚未同步",
      syncFilesNote: "登录后可跨设备同步；图书文件本身不会上传",
      notLoggedIn: "尚未登录",
      searchBooks: "搜索书籍",
      shelfSearch: "全书架正文检索",
      searchPlaceholder: "搜索 书名 / 作者 / 简介",
      shelfSearchPlaceholder: "全书架正文检索，回车搜索…",
      clearSearch: "清空搜索",
      noSearchHistory: "暂无搜索记录",
    },
    "zh-TW": {
      syncTitle: "同步",
      accountLabel: "帳號",
      password: "密碼",
      register: "註冊",
      login: "登入",
      recoverPassword: "找回密碼",
      boundEmail: "已綁定的電子郵件",
      emailCode: "電子郵件驗證碼",
      newLoginPassword: "新登入密碼（至少 8 個字元）",
      resetAndLogin: "確認重設並登入",
      accountPrefix: "帳號：",
      syncNow: "同步",
      accountSecurity: "帳戶安全",
      logout: "登出",
      syncContent: "同步內容",
      syncProgress: "閱讀進度與續讀位置",
      syncReadingData: "書籤、標示、批註、評分、標籤與收藏夾",
      syncVocabulary: "生詞本",
      syncStatistics: "閱讀統計",
      syncTags: "AI 圖書分類標籤",
      syncApi: "AI 與翻譯 API 設定（不含密鑰）",
      syncHistory: "智讀與書庫問答記錄（可選）",
      syncSecrets: "加密 API Key 與翻譯密鑰（可選）",
      smartReading: "智讀、書庫問答與翻譯",
      smartReadingHelp:
        "分類標籤和設定預設同步；問答記錄與加密密鑰可在同步設定中開啟。",
      syncSettings: "同步設定",
      lastSync: "最近同步：{time}",
      lastSyncNever: "尚未同步",
      syncFilesNote: "登入後可跨裝置同步；圖書檔案本身不會上傳",
      notLoggedIn: "尚未登入",
      searchBooks: "搜尋圖書",
      shelfSearch: "全書架全文檢索",
      searchPlaceholder: "搜尋 書名 / 作者 / 簡介",
      shelfSearchPlaceholder: "全書架全文檢索，按 Enter 搜尋…",
      clearSearch: "清除搜尋",
      noSearchHistory: "暫無搜尋記錄",
    },
    en: {
      syncTitle: "Sync",
      accountLabel: "Account",
      password: "Password",
      register: "Register",
      login: "Sign in",
      recoverPassword: "Recover password",
      boundEmail: "Bound email",
      emailCode: "Email code",
      newLoginPassword: "New password (at least 8 characters)",
      resetAndLogin: "Reset and sign in",
      accountPrefix: "Account: ",
      syncNow: "Sync",
      accountSecurity: "Account security",
      logout: "Sign out",
      syncContent: "What syncs",
      syncProgress: "Reading progress and resume position",
      syncReadingData:
        "Bookmarks, highlights, notes, ratings, tags and collections",
      syncVocabulary: "Vocabulary",
      syncStatistics: "Reading statistics",
      syncTags: "AI book classification tags",
      syncApi: "AI and translation API settings (without secrets)",
      syncHistory: "AI reading and Library Q&A history (optional)",
      syncSecrets: "Encrypted API keys and translation secrets (optional)",
      smartReading: "AI reading, Library Q&A and translation",
      smartReadingHelp:
        "Classification tags and settings sync by default. Enable Q&A history and encrypted secrets in Sync settings.",
      syncSettings: "Sync settings",
      lastSync: "Last sync: {time}",
      lastSyncNever: "Never synced",
      syncFilesNote:
        "Sign in to sync across devices; book files are never uploaded.",
      notLoggedIn: "Not signed in",
      searchBooks: "Search books",
      shelfSearch: "Full-shelf text search",
      searchPlaceholder: "Search title / author / description",
      shelfSearchPlaceholder: "Search the full shelf; press Enter…",
      clearSearch: "Clear search",
      noSearchHistory: "No search history",
    },
    ja: {
      syncTitle: "同期",
      accountLabel: "アカウント",
      password: "パスワード",
      register: "登録",
      login: "ログイン",
      recoverPassword: "パスワードを再設定",
      boundEmail: "登録済みメール",
      emailCode: "メール認証コード",
      newLoginPassword: "新しいパスワード（8文字以上）",
      resetAndLogin: "再設定してログイン",
      accountPrefix: "アカウント: ",
      syncNow: "同期",
      accountSecurity: "アカウントの安全",
      logout: "ログアウト",
      syncContent: "同期内容",
      syncProgress: "読書進捗と再開位置",
      syncReadingData: "しおり、ハイライト、注釈、評価、タグとコレクション",
      syncVocabulary: "単語帳",
      syncStatistics: "読書統計",
      syncTags: "AI書籍分類タグ",
      syncApi: "AI・翻訳 API 設定（秘密情報を除く）",
      syncHistory: "AI読書とライブラリQ&A履歴（任意）",
      syncSecrets: "暗号化された API キーと翻訳キー（任意）",
      smartReading: "AI読書、ライブラリQ&Aと翻訳",
      smartReadingHelp:
        "分類タグと設定は既定で同期されます。Q&A履歴と暗号化キーは同期設定で有効にできます。",
      syncSettings: "同期設定",
      lastSync: "前回の同期: {time}",
      lastSyncNever: "未同期",
      syncFilesNote:
        "ログインすると端末間で同期できます。本のファイルはアップロードされません。",
      notLoggedIn: "未ログイン",
      searchBooks: "本を検索",
      shelfSearch: "書架全体を全文検索",
      searchPlaceholder: "書名 / 著者 / 紹介を検索",
      shelfSearchPlaceholder: "書架全体を検索。Enterで実行…",
      clearSearch: "検索をクリア",
      noSearchHistory: "検索履歴はありません",
    },
    ko: {
      syncTitle: "동기화",
      accountLabel: "계정",
      password: "비밀번호",
      register: "가입",
      login: "로그인",
      recoverPassword: "비밀번호 찾기",
      boundEmail: "연결된 이메일",
      emailCode: "이메일 인증 코드",
      newLoginPassword: "새 비밀번호(8자 이상)",
      resetAndLogin: "재설정 후 로그인",
      accountPrefix: "계정: ",
      syncNow: "동기화",
      accountSecurity: "계정 보안",
      logout: "로그아웃",
      syncContent: "동기화 항목",
      syncProgress: "읽기 진행률 및 이어 읽기 위치",
      syncReadingData: "책갈피, 하이라이트, 메모, 평점, 태그 및 컬렉션",
      syncVocabulary: "단어장",
      syncStatistics: "독서 통계",
      syncTags: "AI 책 분류 태그",
      syncApi: "AI 및 번역 API 설정(비밀 제외)",
      syncHistory: "AI 읽기 및 라이브러리 Q&A 기록(선택)",
      syncSecrets: "암호화된 API 키와 번역 키(선택)",
      smartReading: "AI 읽기, 라이브러리 Q&A 및 번역",
      smartReadingHelp:
        "분류 태그와 설정은 기본 동기화됩니다. Q&A 기록과 암호화 키는 동기화 설정에서 켤 수 있습니다.",
      syncSettings: "동기화 설정",
      lastSync: "최근 동기화: {time}",
      lastSyncNever: "동기화한 적 없음",
      syncFilesNote:
        "로그인하면 기기 간 동기화할 수 있으며 책 파일은 업로드되지 않습니다.",
      notLoggedIn: "로그인하지 않음",
      searchBooks: "책 검색",
      shelfSearch: "전체 책장 본문 검색",
      searchPlaceholder: "제목 / 저자 / 설명 검색",
      shelfSearchPlaceholder: "전체 책장에서 검색, Enter를 누르세요…",
      clearSearch: "검색 지우기",
      noSearchHistory: "검색 기록 없음",
    },
    fr: {
      syncTitle: "Synchronisation",
      accountLabel: "Compte",
      password: "Mot de passe",
      register: "Créer un compte",
      login: "Se connecter",
      recoverPassword: "Récupérer le mot de passe",
      boundEmail: "E-mail associé",
      emailCode: "Code reçu par e-mail",
      newLoginPassword: "Nouveau mot de passe (8 caractères minimum)",
      resetAndLogin: "Réinitialiser et se connecter",
      accountPrefix: "Compte : ",
      syncNow: "Synchroniser",
      accountSecurity: "Sécurité du compte",
      logout: "Se déconnecter",
      syncContent: "Contenu synchronisé",
      syncProgress: "Progression et position de reprise",
      syncReadingData:
        "Marque-pages, surlignages, notes, évaluations, étiquettes et collections",
      syncVocabulary: "Vocabulaire",
      syncStatistics: "Statistiques de lecture",
      syncTags: "Étiquettes de classement IA",
      syncApi: "Réglages API IA et traduction (sans secrets)",
      syncHistory: "Historique IA et Q&R de bibliothèque (facultatif)",
      syncSecrets: "Clés API et clés de traduction chiffrées (facultatif)",
      smartReading: "Lecture IA, Q&R de bibliothèque et traduction",
      smartReadingHelp:
        "Les étiquettes et réglages sont synchronisés par défaut. Activez l’historique et les secrets dans les réglages de synchronisation.",
      syncSettings: "Réglages de synchronisation",
      lastSync: "Dernière synchronisation : {time}",
      lastSyncNever: "Jamais synchronisé",
      syncFilesNote:
        "Connectez-vous pour synchroniser vos appareils ; les fichiers de livres ne sont jamais envoyés.",
      notLoggedIn: "Non connecté",
      searchBooks: "Rechercher des livres",
      shelfSearch: "Recherche plein texte de la bibliothèque",
      searchPlaceholder: "Rechercher titre / auteur / description",
      shelfSearchPlaceholder: "Rechercher toute la bibliothèque ; Entrée…",
      clearSearch: "Effacer la recherche",
      noSearchHistory: "Aucun historique de recherche",
    },
    de: {
      syncTitle: "Synchronisierung",
      accountLabel: "Konto",
      password: "Passwort",
      register: "Registrieren",
      login: "Anmelden",
      recoverPassword: "Passwort wiederherstellen",
      boundEmail: "Verknüpfte E-Mail",
      emailCode: "E-Mail-Code",
      newLoginPassword: "Neues Passwort (mindestens 8 Zeichen)",
      resetAndLogin: "Zurücksetzen und anmelden",
      accountPrefix: "Konto: ",
      syncNow: "Synchronisieren",
      accountSecurity: "Kontosicherheit",
      logout: "Abmelden",
      syncContent: "Synchronisierte Inhalte",
      syncProgress: "Lesefortschritt und Fortsetzungsposition",
      syncReadingData:
        "Lesezeichen, Markierungen, Notizen, Bewertungen, Tags und Sammlungen",
      syncVocabulary: "Vokabeln",
      syncStatistics: "Lesestatistik",
      syncTags: "KI-Buchklassifizierungs-Tags",
      syncApi: "KI- und Übersetzungs-API-Einstellungen (ohne Geheimnisse)",
      syncHistory: "KI-Lese- und Bibliotheksfragen-Verlauf (optional)",
      syncSecrets: "Verschlüsselte API- und Übersetzungsschlüssel (optional)",
      smartReading: "KI-Lesen, Bibliotheksfragen und Übersetzung",
      smartReadingHelp:
        "Klassifizierungs-Tags und Einstellungen werden standardmäßig synchronisiert. Verlauf und Schlüssel lassen sich in den Synchronisierungseinstellungen aktivieren.",
      syncSettings: "Synchronisierungseinstellungen",
      lastSync: "Letzte Synchronisierung: {time}",
      lastSyncNever: "Noch nie synchronisiert",
      syncFilesNote:
        "Melden Sie sich an, um Geräte zu synchronisieren; Buchdateien werden nie hochgeladen.",
      notLoggedIn: "Nicht angemeldet",
      searchBooks: "Bücher suchen",
      shelfSearch: "Volltextsuche in der gesamten Bibliothek",
      searchPlaceholder: "Titel / Autor / Beschreibung suchen",
      shelfSearchPlaceholder: "Gesamte Bibliothek durchsuchen; Eingabetaste…",
      clearSearch: "Suche löschen",
      noSearchHistory: "Kein Suchverlauf",
    },
    es: {
      syncTitle: "Sincronización",
      accountLabel: "Cuenta",
      password: "Contraseña",
      register: "Registrarse",
      login: "Iniciar sesión",
      recoverPassword: "Recuperar contraseña",
      boundEmail: "Correo vinculado",
      emailCode: "Código de correo",
      newLoginPassword: "Nueva contraseña (mínimo 8 caracteres)",
      resetAndLogin: "Restablecer e iniciar sesión",
      accountPrefix: "Cuenta: ",
      syncNow: "Sincronizar",
      accountSecurity: "Seguridad de la cuenta",
      logout: "Cerrar sesión",
      syncContent: "Contenido sincronizado",
      syncProgress: "Progreso de lectura y posición",
      syncReadingData:
        "Marcadores, resaltados, notas, valoraciones, etiquetas y colecciones",
      syncVocabulary: "Vocabulario",
      syncStatistics: "Estadísticas de lectura",
      syncTags: "Etiquetas de clasificación con IA",
      syncApi: "Ajustes de API de IA y traducción (sin secretos)",
      syncHistory: "Historial de IA y preguntas de biblioteca (opcional)",
      syncSecrets: "Claves API y de traducción cifradas (opcional)",
      smartReading: "Lectura IA, preguntas de biblioteca y traducción",
      smartReadingHelp:
        "Las etiquetas y ajustes se sincronizan de forma predeterminada. Active el historial y las claves en los ajustes de sincronización.",
      syncSettings: "Ajustes de sincronización",
      lastSync: "Última sincronización: {time}",
      lastSyncNever: "Nunca sincronizado",
      syncFilesNote:
        "Inicie sesión para sincronizar dispositivos; los archivos de libros nunca se suben.",
      notLoggedIn: "Sin sesión iniciada",
      searchBooks: "Buscar libros",
      shelfSearch: "Búsqueda de texto en toda la biblioteca",
      searchPlaceholder: "Buscar título / autor / descripción",
      shelfSearchPlaceholder: "Buscar en toda la biblioteca; pulse Intro…",
      clearSearch: "Borrar búsqueda",
      noSearchHistory: "Sin historial de búsqueda",
    },
    ru: {
      syncTitle: "Синхронизация",
      accountLabel: "Учётная запись",
      password: "Пароль",
      register: "Регистрация",
      login: "Войти",
      recoverPassword: "Восстановить пароль",
      boundEmail: "Привязанный e-mail",
      emailCode: "Код из e-mail",
      newLoginPassword: "Новый пароль (не менее 8 символов)",
      resetAndLogin: "Сбросить и войти",
      accountPrefix: "Учётная запись: ",
      syncNow: "Синхронизировать",
      accountSecurity: "Безопасность аккаунта",
      logout: "Выйти",
      syncContent: "Синхронизируемые данные",
      syncProgress: "Прогресс чтения и позиция продолжения",
      syncReadingData: "Закладки, выделения, заметки, оценки, теги и коллекции",
      syncVocabulary: "Словарь",
      syncStatistics: "Статистика чтения",
      syncTags: "Теги классификации книг ИИ",
      syncApi: "Настройки ИИ и API перевода (без секретов)",
      syncHistory: "История ИИ и вопросов к библиотеке (необязательно)",
      syncSecrets: "Зашифрованные API-ключи и ключи перевода (необязательно)",
      smartReading: "ИИ-чтение, вопросы к библиотеке и перевод",
      smartReadingHelp:
        "Теги классификации и настройки синхронизируются по умолчанию. Историю и ключи можно включить в настройках синхронизации.",
      syncSettings: "Настройки синхронизации",
      lastSync: "Последняя синхронизация: {time}",
      lastSyncNever: "Не синхронизировалось",
      syncFilesNote:
        "Войдите для синхронизации между устройствами; файлы книг не загружаются.",
      notLoggedIn: "Не выполнен вход",
      searchBooks: "Поиск книг",
      shelfSearch: "Полнотекстовый поиск по всей библиотеке",
      searchPlaceholder: "Поиск названия / автора / описания",
      shelfSearchPlaceholder: "Искать по всей библиотеке; Enter…",
      clearSearch: "Очистить поиск",
      noSearchHistory: "Нет истории поиска",
    },
    "pt-BR": {
      syncTitle: "Sincronização",
      accountLabel: "Conta",
      password: "Senha",
      register: "Criar conta",
      login: "Entrar",
      recoverPassword: "Recuperar senha",
      boundEmail: "E-mail vinculado",
      emailCode: "Código por e-mail",
      newLoginPassword: "Nova senha (ao menos 8 caracteres)",
      resetAndLogin: "Redefinir e entrar",
      accountPrefix: "Conta: ",
      syncNow: "Sincronizar",
      accountSecurity: "Segurança da conta",
      logout: "Sair",
      syncContent: "Conteúdo sincronizado",
      syncProgress: "Progresso de leitura e posição de retomada",
      syncReadingData:
        "Marcadores, destaques, notas, avaliações, etiquetas e coleções",
      syncVocabulary: "Vocabulário",
      syncStatistics: "Estatísticas de leitura",
      syncTags: "Etiquetas de classificação por IA",
      syncApi: "Configurações de API de IA e tradução (sem segredos)",
      syncHistory: "Histórico de IA e perguntas da biblioteca (opcional)",
      syncSecrets: "Chaves de API e tradução criptografadas (opcional)",
      smartReading: "Leitura por IA, perguntas da biblioteca e tradução",
      smartReadingHelp:
        "Etiquetas de classificação e configurações são sincronizadas por padrão. Ative o histórico e as chaves nas configurações de sincronização.",
      syncSettings: "Configurações de sincronização",
      lastSync: "Última sincronização: {time}",
      lastSyncNever: "Nunca sincronizado",
      syncFilesNote:
        "Entre para sincronizar dispositivos; os arquivos dos livros nunca são enviados.",
      notLoggedIn: "Não conectado",
      searchBooks: "Pesquisar livros",
      shelfSearch: "Pesquisa de texto em toda a biblioteca",
      searchPlaceholder: "Pesquisar título / autor / descrição",
      shelfSearchPlaceholder: "Pesquisar toda a biblioteca; pressione Enter…",
      clearSearch: "Limpar pesquisa",
      noSearchHistory: "Sem histórico de pesquisa",
    },
  };
  Object.entries(ACCOUNT_SEARCH_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const SYNC_CONNECTIVITY_COPY = {
    "zh-CN": {
      syncNow: "同步",
      serviceUnchecked: "未检测",
      serviceChecking: "检测中",
      serviceCommunicating: "通信中",
      serviceOnline: "服务畅通",
      serviceOffline: "连接异常",
    },
    "zh-TW": {
      syncNow: "同步",
      serviceUnchecked: "未檢測",
      serviceChecking: "檢測中",
      serviceCommunicating: "通訊中",
      serviceOnline: "服務暢通",
      serviceOffline: "連線異常",
    },
    en: {
      syncNow: "Sync",
      serviceUnchecked: "Not checked",
      serviceChecking: "Checking",
      serviceCommunicating: "Connecting",
      serviceOnline: "Service online",
      serviceOffline: "Connection issue",
    },
    ja: {
      syncNow: "同期",
      serviceUnchecked: "未確認",
      serviceChecking: "確認中",
      serviceCommunicating: "通信中",
      serviceOnline: "接続良好",
      serviceOffline: "接続異常",
    },
    ko: {
      syncNow: "동기화",
      serviceUnchecked: "확인 안 됨",
      serviceChecking: "확인 중",
      serviceCommunicating: "통신 중",
      serviceOnline: "서비스 정상",
      serviceOffline: "연결 이상",
    },
    fr: {
      syncNow: "Synchroniser",
      serviceUnchecked: "Non vérifié",
      serviceChecking: "Vérification",
      serviceCommunicating: "Connexion",
      serviceOnline: "Service disponible",
      serviceOffline: "Problème de connexion",
    },
    de: {
      syncNow: "Synchronisieren",
      serviceUnchecked: "Nicht geprüft",
      serviceChecking: "Wird geprüft",
      serviceCommunicating: "Verbindung",
      serviceOnline: "Dienst erreichbar",
      serviceOffline: "Verbindungsproblem",
    },
    es: {
      syncNow: "Sincronizar",
      serviceUnchecked: "Sin comprobar",
      serviceChecking: "Comprobando",
      serviceCommunicating: "Conectando",
      serviceOnline: "Servicio disponible",
      serviceOffline: "Problema de conexión",
    },
    ru: {
      syncNow: "Синхронизировать",
      serviceUnchecked: "Не проверено",
      serviceChecking: "Проверка",
      serviceCommunicating: "Подключение",
      serviceOnline: "Сервис доступен",
      serviceOffline: "Ошибка подключения",
    },
    "pt-BR": {
      syncNow: "Sincronizar",
      serviceUnchecked: "Não verificado",
      serviceChecking: "Verificando",
      serviceCommunicating: "Conectando",
      serviceOnline: "Serviço disponível",
      serviceOffline: "Problema de conexão",
    },
  };
  Object.entries(SYNC_CONNECTIVITY_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const SYNC_CONTENT_SCOPE_COPY = {
    "zh-CN": {
      syncProgress: "阅读进度、续读位置与阅读时间线",
      syncReadingData: "书签、高亮、批注、评分、标签、收藏夹与书单",
      syncStatistics: "阅读统计（时长、字数与完成时间）",
      syncSoftwareSettings: "软件设置（排版、工具栏、手势等）",
      syncPalettes: "自定义阅读主题与背景",
    },
    "zh-TW": {
      syncProgress: "閱讀進度、續讀位置與閱讀時間軸",
      syncReadingData: "書籤、標示、批註、評分、標籤、收藏夾與書單",
      syncStatistics: "閱讀統計（時間、字數與完成時間）",
      syncSoftwareSettings: "軟體設定（排版、工具列、手勢等）",
      syncPalettes: "自訂閱讀主題與背景",
    },
    en: {
      syncProgress: "Progress, resume position and reading timeline",
      syncReadingData:
        "Bookmarks, highlights, notes, ratings, tags, collections and booklists",
      syncStatistics: "Reading statistics (time, words and completion)",
      syncSoftwareSettings:
        "Software settings (layout, toolbar, gestures and more)",
      syncPalettes: "Custom reading themes and backgrounds",
    },
    ja: {
      syncProgress: "進捗、再開位置、読書タイムライン",
      syncReadingData:
        "しおり、ハイライト、注釈、評価、タグ、コレクション、読書リスト",
      syncStatistics: "読書統計（時間、文字数、完読）",
      syncSoftwareSettings:
        "ソフトウェア設定（レイアウト、ツールバー、ジェスチャーなど）",
      syncPalettes: "カスタム読書テーマと背景",
    },
    ko: {
      syncProgress: "진행률, 이어 읽기 위치 및 읽기 타임라인",
      syncReadingData:
        "책갈피, 하이라이트, 메모, 평점, 태그, 컬렉션 및 독서 목록",
      syncStatistics: "독서 통계(시간, 글자 수 및 완독)",
      syncSoftwareSettings: "소프트웨어 설정(레이아웃, 도구 모음, 제스처 등)",
      syncPalettes: "사용자 읽기 테마 및 배경",
    },
    fr: {
      syncProgress: "Progression, reprise et chronologie de lecture",
      syncReadingData:
        "Signets, surlignages, notes, évaluations, étiquettes, collections et listes",
      syncStatistics: "Statistiques (durée, mots et achèvement)",
      syncSoftwareSettings:
        "Réglages (mise en page, barre d’outils, gestes, etc.)",
      syncPalettes: "Thèmes et arrière-plans personnalisés",
    },
    de: {
      syncProgress: "Fortschritt, Leseposition und Zeitleiste",
      syncReadingData:
        "Lesezeichen, Markierungen, Notizen, Bewertungen, Tags, Sammlungen und Leselisten",
      syncStatistics: "Lesestatistik (Zeit, Wörter und Abschluss)",
      syncSoftwareSettings: "Einstellungen (Layout, Symbolleiste, Gesten usw.)",
      syncPalettes: "Eigene Lesethemen und Hintergründe",
    },
    es: {
      syncProgress: "Progreso, posición y cronología de lectura",
      syncReadingData:
        "Marcadores, resaltados, notas, valoraciones, etiquetas, colecciones y listas",
      syncStatistics: "Estadísticas (tiempo, palabras y finalización)",
      syncSoftwareSettings: "Ajustes (diseño, barra, gestos y más)",
      syncPalettes: "Temas y fondos de lectura personalizados",
    },
    ru: {
      syncProgress: "Прогресс, позиция и хронология чтения",
      syncReadingData:
        "Закладки, выделения, заметки, оценки, теги, коллекции и списки",
      syncStatistics: "Статистика (время, слова и завершение)",
      syncSoftwareSettings: "Настройки (макет, панель, жесты и другое)",
      syncPalettes: "Пользовательские темы и фоны",
    },
    "pt-BR": {
      syncProgress: "Progresso, posição e linha do tempo",
      syncReadingData:
        "Marcadores, destaques, notas, avaliações, etiquetas, coleções e listas",
      syncStatistics: "Estatísticas (tempo, palavras e conclusão)",
      syncSoftwareSettings: "Configurações (layout, barra, gestos e mais)",
      syncPalettes: "Temas e fundos de leitura personalizados",
    },
  };
  Object.entries(SYNC_CONTENT_SCOPE_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  const SYNC_RUNTIME_COPY = {
    "zh-CN": {
      syncInProgress: "同步中",
      autoSyncInProgress: "自动同步中",
      firstSyncInProgress: "首次同步中",
      syncSuccess: "同步成功",
      syncFailed: "同步失败",
      autoSyncFailed: "自动同步失败",
      syncConnecting: "正在连接同步服务器…",
      syncFailedDetail: "同步失败：{error}",
      syncServerTime: "{message}；服务器时间：{time}",
      readSyncSettingsFailed: "读取同步设置失败：{error}",
    },
    "zh-TW": {
      syncInProgress: "同步中",
      autoSyncInProgress: "自動同步中",
      firstSyncInProgress: "首次同步中",
      syncSuccess: "同步成功",
      syncFailed: "同步失敗",
      autoSyncFailed: "自動同步失敗",
      syncConnecting: "正在連線同步伺服器…",
      syncFailedDetail: "同步失敗：{error}",
      syncServerTime: "{message}；伺服器時間：{time}",
      readSyncSettingsFailed: "讀取同步設定失敗：{error}",
    },
    en: {
      syncInProgress: "Syncing",
      autoSyncInProgress: "Auto-syncing",
      firstSyncInProgress: "Initial sync",
      syncSuccess: "Sync complete",
      syncFailed: "Sync failed",
      autoSyncFailed: "Auto-sync failed",
      syncConnecting: "Connecting to the sync server…",
      syncFailedDetail: "Sync failed: {error}",
      syncServerTime: "{message}; server time: {time}",
      readSyncSettingsFailed: "Could not read sync settings: {error}",
    },
    ja: {
      syncInProgress: "同期中",
      autoSyncInProgress: "自動同期中",
      firstSyncInProgress: "初回同期中",
      syncSuccess: "同期完了",
      syncFailed: "同期失敗",
      autoSyncFailed: "自動同期失敗",
      syncConnecting: "同期サーバーに接続中…",
      syncFailedDetail: "同期に失敗しました：{error}",
      syncServerTime: "{message}；サーバー時刻：{time}",
      readSyncSettingsFailed: "同期設定を読み込めませんでした：{error}",
    },
    ko: {
      syncInProgress: "동기화 중",
      autoSyncInProgress: "자동 동기화 중",
      firstSyncInProgress: "첫 동기화 중",
      syncSuccess: "동기화 완료",
      syncFailed: "동기화 실패",
      autoSyncFailed: "자동 동기화 실패",
      syncConnecting: "동기화 서버에 연결 중…",
      syncFailedDetail: "동기화 실패: {error}",
      syncServerTime: "{message}; 서버 시간: {time}",
      readSyncSettingsFailed: "동기화 설정을 읽지 못했습니다: {error}",
    },
    fr: {
      syncInProgress: "Synchronisation…",
      autoSyncInProgress: "Synchronisation automatique…",
      firstSyncInProgress: "Première synchronisation…",
      syncSuccess: "Synchronisation réussie",
      syncFailed: "Échec de la synchronisation",
      autoSyncFailed: "Échec de la synchronisation automatique",
      syncConnecting: "Connexion au serveur de synchronisation…",
      syncFailedDetail: "Échec de la synchronisation : {error}",
      syncServerTime: "{message} ; heure du serveur : {time}",
      readSyncSettingsFailed:
        "Impossible de lire les réglages de synchronisation : {error}",
    },
    de: {
      syncInProgress: "Synchronisierung läuft",
      autoSyncInProgress: "Automatische Synchronisierung läuft",
      firstSyncInProgress: "Erste Synchronisierung läuft",
      syncSuccess: "Synchronisierung erfolgreich",
      syncFailed: "Synchronisierung fehlgeschlagen",
      autoSyncFailed: "Automatische Synchronisierung fehlgeschlagen",
      syncConnecting: "Verbindung zum Synchronisierungsserver…",
      syncFailedDetail: "Synchronisierung fehlgeschlagen: {error}",
      syncServerTime: "{message}; Serverzeit: {time}",
      readSyncSettingsFailed:
        "Synchronisierungseinstellungen konnten nicht gelesen werden: {error}",
    },
    es: {
      syncInProgress: "Sincronizando",
      autoSyncInProgress: "Sincronización automática",
      firstSyncInProgress: "Primera sincronización",
      syncSuccess: "Sincronización completada",
      syncFailed: "Error de sincronización",
      autoSyncFailed: "Error de sincronización automática",
      syncConnecting: "Conectando con el servidor de sincronización…",
      syncFailedDetail: "Error de sincronización: {error}",
      syncServerTime: "{message}; hora del servidor: {time}",
      readSyncSettingsFailed:
        "No se pudieron leer los ajustes de sincronización: {error}",
    },
    ru: {
      syncInProgress: "Синхронизация",
      autoSyncInProgress: "Автосинхронизация",
      firstSyncInProgress: "Первая синхронизация",
      syncSuccess: "Синхронизация завершена",
      syncFailed: "Ошибка синхронизации",
      autoSyncFailed: "Ошибка автосинхронизации",
      syncConnecting: "Подключение к серверу синхронизации…",
      syncFailedDetail: "Ошибка синхронизации: {error}",
      syncServerTime: "{message}; время сервера: {time}",
      readSyncSettingsFailed:
        "Не удалось прочитать настройки синхронизации: {error}",
    },
    "pt-BR": {
      syncInProgress: "Sincronizando",
      autoSyncInProgress: "Sincronização automática",
      firstSyncInProgress: "Primeira sincronização",
      syncSuccess: "Sincronização concluída",
      syncFailed: "Falha na sincronização",
      autoSyncFailed: "Falha na sincronização automática",
      syncConnecting: "Conectando ao servidor de sincronização…",
      syncFailedDetail: "Falha na sincronização: {error}",
      syncServerTime: "{message}; hora do servidor: {time}",
      readSyncSettingsFailed:
        "Não foi possível ler as configurações de sincronização: {error}",
    },
  };
  Object.entries(SYNC_RUNTIME_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  // Account subpages used to be static Chinese markup. Keep the complete
  // English fallback here so every supported UI language switches away from
  // Chinese even before a locale gets its own refined wording.
  const ACCOUNT_SUBPAGE_COPY = {
    "zh-CN": {
      close: "关闭",
      accountDataPrivacy: "数据与隐私",
      accountDataDeviceGroup: "此设备",
      accountDataDeviceGroupHint: "只影响当前电脑，不改动云端同步数据。",
      accountDataCloudGroup: "云端同步数据",
      accountDataCloudGroupHint: "影响全部设备，需要验证当前登录密码。",
      accountDataAccountGroup: "账号",
      accountDataAccountGroupHint: "永久操作，仅在不再使用此账号时执行。",
      accountSecurityLoading: "读取账户安全状态中…",
      bindEmail: "绑定邮箱",
      changeBoundEmail: "更换绑定邮箱",
      email: "邮箱",
      emailForRecovery: "用于找回登录密码",
      sendCode: "发送验证码",
      verificationCode: "验证码",
      confirmBinding: "确认绑定",
      rebindEmailHint: "为保护账号，先向当前绑定邮箱发送验证码。",
      sendOldEmailCode: "发送旧邮箱验证码",
      oldEmailCode: "旧邮箱验证码",
      verifyOldEmail: "验证旧邮箱",
      oldEmailVerified: "旧邮箱已验证。现在验证新的绑定邮箱。",
      newEmail: "新邮箱",
      newVerifiedEmail: "新的验证邮箱",
      sendNewEmailCode: "发送新邮箱验证码",
      newEmailCode: "新邮箱验证码",
      confirmEmailChange: "确认更换",
      changeLoginPassword: "修改登录密码",
      currentLoginPassword: "当前登录密码",
      newLoginPasswordLabel: "新登录密码",
      atLeastEightChars: "至少 8 个字符",
      confirmChange: "确认修改",
      confirmReset: "确认重置",
      passwordRecoveryHint:
        "向已绑定邮箱发送验证码后，可直接设置新密码；重置后其他设备会退出登录。",
      accountFilesKept:
        "以下操作不会删除电脑中的原始 EPUB、PDF、TXT、MOBI 或 AZW 图书文件。",
      clearThisDeviceData: "清除此设备数据",
      clearThisDeviceDescription:
        "清除书架记录、阅读进度、批注、生词、统计、缓存、索引、模型、已下载字体、账号登录和 API 配置。",
      clearThisDevice: "清除此设备",
      clearDeviceAndCloudData: "清除此设备及云端数据",
      clearDeviceAndCloudDescription:
        "清空当前账号的全部同步数据，并让所有设备退出登录；账号本身保留。",
      loginPassword: "登录密码",
      clearDeviceAndCloud: "清除本机及云端",
      deleteAccountPermanently: "永久删除账号",
      deleteAccountDescription:
        "删除账号及全部云端数据，同时清除此设备数据。此操作不可恢复。",
      enterFullAccountName: "输入完整账号名",
      privateSyncTitle: "智读与翻译同步",
      privateSyncNote:
        "普通配置不含 API Key，会跟随账户同步。历史与密钥默认只留在本机。",
      syncServiceConfiguration: "同步服务配置",
      syncServiceConfigurationHint:
        "智读服务商、接口地址、模型名和翻译服务偏好",
      syncAiHistory: "同步智读历史",
      syncAiHistoryHint:
        "包括单书与书库问答；最多保留 40 条，书库记录不上传书籍原文",
      syncSecrets: "同步 API Key 与翻译密钥",
      syncSecretsHint: "须设置同步密码，服务器仅保存加密密文",
      privateSyncPasswordPlaceholder: "设置或输入同步密码（至少 10 个字）",
      encryptAndSyncSecrets: "加密并立即同步密钥",
      unlockCloudSecrets: "解锁云端密钥",
      forgetSyncPassword: "遗忘同步密码并撤销云端密钥",
      forgetSyncPasswordHint:
        "同步密码无法找回；本机 API Key 不会被删除，可用新密码重新加密。",
    },
    "zh-TW": {
      close: "關閉",
      accountDataPrivacy: "資料與隱私",
      accountDataDeviceGroup: "此裝置",
      accountDataDeviceGroupHint: "只影響目前電腦，不變更雲端同步資料。",
      accountDataCloudGroup: "雲端同步資料",
      accountDataCloudGroupHint: "影響所有裝置，需要驗證目前的登入密碼。",
      accountDataAccountGroup: "帳戶",
      accountDataAccountGroupHint: "永久操作，僅在不再使用此帳戶時執行。",
      accountSecurityLoading: "正在讀取帳戶安全狀態…",
      bindEmail: "綁定電子郵件",
      changeBoundEmail: "更換綁定電子郵件",
      email: "電子郵件",
      emailForRecovery: "用於找回登入密碼",
      sendCode: "傳送驗證碼",
      verificationCode: "驗證碼",
      confirmBinding: "確認綁定",
      rebindEmailHint: "為保護帳戶，請先向目前綁定的電子郵件傳送驗證碼。",
      sendOldEmailCode: "傳送舊電子郵件驗證碼",
      oldEmailCode: "舊電子郵件驗證碼",
      verifyOldEmail: "驗證舊電子郵件",
      oldEmailVerified: "舊電子郵件已驗證。現在驗證新的綁定電子郵件。",
      newEmail: "新電子郵件",
      newVerifiedEmail: "新的驗證電子郵件",
      sendNewEmailCode: "傳送新電子郵件驗證碼",
      newEmailCode: "新電子郵件驗證碼",
      confirmEmailChange: "確認更換",
      changeLoginPassword: "修改登入密碼",
      currentLoginPassword: "目前登入密碼",
      newLoginPasswordLabel: "新登入密碼",
      atLeastEightChars: "至少 8 個字元",
      confirmChange: "確認修改",
      confirmReset: "確認重設",
      passwordRecoveryHint:
        "向已綁定電子郵件傳送驗證碼後，可直接設定新密碼；重設後其他裝置會登出。",
      accountFilesKept:
        "以下操作不會刪除電腦中的原始 EPUB、PDF、TXT、MOBI 或 AZW 圖書檔案。",
      clearThisDeviceData: "清除此裝置資料",
      clearThisDeviceDescription:
        "清除書架記錄、閱讀進度、批註、生詞、統計、快取、索引、模型、已下載字型、帳戶登入和 API 設定。",
      clearThisDevice: "清除此裝置",
      clearDeviceAndCloudData: "清除此裝置及雲端資料",
      clearDeviceAndCloudDescription:
        "清空目前帳戶的全部同步資料，並讓所有裝置登出；帳戶本身保留。",
      loginPassword: "登入密碼",
      clearDeviceAndCloud: "清除本機及雲端",
      deleteAccountPermanently: "永久刪除帳戶",
      deleteAccountDescription:
        "刪除帳戶及全部雲端資料，同時清除此裝置資料。此操作不可復原。",
      enterFullAccountName: "輸入完整帳戶名稱",
      privateSyncTitle: "智讀與翻譯同步",
      privateSyncNote:
        "一般設定不含 API Key，會跟隨帳戶同步。歷史與金鑰預設只留在本機。",
      syncServiceConfiguration: "同步服務設定",
      syncServiceConfigurationHint:
        "智讀服務商、介面位址、模型名稱和翻譯服務偏好",
      syncAiHistory: "同步智讀歷史",
      syncAiHistoryHint:
        "包括單書與書庫問答；最多保留 40 條，書庫記錄不上傳書籍原文",
      syncSecrets: "同步 API Key 與翻譯金鑰",
      syncSecretsHint: "須設定同步密碼，伺服器僅保存加密密文",
      privateSyncPasswordPlaceholder: "設定或輸入同步密碼（至少 10 個字元）",
      encryptAndSyncSecrets: "加密並立即同步金鑰",
      unlockCloudSecrets: "解鎖雲端金鑰",
      forgetSyncPassword: "遺忘同步密碼並撤銷雲端金鑰",
      forgetSyncPasswordHint:
        "同步密碼無法找回；本機 API Key 不會被刪除，可用新密碼重新加密。",
    },
    en: {
      close: "Close",
      accountDataPrivacy: "Data & privacy",
      accountDataDeviceGroup: "This device",
      accountDataDeviceGroupHint:
        "Affects this computer only and leaves cloud sync data unchanged.",
      accountDataCloudGroup: "Cloud sync data",
      accountDataCloudGroupHint:
        "Affects every device and requires your current sign-in password.",
      accountDataAccountGroup: "Account",
      accountDataAccountGroupHint:
        "Permanent actions for when you no longer want to use this account.",
      accountSecurityLoading: "Loading account security status…",
      bindEmail: "Bind email",
      changeBoundEmail: "Change bound email",
      email: "Email",
      emailForRecovery: "Used to recover your sign-in password",
      sendCode: "Send code",
      verificationCode: "Verification code",
      confirmBinding: "Confirm binding",
      rebindEmailHint:
        "To protect your account, first send a code to the currently bound email.",
      sendOldEmailCode: "Send old email code",
      oldEmailCode: "Old email code",
      verifyOldEmail: "Verify old email",
      oldEmailVerified:
        "The old email is verified. Now verify the new bound email.",
      newEmail: "New email",
      newVerifiedEmail: "New verification email",
      sendNewEmailCode: "Send new email code",
      newEmailCode: "New email code",
      confirmEmailChange: "Confirm change",
      changeLoginPassword: "Change sign-in password",
      currentLoginPassword: "Current sign-in password",
      newLoginPasswordLabel: "New sign-in password",
      atLeastEightChars: "At least 8 characters",
      confirmChange: "Confirm change",
      confirmReset: "Confirm reset",
      passwordRecoveryHint:
        "Send a code to the bound email to set a new password. Resetting signs out other devices.",
      accountFilesKept:
        "These actions never delete the original EPUB, PDF, TXT, MOBI, or AZW book files on this computer.",
      clearThisDeviceData: "Clear this device's data",
      clearThisDeviceDescription:
        "Clears shelf records, reading progress, notes, vocabulary, statistics, cache, indexes, models, downloaded fonts, sign-in, and API configuration.",
      clearThisDevice: "Clear this device",
      clearDeviceAndCloudData: "Clear this device and cloud data",
      clearDeviceAndCloudDescription:
        "Clears all synced data for this account and signs out every device. The account remains.",
      loginPassword: "Sign-in password",
      clearDeviceAndCloud: "Clear device and cloud",
      deleteAccountPermanently: "Permanently delete account",
      deleteAccountDescription:
        "Deletes the account and all cloud data, and clears this device. This cannot be undone.",
      enterFullAccountName: "Enter the full account name",
      privateSyncTitle: "AI reading & translation sync",
      privateSyncNote:
        "Regular configuration excludes API keys and follows the account. History and keys stay on this device by default.",
      syncServiceConfiguration: "Sync service configuration",
      syncServiceConfigurationHint:
        "AI provider, endpoint, model name, and translation preferences",
      syncAiHistory: "Sync AI reading history",
      syncAiHistoryHint:
        "Includes single-book and Library Q&A history; retains up to 40 records and never uploads book text",
      syncSecrets: "Sync API keys and translation secrets",
      syncSecretsHint:
        "Requires a sync password; the server stores encrypted ciphertext only",
      privateSyncPasswordPlaceholder:
        "Set or enter a sync password (at least 10 characters)",
      encryptAndSyncSecrets: "Encrypt and sync secrets now",
      unlockCloudSecrets: "Unlock cloud secrets",
      forgetSyncPassword: "Forget sync password and revoke cloud secrets",
      forgetSyncPasswordHint:
        "The sync password cannot be recovered. Local API keys remain and can be encrypted again with a new password.",
    },
  };
  Object.keys(COPY)
    .filter((locale) => locale !== "ja" && locale !== "ko")
    .forEach((locale) =>
      Object.assign(
        localeCopy(COPY, locale),
        ACCOUNT_SUBPAGE_COPY.en,
        asLocaleCatalog(ACCOUNT_SUBPAGE_COPY)[locale] || {},
      ),
    );
  const PANEL_COPY = {
    "zh-CN": {
      sortAndLayout: "排序与布局",
      sort: "排序",
      sortTitle: "书名",
      sortAuthor: "作者",
      sortImported: "导入时间",
      sortFolder: "存储目录",
      allBooks: "全部图书",
      sortRecent: "最近阅读",
      sortReadingTime: "阅读时间",
      sortFileSize: "大小",
      sortProgress: "阅读进度",
      readingFilters: "阅读过滤",
      unread: "未读",
      reading: "正在阅读",
      finished: "已读",
      ratingFilterTip: "按评分过滤：点星=只看该评分及以上，再点同一处取消",
      tags: "标签",
      collections: "收藏夹",
      matchAny: "匹配任一",
      layout: "布局",
      listLayout: "横向列表",
      gridLayout: "网格",
      columns: "列数",
      default: "默认",
      decreaseColumns: "减少列数",
      increaseColumns: "增加列数",
      readingStatsSettings: "阅读统计设置",
      readingDuration: "阅读时长",
      readingWords: "阅读字数",
      averageSpeed: "平均速度",
      booksRead: "读过",
      finishedBooks: "读完",
      highlights: "高亮",
      annotations: "批注",
      chartSwitch: "柱状图切换",
      time: "时间",
      chartMetricTip: "切换柱状图时间 / 字数",
      day: "日",
      month: "月",
      year: "年",
      total: "总",
      newsSettings: "资讯设置",
      closeNewsSettings: "关闭资讯设置",
      backgroundPrefetch: "后台预取",
      backgroundPrefetchNote:
        "应用空闲后每 5 分钟更新已启用来源。图片仍在卡片进入视野时才加载。",
      newsHideReturnIcon: "关闭返回图标",
      newsHideReturnIconNote:
        "默认关闭，返回图标会显示。开启后隐藏资讯原文右侧的返回图标；可用手势直接关闭页面。",
      gestureBack: "手势返回",
      drawEditGesture: "绘制 / 修改手势",
      enableGestureBack: "启用手势返回",
      gestureMatchPrecision: "匹配精度",
      gesturePrecisionHint: "精度越高，只有更相似的手势才会触发",
      precisionLow: "低",
      precisionMedium: "中",
      precisionHigh: "高",
      gestureEditorHint:
        "按住左键画出轨迹并保存。使用时在资讯页或打开的资讯子页按住鼠标右键画出相近轨迹。",
      drawGesturePath: "绘制手势返回轨迹",
      clear: "清除",
      savePath: "保存轨迹",
      answerSettings: "设置",
      answerLength: "作答长度",
      answerLengthHint: "长度越长，检索与生成时间越长。",
      answerShort: "短",
      answerShortHint: "当前示例：聚焦结论与 4—6 条依据",
      answerMedium: "中",
      answerMediumHint: "更多来源、依据与延展观点",
      answerLong: "长",
      answerLongHint: "最广证据、深入解读与边界讨论",
      answerFontSize: "字号",
      libraryAnswerFontSize: "书库问答字号",
      decreaseAnswerFont: "减小问答字号",
      increaseAnswerFont: "增大问答字号",
      longContextReading: "复杂问题长文精读（BGE-M3）",
      toggleLongContextReading: "切换复杂问题长文精读",
      closeSettings: "关闭设置",
    },
    "zh-TW": {
      sortAndLayout: "排序與版面",
      sort: "排序",
      sortTitle: "書名",
      sortAuthor: "作者",
      sortImported: "匯入時間",
      sortFolder: "儲存目錄",
      allBooks: "全部圖書",
      sortRecent: "最近閱讀",
      sortReadingTime: "閱讀時間",
      sortFileSize: "大小",
      sortProgress: "閱讀進度",
      readingFilters: "閱讀篩選",
      unread: "未讀",
      reading: "正在閱讀",
      finished: "已讀",
      ratingFilterTip: "按評分篩選：點星只看該評分及以上，再點同一處取消",
      tags: "標籤",
      collections: "收藏夾",
      matchAny: "符合任一",
      layout: "版面",
      listLayout: "橫向清單",
      gridLayout: "網格",
      columns: "欄數",
      default: "預設",
      decreaseColumns: "減少欄數",
      increaseColumns: "增加欄數",
      readingStatsSettings: "閱讀統計設定",
      readingDuration: "閱讀時長",
      readingWords: "閱讀字數",
      averageSpeed: "平均速度",
      booksRead: "讀過",
      finishedBooks: "讀完",
      highlights: "標示",
      annotations: "批註",
      chartSwitch: "長條圖切換",
      time: "時間",
      chartMetricTip: "切換長條圖時間 / 字數",
      day: "日",
      month: "月",
      year: "年",
      total: "總計",
      newsSettings: "資訊設定",
      closeNewsSettings: "關閉資訊設定",
      backgroundPrefetch: "背景預取",
      backgroundPrefetchNote:
        "應用程式閒置後每 5 分鐘更新已啟用來源。圖片仍只在卡片進入視野時載入。",
      newsHideReturnIcon: "關閉返回圖示",
      newsHideReturnIconNote:
        "預設關閉，返回圖示會顯示。開啟後隱藏資訊原文右側的返回圖示；可用手勢直接關閉頁面。",
      gestureBack: "手勢返回",
      drawEditGesture: "繪製 / 修改手勢",
      enableGestureBack: "啟用手勢返回",
      gestureMatchPrecision: "比對精度",
      gesturePrecisionHint: "精度越高，只有更相似的手勢才會觸發",
      precisionLow: "低",
      precisionMedium: "中",
      precisionHigh: "高",
      gestureEditorHint:
        "按住左鍵畫出軌跡並儲存。使用時在資訊頁或已開啟的資訊子頁按住滑鼠右鍵畫出相近軌跡。",
      drawGesturePath: "繪製手勢返回軌跡",
      clear: "清除",
      savePath: "儲存軌跡",
      answerSettings: "設定",
      answerLength: "作答長度",
      answerLengthHint: "長度越長，檢索與生成時間越長。",
      answerShort: "短",
      answerShortHint: "聚焦結論與 4—6 條依據",
      answerMedium: "中",
      answerMediumHint: "更多來源、依據與延伸觀點",
      answerLong: "長",
      answerLongHint: "最廣證據、深入解讀與邊界討論",
      answerFontSize: "字號",
      libraryAnswerFontSize: "書庫問答字號",
      decreaseAnswerFont: "減小問答字號",
      increaseAnswerFont: "增大問答字號",
      longContextReading: "複雜問題長文精讀（BGE-M3）",
      toggleLongContextReading: "切換複雜問題長文精讀",
      closeSettings: "關閉設定",
    },
    en: {
      sortAndLayout: "Sort & layout",
      sort: "Sort",
      sortTitle: "Title",
      sortAuthor: "Author",
      sortImported: "Imported",
      sortFolder: "Folder",
      allBooks: "All books",
      sortRecent: "Recently read",
      sortReadingTime: "Reading time",
      sortFileSize: "Size",
      sortProgress: "Reading progress",
      readingFilters: "Reading filters",
      unread: "Unread",
      reading: "Reading",
      finished: "Finished",
      ratingFilterTip:
        "Filter by rating: click a star for that rating and above; click it again to clear",
      tags: "Tags",
      collections: "Collections",
      matchAny: "Match any",
      layout: "Layout",
      listLayout: "List",
      gridLayout: "Grid",
      columns: "Columns",
      default: "Default",
      decreaseColumns: "Fewer columns",
      increaseColumns: "More columns",
      readingStatsSettings: "Reading statistics settings",
      readingDuration: "Reading time",
      readingWords: "Words read",
      averageSpeed: "Average speed",
      booksRead: "Books read",
      finishedBooks: "Finished",
      highlights: "Highlights",
      annotations: "Notes",
      chartSwitch: "Chart metric",
      time: "Time",
      chartMetricTip: "Switch chart between time and words",
      day: "Day",
      month: "Month",
      year: "Year",
      total: "Total",
      newsSettings: "News settings",
      closeNewsSettings: "Close news settings",
      backgroundPrefetch: "Background prefetch",
      backgroundPrefetchNote:
        "When the app is idle, enabled sources refresh every 5 minutes. Images still load only when cards enter view.",
      newsHideReturnIcon: "Hide return icon",
      newsHideReturnIconNote:
        "Off by default, so the return icon is shown. Enable it to hide the icon on an opened article; a gesture can still close the page directly.",
      gestureBack: "Gesture back",
      drawEditGesture: "Draw / edit gesture",
      enableGestureBack: "Enable gesture back",
      gestureMatchPrecision: "Match precision",
      gesturePrecisionHint:
        "Higher precision only triggers on more similar gestures",
      precisionLow: "Low",
      precisionMedium: "Medium",
      precisionHigh: "High",
      gestureEditorHint:
        "Hold the left mouse button to draw and save a path. On the News page or an opened article, hold the right mouse button and draw a similar path.",
      drawGesturePath: "Draw a gesture-back path",
      clear: "Clear",
      savePath: "Save path",
      answerSettings: "Settings",
      answerLength: "Answer length",
      answerLengthHint:
        "Longer answers take more time to retrieve and generate.",
      answerShort: "Short",
      answerShortHint: "Focus on conclusions and 4–6 supporting points",
      answerMedium: "Medium",
      answerMediumHint: "More sources, evidence, and extended views",
      answerLong: "Long",
      answerLongHint: "Broadest evidence, deeper analysis, and limitations",
      answerFontSize: "Font size",
      libraryAnswerFontSize: "Library Q&A font size",
      decreaseAnswerFont: "Decrease answer font size",
      increaseAnswerFont: "Increase answer font size",
      longContextReading: "Long-context reading for complex questions (BGE-M3)",
      toggleLongContextReading: "Toggle long-context reading",
      closeSettings: "Close settings",
    },
  };
  Object.keys(COPY)
    .filter((locale) => locale !== "ja" && locale !== "ko")
    .forEach((locale) =>
      Object.assign(
        localeCopy(COPY, locale),
        PANEL_COPY.en,
        asLocaleCatalog(PANEL_COPY)[locale] || {},
      ),
    );
  // The main window loads this catalog immediately before this compatibility
  // entry. Keep the local data only for isolated consumers that load this
  // file alone (for example a standalone regression harness).
  const STATS_CATALOG = global.ReaderAppI18nStatsCatalog;
  if (
    STATS_CATALOG !== undefined &&
    (typeof STATS_CATALOG.applyChart !== "function" ||
      typeof STATS_CATALOG.applyDetail !== "function" ||
      typeof STATS_CATALOG.applyHeatmap !== "function")
  ) {
    throw new Error(
      "ReaderAppI18nStatsCatalog must expose statistics appliers",
    );
  }
  const STATS_CHART_COPY = {
    "zh-CN": {
      lineChartData: "折线图显示数据",
      lineChartDataTip: "以折线图显示，并标注数据点数值",
      chartSettings: "图表设置",
      chartStyle: "图形",
      barChart: "柱状",
      lineChart: "折线",
      chartData: "数据",
      chartWords: "字数",
    },
    "zh-TW": {
      lineChartData: "折線圖顯示資料",
      lineChartDataTip: "以折線圖顯示，並標註資料點數值",
      chartSettings: "圖表設定",
      chartStyle: "圖形",
      barChart: "柱狀",
      lineChart: "折線",
      chartData: "資料",
      chartWords: "字數",
    },
    en: {
      lineChartData: "Show data as a line chart",
      lineChartDataTip:
        "Use a line chart with values labelled at each data point",
      chartSettings: "Chart settings",
      chartStyle: "Style",
      barChart: "Bars",
      lineChart: "Line",
      chartData: "Data",
      chartWords: "Words",
    },
    ja: {
      lineChartData: "折れ線グラフで表示",
      lineChartDataTip: "折れ線グラフに切り替え、各データ点の値を表示します",
      chartSettings: "グラフ設定",
      chartStyle: "形式",
      barChart: "棒",
      lineChart: "折れ線",
      chartData: "データ",
      chartWords: "文字数",
    },
    ko: {
      lineChartData: "꺾은선 그래프로 표시",
      lineChartDataTip:
        "꺾은선 그래프로 전환하고 각 데이터 지점의 값을 표시합니다",
      chartSettings: "차트 설정",
      chartStyle: "형식",
      barChart: "막대",
      lineChart: "꺾은선",
      chartData: "데이터",
      chartWords: "글자 수",
    },
  };
  if (STATS_CATALOG) {
    STATS_CATALOG.applyChart(COPY);
  } else {
    Object.keys(COPY).forEach((locale) =>
      Object.assign(
        localeCopy(COPY, locale),
        STATS_CHART_COPY.en,
        asLocaleCatalog(STATS_CHART_COPY)[locale] || {},
      ),
    );
  }
  const DYNAMIC_PANEL_COPY = {
    "zh-CN": {
      activeFilters: "已启用筛选",
      matchAll: "匹配全部",
      matchAllHint: "标签与收藏夹必须同时匹配，点击改为匹配任一",
      matchAnyHint: "标签与收藏夹命中任一即可，点击改为匹配全部",
      selectItems: "选择{title}",
      multiSelectNoFilter: "可多选；不选择则不过滤。",
      statsHourMinute: "{hours} 小时 {minutes} 分钟",
      statsMinutes: "{minutes} 分钟",
      statsSeconds: "{seconds} 秒",
      statsWords: "{words} 字",
      statsTenThousandWords: "{words} 万字",
      wordsPerMinute: "{words} 字/分钟",
      statsMonth: "{month} 月",
      statsAll: "全部",
      statsLoading: "正在加载阅读统计…",
      statsLoadFailed: "阅读统计加载失败，请稍后重试。",
      statsPeriodUnit: "段时间",
      currentPeriodBooks: "这一{unit}读过的书",
      noReadingRecords: "这段时间还没有阅读记录",
      yearlyHeatmap: "近一年每日阅读热力图",
      totalReadingTime: "累计阅读时长",
      dailyPeak: "单日峰值",
      currentStreak: "当前连续阅读",
      longestStreak: "最长连续阅读",
      days: "{count} 天",
      finishedBook: "读完",
      gestureNeedPath: "请先绘制并保存手势返回轨迹。",
      gesturePrecisionSaved: "已将手势返回精度设为{precision}。",
      gesturePathTooShort: "轨迹太短，暂未保存。",
      gestureSaved: "手势返回已保存并启用。",
      gestureCleared: "已清除并关闭手势返回。",
      longContextUnavailable: "当前无法启用，点击查看开启方式",
      longContextEnabled: "已启用复杂问题长文精读。",
      longContextDisabled: "已关闭复杂问题长文精读。",
      longContextSaveFailed: "设置长文精读失败：{error}",
      longContextSetupPath:
        "开启方式：设置 → 语义索引 → 切换语义模型为 BGE-M3 → 下载模型 → 建立语义索引，然后回到书库问答 → 设置开启。",
      answerLengthSaveFailed: "保存作答长度失败：{error}",
    },
    "zh-TW": {
      activeFilters: "已啟用篩選",
      matchAll: "符合全部",
      matchAllHint: "標籤與收藏夾必須同時符合，點擊改為符合任一",
      matchAnyHint: "標籤與收藏夾符合任一即可，點擊改為符合全部",
      selectItems: "選擇{title}",
      multiSelectNoFilter: "可多選；不選擇則不篩選。",
      statsHourMinute: "{hours} 小時 {minutes} 分鐘",
      statsMinutes: "{minutes} 分鐘",
      statsSeconds: "{seconds} 秒",
      statsWords: "{words} 字",
      statsTenThousandWords: "{words} 萬字",
      wordsPerMinute: "{words} 字/分鐘",
      statsMonth: "{month} 月",
      statsAll: "全部",
      statsLoading: "正在載入閱讀統計…",
      statsLoadFailed: "閱讀統計載入失敗，請稍後再試。",
      statsPeriodUnit: "段時間",
      currentPeriodBooks: "這一{unit}讀過的圖書",
      noReadingRecords: "這段時間還沒有閱讀記錄",
      yearlyHeatmap: "近一年每日閱讀熱力圖",
      totalReadingTime: "累計閱讀時長",
      dailyPeak: "單日峰值",
      currentStreak: "目前連續閱讀",
      longestStreak: "最長連續閱讀",
      days: "{count} 天",
      finishedBook: "讀完",
      gestureNeedPath: "請先繪製並儲存手勢返回軌跡。",
      gesturePrecisionSaved: "已將手勢返回精度設為{precision}。",
      gesturePathTooShort: "軌跡太短，暫未儲存。",
      gestureSaved: "手勢返回已儲存並啟用。",
      gestureCleared: "已清除並關閉手勢返回。",
      longContextUnavailable: "目前無法啟用，點擊查看開啟方式",
      longContextEnabled: "已啟用複雜問題長文精讀。",
      longContextDisabled: "已關閉複雜問題長文精讀。",
      longContextSaveFailed: "設定長文精讀失敗：{error}",
      longContextSetupPath:
        "開啟方式：設定 → 語意索引 → 切換語意模型為 BGE-M3 → 下載模型 → 建立語意索引，然後回到書庫問答 → 設定開啟。",
      answerLengthSaveFailed: "儲存作答長度失敗：{error}",
    },
    en: {
      activeFilters: "Filters active",
      matchAll: "Match all",
      matchAllHint: "Tags and collections must all match; click to match any",
      matchAnyHint: "Any tag or collection may match; click to match all",
      selectItems: "Select {title}",
      multiSelectNoFilter:
        "You may select multiple items; select none to disable filtering.",
      statsHourMinute: "{hours} h {minutes} min",
      statsMinutes: "{minutes} min",
      statsSeconds: "{seconds} sec",
      statsWords: "{words} words",
      statsTenThousandWords: "{words} ×10k words",
      wordsPerMinute: "{words} words/min",
      statsMonth: "{month} mo",
      statsAll: "All",
      statsLoading: "Loading reading statistics…",
      statsLoadFailed: "Could not load reading statistics. Please try again.",
      statsPeriodUnit: "period",
      currentPeriodBooks: "Books read this {unit}",
      noReadingRecords: "No reading records in this period",
      yearlyHeatmap: "Daily reading heatmap for the past year",
      totalReadingTime: "Total reading time",
      dailyPeak: "Daily peak",
      currentStreak: "Current streak",
      longestStreak: "Longest streak",
      days: "{count} days",
      finishedBook: "Finished",
      statsQualityDwell:
        "This period may include idle time: reading time is long but few words were counted.",
      statsQualityFast:
        "The average reading speed is high and may include rapid page turns or repeated counting.",
      statsQualitySlow:
        "The average reading speed is low and may include idle time or scanned PDFs.",
      gestureNeedPath: "Draw and save a gesture-back path first.",
      gesturePrecisionSaved: "Gesture-back precision is set to {precision}.",
      gesturePathTooShort: "The path is too short to save.",
      gestureSaved: "Gesture back is saved and enabled.",
      gestureCleared: "Gesture back is cleared and disabled.",
      longContextUnavailable:
        "This cannot be enabled yet. Click for setup instructions.",
      longContextEnabled: "Long-context reading is enabled.",
      longContextDisabled: "Long-context reading is disabled.",
      longContextSaveFailed: "Could not set long-context reading: {error}",
      longContextSetupPath:
        "Setup: Settings → Semantic index → choose BGE-M3 → download the model → build a semantic index; then return to Library Q&A → Settings to enable it.",
      answerLengthSaveFailed: "Could not save answer length: {error}",
    },
  };
  Object.keys(COPY)
    .filter((locale) => locale !== "ja" && locale !== "ko")
    .forEach((locale) =>
      Object.assign(
        localeCopy(COPY, locale),
        DYNAMIC_PANEL_COPY.en,
        asLocaleCatalog(DYNAMIC_PANEL_COPY)[locale] || {},
      ),
    );
  const STATS_DETAIL_COPY = {
    "zh-CN": {
      statsBookNotes: "高亮 {highlights} · 批注 {notes}",
      statsQualityDwell: "本时段可能包含空闲时间：阅读时长较长，但统计字数较少。",
      statsQualityFast: "本时段平均阅读速度偏高，可能包含快速翻页或重复计数。",
      statsQualitySlow: "本时段平均阅读速度偏低，可能包含空闲时间或扫描版 PDF。",
    },
    "zh-TW": {
      statsBookNotes: "標示 {highlights} · 批註 {notes}",
      statsQualityDwell: "這段期間可能包含閒置時間：閱讀時間較長，但統計字數較少。",
      statsQualityFast: "這段期間的平均閱讀速度偏高，可能包含快速翻頁或重複計數。",
      statsQualitySlow: "這段期間的平均閱讀速度偏低，可能包含閒置時間或掃描版 PDF。",
    },
    en: { statsBookNotes: "Highlights {highlights} · Notes {notes}" },
  };
  if (STATS_CATALOG) {
    STATS_CATALOG.applyDetail(COPY);
  } else {
    Object.keys(COPY)
      .filter((locale) => locale !== "ja" && locale !== "ko")
      .forEach((locale) =>
        Object.assign(
          localeCopy(COPY, locale),
          STATS_DETAIL_COPY.en,
          asLocaleCatalog(STATS_DETAIL_COPY)[locale] || {},
        ),
      );
  }
  const STATS_HEATMAP_COPY = {
    "zh-CN": {
      heatmapColor: "热力图颜色",
      heatmapGreen: "青绿",
      heatmapBlue: "湖蓝",
      heatmapOrange: "暖橙",
    },
    "zh-TW": {
      heatmapColor: "熱力圖顏色",
      heatmapGreen: "青綠",
      heatmapBlue: "湖藍",
      heatmapOrange: "暖橙",
    },
    en: {
      heatmapColor: "Heatmap color",
      heatmapGreen: "Green",
      heatmapBlue: "Blue",
      heatmapOrange: "Orange",
    },
    ja: {
      heatmapColor: "ヒートマップの色",
      heatmapGreen: "グリーン",
      heatmapBlue: "ブルー",
      heatmapOrange: "オレンジ",
    },
    ko: {
      heatmapColor: "히트맵 색상",
      heatmapGreen: "초록",
      heatmapBlue: "파랑",
      heatmapOrange: "주황",
    },
  };
  if (STATS_CATALOG) {
    STATS_CATALOG.applyHeatmap(COPY);
  } else {
    Object.keys(COPY).forEach((locale) =>
      Object.assign(
        localeCopy(COPY, locale),
        STATS_HEATMAP_COPY.en,
        asLocaleCatalog(STATS_HEATMAP_COPY)[locale] || {},
      ),
    );
  }
  const ACCOUNT_RUNTIME_COPY = {
    "zh-CN": {
      accountSecurityBoundEmail:
        "已绑定验证邮箱：{email}。可用于找回登录密码。",
      accountSecurityEmailUnbound: "尚未绑定验证邮箱。绑定后才能找回登录密码。",
      accountSecurityMailUnavailable:
        "账户安全邮件暂未配置；暂时不能绑定或找回登录密码。",
      accountSecurityLoadFailed: "读取账户安全状态失败：{error}",
      cloudSecretAvailable: "云端已有加密密钥包；需要同步密码才能在本机解锁。",
      localSecretsOnly: "API Key 和翻译密钥默认仅保留在本机。",
      privateSyncLoadFailed: "读取私密同步设置失败：{error}",
    },
    "zh-TW": {
      accountSecurityBoundEmail:
        "已綁定驗證電子郵件：{email}。可用於找回登入密碼。",
      accountSecurityEmailUnbound:
        "尚未綁定驗證電子郵件。綁定後才能找回登入密碼。",
      accountSecurityMailUnavailable:
        "帳戶安全郵件尚未設定；暫時無法綁定或找回登入密碼。",
      accountSecurityLoadFailed: "讀取帳戶安全狀態失敗：{error}",
      cloudSecretAvailable: "雲端已有加密金鑰包；需要同步密碼才能在本機解鎖。",
      localSecretsOnly: "API Key 和翻譯金鑰預設僅保留在本機。",
      privateSyncLoadFailed: "讀取私密同步設定失敗：{error}",
    },
    en: {
      accountSecurityBoundEmail:
        "Verified email bound: {email}. It can be used to recover your sign-in password.",
      accountSecurityEmailUnbound:
        "No verified email is bound. Bind one to recover your sign-in password.",
      accountSecurityMailUnavailable:
        "Account security email is not configured, so email binding and password recovery are unavailable.",
      accountSecurityLoadFailed:
        "Could not load account security status: {error}",
      cloudSecretAvailable:
        "An encrypted secret package exists in the cloud. Enter the sync password to unlock it on this device.",
      localSecretsOnly:
        "API keys and translation secrets remain on this device by default.",
      privateSyncLoadFailed: "Could not load private sync settings: {error}",
    },
  };
  Object.keys(COPY)
    .filter((locale) => locale !== "ja" && locale !== "ko")
    .forEach((locale) =>
      Object.assign(
        localeCopy(COPY, locale),
        ACCOUNT_RUNTIME_COPY.en,
        asLocaleCatalog(ACCOUNT_RUNTIME_COPY)[locale] || {},
      ),
    );
  const SYNC_COUNTS_COPY = {
    "zh-CN":
      "上次尝试上传 {pushed} 项，新增 {accepted} 项，重复/冲突 {ignored} 项，接收 {pulled} 项；图书文件本身不会上传",
    "zh-TW":
      "上次嘗試上傳 {pushed} 項，新增 {accepted} 項，重複/衝突 {ignored} 項，接收 {pulled} 項；圖書檔案本身不會上傳",
    en: "Last attempt: uploaded {pushed}, added {accepted}, duplicate/conflict {ignored}, received {pulled}; book files are never uploaded.",
    ja: "前回の試行: アップロード {pushed}、追加 {accepted}、重複・競合 {ignored}、受信 {pulled}。本のファイルはアップロードされません。",
    ko: "지난 시도: 업로드 {pushed}, 추가 {accepted}, 중복/충돌 {ignored}, 수신 {pulled}. 책 파일은 업로드되지 않습니다.",
    fr: "Dernière tentative : envoi {pushed}, ajout {accepted}, doublon/conflit {ignored}, réception {pulled}. Les fichiers de livres ne sont jamais envoyés.",
    de: "Letzter Versuch: hochgeladen {pushed}, hinzugefügt {accepted}, Duplikat/Konflikt {ignored}, empfangen {pulled}. Buchdateien werden nie hochgeladen.",
    es: "Último intento: enviados {pushed}, añadidos {accepted}, duplicado/conflicto {ignored}, recibidos {pulled}. Los archivos de libros nunca se suben.",
    ru: "Последняя попытка: отправлено {pushed}, добавлено {accepted}, дубликаты/конфликты {ignored}, получено {pulled}. Файлы книг не загружаются.",
    "pt-BR":
      "Última tentativa: enviados {pushed}, adicionados {accepted}, duplicados/conflitos {ignored}, recebidos {pulled}. Os arquivos dos livros nunca são enviados.",
  };
  Object.entries(SYNC_COUNTS_COPY).forEach(([locale, copy]) => {
    localeCopy(COPY, locale).syncCounts = copy;
  });
  const LIBRARY_SELECTOR_COPY = {
    "zh-CN": {
      libraryScopeTip:
        "书库问答会精确检索全部已建立语义索引的图书，展示最相关的前 20 本（每本 1 段）。勾选图书后才限定范围；跨书对比请选择 2–8 本。",
      libraryFilters: "快速筛选图书",
      tagLabel: "标签",
      collectionLabel: "收藏夹",
      libraryFilterTip:
        "未勾选不代表未参与：书库问答默认检索全部已建立语义索引的图书；勾选才会切换为手动限定范围。",
      bookSelectorPlaceholder: "搜索书名、作者、简介或标签",
      scopeAllBooks: "当前范围：全部书库",
      questionScopeSelected: "当前范围：仅检索已选 {selected} 本{visible}",
      questionScopeAll:
        "当前范围：全部书库（未勾选即全库检索，前 {limit} 本命中）",
      compareScope: "对比范围：已选 {selected}/{limit} 本{visible}",
      scopeVisible: "（当前显示 {count} 本）",
      bookCountAll: "书架共 {count} 本",
      bookCountFiltered: "显示 {visible} / 共 {total} 本",
      noBookSearchMatches: "没有匹配书名、作者、简介或标签的图书。",
      unnamedBook: "未命名图书",
      unknownAuthor: "未知作者",
      selectionLimitMessage: "{mode}最多选择 {limit} 本图书。",
    },
    "zh-TW": {
      libraryScopeTip:
        "書庫問答會精確檢索全部已建立語意索引的圖書，顯示最相關的前 20 本（每本 1 段）。勾選圖書後才限定範圍；跨書比較請選擇 2–8 本。",
      libraryFilters: "快速篩選圖書",
      tagLabel: "標籤",
      collectionLabel: "收藏夾",
      libraryFilterTip:
        "未勾選不代表未參與：書庫問答預設檢索全部已建立語意索引的圖書；勾選才會切換為手動限定範圍。",
      bookSelectorPlaceholder: "搜尋書名、作者、簡介或標籤",
      scopeAllBooks: "目前範圍：全部書庫",
      questionScopeSelected: "目前範圍：僅檢索已選 {selected} 本{visible}",
      questionScopeAll:
        "目前範圍：全部書庫（未勾選即全庫檢索，前 {limit} 本命中）",
      compareScope: "比較範圍：已選 {selected}/{limit} 本{visible}",
      scopeVisible: "（目前顯示 {count} 本）",
      bookCountAll: "書架共 {count} 本",
      bookCountFiltered: "顯示 {visible} / 共 {total} 本",
      noBookSearchMatches: "沒有符合書名、作者、簡介或標籤的圖書。",
      unnamedBook: "未命名圖書",
      unknownAuthor: "未知作者",
      selectionLimitMessage: "{mode}最多選擇 {limit} 本圖書。",
    },
    en: {
      libraryScopeTip:
        "Library Q&A searches every book with a semantic index and shows the 20 most relevant books (one passage each). Checking books limits the scope; choose 2–8 books for comparison.",
      libraryFilters: "Quick book filters",
      tagLabel: "Tags",
      collectionLabel: "Collections",
      libraryFilterTip:
        "Unchecked books still participate: Library Q&A searches every indexed book by default. Checking books switches to a manual scope.",
      bookSelectorPlaceholder: "Search title, author, description, or tags",
      scopeAllBooks: "Current scope: Entire library",
      questionScopeSelected:
        "Current scope: {selected} selected book(s){visible}",
      questionScopeAll:
        "Current scope: Entire library (all indexed books; top {limit} matches)",
      compareScope: "Comparison scope: {selected}/{limit} book(s){visible}",
      scopeVisible: " ({count} currently shown)",
      bookCountAll: "{count} books on shelf",
      bookCountFiltered: "Showing {visible} of {total} books",
      noBookSearchMatches:
        "No books match the title, author, description, or tags.",
      unnamedBook: "Untitled book",
      unknownAuthor: "Unknown author",
      selectionLimitMessage: "{mode} supports up to {limit} books.",
    },
  };
  Object.entries(LIBRARY_SELECTOR_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  // Japanese copy for the news and Library Q&A surfaces.  Do not inherit the
  // English catalog here: doing so made a partial translation look complete
  // and is exactly why Japanese screens could become mixed-language.
  Object.assign(localeCopy(COPY, "ja"), {
    newsTitle: "今日のニュース",
    newsDescription:
      "時間順にまとめた軽量ニュースです。開いたときだけ読み込みます。",
    backToShelf: "本棚に戻る",
    manageSources: "ソースを管理",
    refresh: "更新",
    sourceSettings: "ニュースソースの設定",
    sourceSettingsHint:
      "表示するソースを選択します。選択内容はサインイン済みの端末に同期されます。",
    sourceSearch: "ソース、カテゴリ、キーワードを検索",
    restoreRecommended: "おすすめに戻す",
    doneAndRefresh: "完了して更新",
    mixedOrder: "混在",
    bySourceOrder: "ソース順",
    newsCategoryAll: "すべて",
    newsSourceSummary: "{count}件のソースを表示",
    newsRecommendedSources: "おすすめのソースを使用",
    newsSelectedSources: "{count} / {max} 件を選択",
    noMatchingSources: "一致する内蔵ソースはありません。",
    maxSources: "選択できるソースは最大 {max} 件です。",
    chooseSource:
      "少なくとも1つのソースを選ぶか、「おすすめに戻す」を使ってください。",
    openWebPage: "Webページを開く →",
    noNewsInCategory: "このカテゴリにはまだニュースがありません。",
    noNews:
      "ニュースはまだありません。更新するか、「ソースを管理」で表示内容を変更してください。",
    loadingNews: "読み込み中…",
    refreshingNews: "更新中…",
    newsUpdatedAt: "更新日時: {time}",
    libraryDescription:
      "まずローカルのセマンティック索引を検索し、ヒットした少数の本文だけを設定済みのAI読書サービスに送ります。各回答から元の章へ戻れます。",
    bookClassification: "本の分類",
    questionHistory: "質問履歴",
    localSearchCitations: "ローカル検索・追跡可能な引用",
    searchScope: "検索範囲",
    libraryQuestion: "ライブラリ Q&A",
    crossBookCompare: "複数の本を比較",
    yourQuestion: "質問",
    startQuestion: "質問する",
    answerPlaceholder:
      "範囲を選んで質問を入力してください。結果がない場合は、メイン設定でセマンティック索引を作成してください。",
    questionPlaceholder:
      "例: これらの本は清末の財政危機をどのように説明していますか？\n複数の本を比較する場合: 選択した作品の同じテーマに関する見解と根拠を比較します。",
    allTags: "すべてのタグ",
    allCollections: "すべてのコレクション",
    clearFilters: "フィルターを解除",
    cancelLimit: "範囲指定を解除",
    clearSelection: "選択を解除",
    selectVisible: "表示中をすべて選択",
    invertVisible: "表示中を反転",
    noBooks: "本棚に本がありません。",
    noFilteredBooks: "現在のタグとコレクションに一致する本はありません。",
    unnamedQuestion: "無題の質問",
    noQuestionHistory:
      "保存済みのライブラリ Q&A はありません。質問に回答すると自動保存されます。",
    loadingLibrary: "本棚とAI読書の設定を読み込み中…",
    askInProgress: "検索して回答を生成中…",
    enterQuestion: "質問を入力してください。",
    libraryQuestionFailed: "ライブラリ Q&A に失敗しました。",
    libraryHistory: "質問履歴",
    returnToAnswer: "今回の回答に戻る",
    delete: "削除",
    copy: "コピー",
    cut: "切り取り",
    paste: "貼り付け",
    libraryScopeTip:
      "ライブラリ Q&A はセマンティック索引を作成済みのすべての本を検索し、最も関連する上位20冊（各1節）を表示します。本を選択すると範囲を限定します。比較には2〜8冊を選んでください。",
    libraryFilters: "本をすばやく絞り込む",
    tagLabel: "タグ",
    collectionLabel: "コレクション",
    libraryFilterTip:
      "未選択の本も検索対象です。ライブラリ Q&A は初期状態で索引済みの全書籍を検索し、選択すると手動範囲に切り替わります。",
    bookSelectorPlaceholder: "書名、著者、紹介、タグを検索",
    scopeAllBooks: "現在の範囲: 本棚全体",
    questionScopeSelected: "現在の範囲: {selected}冊を選択{visible}",
    questionScopeAll: "現在の範囲: 本棚全体（索引済み全書籍、上位 {limit} 件）",
    compareScope: "比較範囲: {selected}/{limit}冊を選択{visible}",
    scopeVisible: "（現在 {count}冊を表示）",
    bookCountAll: "本棚に {count}冊",
    bookCountFiltered: "{total}冊中 {visible}冊を表示",
    noBookSearchMatches: "書名、著者、紹介、タグに一致する本はありません。",
    unnamedBook: "無題の本",
    unknownAuthor: "不明な著者",
    selectionLimitMessage: "{mode}では最大 {limit}冊を選択できます。",
  });
  // Settings panels are shared by News and Library Q&A.  Korean must not
  // inherit their English fallback merely because the panels open lazily.
  Object.assign(localeCopy(COPY, "ko"), {
    newsSettings: "뉴스 설정",
    closeNewsSettings: "뉴스 설정 닫기",
    backgroundPrefetch: "백그라운드 미리 가져오기",
    backgroundPrefetchNote:
      "앱이 유휴 상태가 되면 5분마다 활성화한 소스를 업데이트합니다. 이미지는 카드가 화면에 들어올 때만 불러옵니다.",
    newsHideReturnIcon: "반환 아이콘 숨기기",
    newsHideReturnIconNote:
      "기본값은 끔이며 반환 아이콘이 표시됩니다. 켜면 뉴스 원문 오른쪽 아이콘을 숨기며, 제스처로는 바로 페이지를 닫을 수 있습니다.",
    gestureBack: "제스처로 돌아가기",
    drawEditGesture: "제스처 그리기 / 수정",
    enableGestureBack: "제스처로 돌아가기 사용",
    gestureMatchPrecision: "일치 정밀도",
    gesturePrecisionHint: "정밀도가 높을수록 더 비슷한 제스처만 실행됩니다.",
    precisionLow: "낮음",
    precisionMedium: "중간",
    precisionHigh: "높음",
    gestureEditorHint:
      "왼쪽 버튼을 누른 채 궤적을 그리고 저장하세요. 뉴스 페이지 또는 열린 뉴스 하위 페이지에서 오른쪽 버튼을 누른 채 비슷한 궤적을 그리면 사용할 수 있습니다.",
    drawGesturePath: "돌아가기 제스처 궤적 그리기",
    clear: "지우기",
    savePath: "궤적 저장",
    answerSettings: "설정",
    answerLength: "답변 길이",
    answerLengthHint: "길수록 검색과 생성에 더 오래 걸립니다.",
    answerShort: "짧게",
    answerShortHint: "결론과 4~6개의 근거에 집중",
    answerMedium: "보통",
    answerMediumHint: "더 많은 출처, 근거, 확장된 관점",
    answerLong: "길게",
    answerLongHint: "가장 넓은 근거, 깊은 해설, 한계 논의",
    answerFontSize: "글자 크기",
    libraryAnswerFontSize: "라이브러리 Q&A 글자 크기",
    decreaseAnswerFont: "Q&A 글자 줄이기",
    increaseAnswerFont: "Q&A 글자 키우기",
    longContextReading: "복잡한 질문용 긴 글 정독(BGE-M3)",
    toggleLongContextReading: "긴 글 정독 전환",
    closeSettings: "설정 닫기",
  });
  Object.assign(localeCopy(COPY, "en"), {
    historyGridToList: "Grid view is active. Select to switch to list view.",
    historyListToGrid: "List view is active. Select to switch to grid view.",
    newsSourceRequired: "Keep at least one news source.",
    newsSourcesSaved: "Saved. Refreshing news automatically…",
    newsTiebaLimit: "You can add up to {max} forums.",
    newsSourceLimit:
      "The source limit is reached, so {name} cannot be enabled yet.",
  });
  Object.assign(localeCopy(COPY, "ja"), {
    historyGridToList: "グリッド表示です。選ぶとリスト表示に切り替わります。",
    historyListToGrid: "リスト表示です。選ぶとグリッド表示に切り替わります。",
    newsSourceRequired: "ニュースソースを少なくとも1つ残してください。",
    newsSourcesSaved: "保存しました。ニュースを自動更新中です…",
    newsTiebaLimit: "追加できるフォーラムは最大 {max} 件です。",
    newsSourceLimit:
      "ソース数の上限に達したため、{name} はまだ有効にできません。",
  });
  Object.assign(localeCopy(COPY, "ko"), {
    historyGridToList: "격자 보기입니다. 선택하면 목록 보기로 전환합니다.",
    historyListToGrid: "목록 보기입니다. 선택하면 격자 보기로 전환합니다.",
    newsSourceRequired: "뉴스 소스를 하나 이상 남겨 두세요.",
    newsSourcesSaved: "저장되었습니다. 뉴스를 자동으로 새로 고치는 중…",
    newsTiebaLimit: "포럼은 최대 {max}개까지 추가할 수 있습니다.",
    newsSourceLimit:
      "소스 한도에 도달하여 {name}을(를) 아직 활성화할 수 없습니다.",
  });
  // Semantic-index settings are rendered after the main page has loaded, so
  // they need the same catalog rather than module-local Chinese strings.
  const SEMANTIC_SETTINGS_COPY = {
    "zh-CN": {
      semTitle: "语义索引",
      semDescription:
        "语义检索在本机离线运行。首次建立索引会较久，但可以暂停、续建；关闭本窗口后，正在运行的任务会继续在后台执行。",
      semSelectModel: "切换语义模型",
      semModelSmall: "BGE Small 中文（默认，轻量）",
      semModelLarge: "BGE Large 中文（高精度）",
      semModelM3: "BGE-M3（多语言、混合检索）",
      semModelE5: "Multilingual-E5-Small（多语言，轻量）",
      semCurrentModel: "当前模型状态",
      semGpu: "GPU 加速",
      semGpuInitial: "点击“重新检测”读取本机 GPU 状态。",
      semGpuReady: "加速功能已就绪。",
      semRefreshGpu: "重新检测",
      semInstallGpuRuntime: "安装 GPU 组件",
      semResumeGpuRuntime: "继续安装 GPU 组件（{percent}%）",
      semInstallingGpuRuntime: "正在安装 GPU 组件…",
      semGpuInstallConfirm:
        "尚需下载并安装约 {size} GiB 的 NVIDIA GPU 运行库，是否继续？CPU 回退仍会保留。",
      semGpuDownloading: "正在下载 GPU 组件：{percent}%…",
      semGpuInstallFailed: "GPU 组件安装失败：{error}",
      semIndexTitle: "语义索引",
      semNotBuilt: "尚未建立",
      semBuildIndex: "建立语义索引",
      semPause: "暂停",
      semAdvanced: "高级管理：检索增强、加速索引、画像索引与单项删除",
      semRetrievalStrategy: "检索策略",
      semRetrievalStandard: "标准：全文＋语义融合",
      semRetrievalHigh: "高精度：融合＋重排",
      semRetrievalM3: "实验性：M3 稀疏＋ColBERT",
      semReranker: "重排模型",
      semRerankerDescription: "让最符合问题的内容排在前面，回答引用更准确。",
      semDownloadReranker: "下载重排模型",
      semM3Index: "BGE-M3 稀疏索引与 ColBERT 重排",
      semM3Description: "建立后能更好兼顾关键词和语义，复杂问题更容易找到。",
      semBuildM3: "建立 M3 索引",
      semAccelerator: "加速索引",
      semAcceleratorDescription: "让已建立语义索引的大书库更快返回检索结果。",
      semBuildAccelerator: "建立加速索引",
      semMultiProfile: "多中心画像索引",
      semMultiProfileDescription:
        "把一本书的不同主题分别归类，跨主题提问时更容易找到对应内容。",
      semBuildMulti: "建立多中心画像",
      semDelete: "删除",
    },
    en: {
      semTitle: "Semantic index",
      semDescription:
        "Semantic search runs offline on this device. The first build can take time, but it can be paused and resumed; running work continues in the background after this window closes.",
      semSelectModel: "Choose semantic model",
      semModelSmall: "BGE Small Chinese (default, light)",
      semModelLarge: "BGE Large Chinese (high precision)",
      semModelM3: "BGE-M3 (multilingual, hybrid retrieval)",
      semModelE5: "Multilingual-E5-Small (multilingual, light)",
      semCurrentModel: "Current model status",
      semGpu: "GPU acceleration",
      semGpuInitial: "Select Recheck to read the local GPU status.",
      semGpuReady: "Acceleration is ready.",
      semRefreshGpu: "Recheck",
      semInstallGpuRuntime: "Install GPU component",
      semResumeGpuRuntime: "Resume GPU component installation ({percent}%)",
      semInstallingGpuRuntime: "Installing GPU component…",
      semGpuInstallConfirm:
        "Download and install about {size} GiB of remaining NVIDIA GPU runtime files? The CPU fallback remains available.",
      semGpuDownloading: "Downloading GPU component: {percent}%…",
      semGpuInstallFailed: "GPU component installation failed: {error}",
      semIndexTitle: "Semantic index",
      semNotBuilt: "Not built",
      semBuildIndex: "Build semantic index",
      semPause: "Pause",
      semAdvanced:
        "Advanced: retrieval enhancements, accelerator index, profile index, and item deletion",
      semRetrievalStrategy: "Retrieval strategy",
      semRetrievalStandard: "Standard: full text + semantic fusion",
      semRetrievalHigh: "High precision: fusion + reranking",
      semRetrievalM3: "Experimental: M3 sparse + ColBERT",
      semReranker: "Reranking model",
      semRerankerDescription:
        "Moves the content that best answers the question to the top for more accurate citations.",
      semDownloadReranker: "Download reranker",
      semM3Index: "BGE-M3 sparse index and ColBERT reranking",
      semM3Description:
        "Balances keywords and meaning so complex questions are easier to find.",
      semBuildM3: "Build M3 index",
      semAccelerator: "Accelerator index",
      semAcceleratorDescription:
        "Returns results faster for large libraries with a semantic index.",
      semBuildAccelerator: "Build accelerator index",
      semMultiProfile: "Multi-profile index",
      semMultiProfileDescription:
        "Classifies different topics in a book so cross-topic questions find the matching content more easily.",
      semBuildMulti: "Build multi-profile index",
      semDelete: "Delete",
    },
    ja: {
      semTitle: "セマンティック索引",
      semDescription:
        "セマンティック検索はこの端末でオフライン実行されます。初回の索引作成には時間がかかりますが、一時停止と再開ができます。この画面を閉じても実行中の作業はバックグラウンドで続きます。",
      semSelectModel: "セマンティックモデルを選択",
      semModelSmall: "BGE Small 中国語（既定・軽量）",
      semModelLarge: "BGE Large 中国語（高精度）",
      semModelM3: "BGE-M3（多言語・ハイブリッド検索）",
      semModelE5: "Multilingual-E5-Small（多言語・軽量）",
      semCurrentModel: "現在のモデル状態",
      semGpu: "GPUアクセラレーション",
      semGpuInitial: "「再検出」を選ぶと、この端末のGPU状態を読み取ります。",
      semGpuReady: "アクセラレーション機能の準備ができました。",
      semRefreshGpu: "再検出",
      semInstallGpuRuntime: "GPUコンポーネントをインストール",
      semResumeGpuRuntime:
        "GPUコンポーネントのインストールを再開（{percent}%）",
      semInstallingGpuRuntime: "GPUコンポーネントをインストール中…",
      semGpuInstallConfirm:
        "残り約 {size} GiB の NVIDIA GPU ランタイムをダウンロードしてインストールしますか？CPUへのフォールバックは引き続き利用できます。",
      semGpuDownloading: "GPUコンポーネントをダウンロード中: {percent}%…",
      semGpuInstallFailed:
        "GPUコンポーネントのインストールに失敗しました: {error}",
      semIndexTitle: "セマンティック索引",
      semNotBuilt: "未作成",
      semBuildIndex: "セマンティック索引を作成",
      semPause: "一時停止",
      semAdvanced:
        "詳細設定: 検索の強化、高速化索引、プロファイル索引、個別削除",
      semRetrievalStrategy: "検索戦略",
      semRetrievalStandard: "標準: 全文 + セマンティック検索を統合",
      semRetrievalHigh: "高精度: 統合 + 再ランキング",
      semRetrievalM3: "実験的: M3スパース + ColBERT",
      semReranker: "再ランキングモデル",
      semRerankerDescription:
        "質問に最も合う内容を先頭に並べ、引用の精度を高めます。",
      semDownloadReranker: "再ランキングモデルをダウンロード",
      semM3Index: "BGE-M3 スパース索引と ColBERT 再ランキング",
      semM3Description:
        "キーワードと意味の両方を扱い、複雑な質問を見つけやすくします。",
      semBuildM3: "M3索引を作成",
      semAccelerator: "高速化索引",
      semAcceleratorDescription:
        "セマンティック索引を作成済みの大きな本棚で、検索結果をより速く返します。",
      semBuildAccelerator: "高速化索引を作成",
      semMultiProfile: "マルチプロファイル索引",
      semMultiProfileDescription:
        "本の異なる話題を分類し、複数の話題にまたがる質問でも該当内容を見つけやすくします。",
      semBuildMulti: "マルチプロファイルを作成",
      semDelete: "削除",
    },
    ko: {
      semTitle: "의미 색인",
      semDescription:
        "의미 검색은 이 기기에서 오프라인으로 실행됩니다. 첫 색인 생성에는 시간이 걸릴 수 있지만 일시 정지와 이어 만들기가 가능하며, 이 창을 닫아도 실행 중인 작업은 백그라운드에서 계속됩니다.",
      semSelectModel: "의미 모델 선택",
      semModelSmall: "BGE Small 중국어(기본, 경량)",
      semModelLarge: "BGE Large 중국어(고정밀)",
      semModelM3: "BGE-M3(다국어, 하이브리드 검색)",
      semModelE5: "Multilingual-E5-Small(다국어, 경량)",
      semCurrentModel: "현재 모델 상태",
      semGpu: "GPU 가속",
      semGpuInitial: "다시 감지를 선택하면 이 기기의 GPU 상태를 읽습니다.",
      semGpuReady: "가속 기능을 사용할 준비가 되었습니다.",
      semRefreshGpu: "다시 감지",
      semInstallGpuRuntime: "GPU 구성 요소 설치",
      semResumeGpuRuntime: "GPU 구성 요소 설치 계속（{percent}%）",
      semInstallingGpuRuntime: "GPU 구성 요소 설치 중…",
      semGpuInstallConfirm:
        "남은 NVIDIA GPU 런타임 약 {size} GiB를 다운로드하고 설치할까요? CPU 대체 경로는 계속 사용할 수 있습니다.",
      semGpuDownloading: "GPU 구성 요소 다운로드 중: {percent}%…",
      semGpuInstallFailed: "GPU 구성 요소 설치 실패: {error}",
      semIndexTitle: "의미 색인",
      semNotBuilt: "아직 생성되지 않음",
      semBuildIndex: "의미 색인 만들기",
      semPause: "일시 정지",
      semAdvanced: "고급 관리: 검색 강화, 가속 색인, 프로필 색인 및 항목 삭제",
      semRetrievalStrategy: "검색 전략",
      semRetrievalStandard: "표준: 전문 + 의미 결과 결합",
      semRetrievalHigh: "고정밀: 결합 + 재정렬",
      semRetrievalM3: "실험적: M3 희소 + ColBERT",
      semReranker: "재정렬 모델",
      semRerankerDescription:
        "질문에 가장 잘 맞는 내용을 위에 배치하여 인용의 정확도를 높입니다.",
      semDownloadReranker: "재정렬 모델 다운로드",
      semM3Index: "BGE-M3 희소 색인 및 ColBERT 재정렬",
      semM3Description:
        "키워드와 의미를 함께 다루어 복잡한 질문의 내용을 더 쉽게 찾습니다.",
      semBuildM3: "M3 색인 만들기",
      semAccelerator: "가속 색인",
      semAcceleratorDescription:
        "의미 색인이 있는 큰 서가에서 검색 결과를 더 빠르게 반환합니다.",
      semBuildAccelerator: "가속 색인 만들기",
      semMultiProfile: "다중 프로필 색인",
      semMultiProfileDescription:
        "한 권의 서로 다른 주제를 분류하여 여러 주제에 걸친 질문에서도 해당 내용을 더 쉽게 찾습니다.",
      semBuildMulti: "다중 프로필 만들기",
      semDelete: "삭제",
    },
  };
  Object.keys(COPY).forEach((locale) =>
    Object.assign(
      localeCopy(COPY, locale),
      SEMANTIC_SETTINGS_COPY.en,
      asLocaleCatalog(SEMANTIC_SETTINGS_COPY)[locale] || {},
    ),
  );
  // The main window preloads the data-only catalog below. Keep the local
  // table as the explicit standalone fallback for an isolated WebView that
  // loads this compatibility entry on its own.
  const SEMANTIC_RUNTIME_CATALOG = global.ReaderAppI18nSemanticRuntimeCatalog;
  if (
    SEMANTIC_RUNTIME_CATALOG !== undefined &&
    typeof SEMANTIC_RUNTIME_CATALOG.apply !== "function"
  ) {
    throw new Error(
      "ReaderAppI18nSemanticRuntimeCatalog must expose a semantic runtime applier",
    );
  }
  const SEMANTIC_RUNTIME_COPY = {
    "zh-CN": {
      semSmallTitle: "轻量语义检索 · BGE Small 中文",
      semSmallCopy:
        "默认的轻量中文语义模型，适合大多数书库；下载、建索引和查询都更快，占用也更小。",
      semLargeTitle: "高精度语义检索 · BGE Large 中文",
      semLargeCopy:
        "适合更看重中文语义区分度的书库。精度更高，但模型下载、建索引和查询开销也更大。",
      semM3Title: "BGE-M3 · 多语言混合检索",
      semM3Copy:
        "支持稠密、稀疏和 ColBERT 三种表示。建立 M3 索引后可启用实验性混合检索；该索引占用和建库时间较高。",
      semE5Title: "Multilingual-E5-Small · 多语言轻量检索",
      semE5Copy:
        "轻量多语言语义模型。适合含中英及其他语言图书的书库；使用独立向量索引。",
      semRetrievalStandardCopy:
        "更快：把关键词和语义结果合在一起，适合日常检索，不需要额外下载。",
      semRetrievalHighCopy:
        "更准：先融合结果，再挑出最能回答问题的内容；速度会稍慢，需要下载重排模型。",
      semRetrievalM3Copy:
        "覆盖更全：同时理解关键词、语义和多语言术语，适合复杂问题；需要 BGE-M3 和 M3 索引。",
      semModelReady: "已就绪",
      semModelDownloading: "正在下载/加载模型…",
      semModelNotDownloaded: "未下载，首次下载约 {size}。",
      semModelUnsupported: "官方尚未提供可用于本地端的 ONNX 权重。",
      semNoBooks: "书架中暂无可建立语义索引的图书",
      semProgressBooks: "{done}/{total} 本",
      semProgressParts: "{done}/{total} 片",
      semCompleted: "已完成",
      semCanResume: "可续建",
      semLegacyIndex: "已建立（旧版索引，更新后可用于当前算法）",
      semUpdateNeeded: "需要更新",
      semTaskRunning: "任务正在后台运行…",
      semReadingStatus: "正在后台核对索引状态…",
      semCheckingIndex: "正在检测语义索引进度…",
      semReadStatusFailed: "读取语义索引状态失败：{error}",
      semCheckingGpu: "正在检测本机 GPU…",
      semGpuFailed: "检测 GPU 失败：{error}",
      semRerankerLoading:
        "正在加载重排模型；首次加载需要一点时间，完成后才会显示已准备好。",
      semRerankerReady: "已准备好，会让最符合问题的内容排在前面。",
      semRerankerNotReady:
        "让最符合问题的内容排在前面，回答引用更准确；首次下载约 1.6 GB。",
      semM3Ready: "已准备好，复杂问题、关键词和多语言内容更容易找到。",
      semM3BuildHint: "建立后能更好兼顾关键词和语义，复杂问题更容易找到。",
      semM3Only: "仅在选择 BGE-M3 时可使用。",
      semLoadReranker: "加载重排模型",
      semDownloadModel: "下载模型",
      semResumeIndex: "续建语义索引",
      semUpdateAccelerator: "更新加速索引",
      semBuildMulti: "建立多中心画像",
    },
    en: {
      semSmallTitle: "Light semantic search · BGE Small Chinese",
      semSmallCopy:
        "The default lightweight Chinese semantic model. It is faster to download, index, and query, and uses less space.",
      semLargeTitle: "High-precision semantic search · BGE Large Chinese",
      semLargeCopy:
        "For libraries where Chinese semantic distinctions matter more. It is more accurate, but costs more to download, index, and query.",
      semM3Title: "BGE-M3 · Multilingual hybrid retrieval",
      semM3Copy:
        "Supports dense, sparse, and ColBERT representations. Build an M3 index to enable experimental hybrid retrieval; it needs more space and build time.",
      semE5Title: "Multilingual-E5-Small · Lightweight multilingual retrieval",
      semE5Copy:
        "A lightweight multilingual semantic model for libraries containing Chinese, English, and other languages. It uses an independent vector index.",
      semRetrievalStandardCopy:
        "Faster: combines keyword and semantic results for everyday searches, with no extra download.",
      semRetrievalHighCopy:
        "More accurate: fuses results then ranks the content that best answers the question. It is slower and needs the reranker.",
      semRetrievalM3Copy:
        "Broader coverage: understands keywords, meaning, and multilingual terminology. Requires BGE-M3 and an M3 index.",
      semModelReady: "Ready",
      semModelDownloading: "Downloading/loading model…",
      semModelNotDownloaded: "Not downloaded; first download is about {size}.",
      semNoBooks: "There are no books available for semantic indexing.",
      semTaskRunning: "Task is running in the background…",
      semReadingStatus: "Checking index status in the background…",
      semCheckingIndex: "Checking semantic-index progress…",
      semReadStatusFailed: "Could not read semantic-index status: {error}",
      semCheckingGpu: "Detecting local GPU…",
      semGpuFailed: "Could not detect GPU: {error}",
      semRerankerReady:
        "Ready. It places the content that best answers the question first.",
      semRerankerNotReady:
        "Places the content that best answers the question first for more accurate citations; first download is about 1.6 GB.",
      semLoadReranker: "Load reranker",
      semDownloadModel: "Download model",
      semResumeIndex: "Resume semantic index",
      semUpdateAccelerator: "Update accelerator index",
      semBuildMulti: "Build multi-profile index",
    },
    ja: {
      semSmallTitle: "軽量セマンティック検索・BGE Small 中国語",
      semSmallCopy:
        "既定の軽量な中国語セマンティックモデルです。ダウンロード、索引作成、検索が速く、使用容量も小さくなります。",
      semLargeTitle: "高精度セマンティック検索・BGE Large 中国語",
      semLargeCopy:
        "中国語の意味の違いをより重視する本棚向けです。精度は高くなりますが、ダウンロード、索引作成、検索の負荷も増えます。",
      semM3Title: "BGE-M3・多言語ハイブリッド検索",
      semM3Copy:
        "Dense、Sparse、ColBERT の3表現に対応します。M3索引を作成すると実験的なハイブリッド検索を有効にできますが、容量と作成時間が増えます。",
      semE5Title: "Multilingual-E5-Small・軽量多言語検索",
      semE5Copy:
        "中国語、英語など複数言語の本を含む本棚向けの軽量セマンティックモデルです。独立したベクトル索引を使用します。",
      semRetrievalStandardCopy:
        "高速: キーワードと意味の検索結果を統合します。日常の検索向けで、追加ダウンロードは不要です。",
      semRetrievalHighCopy:
        "高精度: 結果を統合してから、質問に最も合う内容を並べ替えます。やや遅くなり、再ランキングモデルが必要です。",
      semRetrievalM3Copy:
        "広い網羅性: キーワード、意味、多言語の専門語を同時に扱います。BGE-M3 と M3索引が必要です。",
      semModelReady: "準備完了",
      semModelDownloading: "モデルをダウンロード / 読み込み中…",
      semModelNotDownloaded: "未ダウンロード。初回は約 {size} です。",
      semNoBooks: "セマンティック索引を作成できる本が本棚にありません。",
      semTaskRunning: "タスクはバックグラウンドで実行中です…",
      semReadingStatus: "バックグラウンドで索引状態を確認中…",
      semReadStatusFailed:
        "セマンティック索引の状態を読み取れませんでした: {error}",
      semCheckingGpu: "この端末のGPUを検出中…",
      semGpuFailed: "GPUを検出できませんでした: {error}",
      semRerankerReady: "準備完了。質問に最も合う内容を先頭に配置します。",
      semRerankerNotReady:
        "質問に最も合う内容を先頭に配置して引用精度を高めます。初回ダウンロードは約1.6 GBです。",
      semLoadReranker: "再ランキングモデルを読み込む",
      semDownloadModel: "モデルをダウンロード",
      semResumeIndex: "セマンティック索引を続行",
      semUpdateAccelerator: "高速化索引を更新",
      semBuildMulti: "マルチプロファイルを作成",
    },
    ko: {
      semSmallTitle: "경량 의미 검색 · BGE Small 중국어",
      semSmallCopy:
        "기본 경량 중국어 의미 모델입니다. 다운로드, 색인 생성, 검색이 더 빠르고 사용 공간도 작습니다.",
      semLargeTitle: "고정밀 의미 검색 · BGE Large 중국어",
      semLargeCopy:
        "중국어 의미 구분을 더 중시하는 서가에 적합합니다. 정확도는 높지만 다운로드, 색인 생성, 검색 비용도 커집니다.",
      semM3Title: "BGE-M3 · 다국어 하이브리드 검색",
      semM3Copy:
        "밀집, 희소, ColBERT 표현을 지원합니다. M3 색인을 만들면 실험적 하이브리드 검색을 사용할 수 있지만 공간과 구축 시간이 더 필요합니다.",
      semE5Title: "Multilingual-E5-Small · 경량 다국어 검색",
      semE5Copy:
        "중국어, 영어 등 여러 언어 책이 있는 서가에 적합한 경량 의미 모델입니다. 별도 벡터 색인을 사용합니다.",
      semRetrievalStandardCopy:
        "더 빠름: 키워드와 의미 결과를 합쳐 일상 검색에 적합하며 추가 다운로드가 필요 없습니다.",
      semRetrievalHighCopy:
        "더 정확함: 결과를 결합한 뒤 질문에 가장 맞는 내용을 재정렬합니다. 조금 느리며 재정렬 모델이 필요합니다.",
      semRetrievalM3Copy:
        "더 넓은 범위: 키워드, 의미, 다국어 용어를 함께 이해합니다. BGE-M3와 M3 색인이 필요합니다.",
      semModelReady: "준비됨",
      semModelDownloading: "모델 다운로드/불러오는 중…",
      semModelNotDownloaded:
        "다운로드되지 않음. 첫 다운로드는 약 {size}입니다.",
      semNoBooks: "의미 색인을 만들 수 있는 책이 서가에 없습니다.",
      semTaskRunning: "작업이 백그라운드에서 실행 중입니다…",
      semReadingStatus: "백그라운드에서 색인 상태를 확인 중…",
      semReadStatusFailed: "의미 색인 상태를 읽지 못했습니다: {error}",
      semCheckingGpu: "이 기기의 GPU를 감지하는 중…",
      semGpuFailed: "GPU를 감지하지 못했습니다: {error}",
      semRerankerReady: "준비됨. 질문에 가장 맞는 내용을 위에 배치합니다.",
      semRerankerNotReady:
        "질문에 가장 맞는 내용을 위에 배치해 인용의 정확도를 높입니다. 첫 다운로드는 약 1.6 GB입니다.",
      semLoadReranker: "재정렬 모델 불러오기",
      semDownloadModel: "모델 다운로드",
      semResumeIndex: "의미 색인 이어 만들기",
      semUpdateAccelerator: "가속 색인 업데이트",
      semBuildMulti: "다중 프로필 만들기",
    },
  };
  if (SEMANTIC_RUNTIME_CATALOG) {
    SEMANTIC_RUNTIME_CATALOG.apply(COPY);
  } else {
    Object.keys(COPY).forEach((locale) =>
      Object.assign(
        localeCopy(COPY, locale),
        SEMANTIC_RUNTIME_COPY.en,
        asLocaleCatalog(SEMANTIC_RUNTIME_COPY)[locale] || {},
      ),
    );
  }
  const SEMANTIC_DIMENSION_COPY = {
    "zh-CN": {
      semVectorDimensions: "{dimensions} 维",
      semModelSwitching: "正在切换为 {model}（{dimensions} 维）…",
      semModelSwitched: "已切换为 {model}（{dimensions} 维向量）。",
      semModelDownloadProgress:
        "正在下载模型：{percent}%（{downloaded}/{total}）",
      semGpuIndexing: "GPU 加速索引中",
    },
    en: {
      semVectorDimensions: "{dimensions} dimensions",
      semModelSwitching: "Switching to {model} ({dimensions} dimensions)…",
      semModelSwitched:
        "Switched to {model} ({dimensions}-dimensional vectors).",
      semModelDownloadProgress:
        "Downloading model: {percent}% ({downloaded}/{total})",
      semGpuIndexing: "GPU-accelerated indexing in progress.",
    },
    ja: {
      semVectorDimensions: "{dimensions} 次元",
      semModelSwitching: "{model}（{dimensions} 次元）に切り替え中…",
      semModelSwitched:
        "{model}（{dimensions} 次元ベクトル）に切り替えました。",
      semModelDownloadProgress:
        "モデルをダウンロード中: {percent}%（{downloaded}/{total}）",
      semGpuIndexing: "GPU アクセラレーションで索引作成中",
    },
    ko: {
      semVectorDimensions: "{dimensions}차원",
      semModelSwitching: "{model}({dimensions}차원)으로 전환 중…",
      semModelSwitched: "{model}({dimensions}차원 벡터)으로 전환했습니다.",
      semModelDownloadProgress:
        "모델 다운로드 중: {percent}% ({downloaded}/{total})",
      semGpuIndexing: "GPU 가속 색인 생성 중",
    },
  };
  Object.keys(COPY).forEach((locale) =>
    Object.assign(
      localeCopy(COPY, locale),
      SEMANTIC_DIMENSION_COPY.en,
      asLocaleCatalog(SEMANTIC_DIMENSION_COPY)[locale] || {},
    ),
  );
  Object.assign(localeCopy(COPY, "en"), {
    semModelUnsupported: "ONNX weights are not available for local use.",
    semProgressBooks: "{done}/{total} books",
    semProgressParts: "{done}/{total} parts",
    semCompleted: "completed",
    semCanResume: "can resume",
    semLegacyIndex:
      "Built with an older index; update it to use the current algorithm.",
    semUpdateNeeded: "needs update",
    semRerankerLoading:
      "Loading the reranker. The first load can take a moment; it will show Ready when complete.",
    semM3Ready:
      "Ready. Complex questions, keywords, and multilingual content are easier to find.",
    semM3BuildHint:
      "Build it to balance keywords and meaning for complex questions.",
    semM3Only: "Available only when BGE-M3 is selected.",
  });
  Object.assign(localeCopy(COPY, "ja"), {
    semModelUnsupported:
      "ローカルで利用できる ONNX 重みは公式から提供されていません。",
    semProgressBooks: "{done}/{total}冊",
    semProgressParts: "{done}/{total}件",
    semCompleted: "完了",
    semCanResume: "続行可能",
    semLegacyIndex:
      "旧版の索引を作成済みです。現在のアルゴリズムで使うには更新してください。",
    semUpdateNeeded: "更新が必要",
    semRerankerLoading:
      "再ランキングモデルを読み込み中です。初回は少し時間がかかります。完了すると準備完了と表示されます。",
    semM3Ready:
      "準備完了。複雑な質問、キーワード、多言語の内容を見つけやすくします。",
    semM3BuildHint:
      "作成するとキーワードと意味を両立し、複雑な質問を見つけやすくします。",
    semM3Only: "BGE-M3を選択した場合のみ利用できます。",
  });
  Object.assign(localeCopy(COPY, "ko"), {
    semModelUnsupported:
      "로컬에서 사용할 수 있는 ONNX 가중치를 공식적으로 제공하지 않습니다.",
    semProgressBooks: "{done}/{total}권",
    semProgressParts: "{done}/{total}개",
    semCompleted: "완료",
    semCanResume: "이어서 만들기 가능",
    semLegacyIndex:
      "이전 버전 색인이 만들어져 있습니다. 현재 알고리즘에 사용하려면 업데이트하세요.",
    semUpdateNeeded: "업데이트 필요",
    semRerankerLoading:
      "재정렬 모델을 불러오는 중입니다. 처음에는 잠시 걸리며 완료되면 준비됨으로 표시됩니다.",
    semM3Ready: "준비됨. 복잡한 질문, 키워드, 다국어 내용을 더 쉽게 찾습니다.",
    semM3BuildHint:
      "만들면 키워드와 의미를 함께 다뤄 복잡한 질문을 더 쉽게 찾습니다.",
    semM3Only: "BGE-M3를 선택한 경우에만 사용할 수 있습니다.",
  });
  Object.assign(localeCopy(COPY, "ja"), {
    layout: "レイアウト",
    listLayout: "リスト表示",
    gridLayout: "グリッド表示",
    syncSecrets: "APIキーと翻訳キーを同期（任意）",
    close: "閉じる",
    accountDataPrivacy: "データとプライバシー",
    accountDataDeviceGroup: "この端末",
    accountDataDeviceGroupHint:
      "このコンピューターだけに影響し、クラウド同期データは変更しません。",
    accountDataCloudGroup: "クラウド同期データ",
    accountDataCloudGroupHint:
      "すべての端末に影響し、現在のログインパスワードが必要です。",
    accountDataAccountGroup: "アカウント",
    accountDataAccountGroupHint:
      "このアカウントを今後使用しない場合にのみ行う永久操作です。",
    accountSecurityLoading: "アカウントのセキュリティ状態を読み込み中…",
    bindEmail: "メールアドレスを連携",
    changeBoundEmail: "連携メールアドレスを変更",
    email: "メールアドレス",
    emailForRecovery: "ログインパスワードの復旧に使用",
    sendCode: "確認コードを送信",
    verificationCode: "確認コード",
    confirmBinding: "連携を確認",
    rebindEmailHint:
      "アカウント保護のため、先に現在連携中のメールアドレスへ確認コードを送信してください。",
    sendOldEmailCode: "旧メールに確認コードを送信",
    oldEmailCode: "旧メールの確認コード",
    verifyOldEmail: "旧メールを確認",
    oldEmailVerified:
      "旧メールを確認しました。続けて新しい連携メールを確認してください。",
    newEmail: "新しいメールアドレス",
    newVerifiedEmail: "新しい確認用メールアドレス",
    sendNewEmailCode: "新メールに確認コードを送信",
    newEmailCode: "新メールの確認コード",
    confirmEmailChange: "変更を確認",
    changeLoginPassword: "ログインパスワードを変更",
    currentLoginPassword: "現在のログインパスワード",
    newLoginPasswordLabel: "新しいログインパスワード",
    atLeastEightChars: "8文字以上",
    confirmChange: "変更を確認",
    confirmReset: "リセットを確認",
    passwordRecoveryHint:
      "連携済みメールに確認コードを送信すると、新しいパスワードを設定できます。リセットすると他の端末はログアウトされます。",
    accountFilesKept:
      "以下の操作を行っても、このコンピューター上の EPUB、PDF、TXT、MOBI、AZW の元ファイルは削除されません。",
    clearThisDeviceData: "この端末のデータを消去",
    clearThisDeviceDescription:
      "本棚の記録、読書進捗、注釈、単語帳、統計、キャッシュ、索引、モデル、ダウンロード済みフォント、ログイン、API設定を消去します。",
    clearThisDevice: "この端末を消去",
    clearDeviceAndCloudData: "この端末とクラウドのデータを消去",
    clearDeviceAndCloudDescription:
      "このアカウントの同期データをすべて消去し、すべての端末をログアウトします。アカウント自体は残ります。",
    loginPassword: "ログインパスワード",
    clearDeviceAndCloud: "端末とクラウドを消去",
    deleteAccountPermanently: "アカウントを完全に削除",
    deleteAccountDescription:
      "アカウントとすべてのクラウドデータを削除し、この端末のデータも消去します。この操作は元に戻せません。",
    enterFullAccountName: "完全なアカウント名を入力",
    privateSyncTitle: "AI読書と翻訳の同期",
    privateSyncNote:
      "通常の設定にはAPIキーを含まず、アカウントに同期されます。履歴とキーは初期状態でこの端末だけに保存されます。",
    syncServiceConfiguration: "同期サービスの設定",
    syncServiceConfigurationHint:
      "AIプロバイダー、エンドポイント、モデル名、翻訳設定",
    syncAiHistory: "AI読書履歴を同期",
    syncAiHistoryHint:
      "単一書籍とライブラリ Q&A を含みます。最大40件を保持し、本の本文はアップロードしません。",
    syncSecretsHint:
      "同期パスワードが必要です。サーバーには暗号化されたデータだけが保存されます。",
    privateSyncPasswordPlaceholder:
      "同期パスワードを設定または入力（10文字以上）",
    encryptAndSyncSecrets: "キーを暗号化して今すぐ同期",
    unlockCloudSecrets: "クラウドのキーを復号",
    forgetSyncPassword: "同期パスワードを忘れてクラウドのキーを取り消す",
    forgetSyncPasswordHint:
      "同期パスワードは復元できません。ローカルのAPIキーは削除されず、新しいパスワードで再暗号化できます。",
    sortAndLayout: "並び順とレイアウト",
    sort: "並び順",
    sortTitle: "書名",
    sortAuthor: "著者",
    sortImported: "追加日時",
    sortFolder: "保存フォルダー",
    allBooks: "すべての本",
    sortRecent: "最近読んだ順",
    sortReadingTime: "読書時間",
    sortFileSize: "ファイルサイズ",
    sortProgress: "読書進捗",
    readingFilters: "読書フィルター",
    unread: "未読",
    reading: "読書中",
    finished: "読了",
    ratingFilterTip:
      "評価で絞り込み: 星を選ぶとその評価以上だけを表示し、同じ星をもう一度選ぶと解除します。",
    tags: "タグ",
    collections: "コレクション",
    matchAny: "いずれかに一致",
    columns: "列数",
    default: "既定",
    decreaseColumns: "列を減らす",
    increaseColumns: "列を増やす",
    readingStatsSettings: "読書統計の設定",
    readingDuration: "読書時間",
    readingWords: "読書文字数",
    averageSpeed: "平均速度",
    booksRead: "読んだ本",
    finishedBooks: "読了した本",
    highlights: "ハイライト",
    annotations: "注釈",
    chartSwitch: "棒グラフを切り替え",
    time: "時間",
    chartMetricTip: "棒グラフを時間 / 文字数で切り替え",
    day: "日",
    month: "月",
    year: "年",
    total: "合計",
    newsSettings: "ニュース設定",
    closeNewsSettings: "ニュース設定を閉じる",
    backgroundPrefetch: "バックグラウンド取得",
    backgroundPrefetchNote:
      "アプリがアイドル状態になると、5分ごとに有効なソースを更新します。画像はカードが画面に入ったときだけ読み込みます。",
    newsHideReturnIcon: "戻るアイコンを閉じる",
    newsHideReturnIconNote:
      "既定ではオフで、戻るアイコンを表示します。有効にするとニュース本文右側のアイコンを隠します。ジェスチャーでは直接ページを閉じられます。",
    gestureBack: "ジェスチャーで戻る",
    drawEditGesture: "ジェスチャーを描く / 編集",
    enableGestureBack: "ジェスチャーで戻るを有効化",
    gestureMatchPrecision: "一致精度",
    gesturePrecisionHint:
      "精度を上げるほど、より似たジェスチャーだけが反応します。",
    precisionLow: "低",
    precisionMedium: "中",
    precisionHigh: "高",
    gestureEditorHint:
      "左ボタンを押したまま軌跡を描いて保存します。ニュースページまたは開いたニュースの子ページで、右ボタンを押したまま似た軌跡を描くと使えます。",
    drawGesturePath: "戻るジェスチャーの軌跡を描く",
    clear: "消去",
    savePath: "軌跡を保存",
    answerSettings: "設定",
    answerLength: "回答の長さ",
    answerLengthHint: "長いほど検索と生成に時間がかかります。",
    answerShort: "短い",
    answerShortHint: "結論と4〜6個の根拠に集中",
    answerMedium: "中",
    answerMediumHint: "より多くの出典、根拠、発展した見解",
    answerLong: "長い",
    answerLongHint: "最も広い根拠、詳しい解説、限界の議論",
    answerFontSize: "文字サイズ",
    libraryAnswerFontSize: "ライブラリ Q&A の文字サイズ",
    decreaseAnswerFont: "Q&Aの文字を小さくする",
    increaseAnswerFont: "Q&Aの文字を大きくする",
    longContextReading: "複雑な質問向け長文精読（BGE-M3）",
    toggleLongContextReading: "長文精読を切り替え",
    closeSettings: "設定を閉じる",
    activeFilters: "フィルターを適用中",
    matchAll: "すべて一致",
    matchAllHint:
      "タグとコレクションのすべてに一致する必要があります。クリックするといずれかに一致へ切り替わります。",
    matchAnyHint:
      "タグまたはコレクションのいずれかに一致します。クリックするとすべて一致へ切り替わります。",
    selectItems: "{title}を選択",
    multiSelectNoFilter: "複数選択できます。何も選ばなければ絞り込みません。",
    statsHourMinute: "{hours}時間 {minutes}分",
    statsMinutes: "{minutes}分",
    statsSeconds: "{seconds}秒",
    statsWords: "{words}文字",
    statsTenThousandWords: "{words}万字",
    wordsPerMinute: "{words}文字/分",
    statsMonth: "{month}か月",
    statsAll: "すべて",
    statsLoading: "読書統計を読み込み中…",
    statsLoadFailed:
      "読書統計を読み込めませんでした。後でもう一度お試しください。",
    statsPeriodUnit: "期間",
    currentPeriodBooks: "この{unit}に読んだ本",
    noReadingRecords: "この期間の読書記録はありません",
    yearlyHeatmap: "過去1年の毎日の読書ヒートマップ",
    totalReadingTime: "累計読書時間",
    dailyPeak: "1日の最高値",
    currentStreak: "現在の連続読書",
    longestStreak: "最長連続読書",
    days: "{count}日",
    finishedBook: "読了",
    statsQualityDwell:
      "この期間には放置時間が含まれる可能性があります。読書時間が長い一方で文字数が少ない状態です。",
    statsQualityFast:
      "平均読書速度が高く、素早いページめくりまたは重複計上が含まれる可能性があります。",
    statsQualitySlow:
      "平均読書速度が低く、放置時間またはスキャンPDFが含まれる可能性があります。",
    gestureNeedPath: "先に戻るジェスチャーの軌跡を描いて保存してください。",
    gesturePrecisionSaved:
      "戻るジェスチャーの精度を{precision}に設定しました。",
    gesturePathTooShort: "軌跡が短すぎるため保存しませんでした。",
    gestureSaved: "戻るジェスチャーを保存して有効にしました。",
    gestureCleared: "戻るジェスチャーを消去して無効にしました。",
    longContextUnavailable:
      "まだ有効にできません。クリックして設定方法を確認してください。",
    longContextEnabled: "複雑な質問向け長文精読を有効にしました。",
    longContextDisabled: "複雑な質問向け長文精読を無効にしました。",
    longContextSaveFailed: "長文精読の設定に失敗しました: {error}",
    longContextSetupPath:
      "設定方法: 設定 → セマンティック索引 → BGE-M3を選択 → モデルをダウンロード → セマンティック索引を作成。その後、ライブラリ Q&A → 設定で有効にします。",
    answerLengthSaveFailed: "回答の長さを保存できませんでした: {error}",
    statsBookNotes: "ハイライト {highlights}・注釈 {notes}",
    accountSecurityBoundEmail:
      "確認済みメールアドレス: {email}。ログインパスワードの復旧に使用できます。",
    accountSecurityEmailUnbound:
      "確認済みのメールアドレスは未連携です。パスワードを復旧するには連携してください。",
    accountSecurityMailUnavailable:
      "アカウントセキュリティ用メールが未設定のため、メール連携とパスワード復旧は利用できません。",
    accountSecurityLoadFailed:
      "アカウントのセキュリティ状態を読み込めませんでした: {error}",
    cloudSecretAvailable:
      "暗号化されたキーパッケージがクラウドにあります。この端末で復号するには同期パスワードを入力してください。",
    localSecretsOnly:
      "APIキーと翻訳キーは初期状態でこの端末だけに保存されます。",
    privateSyncLoadFailed:
      "プライベート同期設定を読み込めませんでした: {error}",
  });
  // Child settings pages use the same catalog as the main settings panel.
  // Keeping this as one complete ten-language map prevents a newly opened
  // modal from falling back to its original Chinese HTML.
  // SETTINGS_SUBPAGE_COPY lives in a typed static catalog module and is bundled into this classic IIFE.
  Object.entries(SETTINGS_SUBPAGE_COPY).forEach(([locale, copy]) =>
    Object.assign(localeCopy(COPY, locale), copy),
  );
  // Korean is also release-gated.  Do not let a missing key silently fall
  // back to English: every setting and secondary panel must have Korean copy.
  Object.assign(localeCopy(COPY, "ko"), {
    newsTitle: "오늘의 뉴스",
    newsDescription:
      "시간순으로 정리한 가벼운 뉴스 피드입니다. 열 때만 불러옵니다.",
    backToShelf: "책장으로 돌아가기",
    manageSources: "소스 관리",
    refresh: "새로 고침",
    sourceSettings: "뉴스 소스 설정",
    sourceSettingsHint:
      "보고 싶은 소스를 선택하세요. 선택 내용은 로그인한 기기에 동기화됩니다.",
    sourceSearch: "소스, 분류 또는 키워드 검색",
    restoreRecommended: "추천 복원",
    doneAndRefresh: "완료 및 새로 고침",
    mixedOrder: "혼합",
    bySourceOrder: "소스별",
    newsCategoryAll: "전체",
    newsSourceSummary: "{count}개 소스 표시",
    newsRecommendedSources: "추천 소스 사용",
    newsSelectedSources: "{count} / {max}개 선택됨",
    noMatchingSources: "일치하는 기본 소스가 없습니다.",
    maxSources: "소스는 최대 {max}개까지 선택할 수 있습니다.",
    chooseSource: "소스를 하나 이상 선택하거나 추천 목록을 복원하세요.",
    openWebPage: "웹페이지 열기 →",
    noNewsInCategory: "이 분류에는 아직 뉴스가 없습니다.",
    noNews:
      "뉴스가 없습니다. 새로 고치거나 소스 관리에서 표시 내용을 바꾸세요.",
    loadingNews: "불러오는 중…",
    refreshingNews: "새로 고치는 중…",
    newsUpdatedAt: "업데이트: {time}",
    libraryDescription:
      "먼저 기기의 의미 색인을 검색한 뒤, 일치한 소수의 문단만 설정한 AI 읽기 서비스에 보냅니다. 각 답변에서 원래 책의 장으로 돌아갈 수 있습니다.",
    bookClassification: "책 분류",
    questionHistory: "질문 기록",
    localSearchCitations: "로컬 검색 · 추적 가능한 인용",
    searchScope: "검색 범위",
    libraryQuestion: "라이브러리 Q&A",
    crossBookCompare: "여러 책 비교",
    yourQuestion: "질문",
    startQuestion: "질문하기",
    answerPlaceholder:
      "범위를 선택하고 질문을 입력하세요. 결과가 없으면 먼저 기본 설정에서 의미 색인을 만드세요.",
    questionPlaceholder:
      "예: 이 책들은 청말 재정 위기를 어떻게 설명하나요?\n여러 책을 비교할 때: 선택한 작품의 같은 주제에 대한 관점과 근거를 비교합니다.",
    allTags: "모든 태그",
    allCollections: "모든 컬렉션",
    clearFilters: "필터 지우기",
    cancelLimit: "범위 제한 해제",
    clearSelection: "선택 지우기",
    selectVisible: "현재 목록 모두 선택",
    invertVisible: "현재 목록 선택 반전",
    noBooks: "책장에 책이 없습니다.",
    noFilteredBooks: "현재 태그 및 컬렉션에 맞는 책이 없습니다.",
    unnamedQuestion: "제목 없는 질문",
    noQuestionHistory:
      "저장된 라이브러리 Q&A가 없습니다. 답변이 완료되면 질문이 자동 저장됩니다.",
    loadingLibrary: "책장과 AI 읽기 설정을 불러오는 중…",
    askInProgress: "검색하고 답변하는 중…",
    enterQuestion: "질문을 입력하세요.",
    libraryQuestionFailed: "라이브러리 Q&A에 실패했습니다.",
    libraryHistory: "질문 기록",
    returnToAnswer: "이번 답변으로 돌아가기",
    delete: "삭제",
    copy: "복사",
    cut: "잘라내기",
    paste: "붙여넣기",
    libraryScopeTip:
      "라이브러리 Q&A는 의미 색인이 만들어진 모든 책을 정확하게 검색하고 가장 관련 있는 책 20권을 보여줍니다(책마다 한 문단). 책을 선택하면 범위가 제한되며, 비교에는 2~8권을 선택하세요.",
    libraryFilters: "빠른 책 필터",
    tagLabel: "태그",
    collectionLabel: "컬렉션",
    libraryFilterTip:
      "책을 선택하지 않아도 제외되는 것은 아닙니다. 기본적으로 색인된 모든 책을 검색하며, 책을 선택하면 수동 범위로 전환됩니다.",
    bookSelectorPlaceholder: "제목, 저자, 설명 또는 태그 검색",
    scopeAllBooks: "현재 범위: 전체 서가",
    questionScopeSelected: "현재 범위: 선택한 책 {selected}권{visible}",
    questionScopeAll:
      "현재 범위: 전체 서가(색인된 모든 책, 상위 {limit}개 결과)",
    compareScope: "비교 범위: {selected}/{limit}권{visible}",
    scopeVisible: " (현재 {count}권 표시)",
    bookCountAll: "책장에 {count}권",
    bookCountFiltered: "{total}권 중 {visible}권 표시",
    noBookSearchMatches: "제목, 저자, 설명 또는 태그와 일치하는 책이 없습니다.",
    unnamedBook: "제목 없는 책",
    unknownAuthor: "알 수 없는 저자",
    selectionLimitMessage: "{mode}에서는 최대 {limit}권을 선택할 수 있습니다.",

    close: "닫기",
    accountDataPrivacy: "데이터 및 개인정보",
    accountDataDeviceGroup: "이 기기",
    accountDataDeviceGroupHint:
      "현재 컴퓨터에만 영향을 주며 클라우드 동기화 데이터는 변경하지 않습니다.",
    accountDataCloudGroup: "클라우드 동기화 데이터",
    accountDataCloudGroupHint:
      "모든 기기에 영향을 주며 현재 로그인 비밀번호가 필요합니다.",
    accountDataAccountGroup: "계정",
    accountDataAccountGroupHint:
      "이 계정을 더 이상 사용하지 않을 때만 실행하는 영구 작업입니다.",
    accountSecurityLoading: "계정 보안 상태를 불러오는 중…",
    bindEmail: "이메일 연결",
    changeBoundEmail: "연결된 이메일 변경",
    email: "이메일",
    emailForRecovery: "로그인 비밀번호 복구에 사용",
    sendCode: "인증 코드 보내기",
    verificationCode: "인증 코드",
    confirmBinding: "연결 확인",
    rebindEmailHint:
      "계정을 보호하기 위해 먼저 현재 연결된 이메일로 인증 코드를 보내세요.",
    sendOldEmailCode: "기존 이메일로 코드 보내기",
    oldEmailCode: "기존 이메일 인증 코드",
    verifyOldEmail: "기존 이메일 확인",
    oldEmailVerified:
      "기존 이메일이 확인되었습니다. 이제 새 연결 이메일을 확인하세요.",
    newEmail: "새 이메일",
    newVerifiedEmail: "새 확인 이메일",
    sendNewEmailCode: "새 이메일로 코드 보내기",
    newEmailCode: "새 이메일 인증 코드",
    confirmEmailChange: "변경 확인",
    changeLoginPassword: "로그인 비밀번호 변경",
    currentLoginPassword: "현재 로그인 비밀번호",
    newLoginPasswordLabel: "새 로그인 비밀번호",
    atLeastEightChars: "최소 8자",
    confirmChange: "변경 확인",
    confirmReset: "재설정 확인",
    passwordRecoveryHint:
      "연결된 이메일로 코드를 보내면 새 비밀번호를 설정할 수 있습니다. 재설정하면 다른 기기에서 로그아웃됩니다.",
    accountFilesKept:
      "아래 작업을 해도 이 컴퓨터의 EPUB, PDF, TXT, MOBI, AZW 원본 책 파일은 삭제되지 않습니다.",
    clearThisDeviceData: "이 기기 데이터 지우기",
    clearThisDeviceDescription:
      "책장 기록, 읽기 진행률, 메모, 단어장, 통계, 캐시, 색인, 모델, 다운로드한 글꼴, 로그인 및 API 설정을 지웁니다.",
    clearThisDevice: "이 기기 지우기",
    clearDeviceAndCloudData: "이 기기 및 클라우드 데이터 지우기",
    clearDeviceAndCloudDescription:
      "이 계정의 모든 동기화 데이터를 지우고 모든 기기에서 로그아웃합니다. 계정 자체는 유지됩니다.",
    loginPassword: "로그인 비밀번호",
    clearDeviceAndCloud: "기기 및 클라우드 지우기",
    deleteAccountPermanently: "계정 영구 삭제",
    deleteAccountDescription:
      "계정과 모든 클라우드 데이터를 삭제하고 이 기기 데이터도 지웁니다. 이 작업은 되돌릴 수 없습니다.",
    enterFullAccountName: "전체 계정 이름 입력",
    privateSyncTitle: "AI 읽기 및 번역 동기화",
    privateSyncNote:
      "일반 설정에는 API 키가 포함되지 않고 계정 설정을 따릅니다. 기록과 키는 기본적으로 이 기기에만 보관됩니다.",
    syncServiceConfiguration: "동기화 서비스 설정",
    syncServiceConfigurationHint:
      "AI 제공자, 엔드포인트, 모델 이름 및 번역 설정",
    syncAiHistory: "AI 읽기 기록 동기화",
    syncAiHistoryHint:
      "단일 책과 라이브러리 Q&A 기록을 포함합니다. 최대 40개를 보관하며 책 본문은 업로드하지 않습니다.",
    syncSecrets: "API 키 및 번역 키 동기화",
    syncSecretsHint:
      "동기화 비밀번호가 필요하며 서버에는 암호화된 데이터만 저장됩니다.",
    privateSyncPasswordPlaceholder: "동기화 비밀번호 설정 또는 입력(최소 10자)",
    encryptAndSyncSecrets: "키 암호화 및 지금 동기화",
    unlockCloudSecrets: "클라우드 키 잠금 해제",
    forgetSyncPassword: "동기화 비밀번호 삭제 및 클라우드 키 폐기",
    forgetSyncPasswordHint:
      "동기화 비밀번호는 복구할 수 없습니다. 로컬 API 키는 삭제되지 않으며 새 비밀번호로 다시 암호화할 수 있습니다.",

    sortAndLayout: "정렬 및 레이아웃",
    sort: "정렬",
    sortTitle: "제목",
    sortAuthor: "저자",
    sortImported: "가져온 날짜",
    sortFolder: "폴더",
    allBooks: "모든 책",
    sortRecent: "최근 읽음",
    sortReadingTime: "읽기 시간",
    sortFileSize: "크기",
    sortProgress: "읽기 진행률",
    readingFilters: "읽기 필터",
    unread: "읽지 않음",
    reading: "읽는 중",
    finished: "완독",
    ratingFilterTip:
      "평점으로 필터링: 별을 누르면 해당 평점 이상만 표시하고, 다시 누르면 해제합니다.",
    tags: "태그",
    collections: "컬렉션",
    matchAny: "하나라도 일치",
    layout: "레이아웃",
    listLayout: "목록",
    gridLayout: "격자",
    columns: "열 수",
    default: "기본값",
    decreaseColumns: "열 줄이기",
    increaseColumns: "열 늘리기",
    readingStatsSettings: "독서 통계 설정",
    readingDuration: "읽기 시간",
    readingWords: "읽은 단어 수",
    averageSpeed: "평균 속도",
    booksRead: "읽은 책",
    finishedBooks: "완독한 책",
    highlights: "하이라이트",
    annotations: "메모",
    chartSwitch: "차트 기준",
    time: "시간",
    chartMetricTip: "차트를 시간/단어 수로 전환",
    day: "일",
    month: "월",
    year: "년",
    total: "합계",
    newsSettings: "뉴스 설정",
    closeNewsSettings: "뉴스 설정 닫기",
    backgroundPrefetch: "백그라운드 미리 가져오기",
    backgroundPrefetchNote:
      "앱이 유휴 상태이면 활성화한 소스를 5분마다 새로 고칩니다. 이미지는 카드가 화면에 들어올 때만 불러옵니다.",
    gestureBack: "제스처로 돌아가기",
    drawEditGesture: "제스처 그리기 / 수정",
    enableGestureBack: "제스처로 돌아가기 사용",
    gestureMatchPrecision: "일치 정밀도",
    gesturePrecisionHint: "정밀도가 높을수록 더 비슷한 제스처만 작동합니다.",
    precisionLow: "낮음",
    precisionMedium: "중간",
    precisionHigh: "높음",
    gestureEditorHint:
      "왼쪽 버튼을 누른 채 경로를 그려 저장하세요. 뉴스 페이지나 열린 뉴스 하위 페이지에서 오른쪽 버튼을 누른 채 비슷한 경로를 그리면 사용할 수 있습니다.",
    drawGesturePath: "돌아가기 제스처 경로 그리기",
    clear: "지우기",
    savePath: "경로 저장",
    answerSettings: "설정",
    answerLength: "답변 길이",
    answerLengthHint: "답변이 길수록 검색과 생성에 시간이 더 걸립니다.",
    answerShort: "짧게",
    answerShortHint: "결론과 4~6개의 근거에 집중",
    answerMedium: "보통",
    answerMediumHint: "더 많은 출처, 근거 및 확장된 관점",
    answerLong: "길게",
    answerLongHint: "가장 폭넓은 근거, 깊은 해설 및 한계 논의",
    answerFontSize: "글자 크기",
    libraryAnswerFontSize: "라이브러리 Q&A 글자 크기",
    decreaseAnswerFont: "답변 글자 크기 줄이기",
    increaseAnswerFont: "답변 글자 크기 늘리기",
    longContextReading: "복잡한 질문 장문 정독(BGE-M3)",
    toggleLongContextReading: "장문 정독 전환",
    closeSettings: "설정 닫기",

    activeFilters: "필터 적용 중",
    matchAll: "모두 일치",
    matchAllHint:
      "태그와 컬렉션이 모두 일치해야 합니다. 누르면 하나라도 일치로 바뀝니다.",
    matchAnyHint:
      "태그 또는 컬렉션 중 하나가 일치하면 됩니다. 누르면 모두 일치로 바뀝니다.",
    selectItems: "{title} 선택",
    multiSelectNoFilter:
      "여러 항목을 선택할 수 있으며, 선택하지 않으면 필터링하지 않습니다.",
    statsHourMinute: "{hours}시간 {minutes}분",
    statsMinutes: "{minutes}분",
    statsSeconds: "{seconds}초",
    statsWords: "{words}단어",
    statsTenThousandWords: "{words}만 단어",
    wordsPerMinute: "분당 {words}단어",
    statsMonth: "{month}개월",
    statsAll: "전체",
    statsLoading: "독서 통계를 불러오는 중…",
    statsLoadFailed: "독서 통계를 불러오지 못했습니다. 나중에 다시 시도하세요.",
    statsPeriodUnit: "기간",
    currentPeriodBooks: "이번 {unit}에 읽은 책",
    noReadingRecords: "이 기간에는 읽기 기록이 없습니다.",
    yearlyHeatmap: "지난 1년간의 일별 읽기 히트맵",
    totalReadingTime: "누적 읽기 시간",
    dailyPeak: "일일 최고",
    currentStreak: "현재 연속 읽기",
    longestStreak: "최장 연속 읽기",
    days: "{count}일",
    finishedBook: "완독",
    statsQualityDwell:
      "이 기간에는 유휴 시간이 포함될 수 있습니다. 읽기 시간은 길지만 집계된 단어 수가 적습니다.",
    statsQualityFast:
      "평균 읽기 속도가 높습니다. 빠른 페이지 넘김이나 중복 집계가 포함되었을 수 있습니다.",
    statsQualitySlow:
      "평균 읽기 속도가 낮습니다. 유휴 시간 또는 스캔한 PDF가 포함되었을 수 있습니다.",
    gestureNeedPath: "먼저 돌아가기 제스처 경로를 그리고 저장하세요.",
    gesturePrecisionSaved:
      "돌아가기 제스처 정밀도를 {precision}(으)로 설정했습니다.",
    gesturePathTooShort: "경로가 너무 짧아 저장하지 않았습니다.",
    gestureSaved: "돌아가기 제스처를 저장하고 사용하도록 설정했습니다.",
    gestureCleared: "돌아가기 제스처를 지우고 사용하지 않도록 설정했습니다.",
    longContextUnavailable:
      "아직 사용할 수 없습니다. 눌러 설정 방법을 확인하세요.",
    longContextEnabled: "복잡한 질문 장문 정독을 켰습니다.",
    longContextDisabled: "복잡한 질문 장문 정독을 껐습니다.",
    longContextSaveFailed: "장문 정독 설정에 실패했습니다: {error}",
    longContextSetupPath:
      "설정 방법: 설정 → 의미 색인 → BGE-M3 선택 → 모델 다운로드 → 의미 색인 만들기. 그다음 라이브러리 Q&A → 설정에서 켜세요.",
    answerLengthSaveFailed: "답변 길이를 저장하지 못했습니다: {error}",
    statsBookNotes: "하이라이트 {highlights} · 메모 {notes}",

    accountSecurityBoundEmail:
      "연결된 확인 이메일: {email}. 로그인 비밀번호를 복구하는 데 사용할 수 있습니다.",
    accountSecurityEmailUnbound:
      "확인된 이메일이 연결되지 않았습니다. 비밀번호를 복구하려면 이메일을 연결하세요.",
    accountSecurityMailUnavailable:
      "계정 보안 이메일이 설정되지 않아 이메일 연결 및 비밀번호 복구를 사용할 수 없습니다.",
    accountSecurityLoadFailed: "계정 보안 상태를 불러오지 못했습니다: {error}",
    cloudSecretAvailable:
      "암호화된 키 패키지가 클라우드에 있습니다. 이 기기에서 잠금을 해제하려면 동기화 비밀번호를 입력하세요.",
    localSecretsOnly: "API 키와 번역 키는 기본적으로 이 기기에만 보관됩니다.",
    privateSyncLoadFailed: "비공개 동기화 설정을 불러오지 못했습니다: {error}",
  });
  const HISTORY_RETENTION_COPY = {
    "zh-CN": "包括单书与书库问答；云端各保留 100 条，不上传书籍原文",
    "zh-TW": "包括單書與書庫問答；雲端各保留 100 條，不上傳書籍原文",
    en: "Cloud history keeps 100 AI-reading records and 100 Library Q&A records; book text is never uploaded",
    ja: "クラウドにはAI読書100件とライブラリQ&A 100件を保存し、本文はアップロードしません。",
    ko: "클라우드에 AI 읽기 100개와 라이브러리 Q&A 100개를 보관하며 책 본문은 업로드하지 않습니다.",
    fr: "Le cloud conserve 100 historiques de lecture IA et 100 questions-réponses de bibliothèque, sans importer le texte des livres.",
    de: "Die Cloud speichert 100 KI-Leseverläufe und 100 Bibliotheksfragen; Buchtexte werden nicht hochgeladen.",
    es: "La nube conserva 100 historiales de lectura con IA y 100 consultas de biblioteca; no se sube el texto de los libros.",
    ru: "В облаке хранится 100 записей ИИ-чтения и 100 вопросов к библиотеке; текст книг не загружается.",
    "pt-BR":
      "A nuvem mantém 100 históricos de leitura com IA e 100 perguntas da biblioteca; o texto dos livros não é enviado.",
  };
  Object.entries(HISTORY_RETENTION_COPY).forEach(([locale, text]) => {
    const target = localeCopy(COPY, locale);
    if (locale === "zh-CN") {
      target.syncAiHistory = "同步单书智读历史";
      target.syncAiHistoryHint = "仅单书智读；书库问答请在其设置中选择同步方式";
      target.syncHistory = "智读与书库问答记录（可选）";
    }
    target.syncAiHistoryHint = text;
  });
  // The main window loads this catalog immediately before this compatibility
  // entry. Keep the local data only for isolated consumers that load this
  // file alone (for example a standalone regression harness).
  const NEWS_SURFACE_CATALOG = global.ReaderAppI18nNewsSurfaceCatalog;
  if (
    NEWS_SURFACE_CATALOG !== undefined &&
    typeof NEWS_SURFACE_CATALOG.apply !== "function"
  ) {
    throw new Error(
      "ReaderAppI18nNewsSurfaceCatalog must expose a news surface applier",
    );
  }
  // The news surface renders both static markup and dynamic controls. Keep its
  // complete catalog together so switching the app language never leaves a
  // Chinese fallback in the feed, source picker, or article view.
  const NEWS_SURFACE_COPY = {
    "zh-CN": {
      newsTitle: "今日资讯",
      newsDescription: "按时间归并的轻量资讯流，只在你打开时加载。",
      backToShelf: "返回书架",
      manageSources: "管理来源",
      refresh: "刷新",
      sourceSettings: "资讯来源设置",
      sourceSettingsHint: "勾选想看的来源；选择会同步到已登录设备。",
      sourceSearch: "搜索来源、分类或关键词",
      listLayout: "横排布局",
      gridLayout: "方格布局",
      mixedOrder: "混合",
      bySourceOrder: "按来源",
      newsCategoryAll: "全部",
      newsSelectedSources: "已选 {count} / {max}",
      noMatchingSources: "没有找到匹配的内置来源。",
      maxSources: "最多选择 {max} 个来源。",
      openWebPage: "打开网页 →",
      noNewsInCategory: "这个分类暂时没有资讯。",
      noNews: "暂无资讯。请刷新，或在“管理来源”中调整显示内容。",
      loadingNews: "加载中…",
      refreshingNews: "刷新中…",
      newsUpdatedAt: "更新于 {time}",
      newsSourceRequired: "请至少保留一个资讯来源。",
      newsSourcesSaved: "已保存，正在自动刷新资讯…",
      newsTiebaLimit: "最多添加 {max} 个吧。",
      newsSourceLimit: "来源数量已达上限，暂时无法启用 {name}。",
      newsCategories: "资讯分类",
      newsLayout: "资讯布局",
      newsOrder: "资讯排列",
      newsReader: "资讯正文",
      newsReaderBack: "返回资讯流",
      newsOpenOriginal: "在浏览器打开原文",
      tiebaSection: "自定义贴吧",
      tiebaHint: "添加后勾选吧名，最新帖子会并入资讯流。",
      tiebaAdd: "＋ 添加吧",
      tiebaInput: "输入吧名，例如：原神",
      tiebaInputAria: "添加百度贴吧吧名",
      tiebaConfirm: "确认",
      tiebaCancel: "取消",
      tiebaCount: "已添加 {count} / {max} 个吧 · 已启用 {enabled}",
      tiebaEmpty: "还没有添加吧名。",
      tiebaBarName: "{name}吧",
      tiebaEnable: "启用 {name}吧",
      tiebaRemove: "删除 {name}吧",
      untitledNews: "未命名资讯",
      newsArticleLoadFailed: "资讯正文加载失败，请稍后重试。",
      newsBackgroundRefreshFailed: "资讯后台更新失败，正在保留已显示内容。",
      newsRequestTimedOut: "资讯请求超时，正在保留当前内容。",
      newsLoadFailed: "资讯加载失败，请检查网络后重试。",
    },
    "zh-TW": {
      newsTitle: "今日資訊",
      newsDescription: "依時間彙整的輕量資訊流，只在你開啟時載入。",
      backToShelf: "返回書架",
      manageSources: "管理來源",
      refresh: "重新整理",
      sourceSettings: "資訊來源設定",
      sourceSettingsHint: "勾選想看的來源；選擇會同步到已登入裝置。",
      sourceSearch: "搜尋來源、分類或關鍵字",
      listLayout: "橫排版面",
      gridLayout: "方格版面",
      mixedOrder: "混合",
      bySourceOrder: "依來源",
      newsCategoryAll: "全部",
      newsSelectedSources: "已選 {count} / {max}",
      noMatchingSources: "沒有找到相符的內建來源。",
      maxSources: "最多選擇 {max} 個來源。",
      openWebPage: "開啟網頁 →",
      noNewsInCategory: "這個分類暫時沒有資訊。",
      noNews: "暫無資訊。請重新整理，或在「管理來源」中調整顯示內容。",
      loadingNews: "載入中…",
      refreshingNews: "重新整理中…",
      newsUpdatedAt: "更新於 {time}",
      newsSourceRequired: "請至少保留一個資訊來源。",
      newsSourcesSaved: "已儲存，正在自動重新整理資訊…",
      newsTiebaLimit: "最多加入 {max} 個吧。",
      newsSourceLimit: "來源數量已達上限，暫時無法啟用 {name}。",
      newsCategories: "資訊分類",
      newsLayout: "資訊版面",
      newsOrder: "資訊排序",
      newsReader: "資訊正文",
      newsReaderBack: "返回資訊流",
      newsOpenOriginal: "在瀏覽器開啟原文",
      tiebaSection: "自訂貼吧",
      tiebaHint: "加入後勾選吧名，最新貼文會併入資訊流。",
      tiebaAdd: "＋ 新增吧",
      tiebaInput: "輸入吧名，例如：原神",
      tiebaInputAria: "新增百度貼吧吧名",
      tiebaConfirm: "確認",
      tiebaCancel: "取消",
      tiebaCount: "已加入 {count} / {max} 個吧 · 已啟用 {enabled}",
      tiebaEmpty: "尚未加入吧名。",
      tiebaBarName: "{name}吧",
      tiebaEnable: "啟用 {name}吧",
      tiebaRemove: "刪除 {name}吧",
      untitledNews: "未命名資訊",
      newsArticleLoadFailed: "資訊正文載入失敗，請稍後再試。",
      newsBackgroundRefreshFailed: "資訊背景更新失敗，會保留目前顯示的內容。",
      newsRequestTimedOut: "資訊請求逾時，會保留目前內容。",
      newsLoadFailed: "資訊載入失敗，請檢查網路後再試。",
    },
    en: {
      newsTitle: "Today’s news",
      newsDescription:
        "A lightweight, time-ordered news feed that loads only when you open it.",
      backToShelf: "Back to shelf",
      manageSources: "Manage sources",
      refresh: "Refresh",
      sourceSettings: "News sources",
      sourceSettingsHint:
        "Choose the sources you want. Your selection syncs to signed-in devices.",
      sourceSearch: "Search sources, categories, or keywords",
      listLayout: "List layout",
      gridLayout: "Grid layout",
      mixedOrder: "Mixed",
      bySourceOrder: "By source",
      newsCategoryAll: "All",
      newsSelectedSources: "Selected {count} / {max}",
      noMatchingSources: "No matching built-in sources.",
      maxSources: "You can select up to {max} sources.",
      openWebPage: "Open webpage →",
      noNewsInCategory: "No news in this category yet.",
      noNews: "No news yet. Refresh, or change the sources in Manage sources.",
      loadingNews: "Loading…",
      refreshingNews: "Refreshing…",
      newsUpdatedAt: "Updated {time}",
      newsSourceRequired: "Keep at least one news source.",
      newsSourcesSaved: "Saved. Refreshing news automatically…",
      newsTiebaLimit: "You can add up to {max} forums.",
      newsSourceLimit:
        "The source limit is reached, so {name} cannot be enabled yet.",
      newsCategories: "News categories",
      newsLayout: "News layout",
      newsOrder: "News order",
      newsReader: "Article",
      newsReaderBack: "Back to news feed",
      newsOpenOriginal: "Open original in browser",
      tiebaSection: "Custom Baidu Tieba forums",
      tiebaHint:
        "Select a forum after adding it to include its latest posts in the news feed.",
      tiebaAdd: "+ Add forum",
      tiebaInput: "Enter a forum name, for example Genshin Impact",
      tiebaInputAria: "Add a Baidu Tieba forum",
      tiebaConfirm: "Confirm",
      tiebaCancel: "Cancel",
      tiebaCount: "Added {count} / {max} forums · {enabled} enabled",
      tiebaEmpty: "No forum names have been added.",
      tiebaBarName: "{name} forum",
      tiebaEnable: "Enable {name} forum",
      tiebaRemove: "Remove {name} forum",
      untitledNews: "Untitled news",
      newsArticleLoadFailed:
        "Could not load the article. Please try again later.",
      newsBackgroundRefreshFailed:
        "Background refresh failed. The current items are still available.",
      newsRequestTimedOut:
        "The news request timed out. Keeping the current items.",
      newsLoadFailed:
        "Could not load news. Check your network connection and try again.",
    },
    ja: {
      newsTitle: "今日のニュース",
      newsDescription:
        "開いたときだけ読み込む、時系列の軽量ニュースフィードです。",
      backToShelf: "本棚に戻る",
      manageSources: "ソースを管理",
      refresh: "更新",
      sourceSettings: "ニュースソースの設定",
      sourceSettingsHint:
        "表示するソースを選択します。選択内容はサインイン済みの端末に同期されます。",
      sourceSearch: "ソース、カテゴリ、キーワードを検索",
      listLayout: "リスト表示",
      gridLayout: "グリッド表示",
      mixedOrder: "混在",
      bySourceOrder: "ソース順",
      newsCategoryAll: "すべて",
      newsSelectedSources: "{count} / {max} 件を選択",
      noMatchingSources: "一致する内蔵ソースはありません。",
      maxSources: "選択できるソースは最大 {max} 件です。",
      openWebPage: "Webページを開く →",
      noNewsInCategory: "このカテゴリにはまだニュースがありません。",
      noNews:
        "ニュースはまだありません。更新するか、「ソースを管理」で表示内容を変更してください。",
      loadingNews: "読み込み中…",
      refreshingNews: "更新中…",
      newsUpdatedAt: "更新日時: {time}",
      newsSourceRequired: "ニュースソースを少なくとも1つ残してください。",
      newsSourcesSaved: "保存しました。ニュースを自動更新中です…",
      newsTiebaLimit: "追加できるフォーラムは最大 {max} 件です。",
      newsSourceLimit:
        "ソース数の上限に達したため、{name} はまだ有効にできません。",
      newsCategories: "ニュースカテゴリ",
      newsLayout: "ニュースの表示形式",
      newsOrder: "ニュースの並び順",
      newsReader: "ニュース本文",
      newsReaderBack: "ニュースフィードに戻る",
      newsOpenOriginal: "ブラウザで原文を開く",
      tiebaSection: "カスタム百度Tiebaフォーラム",
      tiebaHint:
        "追加後にフォーラムを選ぶと、最新の投稿がニュースフィードに含まれます。",
      tiebaAdd: "＋ フォーラムを追加",
      tiebaInput: "フォーラム名を入力（例: 原神）",
      tiebaInputAria: "百度Tiebaフォーラムを追加",
      tiebaConfirm: "確認",
      tiebaCancel: "キャンセル",
      tiebaCount: "{count} / {max} 件を追加 · {enabled} 件を有効化",
      tiebaEmpty: "フォーラム名はまだ追加されていません。",
      tiebaBarName: "{name} フォーラム",
      tiebaEnable: "{name} フォーラムを有効にする",
      tiebaRemove: "{name} フォーラムを削除",
      untitledNews: "無題のニュース",
      newsArticleLoadFailed:
        "ニュース本文を読み込めませんでした。しばらくしてからもう一度お試しください。",
      newsBackgroundRefreshFailed:
        "バックグラウンド更新に失敗しました。表示中の記事はそのまま利用できます。",
      newsRequestTimedOut:
        "ニュースの取得がタイムアウトしました。現在の記事を保持します。",
      newsLoadFailed:
        "ニュースを読み込めませんでした。ネットワークを確認してからもう一度お試しください。",
    },
    ko: {
      newsTitle: "오늘의 뉴스",
      newsDescription: "열 때만 불러오는 시간순 경량 뉴스 피드입니다.",
      backToShelf: "책장으로 돌아가기",
      manageSources: "소스 관리",
      refresh: "새로 고침",
      sourceSettings: "뉴스 소스 설정",
      sourceSettingsHint:
        "보고 싶은 소스를 선택하세요. 선택 내용은 로그인한 기기에 동기화됩니다.",
      sourceSearch: "소스, 분류 또는 키워드 검색",
      listLayout: "목록 레이아웃",
      gridLayout: "격자 레이아웃",
      mixedOrder: "혼합",
      bySourceOrder: "소스별",
      newsCategoryAll: "전체",
      newsSelectedSources: "{count} / {max}개 선택됨",
      noMatchingSources: "일치하는 기본 소스가 없습니다.",
      maxSources: "소스는 최대 {max}개까지 선택할 수 있습니다.",
      openWebPage: "웹페이지 열기 →",
      noNewsInCategory: "이 분류에는 아직 뉴스가 없습니다.",
      noNews:
        "뉴스가 없습니다. 새로 고치거나 소스 관리에서 표시 내용을 바꾸세요.",
      loadingNews: "불러오는 중…",
      refreshingNews: "새로 고치는 중…",
      newsUpdatedAt: "업데이트: {time}",
      newsSourceRequired: "뉴스 소스를 하나 이상 남겨 두세요.",
      newsSourcesSaved: "저장되었습니다. 뉴스를 자동으로 새로 고치는 중…",
      newsTiebaLimit: "포럼은 최대 {max}개까지 추가할 수 있습니다.",
      newsSourceLimit:
        "소스 한도에 도달하여 {name}을(를) 아직 활성화할 수 없습니다.",
      newsCategories: "뉴스 분류",
      newsLayout: "뉴스 레이아웃",
      newsOrder: "뉴스 정렬",
      newsReader: "뉴스 본문",
      newsReaderBack: "뉴스 피드로 돌아가기",
      newsOpenOriginal: "브라우저에서 원문 열기",
      tiebaSection: "사용자 지정 Baidu Tieba 포럼",
      tiebaHint:
        "포럼을 추가한 뒤 선택하면 최신 게시물이 뉴스 피드에 포함됩니다.",
      tiebaAdd: "＋ 포럼 추가",
      tiebaInput: "포럼 이름 입력(예: 원신)",
      tiebaInputAria: "Baidu Tieba 포럼 추가",
      tiebaConfirm: "확인",
      tiebaCancel: "취소",
      tiebaCount: "{count} / {max}개 추가 · {enabled}개 사용",
      tiebaEmpty: "추가한 포럼 이름이 없습니다.",
      tiebaBarName: "{name} 포럼",
      tiebaEnable: "{name} 포럼 사용",
      tiebaRemove: "{name} 포럼 삭제",
      untitledNews: "제목 없는 뉴스",
      newsArticleLoadFailed:
        "뉴스 본문을 불러오지 못했습니다. 잠시 후 다시 시도하세요.",
      newsBackgroundRefreshFailed:
        "백그라운드 새로 고침에 실패했습니다. 현재 항목은 유지됩니다.",
      newsRequestTimedOut:
        "뉴스 요청 시간이 초과되었습니다. 현재 항목을 유지합니다.",
      newsLoadFailed:
        "뉴스를 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.",
    },
    fr: {
      newsTitle: "Actualités du jour",
      newsDescription:
        "Un flux d’actualités léger, classé dans le temps et chargé seulement à l’ouverture.",
      backToShelf: "Retour à la bibliothèque",
      manageSources: "Gérer les sources",
      refresh: "Actualiser",
      sourceSettings: "Sources d’actualités",
      sourceSettingsHint:
        "Choisissez les sources à afficher. Votre sélection est synchronisée sur les appareils connectés.",
      sourceSearch: "Rechercher des sources, catégories ou mots-clés",
      listLayout: "Vue liste",
      gridLayout: "Vue grille",
      mixedOrder: "Mélangé",
      bySourceOrder: "Par source",
      newsCategoryAll: "Tout",
      newsSelectedSources: "{count} / {max} sélectionnées",
      noMatchingSources: "Aucune source intégrée correspondante.",
      maxSources: "Vous pouvez choisir jusqu’à {max} sources.",
      openWebPage: "Ouvrir la page web →",
      noNewsInCategory: "Aucune actualité dans cette catégorie pour le moment.",
      noNews:
        "Aucune actualité pour le moment. Actualisez ou modifiez les sources affichées.",
      loadingNews: "Chargement…",
      refreshingNews: "Actualisation…",
      newsUpdatedAt: "Mis à jour {time}",
      newsSourceRequired: "Conservez au moins une source d’actualités.",
      newsSourcesSaved: "Enregistré. Actualisation automatique des actualités…",
      newsTiebaLimit: "Vous pouvez ajouter jusqu’à {max} forums.",
      newsSourceLimit:
        "La limite de sources est atteinte ; {name} ne peut pas encore être activé.",
      newsCategories: "Catégories d’actualités",
      newsLayout: "Disposition des actualités",
      newsOrder: "Ordre des actualités",
      newsReader: "Article",
      newsReaderBack: "Retour au flux d’actualités",
      newsOpenOriginal: "Ouvrir l’original dans le navigateur",
      tiebaSection: "Forums Baidu Tieba personnalisés",
      tiebaHint:
        "Après avoir ajouté un forum, sélectionnez-le pour inclure ses derniers messages dans le flux.",
      tiebaAdd: "+ Ajouter un forum",
      tiebaInput: "Saisissez un nom de forum, par exemple Genshin Impact",
      tiebaInputAria: "Ajouter un forum Baidu Tieba",
      tiebaConfirm: "Confirmer",
      tiebaCancel: "Annuler",
      tiebaCount: "{count} / {max} forums ajoutés · {enabled} activés",
      tiebaEmpty: "Aucun forum n’a été ajouté.",
      tiebaBarName: "Forum {name}",
      tiebaEnable: "Activer le forum {name}",
      tiebaRemove: "Supprimer le forum {name}",
      untitledNews: "Actualité sans titre",
      newsArticleLoadFailed:
        "Impossible de charger l’article. Réessayez plus tard.",
      newsBackgroundRefreshFailed:
        "L’actualisation en arrière-plan a échoué. Les éléments actuels restent disponibles.",
      newsRequestTimedOut:
        "La demande d’actualités a expiré. Les éléments actuels sont conservés.",
      newsLoadFailed:
        "Impossible de charger les actualités. Vérifiez votre connexion et réessayez.",
    },
    de: {
      newsTitle: "Heutige Nachrichten",
      newsDescription:
        "Ein schlanker, zeitlich geordneter Nachrichtenfeed, der nur beim Öffnen geladen wird.",
      backToShelf: "Zurück zum Bücherregal",
      manageSources: "Quellen verwalten",
      refresh: "Aktualisieren",
      sourceSettings: "Nachrichtenquellen",
      sourceSettingsHint:
        "Wählen Sie die gewünschten Quellen. Ihre Auswahl wird mit angemeldeten Geräten synchronisiert.",
      sourceSearch: "Quellen, Kategorien oder Stichwörter suchen",
      listLayout: "Listenansicht",
      gridLayout: "Rasteransicht",
      mixedOrder: "Gemischt",
      bySourceOrder: "Nach Quelle",
      newsCategoryAll: "Alle",
      newsSelectedSources: "{count} / {max} ausgewählt",
      noMatchingSources: "Keine passenden integrierten Quellen.",
      maxSources: "Sie können bis zu {max} Quellen auswählen.",
      openWebPage: "Webseite öffnen →",
      noNewsInCategory: "In dieser Kategorie gibt es noch keine Nachrichten.",
      noNews:
        "Noch keine Nachrichten. Aktualisieren Sie oder ändern Sie die Quellen.",
      loadingNews: "Wird geladen…",
      refreshingNews: "Wird aktualisiert…",
      newsUpdatedAt: "Aktualisiert {time}",
      newsSourceRequired:
        "Lassen Sie mindestens eine Nachrichtenquelle aktiviert.",
      newsSourcesSaved:
        "Gespeichert. Nachrichten werden automatisch aktualisiert…",
      newsTiebaLimit: "Sie können bis zu {max} Foren hinzufügen.",
      newsSourceLimit:
        "Das Quellenlimit ist erreicht; {name} kann noch nicht aktiviert werden.",
      newsCategories: "Nachrichtenkategorien",
      newsLayout: "Nachrichtenlayout",
      newsOrder: "Nachrichtenreihenfolge",
      newsReader: "Artikel",
      newsReaderBack: "Zurück zum Nachrichtenfeed",
      newsOpenOriginal: "Original im Browser öffnen",
      tiebaSection: "Eigene Baidu-Tieba-Foren",
      tiebaHint:
        "Wählen Sie ein hinzugefügtes Forum aus, um dessen neueste Beiträge in den Feed aufzunehmen.",
      tiebaAdd: "+ Forum hinzufügen",
      tiebaInput: "Forumnamen eingeben, z. B. Genshin Impact",
      tiebaInputAria: "Baidu-Tieba-Forum hinzufügen",
      tiebaConfirm: "Bestätigen",
      tiebaCancel: "Abbrechen",
      tiebaCount: "{count} / {max} Foren hinzugefügt · {enabled} aktiviert",
      tiebaEmpty: "Es wurden noch keine Foren hinzugefügt.",
      tiebaBarName: "Forum {name}",
      tiebaEnable: "Forum {name} aktivieren",
      tiebaRemove: "Forum {name} entfernen",
      untitledNews: "Unbenannte Nachricht",
      newsArticleLoadFailed:
        "Der Artikel konnte nicht geladen werden. Bitte versuchen Sie es später erneut.",
      newsBackgroundRefreshFailed:
        "Die Hintergrundaktualisierung ist fehlgeschlagen. Die aktuellen Einträge bleiben verfügbar.",
      newsRequestTimedOut:
        "Die Nachrichtenanfrage hat zu lange gedauert. Aktuelle Einträge werden beibehalten.",
      newsLoadFailed:
        "Nachrichten konnten nicht geladen werden. Prüfen Sie die Netzwerkverbindung und versuchen Sie es erneut.",
    },
    es: {
      newsTitle: "Noticias de hoy",
      newsDescription:
        "Un flujo de noticias ligero y cronológico que se carga solo al abrirlo.",
      backToShelf: "Volver a la estantería",
      manageSources: "Gestionar fuentes",
      refresh: "Actualizar",
      sourceSettings: "Fuentes de noticias",
      sourceSettingsHint:
        "Elige las fuentes que quieres ver. La selección se sincroniza con los dispositivos conectados.",
      sourceSearch: "Buscar fuentes, categorías o palabras clave",
      listLayout: "Diseño de lista",
      gridLayout: "Diseño de cuadrícula",
      mixedOrder: "Mezclado",
      bySourceOrder: "Por fuente",
      newsCategoryAll: "Todas",
      newsSelectedSources: "{count} / {max} seleccionadas",
      noMatchingSources: "No hay fuentes integradas coincidentes.",
      maxSources: "Puedes seleccionar hasta {max} fuentes.",
      openWebPage: "Abrir página web →",
      noNewsInCategory: "Aún no hay noticias en esta categoría.",
      noNews:
        "Aún no hay noticias. Actualiza o cambia las fuentes en Gestionar fuentes.",
      loadingNews: "Cargando…",
      refreshingNews: "Actualizando…",
      newsUpdatedAt: "Actualizado {time}",
      newsSourceRequired: "Mantén al menos una fuente de noticias.",
      newsSourcesSaved: "Guardado. Actualizando las noticias automáticamente…",
      newsTiebaLimit: "Puedes añadir hasta {max} foros.",
      newsSourceLimit:
        "Se alcanzó el límite de fuentes; {name} todavía no se puede activar.",
      newsCategories: "Categorías de noticias",
      newsLayout: "Diseño de noticias",
      newsOrder: "Orden de noticias",
      newsReader: "Artículo",
      newsReaderBack: "Volver al flujo de noticias",
      newsOpenOriginal: "Abrir original en el navegador",
      tiebaSection: "Foros personalizados de Baidu Tieba",
      tiebaHint:
        "Tras añadir un foro, selecciónalo para incluir sus últimas publicaciones en el flujo.",
      tiebaAdd: "+ Añadir foro",
      tiebaInput: "Introduce un nombre de foro, por ejemplo Genshin Impact",
      tiebaInputAria: "Añadir un foro de Baidu Tieba",
      tiebaConfirm: "Confirmar",
      tiebaCancel: "Cancelar",
      tiebaCount: "{count} / {max} foros añadidos · {enabled} activados",
      tiebaEmpty: "No se ha añadido ningún foro.",
      tiebaBarName: "Foro {name}",
      tiebaEnable: "Activar foro {name}",
      tiebaRemove: "Eliminar foro {name}",
      untitledNews: "Noticia sin título",
      newsArticleLoadFailed:
        "No se pudo cargar el artículo. Inténtalo de nuevo más tarde.",
      newsBackgroundRefreshFailed:
        "La actualización en segundo plano falló. Los elementos actuales siguen disponibles.",
      newsRequestTimedOut:
        "La solicitud de noticias agotó el tiempo. Se conservan los elementos actuales.",
      newsLoadFailed:
        "No se pudieron cargar las noticias. Revisa la conexión e inténtalo de nuevo.",
    },
    ru: {
      newsTitle: "Новости за сегодня",
      newsDescription:
        "Лёгкая лента новостей в хронологическом порядке, которая загружается только при открытии.",
      backToShelf: "Вернуться к полке",
      manageSources: "Управление источниками",
      refresh: "Обновить",
      sourceSettings: "Источники новостей",
      sourceSettingsHint:
        "Выберите нужные источники. Выбор синхронизируется с устройствами, где выполнен вход.",
      sourceSearch: "Поиск источников, категорий или ключевых слов",
      listLayout: "Список",
      gridLayout: "Сетка",
      mixedOrder: "Вперемешку",
      bySourceOrder: "По источнику",
      newsCategoryAll: "Все",
      newsSelectedSources: "Выбрано {count} / {max}",
      noMatchingSources: "Подходящих встроенных источников нет.",
      maxSources: "Можно выбрать до {max} источников.",
      openWebPage: "Открыть веб-страницу →",
      noNewsInCategory: "В этой категории пока нет новостей.",
      noNews: "Новостей пока нет. Обновите ленту или измените источники.",
      loadingNews: "Загрузка…",
      refreshingNews: "Обновление…",
      newsUpdatedAt: "Обновлено {time}",
      newsSourceRequired: "Оставьте включённым хотя бы один источник новостей.",
      newsSourcesSaved: "Сохранено. Новости обновляются автоматически…",
      newsTiebaLimit: "Можно добавить до {max} форумов.",
      newsSourceLimit:
        "Достигнут лимит источников, поэтому {name} пока нельзя включить.",
      newsCategories: "Категории новостей",
      newsLayout: "Макет новостей",
      newsOrder: "Порядок новостей",
      newsReader: "Статья",
      newsReaderBack: "Вернуться к ленте новостей",
      newsOpenOriginal: "Открыть оригинал в браузере",
      tiebaSection: "Пользовательские форумы Baidu Tieba",
      tiebaHint:
        "После добавления выберите форум, чтобы включить его последние публикации в ленту.",
      tiebaAdd: "+ Добавить форум",
      tiebaInput: "Введите название форума, например Genshin Impact",
      tiebaInputAria: "Добавить форум Baidu Tieba",
      tiebaConfirm: "Подтвердить",
      tiebaCancel: "Отмена",
      tiebaCount: "Добавлено {count} / {max} форумов · включено {enabled}",
      tiebaEmpty: "Форумы ещё не добавлены.",
      tiebaBarName: "Форум {name}",
      tiebaEnable: "Включить форум {name}",
      tiebaRemove: "Удалить форум {name}",
      untitledNews: "Новость без названия",
      newsArticleLoadFailed:
        "Не удалось загрузить статью. Повторите попытку позже.",
      newsBackgroundRefreshFailed:
        "Фоновое обновление не удалось. Текущие элементы сохранены.",
      newsRequestTimedOut:
        "Время ожидания запроса новостей истекло. Текущие элементы сохранены.",
      newsLoadFailed:
        "Не удалось загрузить новости. Проверьте подключение к сети и повторите попытку.",
    },
    "pt-BR": {
      newsTitle: "Notícias de hoje",
      newsDescription:
        "Um feed de notícias leve, em ordem cronológica, carregado apenas quando você o abre.",
      backToShelf: "Voltar à estante",
      manageSources: "Gerenciar fontes",
      refresh: "Atualizar",
      sourceSettings: "Fontes de notícias",
      sourceSettingsHint:
        "Escolha as fontes que deseja ver. A seleção é sincronizada nos dispositivos conectados.",
      sourceSearch: "Buscar fontes, categorias ou palavras-chave",
      listLayout: "Layout de lista",
      gridLayout: "Layout de grade",
      mixedOrder: "Misto",
      bySourceOrder: "Por fonte",
      newsCategoryAll: "Todas",
      newsSelectedSources: "{count} / {max} selecionadas",
      noMatchingSources: "Nenhuma fonte integrada correspondente.",
      maxSources: "Você pode selecionar até {max} fontes.",
      openWebPage: "Abrir página da web →",
      noNewsInCategory: "Ainda não há notícias nesta categoria.",
      noNews:
        "Ainda não há notícias. Atualize ou altere as fontes em Gerenciar fontes.",
      loadingNews: "Carregando…",
      refreshingNews: "Atualizando…",
      newsUpdatedAt: "Atualizado {time}",
      newsSourceRequired: "Mantenha pelo menos uma fonte de notícias.",
      newsSourcesSaved: "Salvo. Atualizando as notícias automaticamente…",
      newsTiebaLimit: "Você pode adicionar até {max} fóruns.",
      newsSourceLimit:
        "O limite de fontes foi atingido; {name} ainda não pode ser ativado.",
      newsCategories: "Categorias de notícias",
      newsLayout: "Layout de notícias",
      newsOrder: "Ordem das notícias",
      newsReader: "Artigo",
      newsReaderBack: "Voltar ao feed de notícias",
      newsOpenOriginal: "Abrir original no navegador",
      tiebaSection: "Fóruns personalizados do Baidu Tieba",
      tiebaHint:
        "Depois de adicionar um fórum, selecione-o para incluir as publicações mais recentes no feed.",
      tiebaAdd: "+ Adicionar fórum",
      tiebaInput: "Digite o nome de um fórum, por exemplo Genshin Impact",
      tiebaInputAria: "Adicionar um fórum do Baidu Tieba",
      tiebaConfirm: "Confirmar",
      tiebaCancel: "Cancelar",
      tiebaCount: "{count} / {max} fóruns adicionados · {enabled} ativados",
      tiebaEmpty: "Nenhum fórum foi adicionado.",
      tiebaBarName: "Fórum {name}",
      tiebaEnable: "Ativar fórum {name}",
      tiebaRemove: "Remover fórum {name}",
      untitledNews: "Notícia sem título",
      newsArticleLoadFailed:
        "Não foi possível carregar o artigo. Tente novamente mais tarde.",
      newsBackgroundRefreshFailed:
        "A atualização em segundo plano falhou. Os itens atuais continuam disponíveis.",
      newsRequestTimedOut:
        "A solicitação de notícias expirou. Os itens atuais serão mantidos.",
      newsLoadFailed:
        "Não foi possível carregar as notícias. Verifique a conexão e tente novamente.",
    },
  };
  if (NEWS_SURFACE_CATALOG) {
    NEWS_SURFACE_CATALOG.apply(COPY);
  } else {
    Object.entries(NEWS_SURFACE_COPY).forEach(([locale, copy]) =>
      Object.assign(localeCopy(COPY, locale), copy),
    );
  }
  function selectedLanguage(): string {
    return localStorage.getItem(STORAGE_KEY) || "system";
  }
  function resolvedLanguage(): string {
    const selected = selectedLanguage();
    if (selected !== "system") return selected;
    const system = String(navigator.language || "zh-CN").toLowerCase();
    if (
      system.startsWith("zh-tw") ||
      system.startsWith("zh-hk") ||
      system.startsWith("zh-mo")
    )
      return "zh-TW";
    const exact = LANGUAGES.map((item) => item[0]).find(
      (item) => item.toLowerCase() === system,
    );
    const base = system.split("-")[0] || "zh-CN";
    return exact || (base === "zh" ? "zh-CN" : base);
  }
  function t(key: string): string {
    const language = resolvedLanguage();
    const english = localeCopy(COPY, "en");
    const chinese = localeCopy(COPY, "zh-CN");
    const local = (COPY[language] || english)[key];
    // Japanese and Korean are release-gated catalogs: never mask a missing
    // entry by silently showing English on an otherwise localized screen.
    return (
      local ??
      (language === "ja" || language === "ko"
        ? `⟦${key}⟧`
        : english[key] || chinese[key] || key)
    );
  }
  function apply(root?: Document | Element | null): void {
    const language = resolvedLanguage();
    document.documentElement.lang = language;
    (root || document)
      .querySelectorAll<HTMLElement>("[data-i18n]")
      .forEach((element) => {
        element.textContent = t(element.dataset.i18n || "");
      });
    (root || document)
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "[data-i18n-placeholder]",
      )
      .forEach((element) => {
        element.placeholder = t(element.dataset.i18nPlaceholder || "");
      });
    (root || document)
      .querySelectorAll<HTMLElement>("[data-i18n-title]")
      .forEach((element) => {
        element.title = t(element.dataset.i18nTitle || "");
      });
    (root || document)
      .querySelectorAll<HTMLElement>("[data-i18n-aria]")
      .forEach((element) => {
        element.setAttribute("aria-label", t(element.dataset.i18nAria || ""));
      });
  }
  function populate(select: HTMLSelectElement | null | undefined): void {
    if (!select) return;
    select.replaceChildren(
      ...LANGUAGES.map(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "system" ? t("followSystem") : label;
        return option;
      }),
    );
    select.value = selectedLanguage();
  }
  function setLanguage(value: string): void {
    localStorage.setItem(
      STORAGE_KEY,
      LANGUAGES.some(([id]) => id === value) ? value : "system",
    );
    apply(document);
    document
      .querySelectorAll<HTMLSelectElement>(".app-language-select")
      .forEach((select) => populate(select));
    const EventConstructor = host.CustomEvent;
    host.dispatchEvent(
      new EventConstructor("app-language-changed", {
        detail: { selected: selectedLanguage(), resolved: resolvedLanguage() },
      }),
    );
  }
  // 重排模型由高精度策略自动准备，状态不再把“下载/加载”操作暴露给用户。
  // Catalogs load before this compatibility entry; keeping the guard explicit
  // makes a packaging-order error fail early instead of silently falling back.
  const RERANKER_AUTOLOAD_COPY = host.ReaderAppI18nRerankerCatalog;
  if (!RERANKER_AUTOLOAD_COPY) {
    throw new Error(
      "ReaderAppI18nRerankerCatalog must load before app-i18n.js",
    );
  }
  Object.keys(COPY).forEach((locale) =>
    Object.assign(
      localeCopy(COPY, locale),
      RERANKER_AUTOLOAD_COPY.en || {},
      RERANKER_AUTOLOAD_COPY[locale] || {},
    ),
  );
  const missingKeys = (language: string): string[] =>
    Object.keys(localeCopy(COPY, "en")).filter(
      (key) => !Object.prototype.hasOwnProperty.call(COPY[language] || {}, key),
    );
  const api: AppI18nApi = {
    STORAGE_KEY,
    apply,
    populate,
    selectedLanguage,
    resolvedLanguage,
    setLanguage,
    t,
    missingKeys,
  };
  host.ReaderAppI18n = api;
  document.addEventListener("DOMContentLoaded", () => apply(document), {
    once: true,
  });
  return api;
}
