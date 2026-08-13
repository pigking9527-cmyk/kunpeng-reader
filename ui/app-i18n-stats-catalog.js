// Reading-statistics copy has no DOM, storage, or IPC dependency.  It is
// staged as a classic-script catalog while the single UI owner coordinates its
// load order in index.html.  The compatibility entry owns its fallback rules
// so a WebView with no preceding catalog script still has the same copy.
(function (global) {
  const CHART_COPY = {
    "zh-CN": {
      lineChartData: "折线图显示数据", lineChartDataTip: "以折线图显示，并标注数据点数值", chartSettings: "图表设置", chartStyle: "图形", barChart: "柱状", lineChart: "折线", chartData: "数据", chartWords: "字数",
    },
    "zh-TW": {
      lineChartData: "折線圖顯示資料", lineChartDataTip: "以折線圖顯示，並標註資料點數值", chartSettings: "圖表設定", chartStyle: "圖形", barChart: "柱狀", lineChart: "折線", chartData: "資料", chartWords: "字數",
    },
    en: {
      lineChartData: "Show data as a line chart", lineChartDataTip: "Use a line chart with values labelled at each data point", chartSettings: "Chart settings", chartStyle: "Style", barChart: "Bars", lineChart: "Line", chartData: "Data", chartWords: "Words",
    },
    ja: {
      lineChartData: "折れ線グラフで表示", lineChartDataTip: "折れ線グラフに切り替え、各データ点の値を表示します", chartSettings: "グラフ設定", chartStyle: "形式", barChart: "棒", lineChart: "折れ線", chartData: "データ", chartWords: "文字数",
    },
    ko: {
      lineChartData: "꺾은선 그래프로 표시", lineChartDataTip: "꺾은선 그래프로 전환하고 각 데이터 지점의 값을 표시합니다", chartSettings: "차트 설정", chartStyle: "형식", barChart: "막대", lineChart: "꺾은선", chartData: "데이터", chartWords: "글자 수",
    },
  };
  const DETAIL_COPY = {
    "zh-CN": { statsBookNotes: "高亮 {highlights} · 批注 {notes}" },
    "zh-TW": { statsBookNotes: "標示 {highlights} · 批註 {notes}" },
    en: { statsBookNotes: "Highlights {highlights} · Notes {notes}" },
  };
  const HEATMAP_COPY = {
    "zh-CN": { heatmapColor: "热力图颜色", heatmapGreen: "青绿", heatmapBlue: "湖蓝", heatmapOrange: "暖橙" },
    "zh-TW": { heatmapColor: "熱力圖顏色", heatmapGreen: "青綠", heatmapBlue: "湖藍", heatmapOrange: "暖橙" },
    en: { heatmapColor: "Heatmap color", heatmapGreen: "Green", heatmapBlue: "Blue", heatmapOrange: "Orange" },
    ja: { heatmapColor: "ヒートマップの色", heatmapGreen: "グリーン", heatmapBlue: "ブルー", heatmapOrange: "オレンジ" },
    ko: { heatmapColor: "히트맵 색상", heatmapGreen: "초록", heatmapBlue: "파랑", heatmapOrange: "주황" },
  };

  function applyChart(copy) {
    Object.keys(copy).forEach((locale) =>
      Object.assign(copy[locale], CHART_COPY.en, CHART_COPY[locale] || {}),
    );
  }
  function applyDetail(copy) {
    Object.keys(copy)
      .filter((locale) => locale !== "ja" && locale !== "ko")
      .forEach((locale) =>
        Object.assign(copy[locale], DETAIL_COPY.en, DETAIL_COPY[locale] || {}),
      );
  }
  function applyHeatmap(copy) {
    Object.keys(copy).forEach((locale) =>
      Object.assign(copy[locale], HEATMAP_COPY.en, HEATMAP_COPY[locale] || {}),
    );
  }

  global.ReaderAppI18nStatsCatalog = Object.freeze({
    applyChart,
    applyDetail,
    applyHeatmap,
  });
})(window);
