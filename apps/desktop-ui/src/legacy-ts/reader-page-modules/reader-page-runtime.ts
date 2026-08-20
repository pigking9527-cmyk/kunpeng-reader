type Bag = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

interface ParentPort { postMessage(message: Bag, origin: "*"): void }
interface SideTxn extends Bag { id: unknown; finished: boolean; committed: boolean }
interface RuntimeWindow {
  innerWidth: number;
  speechSynthesis?: SpeechSynthesis;
  CSS?: { highlights?: { set(name: string, value: Highlight): void; delete(name: string): void } };
  ReaderHighlightMenuSettings?: { get(): unknown; update(settings: unknown): unknown; activate(): unknown };
  replayPendingReaderModeInput?: (value: unknown) => void;
  __readerSideViewportTxn?: SideTxn;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  getSelection?: () => Selection | null;
}
interface TtsSentence { text: string; base: number }
interface TtsSegment { node: Node; start: number; end: number }
interface TtsMark { at: number; word?: string }
interface TtsAudio extends Bag { audio: string; marks: readonly TtsMark[]; err?: unknown }
interface PreviewImage extends HTMLImageElement { __kpPagedPreviewHeight?: number; __kpPagedPreviewFromPage?: number; __kpPagedOriginalHeight?: number }
interface PreviewBox extends HTMLDivElement { _rrCroppedSource?: PreviewImage | null; _rrSourceStyle?: string | null; _rrPreviewSource?: PreviewImage | null }
interface Line { left?: number; right?: number; top?: number; bottom?: number; width?: number; height?: number; fragments?: readonly Line[] }
interface Anchor { range?: Range; el?: Element }

export interface ReaderPageRuntime extends Bag {
  document: Document;
  window: RuntimeWindow;
  parent: ParentPort;
  Node: Pick<typeof Node, "DOCUMENT_POSITION_FOLLOWING">;
  NodeFilter: Pick<typeof NodeFilter, "SHOW_TEXT" | "FILTER_REJECT" | "FILTER_ACCEPT">;
  Highlight: new (range: Range) => Highlight;
  Audio: typeof Audio;
  SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout>;
  S: Bag;
}

export interface ReaderPageRuntimeApi extends Bag {
  ttsUiLanguage(): string;
  ttsLatinLanguage(text: unknown): string;
  ttsLanguageForText(text: unknown): string;
  ttsVoiceForText(text: unknown): string;
  ttsBuildChapter(): void;
  ttsStart(): void;
  ttsStop(): void;
  queuePendingReaderModeInput(replay: unknown): boolean;
  announceHighlightMenuPreferencesReady(): void;
  tracePagedImageLayout(outcome: string, detail?: Bag): void;
  restorePagedImagePreviewSource(): void;
  clearPagedImagePreview(): void;
  cancelPagedImagePreview(): void;
  ensurePagedImagePreview(): PreviewBox | null;
  pagedImageSourcePage(rect: Line | null, rootRect: Line | null, step: number): number;
  pagedTextLineBottomOnPage(line: Line | null, rootRect: Line, step: number, page: number): number;
  pagedImageFreeHeight(lines: readonly Line[], rootRect: Line, step: number, page: number, viewport: Line): { last: number; free: number };
  hasPagedTextBeforeMedia(lines: readonly Line[], rootRect: Line, step: number, page: number, mediaTop: number): boolean;
  hasPendingContinuousPagedImageSource(): boolean;
  schedulePagedImagePreview(): void;
  refreshPagedImagePreview(): void;
}

const VOICES: Readonly<Record<string, string>> = Object.freeze({
  "zh-CN": "zh-CN-XiaoxiaoNeural", "zh-TW": "zh-TW-HsiaoChenNeural", en: "en-US-JennyNeural",
  ja: "ja-JP-NanamiNeural", ko: "ko-KR-SunHiNeural", fr: "fr-FR-DeniseNeural", de: "de-DE-KatjaNeural",
  es: "es-ES-ElviraNeural", ru: "ru-RU-SvetlanaNeural", "pt-BR": "pt-BR-FranciscaNeural",
});
const obj = (value: unknown): Bag | null => typeof value === "object" && value !== null ? value as Bag : null;
const num = (value: unknown): number => Number(value) || 0;
const fn = <T>(runtime: Bag, name: string, ...args: unknown[]): T => {
  const value = runtime[name];
  if (typeof value !== "function") throw new TypeError(`Missing reader runtime function: ${name}`);
  return (value as Fn)(...args) as T;
};
const query = <T extends Element>(root: ParentNode | null, selector: string): T | null => root?.querySelector<T>(selector) ?? null;
const concreteOrigin = (value: string): string => {
  try {
    const url = new URL(value);
    return url.origin !== "null" ? url.origin : url.host ? `${url.protocol}//${url.host}` : "";
  } catch {
    return "";
  }
};

const readerShellOrigin = (document: Document): string => {
  const referrerOrigin = concreteOrigin(document.referrer);
  if (referrerOrigin) return referrerOrigin;
  try {
    const page = new URL(document.URL);
    return page.protocol === "reader:" && page.host ? `tauri://${page.host}` : "";
  } catch {
    return "";
  }
};

