(function (global) {
  "use strict";

  const LANGUAGE_DEFINITIONS = [
    { name: "TypeScript", extensions: [".d.ts", ".ts", ".tsx"], color: "#3178c6", comments: "slash" },
    { name: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"], color: "#e4b72f", comments: "slash" },
    { name: "Rust", extensions: [".rs"], color: "#d66a3a", comments: "slash" },
    { name: "Python", extensions: [".py", ".pyw"], color: "#3572a5", comments: "hash" },
    { name: "HTML", extensions: [".html", ".htm"], color: "#e34c26", comments: "html" },
    { name: "CSS", extensions: [".css", ".scss", ".sass", ".less"], color: "#563d7c", comments: "block" },
    { name: "Java", extensions: [".java"], color: "#b07219", comments: "slash" },
    { name: "Kotlin", extensions: [".kt", ".kts"], color: "#a46df1", comments: "slash" },
    { name: "C", extensions: [".c", ".h"], color: "#6a78a8", comments: "slash" },
    { name: "C++", extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"], color: "#f34b7d", comments: "slash" },
    { name: "C#", extensions: [".cs"], color: "#7b3fa1", comments: "slash" },
    { name: "Go", extensions: [".go"], color: "#00add8", comments: "slash" },
    { name: "Swift", extensions: [".swift"], color: "#f05138", comments: "slash" },
    { name: "PHP", extensions: [".php", ".phtml"], color: "#777bb4", comments: "php" },
    { name: "Ruby", extensions: [".rb", ".rake"], color: "#cc342d", comments: "hash" },
    { name: "Shell", extensions: [".sh", ".bash", ".zsh", ".fish"], color: "#4eaa25", comments: "hash" },
    { name: "PowerShell", extensions: [".ps1", ".psm1", ".psd1"], color: "#2671be", comments: "powershell" },
    { name: "SQL", extensions: [".sql"], color: "#e38c00", comments: "sql" },
    { name: "Vue", extensions: [".vue"], color: "#41b883", comments: "mixed" },
    { name: "Svelte", extensions: [".svelte"], color: "#ff3e00", comments: "mixed" },
    { name: "Dart", extensions: [".dart"], color: "#00b4ab", comments: "slash" },
    { name: "Lua", extensions: [".lua"], color: "#294aa3", comments: "lua" },
    { name: "R", extensions: [".r", ".rmd"], color: "#198ce7", comments: "hash" },
    { name: "Scala", extensions: [".scala", ".sc"], color: "#c22d40", comments: "slash" },
    { name: "Objective-C", extensions: [".m", ".mm"], color: "#438eff", comments: "slash" },
    { name: "TOML", extensions: [".toml"], color: "#9c4221", comments: "hash" },
    { name: "YAML", extensions: [".yaml", ".yml"], color: "#cb171e", comments: "hash" },
    { name: "JSON", extensions: [".json", ".jsonc"], color: "#7c8798", comments: "json" },
    { name: "XML", extensions: [".xml", ".xhtml", ".svg"], color: "#d7892e", comments: "html" },
    { name: "Markdown", extensions: [".md", ".mdx"], color: "#59636e", comments: "html" },
    { name: "Dockerfile", exactNames: ["dockerfile"], color: "#2496ed", comments: "hash" },
    { name: "Makefile", exactNames: ["makefile", "gnumakefile"], color: "#6d5a4b", comments: "hash" }
  ];

  const COMMENT_STYLES = {
    none: { line: [], block: [] },
    slash: { line: ["//"], block: [["/*", "*/"]] },
    hash: { line: ["#"], block: [] },
    block: { line: [], block: [["/*", "*/"]] },
    html: { line: [], block: [["<!--", "-->"]] },
    mixed: { line: ["//"], block: [["/*", "*/"], ["<!--", "-->"]] },
    php: { line: ["//", "#"], block: [["/*", "*/"]] },
    powershell: { line: ["#"], block: [["<#", "#>"]] },
    sql: { line: ["--"], block: [["/*", "*/"]] },
    lua: { line: ["--"], block: [["--[[", "]]" ]] },
    json: { line: ["//"], block: [["/*", "*/"]] }
  };

  const DEFAULT_COLORS = ["#2864ff", "#35b98b", "#f0a33a", "#7c65e8", "#2bb7d6", "#e06582", "#7d91aa", "#8ab546"];

  function detectLanguage(path) {
    const normalized = String(path || "").replace(/\\/g, "/").toLowerCase();
    const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
    return LANGUAGE_DEFINITIONS.find((language) => {
      if (language.exactNames && language.exactNames.includes(fileName)) return true;
      return (language.extensions || []).some((extension) => fileName.endsWith(extension));
    }) || null;
  }

  function countLines(text, language) {
    if (!text) return { total: 0, code: 0, comment: 0, blank: 0 };
    const lines = String(text).split(/\r\n|\n|\r/);
    if (/\r\n$|[\n\r]$/.test(text)) lines.pop();
    const styleName = typeof language === "string" ? language : (language && language.comments) || "none";
    const style = COMMENT_STYLES[styleName] || COMMENT_STYLES.none;
    let blockEnd = null;
    let code = 0;
    let comment = 0;
    let blank = 0;

    for (const line of lines) {
      if (!line.trim()) {
        blank += 1;
        continue;
      }

      let index = 0;
      let hasCode = false;
      let hasComment = false;
      let quote = null;
      let escaped = false;

      while (index < line.length) {
        if (blockEnd) {
          hasComment = true;
          const endIndex = line.indexOf(blockEnd, index);
          if (endIndex < 0) {
            index = line.length;
            break;
          }
          index = endIndex + blockEnd.length;
          blockEnd = null;
          continue;
        }

        const char = line[index];
        if (quote) {
          hasCode = true;
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === quote) quote = null;
          index += 1;
          continue;
        }

        if (/\s/.test(char)) {
          index += 1;
          continue;
        }

        if (char === "\"" || char === "'" || char === "`") {
          hasCode = true;
          quote = char;
          index += 1;
          continue;
        }

        const lineToken = style.line.find((token) => line.startsWith(token, index));
        if (lineToken) {
          hasComment = true;
          break;
        }

        const blockToken = style.block.find(([start]) => line.startsWith(start, index));
        if (blockToken) {
          hasComment = true;
          blockEnd = blockToken[1];
          index += blockToken[0].length;
          continue;
        }

        hasCode = true;
        index += 1;
      }

      if (hasCode) code += 1;
      else if (hasComment || blockEnd) comment += 1;
      else blank += 1;
    }

    return { total: lines.length, code, comment, blank };
  }

  function normalizePatterns(value) {
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    return String(value || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  }

  function wildcardToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp("^" + escaped + "$", "i");
  }

  function shouldExclude(path, patterns) {
    const normalized = String(path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const lower = normalized.toLowerCase();
    const segments = lower.split("/");
    return normalizePatterns(patterns).some((rawPattern) => {
      const pattern = rawPattern.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
      if (!pattern) return false;
      if (pattern.includes("*") || pattern.includes("?")) {
        const matcher = wildcardToRegExp(pattern);
        return matcher.test(lower) || segments.some((segment) => matcher.test(segment));
      }
      if (pattern.includes("/")) return lower === pattern || lower.startsWith(pattern + "/") || lower.includes("/" + pattern + "/");
      return segments.includes(pattern);
    });
  }

  function aggregateStats(files) {
    const summary = { files: 0, total: 0, code: 0, comment: 0, blank: 0, bytes: 0, languages: [] };
    const grouped = new Map();
    for (const file of files) {
      summary.files += 1;
      summary.total += file.total;
      summary.code += file.code;
      summary.comment += file.comment;
      summary.blank += file.blank;
      summary.bytes += file.bytes || 0;
      if (!grouped.has(file.language.name)) {
        grouped.set(file.language.name, {
          name: file.language.name,
          color: file.language.color,
          files: 0,
          total: 0,
          code: 0,
          comment: 0,
          blank: 0,
          bytes: 0
        });
      }
      const item = grouped.get(file.language.name);
      item.files += 1;
      item.total += file.total;
      item.code += file.code;
      item.comment += file.comment;
      item.blank += file.blank;
      item.bytes += file.bytes || 0;
    }
    summary.languages = Array.from(grouped.values()).sort((a, b) => b.code - a.code || a.name.localeCompare(b.name));
    return summary;
  }

  const core = { LANGUAGE_DEFINITIONS, detectLanguage, countLines, normalizePatterns, shouldExclude, aggregateStats };
  global.CodeStatsCore = core;
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof document === "undefined") return;

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    pick: $("#pick-directory"),
    pickTop: $("#pick-directory-top"),
    input: $("#directory-input"),
    projectName: $("#project-name"),
    projectMeta: $("#project-meta"),
    exclude: $("#exclude-patterns"),
    maxSize: $("#max-file-size"),
    progressPanel: $("#progress-panel"),
    progressLabel: $("#progress-label"),
    progressCount: $("#progress-count"),
    progressBar: $("#progress-bar"),
    results: $("#results"),
    tableBody: $("#language-table-body"),
    tableEmpty: $("#table-empty"),
    search: $("#language-search"),
    sort: $("#language-sort"),
    toast: $("#toast")
  };

  let currentReport = null;
  let currentProjectName = "项目";
  let toastTimer = null;

  function formatNumber(value) { return new Intl.NumberFormat("zh-CN").format(value || 0); }
  function formatPercent(value, total) { return total ? (value / total * 100).toFixed(1) + "%" : "0%"; }
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
  }

  function setProgress(label, count, percent) {
    elements.progressPanel.hidden = false;
    elements.progressLabel.textContent = label;
    elements.progressCount.textContent = count;
    elements.progressBar.style.width = Math.max(2, Math.min(100, percent || 0)) + "%";
  }

  function getOptions() {
    const maxMb = Math.max(0.1, Number(elements.maxSize.value) || 2);
    return { patterns: normalizePatterns(elements.exclude.value), maxBytes: maxMb * 1024 * 1024 };
  }

  async function collectDirectoryFiles(handle, options) {
    const files = [];
    let excluded = 0;
    async function walk(directory, prefix) {
      for await (const entry of directory.values()) {
        const path = prefix ? prefix + "/" + entry.name : entry.name;
        if (shouldExclude(path, options.patterns)) {
          excluded += 1;
          continue;
        }
        if (entry.kind === "directory") await walk(entry, path);
        else {
          const language = detectLanguage(path);
          if (language) files.push({ file: await entry.getFile(), path, language });
        }
        if ((files.length + excluded) % 100 === 0) setProgress("正在发现源文件…", formatNumber(files.length) + " 个", 8);
      }
    }
    await walk(handle, "");
    return { files, excluded };
  }

  function collectInputFiles(fileList, options) {
    const files = [];
    let excluded = 0;
    for (const file of Array.from(fileList || [])) {
      const fullPath = file.webkitRelativePath || file.name;
      const path = fullPath.includes("/") ? fullPath.slice(fullPath.indexOf("/") + 1) : fullPath;
      if (shouldExclude(path, options.patterns)) {
        excluded += 1;
        continue;
      }
      const language = detectLanguage(path);
      if (language) files.push({ file, path, language });
    }
    return { files, excluded };
  }

  async function analyzeFiles(entries, options, initialSkipped) {
    const results = [];
    const skipped = { excluded: initialSkipped || 0, tooLarge: 0, binary: 0, unreadable: 0 };
    let cursor = 0;
    let completed = 0;
    const workerCount = Math.min(8, Math.max(1, entries.length));

    async function worker() {
      while (cursor < entries.length) {
        const index = cursor++;
        const entry = entries[index];
        try {
          if (entry.file.size > options.maxBytes) {
            skipped.tooLarge += 1;
          } else {
            const text = await entry.file.text();
            if (text.slice(0, 8192).includes("\0")) skipped.binary += 1;
            else results.push({
              path: entry.path,
              language: entry.language,
              bytes: entry.file.size,
              ...countLines(text, entry.language)
            });
          }
        } catch (error) {
          skipped.unreadable += 1;
        }
        completed += 1;
        if (completed === entries.length || completed % 10 === 0) {
          setProgress("正在分析代码…", formatNumber(completed) + " / " + formatNumber(entries.length), completed / entries.length * 100);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, worker));
    return { summary: aggregateStats(results), files: results, skipped };
  }

  async function runScan(source) {
    const options = getOptions();
    currentProjectName = source.name || "项目";
    elements.projectName.textContent = currentProjectName;
    elements.projectMeta.textContent = "正在读取项目结构…";
    elements.results.hidden = true;
    setProgress("正在发现源文件…", "0 个", 4);

    try {
      const collected = source.handle
        ? await collectDirectoryFiles(source.handle, options)
        : collectInputFiles(source.files, options);
      if (!collected.files.length) {
        throw new Error("未找到支持的源代码文件，请检查忽略规则或重新选择文件夹。");
      }
      const report = await analyzeFiles(collected.files, options, collected.excluded);
      currentReport = { project: currentProjectName, scannedAt: new Date().toISOString(), ...report };
      renderReport(currentReport);
      elements.projectMeta.textContent = formatNumber(report.summary.files) + " 个源文件 · " + report.summary.languages.length + " 种语言";
      elements.progressPanel.hidden = true;
      elements.results.hidden = false;
      elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      elements.progressPanel.hidden = true;
      elements.projectMeta.textContent = "扫描未完成";
      showToast(error && error.message ? error.message : "无法读取该文件夹");
    }
  }

  function renderReport(report) {
    const summary = report.summary;
    $("#metric-files").textContent = formatNumber(summary.files);
    $("#metric-languages").textContent = summary.languages.length + " 种语言";
    $("#metric-total").textContent = formatNumber(summary.total);
    $("#metric-code").textContent = formatNumber(summary.code);
    $("#metric-comment").textContent = formatNumber(summary.comment);
    $("#metric-blank").textContent = formatNumber(summary.blank);
    $("#metric-code-ratio").textContent = "占 " + formatPercent(summary.code, summary.total);
    $("#metric-comment-ratio").textContent = "占 " + formatPercent(summary.comment, summary.total);
    $("#metric-blank-ratio").textContent = "占 " + formatPercent(summary.blank, summary.total);
    $("#source-size").textContent = formatBytes(summary.bytes) + " 源文件";

    const commentBase = summary.code + summary.comment;
    const commentRatio = commentBase ? summary.comment / commentBase * 100 : 0;
    $("#comment-score").textContent = commentRatio.toFixed(1) + "%";
    $("#comment-ring-value").textContent = commentRatio.toFixed(1) + "%";
    $("#comment-ring").style.setProperty("--value", Math.min(100, commentRatio) * 3.6 + "deg");
    $("#comment-insight").textContent = getCommentInsight(commentRatio);

    renderDistribution(summary);
    renderLanguageTable();
    renderSkipped(report.skipped);
  }

  function getCommentInsight(ratio) {
    if (ratio === 0) return "没有识别到独立注释行；行尾注释会归入代码行。";
    if (ratio < 8) return "注释较精简。复杂逻辑和公共接口可以适当补充说明。";
    if (ratio < 25) return "注释比例适中，代码与说明保持了较好的平衡。";
    return "项目包含较丰富的注释或文档性内容。";
  }

  function renderDistribution(summary) {
    const bar = $("#language-bar");
    const legend = $("#language-legend");
    bar.replaceChildren();
    legend.replaceChildren();
    const visible = summary.languages.slice(0, 7);
    const other = summary.languages.slice(7);
    if (other.length) {
      visible.push({
        name: "其他",
        color: "#a0aec0",
        code: other.reduce((sum, item) => sum + item.code, 0),
        files: other.reduce((sum, item) => sum + item.files, 0)
      });
    }
    const totalCode = Math.max(1, summary.code);
    visible.forEach((item, index) => {
      const color = item.color || DEFAULT_COLORS[index % DEFAULT_COLORS.length];
      const ratio = item.code / totalCode * 100;
      const segment = document.createElement("span");
      segment.className = "language-segment";
      segment.style.width = ratio + "%";
      segment.style.background = color;
      segment.title = item.name + " " + ratio.toFixed(1) + "%";
      bar.appendChild(segment);

      const legendItem = document.createElement("div");
      legendItem.className = "legend-item";
      const dot = document.createElement("span");
      dot.className = "legend-dot";
      dot.style.background = color;
      const name = document.createElement("span");
      name.className = "legend-name";
      name.textContent = item.name;
      const value = document.createElement("span");
      value.className = "legend-value";
      value.textContent = ratio.toFixed(1) + "%";
      legendItem.append(dot, name, value);
      legend.appendChild(legendItem);
    });
  }

  function renderLanguageTable() {
    if (!currentReport) return;
    const query = elements.search.value.trim().toLocaleLowerCase("zh-CN");
    const sort = elements.sort.value;
    const languages = currentReport.summary.languages
      .filter((item) => item.name.toLocaleLowerCase("zh-CN").includes(query))
      .slice()
      .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : b[sort] - a[sort] || a.name.localeCompare(b.name));
    elements.tableBody.replaceChildren();
    elements.tableEmpty.hidden = languages.length > 0;

    for (const item of languages) {
      const row = document.createElement("tr");
      const ratio = currentReport.summary.code ? item.code / currentReport.summary.code * 100 : 0;
      row.innerHTML =
        '<td><span class="language-cell"><span class="legend-dot"></span><span class="language-name"></span></span></td>' +
        '<td class="number files"></td><td class="number total"></td><td class="number code"></td>' +
        '<td class="number comment"></td><td class="number blank"></td>' +
        '<td><span class="ratio-cell"><span class="ratio-track"><span></span></span><small></small></span></td>';
      row.querySelector(".legend-dot").style.background = item.color;
      row.querySelector(".language-name").textContent = item.name;
      row.querySelector(".files").textContent = formatNumber(item.files);
      row.querySelector(".total").textContent = formatNumber(item.total);
      row.querySelector(".code").textContent = formatNumber(item.code);
      row.querySelector(".comment").textContent = formatNumber(item.comment);
      row.querySelector(".blank").textContent = formatNumber(item.blank);
      row.querySelector(".ratio-track span").style.width = ratio + "%";
      row.querySelector(".ratio-track span").style.background = item.color;
      row.querySelector(".ratio-cell small").textContent = ratio.toFixed(1) + "%";
      elements.tableBody.appendChild(row);
    }
  }

  function renderSkipped(skipped) {
    const labels = [
      ["excluded", "匹配忽略规则"],
      ["tooLarge", "超过大小上限"],
      ["binary", "疑似二进制文件"],
      ["unreadable", "无法读取"]
    ];
    const total = labels.reduce((sum, [key]) => sum + (skipped[key] || 0), 0);
    $("#skipped-summary").textContent = total ? "跳过 " + formatNumber(total) + " 项" : "未跳过文件";
    const list = $("#skipped-list");
    list.replaceChildren();
    labels.filter(([key]) => skipped[key]).forEach(([key, label]) => {
      const item = document.createElement("div");
      item.textContent = label + "：" + formatNumber(skipped[key]);
      list.appendChild(item);
    });
  }

  function sanitizeFileName(name) { return String(name || "code-stats").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_"); }

  function downloadFile(content, type, suffix) {
    if (!currentReport) return;
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = sanitizeFileName(currentProjectName) + "-代码统计." + suffix;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("统计报告已导出");
  }

  function exportJson() {
    const data = {
      project: currentReport.project,
      scannedAt: currentReport.scannedAt,
      summary: currentReport.summary,
      skipped: currentReport.skipped,
      files: currentReport.files.map((file) => ({
        path: file.path,
        language: file.language.name,
        total: file.total,
        code: file.code,
        comment: file.comment,
        blank: file.blank,
        bytes: file.bytes
      }))
    };
    downloadFile(JSON.stringify(data, null, 2), "application/json;charset=utf-8", "json");
  }

  function csvCell(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }
  function exportCsv() {
    const rows = [["语言", "文件数", "总行数", "代码行", "注释行", "空白行", "字节数"]];
    currentReport.summary.languages.forEach((item) => rows.push([item.name, item.files, item.total, item.code, item.comment, item.blank, item.bytes]));
    const csv = "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadFile(csv, "text/csv;charset=utf-8", "csv");
  }

  async function chooseDirectory() {
    if ("showDirectoryPicker" in window) {
      try {
        const handle = await window.showDirectoryPicker({ mode: "read" });
        await runScan({ name: handle.name, handle });
      } catch (error) {
        if (!error || error.name !== "AbortError") showToast("无法读取该文件夹，请重试");
      }
    } else {
      elements.input.click();
    }
  }

  elements.pick.addEventListener("click", chooseDirectory);
  elements.pickTop.addEventListener("click", chooseDirectory);
  elements.input.addEventListener("change", () => {
    if (!elements.input.files.length) return;
    const firstPath = elements.input.files[0].webkitRelativePath || "项目";
    runScan({ name: firstPath.split("/")[0] || "项目", files: elements.input.files });
    elements.input.value = "";
  });
  elements.search.addEventListener("input", renderLanguageTable);
  elements.sort.addEventListener("change", renderLanguageTable);
  $("#export-json").addEventListener("click", exportJson);
  $("#export-csv").addEventListener("click", exportCsv);
})(typeof globalThis !== "undefined" ? globalThis : this);
