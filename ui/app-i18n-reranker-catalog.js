// Semantic reranker status copy is independent from the main-window DOM. Keep
// it in a classic script so the legacy application can continue to load its
// compatibility entry without turning the catalog into a module boundary.
(function (global) {
  global.ReaderAppI18nRerankerCatalog = {
    "zh-CN": {
      semRerankerLoading:
        "正在下载/载入重排模型；它会对初步检索出的候选内容重新排序，让回答引用更准确。",
      semRerankerReady:
        "已就绪；高精度检索实际调用时会自动载入，再对候选内容重新排序，让回答引用更准确。",
      semRerankerNotDownloaded:
        "未下载；点击“下载重排模型”后可用于高精度检索。",
      semRerankerPartial:
        "下载未完成；点击“继续下载重排模型”可复用已下载部分。",
      semResumeReranker: "继续下载重排模型",
    },
    "zh-TW": {
      semRerankerLoading:
        "正在下載/載入重排模型；它會對初步檢索出的候選內容重新排序，讓回答引用更準確。",
      semRerankerReady:
        "已就緒；高精度檢索實際調用時會自動載入，再對候選內容重新排序，讓回答引用更準確。",
      semRerankerNotDownloaded:
        "未下載；點擊「下載重排模型」後可用於高精度檢索。",
      semRerankerPartial:
        "下載未完成；點擊「繼續下載重排模型」可重用已下載部分。",
      semResumeReranker: "繼續下載重排模型",
    },
    en: {
      semRerankerLoading:
        "Downloading/loading the reranker. It reranks candidate content so citations are more accurate.",
      semRerankerReady:
        "Ready. It loads automatically when high-precision retrieval calls it, then reranks candidate content for more accurate citations.",
      semRerankerNotDownloaded:
        "Not downloaded. Download the reranker before using high-precision retrieval.",
      semRerankerPartial:
        "Download incomplete. Resume to reuse the parts already downloaded.",
      semResumeReranker: "Resume reranker download",
    },
    ja: {
      semRerankerLoading:
        "再ランキングモデルをダウンロード / 読み込み中です。候補内容を並べ替え、回答の引用精度を高めます。",
      semRerankerReady:
        "準備完了。高精度検索で実際に呼び出されたとき自動で読み込み、候補内容を並べ替えて引用精度を高めます。",
      semRerankerNotDownloaded:
        "未ダウンロードです。高精度検索を使う前に再ランキングモデルをダウンロードしてください。",
      semRerankerPartial:
        "ダウンロード未完了です。「再ランキングモデルのダウンロードを再開」で既存部分を再利用できます。",
      semResumeReranker: "再ランキングモデルのダウンロードを再開",
    },
    ko: {
      semRerankerLoading:
        "재정렬 모델을 다운로드/불러오는 중입니다. 후보 내용을 다시 정렬해 답변 인용의 정확도를 높입니다.",
      semRerankerReady:
        "준비됨. 고정밀 검색에서 실제로 호출할 때 자동으로 불러온 뒤 후보 내용을 다시 정렬해 답변 인용의 정확도를 높입니다.",
      semRerankerNotDownloaded:
        "다운로드되지 않았습니다. 고정밀 검색을 사용하기 전에 재정렬 모델을 다운로드하세요.",
      semRerankerPartial:
        "다운로드가 완료되지 않았습니다. 다시 받기를 선택하면 이미 받은 부분을 재사용합니다.",
      semResumeReranker: "재정렬 모델 다운로드 다시 받기",
    },
  };
})(window);
