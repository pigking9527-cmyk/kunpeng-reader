// Semantic-index runtime copy is data-only.  Keeping it in a classic script
// lets the single main UI preload it, while app-i18n.js keeps an equivalent
// standalone fallback for isolated consumers and packaging recovery.
(function (global) {
  const RUNTIME_COPY = {
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

  function apply(copy) {
    Object.keys(copy).forEach((locale) =>
      Object.assign(copy[locale], RUNTIME_COPY.en, RUNTIME_COPY[locale] || {}),
    );
  }

  global.ReaderAppI18nSemanticRuntimeCatalog = Object.freeze({ apply });
})(window);