export function installReaderPageRuntime(g: ReaderPageRuntime): ReaderPageRuntimeApi {
  const d = g.document;
  const w = g.window;
  const expectedShellOrigin = readerShellOrigin(d);
  let dispatchInternalMessage: ((data: Bag) => void) | null = null;
  d.addEventListener("dragstart", (event) => event.preventDefault(), true);

  const ttsUiLanguage = (): string => {
    const language = String(g.S.uiLanguage || d.documentElement.lang || "zh-CN");
    if (VOICES[language]) return language;
    if (language.startsWith("zh-TW")) return "zh-TW";
    if (language.startsWith("pt")) return "pt-BR";
    if (language.startsWith("zh")) return "zh-CN";
    return VOICES[language.slice(0, 2)] ? language.slice(0, 2) : "en";
  };
  const ttsLatinLanguage = (text: unknown): string => {
    const value = ` ${String(text || "").toLowerCase().replace(/[^a-zà-ÿßœ]+/gu, " ")} `;
    const scores: Record<string, number> = { en: 0, fr: 0, de: 0, es: 0, "pt-BR": 0 };
    const rules: ReadonlyArray<readonly [string, RegExp]> = [
      ["fr", /\b(le|la|les|des|une|est|avec|pour|dans|que|qui|bonjour|merci|vous|nous)\b/gu],
      ["de", /\b(der|die|das|und|ist|nicht|mit|eine|für|auf|den|hallo|ich|sie|wir)\b/gu],
      ["es", /\b(el|los|las|del|que|con|para|por|una|está|hola|gracias|como|usted)\b/gu],
      ["pt-BR", /\b(os|as|que|com|para|por|uma|não|dos|das|olá|obrigado|você)\b/gu],
      ["en", /\b(the|and|that|with|for|from|this|have|are|was|you|hello|thanks)\b/gu],
    ];
    for (const [language, pattern] of rules) scores[language] = value.match(pattern)?.length ?? 0;
    if (/[äöüß]/u.test(value)) scores.de = num(scores.de) + 3;
    if (/[ñ¿¡]/u.test(value)) scores.es = num(scores.es) + 3;
    if (/[ãõ]/u.test(value)) scores["pt-BR"] = num(scores["pt-BR"]) + 3;
    if (/[àâçèéêëîïôûùüÿœ]/u.test(value)) scores.fr = num(scores.fr) + 2;
    let best = "en"; let score = 0;
    for (const language of Object.keys(scores)) if (num(scores[language]) > score) { best = language; score = num(scores[language]); }
    return score ? best : "en";
  };
  const ttsLanguageForText = (text: unknown): string => {
    const value = String(text || "");
    if (/[가-힯]/u.test(value)) return "ko";
    if (/[぀-ヿ]/u.test(value)) return "ja";
    if (/[Ѐ-ԯ]/u.test(value)) return "ru";
    if (/[㐀-鿿]/u.test(value)) return /[體臺萬與為國書讀這個們後裡發現]/u.test(value) || ttsUiLanguage() === "zh-TW" ? "zh-TW" : "zh-CN";
    return /[A-Za-zÀ-ÿ]/u.test(value) ? ttsLatinLanguage(value) : ttsUiLanguage();
  };
  const ttsVoiceForText = (text: unknown): string => VOICES[ttsLanguageForText(text)] ?? VOICES.en ?? "en-US-JennyNeural";
  const ttsPickVoice = (text: unknown): { count: number; matched: boolean; language: string } => {
    const language = ttsLanguageForText(text); const voices = w.speechSynthesis?.getVoices() ?? [];
    const wanted = language === "en" ? "en-us" : language.toLowerCase();
    const found = voices.find((voice) => String(voice.lang || "").toLowerCase().startsWith(wanted)) ?? null;
    g.ttsVoice = found ?? voices[0] ?? null;
    return { count: voices.length, matched: Boolean(found), language };
  };
  const ttsBuildChapter = (): void => {
    const root = g.root as Node | null; const segments: TtsSegment[] = []; let base = 0; let text = "";
    if (root) {
      const walker = d.createTreeWalker(root, g.NodeFilter.SHOW_TEXT, { acceptNode(node) {
        const parent = node.parentNode?.nodeName ?? "";
        if (parent === "SCRIPT" || parent === "STYLE") return g.NodeFilter.FILTER_REJECT;
        return node.nodeValue?.trim() ? g.NodeFilter.FILTER_ACCEPT : g.NodeFilter.FILTER_REJECT;
      } });
      let node: Node | null;
      while ((node = walker.nextNode())) { const value = node.nodeValue ?? ""; segments.push({ node, start: base, end: base + value.length }); text += value; base += value.length; }
    }
    const sentences: TtsSentence[] = []; let current = ""; let currentBase = 0;
    for (let index = 0; index < text.length; index += 1) { const character = text[index] ?? ""; current += character;
      if ("。！？!?…\n".includes(character) || current.length >= 120) { if (current.trim()) sentences.push({ text: current, base: currentBase }); currentBase = index + 1; current = ""; }
    }
    if (current.trim()) sentences.push({ text: current, base: currentBase });
    g.ttsMap = segments; g.ttsText = text; g.ttsSents = sentences;
  };
  const ttsHighlight = (start: number, length = 1): void => {
    const segment = (g.ttsMap as TtsSegment[]).find((item) => start >= item.start && start < item.end); if (!segment) return;
    try { const range = d.createRange(); const offset = start - segment.start; range.setStart(segment.node, offset); range.setEnd(segment.node, Math.min(segment.node.nodeValue?.length ?? 0, offset + (length || 1)));
      w.CSS?.highlights?.set("tts", new g.Highlight(range)); const rect = range.getBoundingClientRect(); const viewport = fn<DOMRect>(g, "viewRect"); const x = rect.left - viewport.left + num(g.viewOffset); let page: number;
      if (fn<boolean>(g, "isDualPage")) { const layout = fn<{ l: number; colPitch: number }>(g, "pageLayout"); const physical = Math.max(0, Math.floor((x - layout.l + 1) / layout.colPitch)); page = Math.max(0, Math.floor(Math.max(0, physical - num(g.dualStartColumn)) / 2)); } else page = Math.floor((x + 1) / num(g.pageStep));
      if (page >= 0 && page < num(g.pagesInCh) && page !== num(g.pageInCh)) fn(g, "gotoPage", page);
    } catch { /* stale audio boundary */ }
  };
  const ttsCurrentOffset = (): number => { const anchor = fn<Anchor | null>(g, "topAnchor"); if (!anchor?.range) return 0; const segment = (g.ttsMap as TtsSegment[]).find((item) => item.node === anchor.range?.startContainer); return segment ? segment.start + anchor.range.startOffset : 0; };
  const ttsAdvance = (edge: boolean): void => { if (num(g.curCh) < num(g.CH) - 1) void fn<Promise<unknown>>(g, "showChapter", num(g.curCh) + 1, "start").then(() => { if (g.ttsOn) { ttsBuildChapter(); if (edge) { g.ttsCache = {}; ttsPlayIndex(0); } else ttsSpeakFrom(0); } }); else ttsStop(); };
  const ttsSpeakFrom = (index: number): void => { if (!g.ttsOn) return; const sentence = (g.ttsSents as TtsSentence[])[index]; if (!sentence) { ttsAdvance(false); return; } g.ttsSi = index; const utterance = new g.SpeechSynthesisUtterance(sentence.text); const picked = ttsPickVoice(sentence.text); if (g.ttsVoice) utterance.voice = g.ttsVoice as SpeechSynthesisVoice; utterance.lang = picked.language === "en" ? "en-US" : picked.language; utterance.rate = num(g.ttsRate) || 1; utterance.onboundary = (event) => ttsHighlight(sentence.base + event.charIndex); utterance.onend = () => { if (g.ttsOn) ttsSpeakFrom(index + 1); }; w.speechSynthesis?.speak(utterance); };
  const ttsReq = (index: number): void => { const sentences = g.ttsSents as TtsSentence[]; const sentence = sentences[index]; const cache = g.ttsCache as Record<number, TtsAudio | null | undefined>; if (!sentence || index < 0 || cache[index] !== undefined) return; cache[index] = null; g.parent.postMessage({ ttsSynth: { seq: g.ttsGen, idx: index, text: sentence.text, voice: ttsVoiceForText(sentence.text), rate: Math.round(((num(g.S.ttsRate) || 1) - 1) * 100) } }, "*"); };
  const ttsRenderAudio = (index: number, audio: TtsAudio): void => { if (!g.ttsOn) return; const sentence = (g.ttsSents as TtsSentence[])[index]; if (!sentence) return; g.ttsWaiting = -1; g.ttsSi = index; g.ttsPlayedAny = true; const marks: Array<{ at: number; off: number; len: number }> = []; let cursor = 0;
    for (const mark of audio.marks) { const word = mark.word || ""; let offset = word ? sentence.text.indexOf(word, cursor) : -1; if (offset < 0) offset = cursor; marks.push({ at: mark.at, off: sentence.base + offset, len: Math.max(1, word.length) }); cursor = offset + Math.max(1, word.length); }
    const element = new g.Audio(`data:audio/mpeg;base64,${audio.audio}`); g.ttsAudioEl = element; let markIndex = 0;
    element.ontimeupdate = () => { const milliseconds = element.currentTime * 1000; let highlighted = -1; for (let i = markIndex; i < marks.length; i += 1) { const mark = marks[i]; if (mark && mark.at <= milliseconds) highlighted = i; else break; } const mark = marks[highlighted]; if (mark) { markIndex = highlighted + 1; ttsHighlight(mark.off, mark.len); } };
    element.onended = element.onerror = () => { if (g.ttsOn) ttsPlayIndex(index + 1); }; void element.play().catch(() => { if (g.ttsOn) ttsPlayIndex(index + 1); }); ttsReq(index + 1); ttsReq(index + 2);
  };
  const ttsPlayIndex = (index: number): void => { if (!g.ttsOn) return; if (index >= (g.ttsSents as TtsSentence[]).length) { ttsAdvance(true); return; } g.ttsSi = index; ttsReq(index); ttsReq(index + 1); ttsReq(index + 2); const cached = (g.ttsCache as Record<number, TtsAudio | null | undefined>)[index]; if (cached?.err) ttsPlayIndex(index + 1); else if (cached) ttsRenderAudio(index, cached); else g.ttsWaiting = index; };
  const ttsIsEdge = (): boolean => (g.S.ttsSource || "edge") === "edge";
  const ttsBegin = (): void => { g.parent.postMessage({ ttsState: 1 }, "*"); const sentences = g.ttsSents as TtsSentence[]; const offset = ttsCurrentOffset(); let index = 0; for (let i = 0; i < sentences.length; i += 1) { const sentence = sentences[i]; if (sentence && sentence.base + sentence.text.length > offset) { index = i; break; } } if (ttsIsEdge()) { g.ttsCache = {}; g.ttsWaiting = -1; g.ttsPlayedAny = false; ttsPlayIndex(index); } else ttsSpeakFrom(index); };
  const ttsStart = (): void => { g.ttsOn = true; ttsBuildChapter(); if (ttsIsEdge()) { ttsBegin(); return; } const synthesis = w.speechSynthesis; if (!synthesis) { g.parent.postMessage({ ttsErr: 1 }, "*"); g.ttsOn = false; return; } const picked = ttsPickVoice((g.ttsSents as TtsSentence[])[0]?.text); if (!picked.matched && picked.count) g.parent.postMessage({ ttsNoSystemVoice: picked.language }, "*"); if (!picked.count) { synthesis.onvoiceschanged = () => { if (!g.ttsOn) return; const retry = ttsPickVoice((g.ttsSents as TtsSentence[])[0]?.text); if (!retry.matched) g.parent.postMessage({ ttsNoSystemVoice: retry.language }, "*"); ttsBegin(); synthesis.onvoiceschanged = null; }; } else ttsBegin(); };
  const ttsStop = (): void => { g.ttsOn = false; g.ttsGen = num(g.ttsGen) + 1; g.ttsCache = {}; g.ttsWaiting = -1; try { w.speechSynthesis?.cancel(); } catch { /* detached voice backend */ } const audio = g.ttsAudioEl as HTMLAudioElement | null; if (audio) { try { audio.pause(); } catch { /* detached media */ } g.ttsAudioEl = null; } w.CSS?.highlights?.delete("tts"); g.parent.postMessage({ ttsState: 0 }, "*"); };

  g.pendingReaderModeSettings = null; g.pendingReaderModeReplay = null; g.pendingReaderModeApplying = false;
  const queuePendingReaderModeInput = (replay: unknown): boolean => { if (!g.pendingReaderModeSettings) return false; if (g.pendingReaderModeApplying) return true; g.pendingReaderModeApplying = true; g.pendingReaderModeReplay = replay; const settings = g.pendingReaderModeSettings; g.pendingReaderModeSettings = null; g.setTimeout(() => dispatchInternalMessage?.({ settings, applyQueuedReaderModeChange: 1 }), 0); return true; };

  let pagedImagePreview: PreviewBox | null = null; let pagedImageTraceSignature = ""; let pagedImagePreviewFrame = 0; let pagedImagePreviewGeneration = 0;
  const syncPreviewState = (): void => { g.pagedImagePreview = pagedImagePreview; g.pagedImageTraceSignature = pagedImageTraceSignature; g.pagedImagePreviewFrame = pagedImagePreviewFrame; g.pagedImagePreviewGeneration = pagedImagePreviewGeneration; };
  const tracePagedImageLayout = (outcome: string, detail: Bag = {}): void => { if (typeof g.readerBugTrace !== "function") return; const data: Bag = { ...detail, image_mode: g.S.imagePagination || "unknown" }; const signature = [outcome, g.pageInCh, data.image_mode, data.image_source_page, data.image_candidate_page, data.image_top, data.image_height, data.image_free_height, data.image_preview_height, data.image_next_count, data.image_skipped_text].join("|"); if (signature === pagedImageTraceSignature) return; pagedImageTraceSignature = signature; syncPreviewState(); fn(g, "readerBugTrace", "image_pagination", outcome, null, data); };
  const restorePagedImagePreviewSource = (): void => { if (!pagedImagePreview) return; const source = pagedImagePreview._rrCroppedSource; if (source) { if (pagedImagePreview._rrSourceStyle == null) source.removeAttribute("style"); else source.setAttribute("style", pagedImagePreview._rrSourceStyle); source.__kpPagedPreviewHeight = 0; source.__kpPagedPreviewFromPage = -1; source.__kpPagedOriginalHeight = 0; } pagedImagePreview._rrCroppedSource = null; pagedImagePreview._rrSourceStyle = null; };
  const clearPagedImagePreview = (): void => { if (!pagedImagePreview) return; restorePagedImagePreviewSource(); pagedImagePreview._rrPreviewSource = null; pagedImagePreview.style.display = "none"; pagedImagePreview.innerHTML = ""; };
  const cancelPagedImagePreview = (): void => { pagedImagePreviewGeneration += 1; if (pagedImagePreviewFrame) { g.cancelAnimationFrame(pagedImagePreviewFrame); pagedImagePreviewFrame = 0; } syncPreviewState(); clearPagedImagePreview(); };
  const ensurePagedImagePreview = (): PreviewBox | null => { if (pagedImagePreview?.isConnected) return pagedImagePreview; pagedImagePreview = d.getElementById("paged-image-preview") as PreviewBox | null; if (!pagedImagePreview) { pagedImagePreview = d.createElement("div") as PreviewBox; pagedImagePreview.id = "paged-image-preview"; pagedImagePreview.style.cssText = "position:fixed;display:none;overflow:hidden;pointer-events:none;z-index:2147483646;contain:paint;"; d.body.appendChild(pagedImagePreview); } else if (pagedImagePreview.parentNode !== d.body) d.body.appendChild(pagedImagePreview); syncPreviewState(); return pagedImagePreview; };
  const pagedImageSourcePage = (rect: Line | null, rootRect: Line | null, step: number): number => !rect || !rootRect ? -1 : Math.max(0, Math.floor((num(rect.left) - num(rootRect.left) + 1) / Math.max(1, step || 1)));
  const pagedTextLineBottomOnPage = (line: Line | null, rootRect: Line, step: number, page: number): number => { if (!line) return -1; const fragments = line.fragments ?? []; if (fragments.length) { let bottom = -1; for (const fragment of fragments) if (pagedImageSourcePage(fragment, rootRect, step) === page) bottom = Math.max(bottom, num(fragment.bottom) || num(line.bottom) || -1); return bottom; } return pagedImageSourcePage(line, rootRect, step) === page ? num(line.bottom) || -1 : -1; };
  const pagedImageFreeHeight = (lines: readonly Line[], rootRect: Line, step: number, page: number, viewport: Line): { last: number; free: number } => { let last = fn<number>(g, "mg", g.S.marginTop); for (const line of lines) last = Math.max(last, pagedTextLineBottomOnPage(line, rootRect, step, page)); const bottom = Math.min(num(viewport.height) || fn<number>(g, "viewportHeight"), fn<number>(g, "pagedBoxHeight")) - fn<number>(g, "mg", g.S.marginBottom); return { last, free: Math.floor(bottom - last - 6) }; };
  const hasPagedTextBeforeMedia = (lines: readonly Line[], rootRect: Line, step: number, page: number, mediaTop: number): boolean => lines.some((line) => (line.fragments?.length ? line.fragments : [line]).some((fragment) => pagedImageSourcePage(fragment, rootRect, step) === page && (num(fragment.bottom) || -1) <= mediaTop + 2));
  const continuousPagedImageSourceState = (): { source: PreviewImage; consumed: number } | null => { const root = g.root as HTMLElement | null; if (!root || g.S.epubLayoutEngine === "modern" || g.S.imagePagination !== "continuous") return null; for (const image of root.querySelectorAll<PreviewImage>("img")) { const consumed = Math.floor(image.__kpPagedPreviewHeight ?? 0); if (image.__kpPagedPreviewFromPage === num(g.pageInCh) - 1 && consumed >= 32) return { source: image, consumed }; } return null; };
  const hasPendingContinuousPagedImageSource = (): boolean => Boolean(continuousPagedImageSourceState());
  const cropSource = (box: PreviewBox, source: PreviewImage, height: number): void => { box._rrCroppedSource = source; box._rrSourceStyle = source.getAttribute("style"); source.style.setProperty("height", `${Math.max(1, Math.round(height))}px`, "important"); source.style.setProperty("max-height", "none", "important"); source.style.setProperty("object-fit", "cover", "important"); source.style.setProperty("object-position", "center bottom", "important"); source.style.setProperty("break-before", "column", "important"); source.style.setProperty("-webkit-column-break-before", "always", "important"); };
  const visibleBottom = (viewport: DOMRect): number => { let last = fn<number>(g, "mg", g.S.marginTop); const root = g.root as Node | null; if (!root) return last; const walker = d.createTreeWalker(root, g.NodeFilter.SHOW_TEXT); let node: Node | null; while ((node = walker.nextNode())) { if (!node.nodeValue?.trim()) continue; const range = d.createRange(); try { range.selectNodeContents(node); for (const rect of range.getClientRects()) if (rect.right > viewport.left + 2 && rect.left < viewport.right - 2 && rect.bottom > viewport.top && rect.top < viewport.bottom) last = Math.max(last, Math.round(rect.bottom - viewport.top)); } catch { /* detached node */ } } return last; };
  const lastVisibleTextNode = (viewport: DOMRect): Node | null => { const root = g.root as Node | null; if (!root) return null; const walker = d.createTreeWalker(root, g.NodeFilter.SHOW_TEXT); let node: Node | null; let last: Node | null = null; while ((node = walker.nextNode())) { if (!node.nodeValue?.trim()) continue; const range = d.createRange(); try { range.selectNodeContents(node); for (const rect of range.getClientRects()) if (rect.right > viewport.left + 2 && rect.left < viewport.right - 2 && rect.bottom > viewport.top && rect.top < viewport.bottom) { last = node; break; } } catch { /* detached node */ } } return last; };
  const pageBeforeImage = (image: PreviewImage, rootRect: DOMRect, step: number): number => { const root = g.root as Node | null; if (!root) return -1; try { const range = d.createRange(); range.selectNodeContents(root); range.setEndBefore(image); let page = -1; for (const rect of range.getClientRects()) if (rect.width >= 2 && rect.height >= 2) page = Math.max(page, pagedImageSourcePage(rect, rootRect, step)); return page; } catch { return -1; } };
  const immediateImageAfterText = (viewport: DOMRect): PreviewImage | null => { const root = g.root as HTMLElement | null; const last = lastVisibleTextNode(viewport); if (!root || !last) return null; for (const image of root.querySelectorAll<PreviewImage>("img")) { if (image.closest("sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap")) continue; if (!(last.compareDocumentPosition(image) & g.Node.DOCUMENT_POSITION_FOLLOWING)) continue; try { const range = d.createRange(); range.setStartAfter(last); range.setEndBefore(image); if (range.toString().trim()) return null; } catch { return null; } return image; } return null; };
  const probeImage = (image: PreviewImage | null, viewport: DOMRect, current: number, step: number): { source: PreviewImage; rect: DOMRect } | null => { const root = g.root as HTMLElement | null; if (!root || !image) return null; const previous = root.style.transform; try { root.style.transform = `translateX(-${Math.max(0, (current + 1) * step)}px)`; void root.offsetWidth; const rect = image.getBoundingClientRect(); return rect.width >= 20 && rect.height >= 48 && rect.right > viewport.left + 2 && rect.left < viewport.right - 2 ? { source: image, rect } : null; } catch { return null; } finally { root.style.transform = previous; void root.offsetWidth; } };
  const hasVisiblePagedTextBeforeMedia = (viewport: DOMRect, mediaTop: number): boolean => visibleBottom(viewport) <= mediaTop + 2 && visibleBottom(viewport) > fn<number>(g, "mg", g.S.marginTop);
  const nextPagedImageByPrecedingContent = (images: NodeListOf<PreviewImage> | readonly PreviewImage[], rootRect: DOMRect, step: number, current: number): PreviewImage | null => Array.from(images).find((image) => !image.closest("sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap") && pageBeforeImage(image, rootRect, step) === current) ?? null;
  const showPagedImageSlice = (box: PreviewBox, source: PreviewImage, rect: Line, left: number, top: number, height: number, offset: number, viewport: Line): boolean => { const clone = fn<HTMLElement | null>(g, "clonePreviewElement", source); if (!clone) return false; box.innerHTML = ""; box.style.left = `${Math.max(0, Math.round(num(viewport.left) + left))}px`; box.style.top = `${Math.max(0, Math.round(num(viewport.top) + top))}px`; box.style.width = `${Math.round(num(rect.width))}px`; box.style.height = `${Math.max(1, Math.round(height))}px`; box.style.display = "block"; clone.style.setProperty("width", `${Math.round(num(rect.width))}px`, "important"); clone.style.setProperty("height", `${Math.round(num(rect.height))}px`, "important"); clone.style.setProperty("max-width", "none", "important"); clone.style.setProperty("max-height", "none", "important"); clone.style.transform = `translateY(-${Math.max(0, Math.round(offset || 0))}px)`; box.appendChild(clone); return true; };
  const probeNextPagedImage = (viewport: DOMRect, current: number, step: number): { source: PreviewImage; rect: DOMRect } | null => { const root = g.root as HTMLElement | null; if (!root) return null; for (const image of root.querySelectorAll<PreviewImage>("img")) { const probed = probeImage(image, viewport, current, step); if (probed) return probed; } return null; };
  const refreshPagedImagePreview = (): void => { const root = g.root as HTMLElement | null; if (!root || !g.pager || fn<boolean>(g, "isScrollMode") || fn<boolean>(g, "isDualPage") || g.S.epubLayoutEngine === "modern" || g.S.imagePagination !== "continuous") { clearPagedImagePreview(); return; } const viewport = fn<DOMRect>(g, "viewRect"); const rootRect = root.getBoundingClientRect(); const step = num(g.pageStep) || w.innerWidth || 1; const current = num(g.pageInCh); let candidate: PreviewImage | null = null; let candidateRect: DOMRect | null = null; const lines = typeof g.documentTextLineRects === "function" && typeof g.filterTextLines === "function" ? fn<Line[]>(g, "filterTextLines", fn(g, "documentTextLineRects")) : [];
    for (const image of root.querySelectorAll<PreviewImage>("img")) { if (image.closest("sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap")) continue; const rect = image.getBoundingClientRect(); if (rect.width < 20 || rect.height < 48) continue; const page = pagedImageSourcePage(rect, rootRect, step); const nearTop = rect.top - viewport.top <= fn<number>(g, "mg", g.S.marginTop) + Math.max(32, fn<number>(g, "lineHeightPx") * 1.5); const nextContent = !hasPagedTextBeforeMedia(lines, rootRect, step, current + 1, rect.top); if (rect.left >= viewport.right - 2 && page === current + 1 && (nearTop || nextContent)) { candidate = image; candidateRect = rect; break; } if (rect.right > viewport.left + 2 && rect.left < viewport.right - 2 && image.__kpPagedPreviewFromPage === current - 1 && (image.__kpPagedPreviewHeight ?? 0) >= 32) { candidate = image; candidateRect = rect; break; } }
    if (!candidate || !candidateRect) { const images = Array.from(root.querySelectorAll<PreviewImage>("img")).filter((image) => !image.closest("sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap")); const byContent = images.find((image) => pageBeforeImage(image, rootRect, step) === current) ?? null; const probe = probeImage(byContent ?? immediateImageAfterText(viewport), viewport, current, step); if (probe) { candidate = probe.source; candidateRect = probe.rect; } }
    if (!candidate || !candidateRect) { tracePagedImageLayout("no_candidate", { image_source_page: current, image_candidate_page: -1, image_probed: true }); clearPagedImagePreview(); return; }
    const sourcePage = candidateRect.left >= viewport.right - 2 ? current + 1 : current; const box = ensurePagedImagePreview(); if (!box) return;
    if (sourcePage === current) { const consumed = candidate.__kpPagedPreviewFromPage === current - 1 ? Math.max(0, Math.floor(candidate.__kpPagedPreviewHeight ?? 0)) : 0; if (consumed < 32) { tracePagedImageLayout("source_without_preview", { image_source_page: sourcePage, image_preview_height: consumed }); clearPagedImagePreview(); return; } const original = Math.max(Math.floor(candidate.__kpPagedOriginalHeight ?? 0), Math.floor(candidateRect.height)); candidate.__kpPagedOriginalHeight = original; cropSource(box, candidate, original - consumed); void root.offsetWidth; root.style.transform = `translateX(-${num(g.viewOffset)}px)`; box.innerHTML = ""; box.style.display = "none"; tracePagedImageLayout("continuous_source", { image_source_page: sourcePage, image_preview_height: consumed }); return; }
    const last = visibleBottom(viewport); const pageBottom = Math.min(viewport.height || fn<number>(g, "viewportHeight"), fn<number>(g, "pagedBoxHeight")) - fn<number>(g, "mg", g.S.marginBottom); const maximum = Math.max(32, Math.floor(candidateRect.height * 0.45)); let crop = Math.min(Math.max(0, Math.floor(pageBottom - last - 6)), maximum); let top = Math.round(last) + fn<number>(g, "imagePreviewGapPx"); if (crop < 32) { crop = Math.min(maximum, Math.max(32, Math.floor(viewport.height * 0.36))); top = Math.max(fn<number>(g, "mg", g.S.marginTop), pageBottom - crop); } if (crop >= candidateRect.height - 2) { tracePagedImageLayout("fits_full", { image_source_page: sourcePage, image_preview_height: crop, image_candidate_height: Math.floor(candidateRect.height) }); clearPagedImagePreview(); return; }
    const clone = fn<HTMLElement | null>(g, "clonePreviewElement", candidate); if (!clone) { tracePagedImageLayout("preview_failed", { image_source_page: sourcePage, image_preview_height: crop }); clearPagedImagePreview(); return; } const left = ((candidateRect.left - viewport.left) % step + step) % step; box.innerHTML = ""; box.style.left = `${Math.max(0, Math.round(viewport.left + left))}px`; box.style.top = `${Math.max(0, Math.round(viewport.top + top))}px`; box.style.width = `${Math.round(candidateRect.width)}px`; box.style.height = `${Math.max(1, Math.round(crop))}px`; box.style.display = "block"; clone.style.setProperty("width", `${Math.round(candidateRect.width)}px`, "important"); clone.style.setProperty("height", `${Math.round(candidateRect.height)}px`, "important"); clone.style.setProperty("max-width", "none", "important"); clone.style.setProperty("max-height", "none", "important"); box.appendChild(clone); box._rrPreviewSource = candidate; candidate.__kpPagedPreviewHeight = crop; candidate.__kpPagedPreviewFromPage = current; tracePagedImageLayout("preview", { image_source_page: sourcePage, image_preview_height: crop });
  };
  const schedulePagedImagePreview = (): void => { const generation = ++pagedImagePreviewGeneration; const currentPage = num(g.pageInCh); if (pagedImagePreviewFrame) g.cancelAnimationFrame(pagedImagePreviewFrame); clearPagedImagePreview(); if (!g.root || !g.pager || fn<boolean>(g, "isScrollMode") || fn<boolean>(g, "isDualPage") || g.S.epubLayoutEngine === "modern" || g.S.imagePagination !== "continuous") { tracePagedImageLayout("schedule_skipped", { image_source_page: currentPage, image_candidate_page: -1 }); syncPreviewState(); return; } tracePagedImageLayout("scheduled", { image_source_page: currentPage, image_candidate_page: currentPage + 1 }); pagedImagePreviewFrame = g.requestAnimationFrame(() => { g.requestAnimationFrame(() => { pagedImagePreviewFrame = 0; syncPreviewState(); if (generation === pagedImagePreviewGeneration) refreshPagedImagePreview(); }); }); syncPreviewState(); };

  const handleSettings = (data: Bag): void => { const settings = obj(data.settings); if (!settings) return; const requestedFlow = settings.flowMode || g.S.flowMode; if (data.deferModeChange && requestedFlow !== g.S.flowMode) { g.pendingReaderModeSettings = { ...settings }; return; } g.pendingReaderModeSettings = null; const previousFlow = g.S.flowMode; const previousPageMode = g.S.pageMode; const previousLayoutEngine = g.S.epubLayoutEngine === "modern" ? "modern" : "legacy"; const previousFont = g.S.fontFamily; const previousConversion = g.S.textConversion; const previousImages = g.S.imagePagination; const nextLayoutEngine = settings.epubLayoutEngine === "modern" ? "modern" : "legacy"; const layoutEngineChanged = nextLayoutEngine !== previousLayoutEngine; const imageOnly = !layoutEngineChanged && settings.imagePagination !== undefined && previousImages !== settings.imagePagination && Object.keys(settings).every((key) => key === "imagePagination" || settings[key] === g.S[key]); const gapOnly = !layoutEngineChanged && settings.dualPageGap !== undefined && Object.keys(settings).every((key) => key === "dualPageGap" || settings[key] === g.S[key]); const nextFlow = settings.flowMode || previousFlow; const nextPage = settings.pageMode || previousPageMode; const changingMode = nextFlow !== previousFlow || nextPage !== previousPageMode || layoutEngineChanged; const previousSignature = fn<string>(g, "pageCountSig"); const stored = fn<number | null>(g, "anchorTextOffset", g.curTopAnchor); let anchor: Anchor | null = null; if (changingMode && stored != null && fn<boolean>(g, "anchorValid", g.curTopAnchor)) anchor = g.curTopAnchor as Anchor; else if (changingMode && typeof g.visibleTopTextAnchor === "function") anchor = fn<Anchor | null>(g, "visibleTopTextAnchor"); if (!fn<boolean>(g, "anchorValid", anchor)) anchor = fn<Anchor | null>(g, "topAnchor"); g.modeSwitchRecoveryOffset = null; if (!fn<boolean>(g, "anchorValid", anchor) && fn<boolean>(g, "anchorValid", g.curTopAnchor)) anchor = g.curTopAnchor as Anchor; if (fn<boolean>(g, "anchorValid", anchor)) g.curTopAnchor = anchor; const offset = fn<number | null>(g, "anchorTextOffset", anchor); const imageAnchor = offset == null ? fn<unknown>(g, "captureImageVisualAnchor") : null; const preserveLeadMedia = changingMode && offset != null && typeof g.hasVisibleLeadMediaBeforeAnchor === "function" ? fn<boolean>(g, "hasVisibleLeadMediaBeforeAnchor", offset) : false; const diagnostics = changingMode && typeof g.modeSwitchDiagBegin === "function" ? fn<number>(g, "modeSwitchDiagBegin", previousFlow, nextFlow, previousPageMode, nextPage, offset, stored) : 0;
    if (previousFlow === "scroll") { g.scrollPagedView = false; fn(g, "clearVirtualPage"); fn(g, "clearScrollPreview"); const scroller = g.scroller as HTMLElement | null; if (scroller) { scroller.style.clipPath = "none"; scroller.style.setProperty("-webkit-clip-path", "none"); } }
    const previousLanguage = g.S.uiLanguage; g.S = Object.assign(g.S, settings); if (previousLanguage !== g.S.uiLanguage && typeof g.refreshReaderPageLanguage === "function") fn(g, "refreshReaderPageLanguage");
    if (previousConversion !== g.S.textConversion) { fn(g, "showChapter", g.curCh, g.pageInCh); return; } if (imageOnly) { pagedImageTraceSignature = ""; tracePagedImageLayout("setting_deferred", { image_source_page: g.pageInCh, image_candidate_page: -1 }); return; } if (gapOnly && !fn<boolean>(g, "isDualPage")) return;
    const flowChanged = previousFlow !== g.S.flowMode; const pageChanged = previousPageMode !== g.S.pageMode; if (flowChanged || pageChanged || layoutEngineChanged) cancelPagedImagePreview(); if (flowChanged && fn<boolean>(g, "isScrollMode")) g.scrollPagedView = Boolean(imageAnchor); g.parent.postMessage({ layoutBusy: 1 }, "*"); if (previousSignature !== fn<string>(g, "pageCountSig")) fn(g, "invalidateMeasure"); const result = fn<Bag | null>(g, "relayout", { anchor, anchorOffset: offset, exactScroll: flowChanged && fn<boolean>(g, "isScrollMode") && !imageAnchor, scrollOffset: 8, modeSwitch: changingMode, alignDualAnchor: changingMode && fn<boolean>(g, "isDualPage"), forceAnchorColumn: (flowChanged || pageChanged) && !fn<boolean>(g, "isScrollMode"), preserveLeadMedia }); if (changingMode && result?.modeSwitchVerified === false) g.modeSwitchRecoveryOffset = offset;
    if (previousFont !== g.S.fontFamily) { const selectedFont = g.S.fontFamily; void d.fonts?.ready.then(() => { if (g.S.fontFamily !== selectedFont) return; fn(g, "relayout", { anchorOffset: offset, modeSwitch: true, alignDualAnchor: fn<boolean>(g, "isDualPage") }); fn(g, "invalidateMeasure"); fn(g, "scheduleMeasure"); }).catch(() => undefined); }
    if (diagnostics) { fn(g, "modeSwitchDiagLog", diagnostics, "after_relayout", offset); fn(g, "modeSwitchDiagSchedule", diagnostics, offset); } if (flowChanged || pageChanged) fn(g, "scheduleImageVisualAnchorRestore", imageAnchor); fn(g, "scheduleMeasure"); const replay = g.pendingReaderModeReplay; g.pendingReaderModeReplay = null; if (replay) g.requestAnimationFrame(() => { g.pendingReaderModeApplying = false; w.replayPendingReaderModeInput?.(replay); }); else g.pendingReaderModeApplying = false; };

  const handleData = (data: Bag): void => {
    const menu = obj(data.readerHighlightMenuSettings); if (menu) { const id = Math.max(0, Number.parseInt(String(menu.requestId), 10) || 0); const api = w.ReaderHighlightMenuSettings; if (id && api) { const operation = String(menu.operation || ""); const settings = operation === "get" ? api.get() : operation === "update" ? api.update(menu.settings) : operation === "activate" ? api.activate() : null; if (settings) g.parent.postMessage({ readerHighlightMenuSettings: { requestId: id, settings } }, "*"); } return; }
    if (data.showHighlightMenuSettings) { if (typeof g.showHlSettings === "function") fn(g, "showHlSettings", g.selMenu || g.hlMenu); return; }
    if (data.readerGestureAction === "back") { const closed = typeof g.closeReaderPageGestureSurface === "function" && Boolean(fn(g, "closeReaderPageGestureSurface")); g.parent.postMessage({ readerGestureSurfaceClosed: closed }, "*"); return; }
    if (data.positionSnapshotRequest !== undefined) { const id = Math.max(0, Number.parseInt(String(data.positionSnapshotRequest), 10) || 0); const requestedTurnWaitMs = Number(data.positionSnapshotTurnWaitMs); const turnWaitMs = Math.max(0, Math.min(2400, Number.isFinite(requestedTurnWaitMs) ? requestedTurnWaitMs : 2400)); const started = Date.now(); const wait = (): void => { if (g.chapterTurnPending && Date.now() - started < turnWaitMs) { g.setTimeout(wait, 16); return; } g.requestAnimationFrame(() => g.requestAnimationFrame(() => { fn(g, "captureAnchor"); fn(g, "report", false, false, id); })); }; wait(); }
    const animation = obj(data.animationSettings); if (animation) { g.readerAnimationSettingsOverride = { ...animation }; d.documentElement.classList.toggle("animations-all-off", animation.allAnimations === false); const enabled = fn<boolean>(g, "readerAnimationSettingOn", "highlightSettings"); d.documentElement.classList.toggle("anim-highlight-settings-off", !enabled); const popup = g.hlSettingsPop as HTMLElement | null; if (!enabled && popup) popup.classList.remove("hs-opening"); }
    if (data.windowDragging !== undefined) fn(g, "setMeasurePaused", Boolean(data.windowDragging)); if (data.pageCountTaskControl === "pause" || data.pageCountTaskControl === "cancel") fn(g, "setMeasurePaused", true);
    if (data.pageCountViewportWidth !== undefined) { const old = fn<string>(g, "pageCountSig"); g.pageCountViewportWidth = Math.max(1, Math.round(num(data.pageCountViewportWidth) || w.innerWidth || 1)); if (old !== fn<string>(g, "pageCountSig")) { fn(g, "invalidateMeasure"); g.parent.postMessage({ layoutBusy: 1 }, "*"); fn(g, "scheduleMeasure", 60); } }
    if (data.preserveAnchor) { let anchor: Anchor | null = null; let viewportOffset = 8; let offset = g.sideAnchorVirtualOffset == null ? null : num(g.sideAnchorVirtualOffset); if (offset == null) { anchor = typeof g.visibleTopTextAnchor === "function" ? fn<Anchor | null>(g, "visibleTopTextAnchor") : null; if (!anchor) anchor = fn<Anchor | null>(g, "topAnchor"); if (!fn<boolean>(g, "anchorValid", anchor) && fn<boolean>(g, "anchorValid", g.curTopAnchor)) anchor = g.curTopAnchor as Anchor; offset = fn<number | null>(g, "anchorTextOffset", anchor); if (fn<boolean>(g, "anchorValid", anchor)) { const rect = fn<DOMRect | null>(g, "anchorRect", anchor); const viewport = fn<DOMRect>(g, "viewRect"); if (rect) viewportOffset = Math.max(0, Math.round(rect.top - viewport.top)); } } if (offset != null && typeof g.sourceRangeForOffsets === "function") { const range = fn<Range | null>(g, "sourceRangeForOffsets", offset, offset + 1); if (range) g.curTopAnchor = { range }; const transaction: SideTxn = { id: data.aiReaderSideRequestId || 0, offset, chapter: num(g.curCh), viewportOffset, preparedWidth: Math.round(w.innerWidth || 0), preparedAt: Date.now(), committed: false, finished: false }; w.__readerSideViewportTxn = transaction; if (typeof g.readerSideViewportDiag === "function") fn(g, "readerSideViewportDiag", transaction, "prepared"); } else if (fn<boolean>(g, "anchorValid", anchor)) g.curTopAnchor = anchor; g.parent.postMessage({ readerAnchorReady: 1, aiReaderSideRequestId: data.aiReaderSideRequestId || 0 }, "*"); }
    if (data.aiReaderSideCommit !== undefined) { const transaction = w.__readerSideViewportTxn; if (transaction && transaction.id === (data.aiReaderSideCommit || 0) && !transaction.finished) { transaction.committed = true; transaction.expectedWidth = Math.round(num(data.aiReaderSideExpectedWidth)); transaction.committedAt = Date.now(); if (typeof g.readerSideViewportDiag === "function") fn(g, "readerSideViewportDiag", transaction, "committed"); if (typeof g.scheduleReaderSideViewportRestore === "function") fn(g, "scheduleReaderSideViewportRestore", transaction); } }
    if (data.settings) handleSettings(data);
    if (data.tts) { if (data.tts === "start") ttsStart(); else ttsStop(); }
    const audio = obj(data.ttsAudio) as TtsAudio | null; if (audio && g.ttsOn && audio.seq === g.ttsGen) { const index = num(audio.idx); (g.ttsCache as Record<number, TtsAudio>)[index] = audio; if (num(g.ttsWaiting) === index) ttsRenderAudio(index, audio); }
    const error = obj(data.ttsAudioErr); if (error && g.ttsOn && error.seq === g.ttsGen) { const index = num(error.idx); (g.ttsCache as Record<number, TtsAudio>)[index] = { audio: "", marks: [], err: 1 }; if (num(g.ttsWaiting) === index) { g.ttsWaiting = -1; if (!g.ttsPlayedAny) { g.parent.postMessage({ ttsErr: error.err || 2 }, "*"); ttsStop(); } else ttsPlayIndex(index + 1); } }
    if (data.overlayOpen !== undefined) g.overlayOpen = Boolean(data.overlayOpen); if (data.pageCache) fn(g, "applyPageCache", data.pageCache); if (data.clearMarks) fn(g, "clearMarksKeepPage");
    if (data.gotoChapter !== undefined) void fn<Promise<unknown>>(g, "showChapter", data.gotoChapter, "start", data.frag).then(() => { if (num(data.chFrac) > 0) fn(g, "gotoPage", Math.round(num(data.chFrac) * (num(g.pagesInCh) - 1))); if (data.search) fn(g, "doSearch", data.search); });
    if (data.gotoFrac !== undefined) fn(g, "gotoGlobalFrac", data.gotoFrac); if (data.pageTurn) { fn(g, "markPageTurnInput", "shell"); fn(g, num(data.pageTurn) > 0 ? "nextPage" : "prevPage"); } if (data.reveal) fn(g, "reveal"); if (data.search !== undefined) fn(g, "doSearch", data.search); if (data.searchNav) fn(g, "searchNav", data.searchNav); if (data.vchaps) { g.VC = data.vchaps; fn(g, "report"); }
    if (data.highlights) { g.HL = data.highlights; fn(g, "refreshHighlights"); if (fn<boolean>(g, "isScrollMode")) { g.scrollBreakSig = ""; fn(g, "invalidateScrollItemsCache"); fn(g, "buildScrollBreaks", true); fn(g, "applyScrollPageMask"); } }
    if (data.dictResult !== undefined) fn(g, "showDictResult", data.dictResult); if (data.translationProfiles !== undefined) fn(g, "applyTranslationProfiles", data.translationProfiles); if (data.translateResult !== undefined) fn(g, "showTranslateResult", data.translateResult);
    if (data.excerptSaved !== undefined) { const status = query<HTMLElement>(g.excerptPage as ParentNode | null, ".ex-status"); if (status) status.textContent = `已保存到：${String(data.excerptSaved || "下载目录")}`; } if (data.excerptSaveError !== undefined) { const status = query<HTMLElement>(g.excerptPage as ParentNode | null, ".ex-status"); if (status) status.textContent = String(data.excerptSaveError || "保存图片失败"); }
    if (data.editHighlightTextFor !== undefined) g.setTimeout(() => { w.getSelection?.()?.removeAllRanges(); fn(g, "showHighlightTextEditor", data.editHighlightTextFor); }, 40); if (data.showHlMenuFor !== undefined) g.setTimeout(() => { w.getSelection?.()?.removeAllRanges(); fn(g, "showHlMenu", data.showHlMenuFor); }, 40);
    const credential = obj(data.translationCredentialStatus); if (credential?.provider) { const statuses = g.trCredentialStatus as Bag; statuses[String(credential.provider)] = credential; const panel = g.trPop as HTMLElement | null; const provider = query<HTMLSelectElement>(panel, ".tr-api"); if (provider?.value === credential.provider) { const labels = fn<{ id: string; key: string }>(g, "translateApiLabel", credential.provider); const configured = Boolean(credential.configured); const id = query<HTMLInputElement>(panel, ".tr-api-id"); const key = query<HTMLInputElement>(panel, ".tr-api-key"); if (id) id.placeholder = labels.id + (configured ? "（已安全保存，留空沿用）" : ""); if (key) key.placeholder = labels.key + (configured ? "（已安全保存，留空沿用）" : ""); if (configured && g.trText && panel?.style.display !== "none" && !g.trCredentialDirty) fn(g, "requestTranslate"); } }
    const saved = obj(data.translationCredentialSaved); if (saved?.provider) { const statuses = g.trCredentialStatus as Bag; statuses[String(saved.provider)] = saved; const panel = g.trPop as HTMLElement | null; const provider = query<HTMLSelectElement>(panel, ".tr-api"); if (provider?.value === saved.provider) { if (saved.configured) { g.trCredentialDirty = false; const id = query<HTMLInputElement>(panel, ".tr-api-id"); const key = query<HTMLInputElement>(panel, ".tr-api-key"); if (id) id.value = ""; if (key) key.value = ""; if (g.trText && panel?.style.display !== "none") fn(g, "requestTranslate"); } else { const destination = query<HTMLElement>(panel, ".tr-dst"); if (destination) { destination.textContent = String(saved.error || "保存翻译凭据失败"); destination.className = "tr-text tr-dst tr-error"; } fn(g, "placeTranslate"); } } }
    if (data.gotoHighlight !== undefined) { const highlight = (g.HL as Bag[])[num(data.gotoHighlight)]; if (highlight) void fn<Promise<unknown>>(g, "showChapter", highlight.chapter, "start").then(() => { const range = fn<Range | null>(g, "highlightRange", data.gotoHighlight); let rect: DOMRect | null = null; try { rect = range?.getBoundingClientRect() ?? null; } catch { rect = null; } if (rect) fn(g, "gotoPage", fn<number>(g, "pageOf", { getBoundingClientRect: () => rect })); }); }
    if (data.resolveToc) { const fragments = data.resolveToc as string[]; let best = fragments[0] ?? ""; let bestPage = -1; for (const fragment of fragments) { const element = fragment ? d.getElementById(fragment) : null; const page = fragment ? (element ? fn<number>(g, "pageOf", element) : Number.POSITIVE_INFINITY) : 0; if (page <= num(g.pageInCh) && page >= bestPage) { bestPage = page; best = fragment; } } g.parent.postMessage({ tocResolved: { chapter: g.curCh, frag: best } }, "*"); }
  };
  dispatchInternalMessage = handleData;
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== g.parent || !expectedShellOrigin || event.origin !== expectedShellOrigin) return;
    const data = obj(event.data);
    if (data) handleData(data);
  };
  w.addEventListener("message", handleMessage as EventListener);
  const announceHighlightMenuPreferencesReady = (): void => { if (w.ReaderHighlightMenuSettings) g.parent.postMessage({ readerHighlightMenuPreferencesReady: true }, "*"); else g.setTimeout(announceHighlightMenuPreferencesReady, 0); };
  if (d.readyState === "complete") g.setTimeout(announceHighlightMenuPreferencesReady, 0); else w.addEventListener("load", announceHighlightMenuPreferencesReady, { once: true });

  const baseSetViewOffset = g.setViewOffset as Fn; g.setViewOffset = (): void => { baseSetViewOffset(); if (hasPendingContinuousPagedImageSource()) { if (pagedImagePreviewFrame) { g.cancelAnimationFrame(pagedImagePreviewFrame); pagedImagePreviewFrame = 0; syncPreviewState(); } refreshPagedImagePreview(); if (typeof g.stabilizeProgrammaticViewPaint === "function") fn(g, "stabilizeProgrammaticViewPaint"); } else schedulePagedImagePreview(); };
  const installed: ReaderPageRuntimeApi = Object.freeze({
    ttsUiLanguage, ttsLatinLanguage, ttsLanguageForText, ttsVoiceForText, ttsPickVoice,
    ttsBuildChapter, ttsHighlight, ttsCurrentOffset, ttsAdvance, ttsSpeakFrom, ttsReq,
    ttsPlayIndex, ttsRenderAudio, ttsIsEdge, ttsBegin, ttsStart, ttsStop,
    queuePendingReaderModeInput, announceHighlightMenuPreferencesReady, tracePagedImageLayout,
    restorePagedImagePreviewSource, clearPagedImagePreview, cancelPagedImagePreview,
    ensurePagedImagePreview, pagedImageSourcePage, pagedTextLineBottomOnPage,
    pagedImageFreeHeight, visiblePagedTextBottom: visibleBottom,
    hasPagedTextBeforeMedia, hasVisiblePagedTextBeforeMedia,
    lastVisiblePagedTextNode: lastVisibleTextNode,
    hasPagedTextBetween: (start: Node | null, end: Node | null): boolean => {
      if (!start || !end) return true;
      try { const range = d.createRange(); range.setStartAfter(start); range.setEndBefore(end); return Boolean(range.toString().trim()); } catch { return true; }
    },
    immediatePagedImageAfterVisibleText: immediateImageAfterText,
    pageBeforePagedImage: pageBeforeImage, nextPagedImageByPrecedingContent,
    showPagedImageSlice, cropPagedImageSource: cropSource,
    continuousPagedImageSourceState, probeNextPagedImage,
    probePagedImageElement: probeImage, refreshPagedImagePreview,
    hasPendingContinuousPagedImageSource, schedulePagedImagePreview,
  });
  Object.assign(g, installed); g.TTS_AUTO_VOICES = VOICES; g.baseSetViewOffset = baseSetViewOffset; syncPreviewState(); if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", () => fn(g, "init")); else fn(g, "init"); return installed;
}
