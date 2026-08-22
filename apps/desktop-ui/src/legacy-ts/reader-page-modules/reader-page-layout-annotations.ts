/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const, no-var -- This installer preserves the classic six-segment lexical scope and declaration semantics during the strict TypeScript migration. */
interface ReaderPageMessage { [key:string]: string | number | boolean | null | ReaderPageMessage | ReaderPageMessage[]; }
type ReaderPageTraceDetail = Record<string, string | number | boolean | null>;
interface ReaderPageAnchor { range?:Range; el?:Element; modeSwitchMarker?:boolean; media?:boolean; }
interface ReaderRelayoutOptions { anchor?:ReaderPageAnchor|null; anchorOffset?:number|null; modeSwitch?:boolean; forceAnchorColumn?:boolean; preserveLeadMedia?:boolean; sidePaneResize?:boolean; exactScroll?:boolean; scrollOffset?:number; alignDualAnchor?:boolean; }
interface ReaderPageCache { sig:string; pages:number[]; complete?:boolean; }
interface ReaderChapterPayload { body?:string; head?:string; }
interface ReaderPageLayout { l:number;r:number;gap:number;colW:number;colPitch:number;pageStep:number;width?:number; }
interface ReaderSourceRecord { node:Text; start:number; end:number; }
interface ReaderPageTurnTrace { id: number; direction: string; chapter: number; page: number; input: string; detail: ReaderPageTraceDetail | null; }
interface ReaderChapterTrace { chapter: number; started: number; }
interface ReaderPageScrollRulesPort { firstUnfinishedItemIndex(items: readonly ReaderPageFlowItem[], start: number, bottom: number): number; pageBottomForSlice(top: number, height: number, item?: ReaderPageFlowItem | null): number; pageTopForStartItem(items: readonly ReaderPageFlowItem[], start: number, max: number, pad: number): number; alignedPageStart(items: readonly ReaderPageFlowItem[], start: number, max: number, pad: number): { startIdx: number; pageTop: number }; nearestBreakIndex(breaks: readonly number[], top: number): number; pageIndexForTop(breaks: readonly number[], top: number, epsilon: number): number; }

type HighlightActionKey='web'|'dict'|'translate'|'copy'|'highlight'|'correct'|'excerpt'|'cross'|'semantic'|'aiReader'|'note'|'bookmark';
type HighlightColorKey='y'|'g'|'b'|'p'|'gray'; type HighlightMode='text'|'icon'|'both'; type HighlightLayout='row'|'grid'; type HighlightSize='small'|'medium'|'large'; type WebEngine='baidu'|'google';
interface HighlightMenuConfig {key:HighlightActionKey;show:boolean} interface HighlightAction {key:HighlightActionKey;icon:string} interface HighlightColor {key:HighlightColorKey;labelKey:string;value:string} interface HighlightMenuPreferencesInput {displayMode?:HighlightMode;layout?:HighlightLayout;size?:HighlightSize;webSearchEngine?:WebEngine;colorful?:boolean;actions?:Array<{key?:string;visible?:boolean}>} interface HighlightMenuItem {key:HighlightActionKey;button:HTMLButtonElement;host?:HTMLElement;label?:string;labelKey?:string;icon?:string}
interface ReaderStoredAnchor {chapter:number;dom_path:string;text_offset:number;context_before:string;context_after:string;viewport_offset:number}
interface ReaderStoredPosition {chapter:number;anchor?:ReaderStoredAnchor}
interface ReaderSameBookResumeRequest {chapter:number;anchor:{text_offset:number;viewport_offset:number}}
interface ReaderSameBookResumeReport {reason:string;before_page:number;after_page:number;before_anchor_offset:number;after_anchor_offset:number;resize_sequence:number;layout_width:number;layout_height:number;restore_pending:boolean}
interface ReaderRectProvider {getBoundingClientRect():DOMRect}
interface SelectionOffsets {start:number;end:number;text:string;chapter?:number;context?:string;color?:HighlightColorKey;range_anchor?:{start:ReaderStoredAnchor;end:ReaderStoredAnchor}}
interface HighlightRecord {chapter:number;start:number|string;end:number|string;text:string;note?:string;color?:HighlightColorKey;corrected_text?:string;context?:string}
interface ReaderMenuElement extends HTMLDivElement {_setBtn?:HTMLButtonElement;_actionHost?:HTMLSpanElement;_colorHost?:HTMLSpanElement;_onColorPick?:(color:HighlightColorKey)=>void;_anchorRect?:RectLike;_menuPreferredAbove?:boolean;_menuPointerX?:number;_menuAbove?:boolean}
interface MenuDragState {row:HTMLDivElement;placeholder:HTMLDivElement;offsetY:number}
interface RectLike {left:number;top:number;right:number;bottom:number;width:number;height:number} interface PointerLike {x:number;y:number} interface HighlightPlacement {rect:RectLike;above:boolean}
type DictEnhancementKey='plain'|'sense'|'context'|'hypernyms'|'synonyms'|'antonyms'; interface DictSettings {plain:boolean;sense:boolean;context:boolean;hypernyms:boolean;synonyms:boolean;antonyms:boolean} interface DictConfig {key:DictEnhancementKey;labelKey:string} interface HowNetResult {plain?:string;sense?:string;example_note?:string;hypernyms?:string[];synonyms?:string[];antonyms?:string[]} interface DictSource {source_name?:string;word?:string;phonetic?:string;def?:string;def_en?:string} interface DictResult {word:string;lang:string;found:boolean;phonetic?:string;def?:string;def_en?:string;source_name?:string;sources?:DictSource[];hownet?:HowNetResult;autoSpeak?:boolean} interface DictGearButton extends HTMLButtonElement {_dictGearBound?:boolean}
type TranslationProvider='baidu'|'tencent'|'deepl'|'google'; interface TranslationProfile {provider:TranslationProvider;configured:boolean;config_id?:string} interface TranslationProfileStatus {profiles?:TranslationProfile[];activeProvider?:TranslationProvider;active_provider?:TranslationProvider} interface TranslationResult {ok:boolean;translated?:string;error?:string}
type ReaderDirection = -1 | 1;
type ReaderWhere = "start" | "end" | "after-dual-continuation" | number;
type ReaderClickAction='prev'|'center'|'next'|'none';
type ReaderBackgroundPreset='light'|'dark'|'sepia'|'paper'|'blue'|'custom';
interface ReaderClickZone {id:string;action:ReaderClickAction;x:number;y:number;width:number;height:number}
interface ReaderWheelReplayEvent {deltaX:number;deltaY:number;deltaMode:number;timeStamp:number;replay:true;preventDefault():void;cancelable?:boolean}
type ReaderModeReplayInput={kind:'tap';event:MouseEvent|PointerEvent}|{kind:'key';event:KeyboardEvent}|{kind:'wheel';event:ReaderWheelReplayEvent};
interface ReaderWheelGesture {direction:ReaderDirection;started:number}
interface ReaderTapSnapshot {at:number;x:number;y:number;target:EventTarget|null}
interface ReaderSettings {fontFamily:string;styleMode:string;textConversion:string;fontSize:number;noteFontSize:number;lineHeight:number;paraSpacing:number;letterSpacing:number;marginTop:number;marginBottom:number;marginLeft:number;marginRight:number;dualPageGap:number;pageMode:string;flowMode:string;pageTurnEffect:string;pageTurnSpeed:number;backgroundPreset:string;customBackgroundColor:string;customBackgroundImage:string;customPaletteId:string;textColor:string;linkColor:string;selectionColor:string;footnoteBackground:string;footnoteBorder:string;imagePagination:string;epubLayoutEngine:string;uiLanguage:string;clickZones?:ReaderClickZone[]}
interface ReaderComputedLineStyle { color:string; fontFamily:string; fontSize:string; fontWeight:string; fontStyle:string; fontVariant:string; lineHeight:string; letterSpacing:string; wordSpacing:string; textDecoration:string; textTransform:string; textAlign?:string; backgroundColor?:string; }
interface ReaderLineFragment { node?:Text; el?:Element; kind?:"inline"|"note-number"; text:string; left:number; right:number; top:number; bottom:number; width:number; height:number; style?:ReaderComputedLineStyle|null; start?:number; end?:number; }
interface ReaderLineRect { top:number; bottom:number; height:number; left:number; right:number; fragments:ReaderLineFragment[]; flowNodes?:Node[]; }
interface ReaderVisibleLineRect { top:number; bottom:number; height:number; }
interface ReaderPageFlowItem { top:number; bottom:number; height:number; type:"line"|"block"; atomic:boolean; tag?:string; preview?:boolean; el?:Element; left?:number; right?:number; width?:number; renderLeft?:number; renderTopOffset?:number; renderWidth?:number; renderHeight?:number; index?:number; fragments?:ReaderLineFragment[]; flowNodes?:Node[]; }
type ReaderLineLike={top:number;bottom:number};
interface ReaderVirtualLayoutEntry { index:number; type:"line"|"block"; top:number; height:number; sourceTop:number; item:ReaderPageFlowItem; }
interface ReaderScrollSlice { top:number; bottom:number; index?:number; startIndex?:number; endIndex?:number; nextIndex?:number; nextTop?:number; previewIndex?:number; previewItem?:ReaderPageFlowItem|null; virtualLayout?:ReaderVirtualLayoutEntry[]; virtualBottom?:number; end?:boolean; _rrExactLineCount?:number; _rrFragmentCount?:number; }
interface ReaderScrollNav { index:number; top:number; }
interface ReaderAlignedScrollStart { startIdx:number; pageTop:number; }
interface ReaderImageAnchor { source:Element; top:number; }
interface ReaderTtsMapEntry { node:Text; start:number; end:number; }
interface ReaderTtsSentence { text:string; start:number; end:number; }
interface ReaderTtsCacheEntry { audio:string; marks:ReaderPageMessage[]; err?:number; }
type ReaderPageCopy=Record<string,string>;
interface ReaderPageWindow extends Window { __CH__?: number; __ID__?: string | number; __readerSideViewportTxn?: ReaderSideViewportTransaction|null; replayPendingReaderModeInput?:(input:ReaderModeReplayInput)=>void; ReaderHighlightMenuSettings?:Readonly<{get():object;update(value:HighlightMenuPreferencesInput):object;activate():object}>; }
interface ReaderHighlightRegistry {set(name:string,highlight:Highlight):void;delete(name:string):boolean}
interface ReaderSideViewportTransaction { id: string | number; offset: number; chapter: number; viewportOffset: number; preparedWidth: number; preparedAt: number; committed: boolean; finished: boolean; expectedWidth?: number; committedAt?: number; restoreAttempts?: number; restoreTimer?: ReturnType<typeof setTimeout>; }
interface ReaderPreviewElement extends HTMLElement { _rrPreviewSource?: Element | null; _rrReservedBlank?: number; _rrRenderLayoutCount?:number; _rrRenderNodeCount?:number; }
interface ReaderFlowElement extends HTMLElement { __kpFlowWatch?:boolean; }
interface ReaderPageRootElement extends HTMLElement { __rrPageTailTightStats?: { cross?: number; fit?: number; tightened?: number }; }
function arrayValue<T>(values: readonly T[], index: number): T {
  const value=values[index];
  if(value===undefined)throw new RangeError('reader page array index out of bounds');
  return value;
}
function recordValue<T>(values: Record<string,T>, key: string | number): T {
  const value=values[String(key)];
  if(value===undefined)throw new RangeError('reader page record key is missing');
  return value;
}
export interface ReaderPageSharedRuntime {
  readonly window: ReaderPageWindow;
  readonly document: Document;
  readonly ReaderPageScrollRules: ReaderPageScrollRulesPort;
  scrollPort: () => HTMLElement | null;
  viewRect: () => DOMRect;
  readerBugTrace: (kind: string, outcome: string, event?: MouseEvent | WheelEvent | null, extra?: ReaderPageTraceDetail) => void;
  fastChapterLayout: boolean;
  perfLog: (name: string, detail?: string | number) => void;
  beginChapterTurnFx: (direction: number, chapter: number, where: string | number) => Promise<void>;
  chapterTurnPending?: boolean;
  chapterLoadFailed?: boolean;
  queueChapterTurnInput?: (direction: number) => boolean;
  replayQueuedChapterTurn?: (direction: number) => void;
  scrollCaptureTimer: ReturnType<typeof setTimeout> | null;
  queuePendingReaderModeInput: (input: ReaderModeReplayInput) => boolean;
  pagedImagePreview: ReaderPreviewElement | null;
  markPageTurnInput: (input: string, detail?: ReaderPageTraceDetail) => void;
  userNav: () => void;
  sourceAnchorRangeForOffset: (offset: number) => Range | null;
  scrollGlyphSafePx: () => number;
  reportReaderPaintPerf: (name: string, started: number, detail?: string) => void;
  modeSwitchDiagEvent: (phase: string) => void;
  refreshPagedImagePreview: () => void;
  pageDebugSettingOn: (key: string) => boolean;
  hasPendingContinuousPagedImageSource: () => boolean;
  finishChapterBugTrace: (trace: ReaderChapterTrace, ready: boolean, page: number) => void;
  clearPagedImagePreview: () => void;
  clearModeSwitchAnchor: () => void;
  beginTurnFx: (direction: number, move: () => void) => void;
  beginPageTurnBugTrace: (direction: string) => ReaderPageTurnTrace;
  scrollStartEpsilonPx: () => number;
  scrollBottomSafePx: () => number;
  schedulePagedImagePreview: () => void;
  padModeSwitchAnchorToColumnTop: (element: Element) => boolean;
  modeSwitchAnchorAtVisibleTop: (offset: number) => boolean;
  largeChapterFastLayout: (html: string) => boolean;
  forceModeSwitchAnchorColumn: (offset: number, preserve: boolean) => Element | false;
  finishPageTurnBugTrace: (trace?: ReaderPageTurnTrace | null) => void;
  chapterPending: number;
  beginChapterBugTrace: (chapter: number, where: string | number) => ReaderChapterTrace;
  clearTurnFx: () => void;
  cacheChapterBoundarySnapshot: (chapter: number, boundary: "start" | "end", page: HTMLElement) => void;
}

export function installReaderPageLayoutAnnotations(sharedRuntime: ReaderPageSharedRuntime): void {
  const runtime = sharedRuntime;
  const window: ReaderPageWindow = runtime.window;
  const document: Document = runtime.document;
  const ReaderPageScrollRules: ReaderPageScrollRulesPort = runtime.ReaderPageScrollRules;
  const scrollPort = (...args: []) => runtime.scrollPort(...args);
  const viewRect = (...args: []) => runtime.viewRect(...args);
  const readerBugTrace = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["readerBugTrace"]>>) => runtime.readerBugTrace(...args);
  let fastChapterLayout = runtime.fastChapterLayout;
  // 章首快速路径会优先以整行 Range 定位文字；仅在 WebKit 无法可靠反查
  // 字符边界时才回退逐字测量。计数只进脱敏性能诊断，不含正文或位置。
  let lastExactBandFastNodes=0,lastExactBandCharNodes=0;
  const perfLog = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["perfLog"]>>) => runtime.perfLog(...args);
  const beginChapterTurnFx = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["beginChapterTurnFx"]>>) => runtime.beginChapterTurnFx(...args);
  const queueChapterTurnInput = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["queueChapterTurnInput"]>>) => runtime.queueChapterTurnInput?.(...args) ?? false;
  let scrollCaptureTimer = runtime.scrollCaptureTimer;
  const queuePendingReaderModeInput = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["queuePendingReaderModeInput"]>>) => runtime.queuePendingReaderModeInput(...args);
  let pagedImagePreview = runtime.pagedImagePreview;
  const markPageTurnInput = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["markPageTurnInput"]>>) => runtime.markPageTurnInput(...args);
  const userNav = () => runtime.userNav();
  const sourceAnchorRangeForOffset = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["sourceAnchorRangeForOffset"]>>) => runtime.sourceAnchorRangeForOffset(...args);
  const scrollGlyphSafePx = () => runtime.scrollGlyphSafePx();
  const reportReaderPaintPerf = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["reportReaderPaintPerf"]>>) => runtime.reportReaderPaintPerf(...args);
  const modeSwitchDiagEvent = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["modeSwitchDiagEvent"]>>) => runtime.modeSwitchDiagEvent(...args);
  const refreshPagedImagePreview = () => runtime.refreshPagedImagePreview();
  const pageDebugSettingOn = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["pageDebugSettingOn"]>>) => runtime.pageDebugSettingOn(...args);
  const hasPendingContinuousPagedImageSource = () => runtime.hasPendingContinuousPagedImageSource();
  const finishChapterBugTrace = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["finishChapterBugTrace"]>>) => runtime.finishChapterBugTrace(...args);
  const clearPagedImagePreview = () => runtime.clearPagedImagePreview();
  const clearModeSwitchAnchor = () => runtime.clearModeSwitchAnchor();
  const beginTurnFx = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["beginTurnFx"]>>) => runtime.beginTurnFx(...args);
  const beginPageTurnBugTrace = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["beginPageTurnBugTrace"]>>) => runtime.beginPageTurnBugTrace(...args);
  const scrollStartEpsilonPx = () => runtime.scrollStartEpsilonPx();
  const scrollBottomSafePx = () => runtime.scrollBottomSafePx();
  const schedulePagedImagePreview = () => runtime.schedulePagedImagePreview();
  const padModeSwitchAnchorToColumnTop = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["padModeSwitchAnchorToColumnTop"]>>) => runtime.padModeSwitchAnchorToColumnTop(...args);
  const modeSwitchAnchorAtVisibleTop = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["modeSwitchAnchorAtVisibleTop"]>>) => runtime.modeSwitchAnchorAtVisibleTop(...args);
  const largeChapterFastLayout = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["largeChapterFastLayout"]>>) => runtime.largeChapterFastLayout(...args);
  const forceModeSwitchAnchorColumn = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["forceModeSwitchAnchorColumn"]>>) => runtime.forceModeSwitchAnchorColumn(...args);
  const finishPageTurnBugTrace = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["finishPageTurnBugTrace"]>>) => runtime.finishPageTurnBugTrace(...args);
  let chapterPending = runtime.chapterPending;
  const beginChapterBugTrace = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["beginChapterBugTrace"]>>) => runtime.beginChapterBugTrace(...args);
  const clearTurnFx = () => runtime.clearTurnFx();
  const cacheChapterBoundarySnapshot = (...args: Parameters<NonNullable<ReaderPageSharedRuntime["cacheChapterBoundarySnapshot"]>>) => runtime.cacheChapterBoundarySnapshot(...args);
let S: ReaderSettings={fontFamily:"",styleMode:"local",textConversion:"original",fontSize:18,noteFontSize:14,lineHeight:1.7,paraSpacing:0.6,letterSpacing:0,marginTop:18,marginBottom:24,marginLeft:28,marginRight:28,dualPageGap:40,pageMode:"single",flowMode:"paged",pageTurnEffect:"horizontal",pageTurnSpeed:1,backgroundPreset:"light",customBackgroundColor:"#fffdf8",customBackgroundImage:"",customPaletteId:"",textColor:"",linkColor:"",selectionColor:"",footnoteBackground:"",footnoteBorder:"",imagePagination:"next-page",epubLayoutEngine:"legacy",uiLanguage:"zh-CN"};
function isModernEpubLayout(): boolean{return S.epubLayoutEngine==='modern';}
const READER_ANIMATION_SETTINGS_KEY='readerAnimationSettingsV1';
const readerAnimationGroupByKey={annotationAdd:'readerPage',readingMode:'readerPage',pageTurn:'readerPage',highlightSettings:'readerPage'};
let readerAnimationSettingsOverride: Record<string, boolean> | null=null;
function readerAnimationSettingOn(key: keyof typeof readerAnimationGroupByKey): boolean{let values: Record<string,boolean>={};try{const parsed=JSON.parse(localStorage.getItem(READER_ANIMATION_SETTINGS_KEY)||'{}');if(parsed&&typeof parsed==='object')values=Object.assign(values,parsed);}catch(_){}if(readerAnimationSettingsOverride)values=readerAnimationSettingsOverride;const group=readerAnimationGroupByKey[key];return values.allAnimations!==false&&values[key]!==false&&(!group||values[group]!==false);}
const IS_MAC_WEBKIT=/Macintosh|Mac OS X/.test(navigator.userAgent||'')&&/AppleWebKit/.test(navigator.userAgent||'')&&!/(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent||'');
let root: ReaderPageRootElement,pager: HTMLElement,scroller: HTMLElement,pageMask: HTMLElement|null=null,virtualPage: HTMLElement|null=null,scrollPreview: ReaderPreviewElement|null=null,curCh=0,pageInCh=0,pagesInCh=1,pageStep=1,viewOffset=0,dualStartColumn=0,dualContinuationChapter=-1,dualContinuationEntry=false,headSeen: Record<string, Promise<void>>={},chapChars=0,scrollBreaks: number[]=[0],scrollPages: ReaderScrollSlice[]=[],scrollBreakSig='',scrollItemsSig='',scrollItemsCache: ReaderPageFlowItem[]=[],scrollMaskSig='',scrollProgrammaticUntil=0,scrollProgrammaticTarget: number|null=null,scrollActiveSlice: ReaderScrollSlice|null=null,scrollPagedView=true,sideAnchorVirtualOffset: number|null=null,macPageRenderDiagSig='',macVirtualPageCacheKey='',macVirtualPageCache: ReaderScrollSlice|null=null,fastTextNodeOffsets=new WeakMap<Text,number>(),macVirtualPageCacheByKey=new Map<string,ReaderScrollSlice>(),macVirtualPagePrefetchTimers=new Map<string,ReturnType<typeof setTimeout>>(),chapterPayloadCache=new Map<string,Required<ReaderChapterPayload>>(),chapterPayloadLoads=new Map<string,Promise<Required<ReaderChapterPayload>>>(),chapterPayloadPrefetchTimers=new Map<string,ReturnType<typeof setTimeout>>(),chapterOpeningSnapshotTimers=new Map<string,ReturnType<typeof setTimeout>>();
let downX: number|null=null,downY: number|null=null,didDrag=false;
let overlayOpen=false; // 外壳里搜索框/设置面板是否打开（打开时正文点击只用于关闭它）
let ttsOn=false,ttsMap: ReaderTtsMapEntry[]=[],ttsText='',ttsSents: ReaderTtsSentence[]=[],ttsVoice: SpeechSynthesisVoice|null=null,ttsRate=1,ttsSi=0,ttsGen=0,ttsAudioEl: HTMLAudioElement|null=null,ttsCache: Record<number,ReaderTtsCacheEntry>={},ttsWaiting=-1,ttsPlayedAny=false; // 朗读状态
let CH=window.__CH__||0, ID=window.__ID__||0;
let VC: Array<{ch:number;frag?:string}>|null=null; // 虚拟章节列表 [{ch:spine序号, frag:锚点}]（按目录顺序），用于在大文件内细分逻辑章节
function computeLogical(){
  if(!VC||!VC.length)return {lc:curCh,lt:CH};
  let idx=0;
  for(let k=0;k<VC.length;k++){
    const v=VC[k];
    if(!v)continue;
    if(v.ch<curCh){idx=k;}
    else if(v.ch===curCh){
      let pg=0;if(v.frag){const el=document.getElementById(v.frag);if(el)pg=pageOf(el);}
      if(pg<=pageInCh){idx=k;}else{break;}
    }else{break;}
  }
  return {lc:idx,lt:VC.length};
}
function applyStyle(){
  let st=document.getElementById('user-style');
  if(!st){st=document.createElement('style');st.id='user-style';document.head.appendChild(st);}
  const hm=hMargins(),scroll=isScrollMode();
  const padT=scroll?0:mg(S.marginTop),padB=scroll?0:mg(S.marginBottom);
  // 滚动模式也把左右阅读边距放在正文根节点：这样两种模式的正文内容盒宽度
  // 相同，EPUB 内部使用百分比宽度的元素也不会在模式切换时重新换行。
  const padL=isDualPage()?0:hm.l;
  const padR=isDualPage()?0:hm.r;
  const useLocalStyle=S.styleMode!=='book';
  let c='@font-face{font-family:"Kunpeng LXGW WenKai Lite";src:url("reader://localhost/font/1/LXGWWenKaiLite-Regular.ttf") format("truetype");font-display:swap;}';
  c+='@font-face{font-family:"Kunpeng Source Han Serif SC";src:url("reader://localhost/font/2/SourceHanSerifSC-Regular.otf") format("opentype");font-display:swap;}';
  c+='@font-face{font-family:"Kunpeng Zhuque Fangsong";src:url("reader://localhost/font/3/ZhuqueFangsong-Regular.ttf") format("truetype");font-display:swap;}';
  c+='.rr{margin:0 !important;padding:'+padT+'px '+padR+'px '+padB+'px '+padL+'px;';
  if(useLocalStyle&&S.fontSize)c+='font-size:'+S.fontSize+'px;';
  if(useLocalStyle&&S.lineHeight)c+='line-height:'+S.lineHeight+';';
  if(useLocalStyle)c+='letter-spacing:'+S.letterSpacing+'px;';
  if(useLocalStyle&&S.fontFamily)c+='font-family:'+S.fontFamily+';';
  c+='}';
  if(useLocalStyle&&S.fontFamily)c+='.rr *{font-family:'+S.fontFamily+' !important;}';
  if(useLocalStyle&&S.lineHeight)c+='.rr p,.rr div,.rr li{line-height:'+S.lineHeight+';}';
  if(useLocalStyle){
    c+='.rr body,.rr section,.rr article,.rr main,.rr header,.rr footer,.rr nav{margin-top:0 !important;margin-bottom:0 !important;padding-top:0 !important;padding-bottom:0 !important;}';
    c+='.rr p,.rr li,.rr blockquote{margin-top:0 !important;margin-bottom:'+S.paraSpacing+'em !important;padding-top:0 !important;padding-bottom:0 !important;}';
    // 分页末尾如果只差段间距就能再放一整行，布局阶段会为该段写入一个
    // 更小的变量值；普通段落和普通页面仍使用用户设置的 paraSpacing。
    c+='.rr p.rr-page-tail-tight{margin-bottom:var(--rr-page-tail-gap,0px) !important;}';
    c+='.rr div{margin-top:0 !important;margin-bottom:0 !important;padding-top:0 !important;padding-bottom:0 !important;}';
    // 不让 EPUB 自带的 h3{margin:2em 0} 在标题前后再塞进数行空白。
    // 标题上下间距保持在一行以内。
    c+='.rr h1,.rr h2,.rr h3,.rr h4,.rr h5,.rr h6{margin-top:.55em !important;margin-bottom:.55em !important;padding-top:0 !important;padding-bottom:0 !important;}';
    // 部分 EPUB（如《南明史》）把章节首的右上角小印章放在独占一行的 div 里。
    // 该 div 只有一张 logo 图，却会占用整张图的高度，造成标题和正文之间看似
    // “丢失”的大片空白。仅对首个、显式标记为 logo 的小装饰图改为右浮动：
    // 它仍然可见，正文可以环绕；普通插图和没有 alt="logo" 的图片完全不受影响。
    c+='.rr>div:first-child:has(>img[alt="logo"]){float:right !important;width:auto !important;height:auto !important;line-height:0 !important;margin:0 0 .35em .8em !important;padding:0 !important;}.rr>div:first-child:has(>img[alt="logo"])>img{display:block !important;margin:0 !important;padding:0 !important;}';
  }
  c+='.rr hr.rr-note-sep{display:none !important;}';
  c+='.rr *{break-before:auto !important;break-after:auto !important;break-inside:auto !important;page-break-before:auto !important;page-break-after:auto !important;page-break-inside:auto !important;-webkit-column-break-before:auto !important;-webkit-column-break-after:auto !important;-webkit-column-break-inside:auto !important;}';
  // 章节边界不能参与横向分栏。此前末尾占位元素会强制出一栏，双页下可能
  // 形成完全空白的最后跨；滚动模式仍在下方单独显示它来保留尾部缓冲。
  c+='body:not(.scroll-mode):not(.line-paged-mode) .rr-end{display:none !important;}';
  // 当本章正文恰好停在双页的左栏时，将下一章的首栏接到右栏。它是一个
  // 真实的跨章 spread，页码计算仍只统计当前章，外壳会收到明确的右页章节号。
  // 离开双页分页（单页/滚动）时必须隐藏该临时首栏，避免同一段正文被重复显示。
  if(isDualPage())c+='.rr .rr-dual-continuation{display:block !important;box-sizing:border-box !important;height:'+pagedBoxHeight()+'px !important;overflow:hidden !important;margin:0 !important;padding:0 !important;break-before:column !important;page-break-before:always !important;-webkit-column-break-before:always !important;}';
  else c+='.rr .rr-dual-continuation{display:none !important;}';
  // 单页/双页切换时，把切换前首行所在段落从该字符处分成两个真实块，并让后半块
  // 强制从新栏开始。不能使用零宽零高空节点：Chromium 只保证空节点在栏首，并不保证
  // 紧随其后的文字也在栏首，长段落因此会落到新栏中部。
  // 这条规则必须放在通用 break-before 重置之后，才能覆盖书籍自身及上面的重置。
  c+='.rr .rr-mode-switch-anchor{display:block !important;margin-top:0 !important;padding-top:0 !important;break-before:column !important;page-break-before:always !important;-webkit-column-break-before:always !important;}.rr .rr-mode-switch-continuation{text-indent:0 !important;}body.scroll-mode .rr .rr-mode-switch-anchor{break-before:auto !important;page-break-before:auto !important;-webkit-column-break-before:auto !important;}';
  if(mg(S.marginTop)===0)c+='.rr>:first-child,.rr body>:first-child{margin-top:0 !important;padding-top:0 !important;}';
  if(mg(S.marginBottom)===0)c+='.rr>:last-child,.rr body>:last-child{margin-bottom:0 !important;padding-bottom:0 !important;}';
  if(mg(S.marginLeft)===0)c+='.rr,.rr>*,.rr body{margin-left:0 !important;padding-left:0 !important;}';
  if(mg(S.marginRight)===0)c+='.rr,.rr>*,.rr body{margin-right:0 !important;padding-right:0 !important;}';
  // 0 px 的含义是两栏内容边缘真正相接。真实 EPUB 的首层 body/section
  // 可能自带水平留白；只在双页且中缝明确为 0 时清掉它，其他中缝值和
  // 外侧阅读边距仍由 pageLayout() 正常控制。
  if(isDualPage()&&dualPageGapPx()===0)c+='.rr,.rr>*,.rr body{margin-left:0 !important;margin-right:0 !important;padding-left:0 !important;padding-right:0 !important;}';
  if(useLocalStyle&&S.fontSize){
    c+='.rr *{font-size:inherit !important;}';
    c+='.rr h1{font-size:1.7em !important;} .rr h2{font-size:1.4em !important;} .rr h3{font-size:1.2em !important;} .rr h4{font-size:1.1em !important;}';
    c+='.rr sup,.rr sub{font-size:.75em !important;}'; // 上下标（注释角标）仍保持小一号
  }
  const presets: Record<ReaderBackgroundPreset,readonly [string,string,string,string,string,string]>={light:['#fff','#222','#2f6fad','#dceafa','#f3f6fa','#b7c7da'],dark:['#1c1c1e','#d2d2d2','#9abfe8','#3a4f6b','#252f3a','#647a94'],sepia:['#f4ecd8','#5b4636','#875b37','#e7dab8','#f3ebdd','#b79d76'],paper:['#f8f1df','#443a2d','#875b37','#e7dab8','#f3ebdd','#b79d76'],blue:['#eaf2fa','#26394d','#2f6fad','#d3e4f6','#edf3f9','#a7c1dd'],custom:['#fffdf8','#222','#2f6fad','#dceafa','#f3f6fa','#b7c7da']};
  const preset=presets[S.backgroundPreset as ReaderBackgroundPreset]||presets.light,validColor=function(v: string|undefined,f: string): string{return /^#[0-9a-f]{3,8}$/i.test(String(v||''))?String(v):f;},backgroundImageValue=String(S.customBackgroundImage||'');const bg=S.backgroundPreset==='custom'?validColor(S.customBackgroundColor,preset[0]):preset[0],link=validColor(S.linkColor,preset[2]),selection=validColor(S.selectionColor,preset[3]),noteBg=validColor(S.footnoteBackground,preset[4]),noteBorder=validColor(S.footnoteBorder,preset[5]),bgImage=/^(?:reader:\/\/localhost|http:\/\/reader\.localhost)\/background\/[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/i.test(backgroundImageValue)?backgroundImageValue:'';
  // 自定义颜色保存在书籍设置中，旧版本曾允许浅色背景配白色正文，结果正文
  // 实际仍在页面里却几乎不可见。纯色背景下强制一个最低对比度；有背景图时
  // 无法可靠判断图片亮度，保留用户原先选择。
  let colorParts=function(v: string): [number,number,number,number]|null{let h=String(v||'').replace(/^#/,'');if(h.length===3||h.length===4)h=h.split('').map(function(x){return x+x;}).join('');if(h.length!==6&&h.length!==8)return null;const a=h.length===8?parseInt(h.slice(6,8),16)/255:1;return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16),a];},linear=function(n: number): number{n/=255;return n<=.03928?n/12.92:Math.pow((n+.055)/1.055,2.4);},contrast=function(f: string,b: string): number{const fgParts=colorParts(f),bgParts=colorParts(b);if(!fgParts||!bgParts)return Infinity;const alpha=fgParts[3];if(alpha<1){fgParts[0]=fgParts[0]*alpha+bgParts[0]*(1-alpha);fgParts[1]=fgParts[1]*alpha+bgParts[1]*(1-alpha);fgParts[2]=fgParts[2]*alpha+bgParts[2]*(1-alpha);}const fl=.2126*linear(fgParts[0])+.7152*linear(fgParts[1])+.0722*linear(fgParts[2]),bl=.2126*linear(bgParts[0])+.7152*linear(bgParts[1])+.0722*linear(bgParts[2]);return (Math.max(fl,bl)+.05)/(Math.min(fl,bl)+.05);},fg=validColor(S.textColor,preset[1]);
  if(!bgImage&&contrast(fg,bg)<4.5)fg=preset[1];
  const bgImageRule=bgImage?'background-image:url("'+bgImage+'") !important;background-size:cover !important;background-position:center !important;background-attachment:fixed !important;':'';
  c+='html,body{background:'+bg+' !important;'+bgImageRule+'}#page-mask{background:'+bg+' !important;'+bgImageRule+'}#virtual-page{--reader-bg:'+bg+';'+bgImageRule+'}';
  c+='html,body,#page-mask,#virtual-page,.rr,.rr *{transition:none !important;}';
  c+='#fn-pop{font-size:'+noteFontSizePx()+'px !important;background:'+noteBg+' !important;border-color:'+noteBorder+' !important;}';
  c+='.rr,.rr *{color:'+fg+' !important;}.rr a{color:'+link+' !important;}.rr ::selection{background:'+selection+' !important;}';
  c+='.rr .rr-note-wrap{display:inline !important;margin:0 !important;padding:0 !important;font-size:inherit !important;line-height:1 !important;vertical-align:baseline !important;text-decoration:none !important;}';
  c+='.rr .rr-note-ref,#virtual-page .rr-note-ref{display:inline-flex !important;align-items:center !important;justify-content:center !important;width:14px !important;height:14px !important;box-sizing:border-box !important;border-radius:50% !important;background:'+noteBg+' !important;border:1px solid '+noteBorder+' !important;color:'+link+' !important;font-size:9px !important;font-family:system-ui,"Microsoft YaHei",sans-serif !important;font-weight:700 !important;line-height:1 !important;text-decoration:none !important;vertical-align:middle !important;overflow:hidden !important;padding:0 !important;margin:0 0 0 .02em !important;}';
  c+='#virtual-page .rr-note-ref{margin:0 !important;}';
  c+='.rr .rr-note-ref::before,.rr .rr-note-ref::after,#virtual-page .rr-note-ref::before,#virtual-page .rr-note-ref::after{content:none !important;}';
  c+='.rr .rr-note-badge,#virtual-page .rr-note-badge{display:inline-flex !important;align-items:center !important;justify-content:center !important;width:100% !important;height:100% !important;box-sizing:border-box !important;color:'+link+' !important;background:transparent !important;border:0 !important;border-radius:50% !important;font:700 9px/1 system-ui,"Microsoft YaHei",sans-serif !important;text-decoration:none !important;letter-spacing:0 !important;}';
  // 两种图片过渡方式共享同一份正文分页规则。
  c+='.rr img,.rr figure,.rr svg{break-inside:avoid !important;page-break-inside:avoid !important;-webkit-column-break-inside:avoid !important;max-height:calc(100vh - '+(mg(S.marginTop)+mg(S.marginBottom)+8)+'px) !important;max-width:100% !important;object-fit:contain !important;}';
  if(isModernEpubLayout())c+='.rr img,.rr svg,.rr video{box-sizing:border-box !important;width:auto !important;height:auto !important;max-width:100% !important;max-height:calc('+pagedBoxHeight()+'px - 2.5em) !important;object-fit:contain !important;break-inside:avoid !important;page-break-inside:avoid !important;-webkit-column-break-inside:avoid !important;}.rr figure,.rr table{box-sizing:border-box !important;max-width:100% !important;break-inside:avoid !important;page-break-inside:avoid !important;-webkit-column-break-inside:avoid !important;}.rr a,.rr h1,.rr h2,.rr h3,.rr h4,.rr h5,.rr h6{overflow-wrap:anywhere !important;}';
  const minLines=isModernEpubLayout()?2:1;
  c+='html,body,.rr,.rr *{writing-mode:horizontal-tb !important;-webkit-writing-mode:horizontal-tb !important;-epub-writing-mode:horizontal-tb !important;text-orientation:mixed !important;}.rr{direction:ltr !important;orphans:'+minLines+' !important;widows:'+minLines+' !important;-webkit-line-box-contain:block glyphs replaced !important;}.rr p,.rr div,.rr li,.rr blockquote{orphans:'+minLines+' !important;widows:'+minLines+' !important;}';
  // 模式切换会以字符锚点直接设置 scrollTop。书籍自带的平滑滚动或滚动吸附
  // 会在这次即时恢复后再次修正位置，形成肉眼可见的上下抖动。
  c+='html,body,#pager,#scroller,.rr{overflow-anchor:none;scroll-behavior:auto !important;scroll-snap-type:none !important;scroll-snap-stop:normal !important;}';
  c+='body.scroll-mode #pager{overflow:hidden !important;}body.scroll-mode #scroller{overflow-y:auto !important;overflow-x:hidden !important;}';
  c+='body.scroll-mode .rr{height:auto !important;min-height:100% !important;column-count:auto !important;column-width:auto !important;column-gap:normal !important;}';
  c+='body.scroll-mode .rr-end{display:block !important;height:var(--scroll-tail-space,100vh) !important;width:100% !important;margin:0 !important;padding:0 !important;border:0 !important;font-size:0 !important;line-height:0 !important;break-before:auto !important;-webkit-column-break-before:auto !important;}';
  c+='body.line-paged-mode #pager,body.line-paged-mode #scroller{overflow:hidden !important;}';
  c+='body.line-paged-mode .rr{height:auto !important;min-height:100vh !important;padding-top:0 !important;padding-bottom:0 !important;column-count:auto !important;column-width:auto !important;column-gap:normal !important;}';
  c+='body.line-paged-mode .rr-end{display:none !important;}';
  st.textContent=c;
}
function firstColumnLineRectsForHeight(): ReaderVisibleLineRect[]{
  if(!root)return [];
  const rr=root.getBoundingClientRect(),pl=pageLayout();
  const left=rr.left-2,right=rr.left+pl.colW+2;
  let out: ReaderVisibleLineRect[]=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    const range=document.createRange();
    try{range.selectNodeContents(node);}catch(e){continue;}
    const rects=range.getClientRects();
    for(let i=0;i<rects.length;i++){
      const r=rects.item(i);if(!r)continue;
      if(r.width<1||r.height<3)continue;
      if(r.right<left||r.left>right)continue;
      out.push({top:r.top,bottom:r.bottom,height:r.height});
    }
  }
  out.sort(function(a,b){return a.top-b.top||a.bottom-b.bottom;});
  const merged: ReaderVisibleLineRect[]=[];
  for(let j=0;j<out.length;j++){
    const current=out[j];
    if(!current)continue;
    const last=merged[merged.length-1];
    if(last&&Math.abs(last.top-current.top)<2){
      last.bottom=Math.max(last.bottom,current.bottom);
      last.height=Math.max(last.height,current.height);
    }else merged.push(current);
  }
  return merged;
}
function calibratePagedBoxHeight(baseH: number): number{
  if(!root||isScrollMode())return baseH;
  const raw=viewportHeight();
  let h=Math.max(1,Math.min(raw,Math.floor(baseH||raw)));
  const minH=Math.max(1,mg(S.marginTop)+lineHeightPx()+mg(S.marginBottom));
  for(let pass=0;pass<4;pass++){
    root.style.height=h+'px';
    const rr=root.getBoundingClientRect();
    // 根元素本身并不裁剪内容。此前这里额外预留 2px，再把哪怕仍在可视
    // 范围内的末行判成“越界”，随后整行提前换栏，视觉上就留下了能放下一行
    // 字的大空白。只按真实页面底边判断；最多容忍 1px 的小数像素误差。
    const bottom=rr.top+h;
    const lines=firstColumnLineRectsForHeight();
    if(!lines.length)break;
    let bad=-1;
    for(let i=0;i<lines.length;i++){
      const candidate=lines[i];
      if(candidate&&candidate.bottom>bottom){bad=i;break;}
    }
    if(bad<0)break;
    const badLine=lines[bad];
    if(!badLine)break;
    if(badLine.bottom-bottom<=1)break;
    if(bad===0){h=Math.max(minH,Math.floor(h-lineHeightPx()));break;}
    const previousLine=lines[bad-1];
    if(!previousLine)break;
    let next=Math.floor(previousLine.bottom-rr.top+mg(S.marginBottom)+2);
    next=Math.max(minH,Math.min(h-1,next));
    if(next>=h-1)next=Math.max(minH,Math.floor(h-lineHeightPx()));
    if(Math.abs(next-h)<1)break;
    h=next;
  }
  return Math.max(1,Math.min(raw,Math.floor(h)));
}
function packedPagedBoxHeight(baseH: number): number{
  // 页底校准只用于避免最后一行被切半；若缩短过多，正文会被提前推到下一页，形成远大于一行的无意义留白；底部已有页边距，因此额外收缩最多补足一行行高。
  const raw=Math.max(1,Math.floor(baseH||viewportHeight()));
  const calibrated=calibratePagedBoxHeight(raw);
  const allowedTrim=Math.max(0,Math.floor(lineHeightPx())-mg(S.marginBottom));
  return Math.max(raw-allowedTrim,calibrated);
}
// 分栏的软换页会把“上一段的段后间距 + 下一段完整行”一起计入可用高度。
// 这会造成页面明明还看得出一行空间，却因为默认的 .6em 段间距把下一段整体
// 推走。仅压缩正好跨栏的一处段后间距，保留至少能放入完整下一行的空间；
// 正文中部、滚动模式、标题和脚注的间距一律不动。
function tightenPagedParagraphTails(){
  if(!root||isScrollMode()||fastChapterLayout)return;
  const stats={cross:0,fit:0,tightened:0};
  root.__rrPageTailTightStats=stats;
  const all=root.querySelectorAll<HTMLParagraphElement>('p.rr-page-tail-tight');
  for(let clear=0;clear<all.length;clear++){const clearParagraph=all.item(clear);clearParagraph.classList.remove('rr-page-tail-tight');clearParagraph.style.removeProperty('--rr-page-tail-gap');}
  const paragraphs=Array.from(root.querySelectorAll<HTMLParagraphElement>('p')).filter(function(p){return !p.closest('li,blockquote,table,.rr-note-list,.duokan-footnote-content');});
  if(paragraphs.length<2)return;
  const rootBox=root.getBoundingClientRect(),height=Math.max(1,rootBox.height),step=Math.max(1,pageLayout().pageStep),line=Math.max(1,lineHeightPx()),range=document.createRange();
  function bounds(p: HTMLParagraphElement): {first:{page:number;top:number;bottom:number;height:number};last:{page:number;top:number;bottom:number;height:number}}|null{
    let first: {page:number;top:number;bottom:number;height:number}|null=null,last: {page:number;top:number;bottom:number;height:number}|null=null;
    try{range.selectNodeContents(p);}catch(_){return null;}
    const rects=range.getClientRects();
    for(let rIndex=0;rIndex<rects.length;rIndex++){
      const r=rects.item(rIndex);if(!r||r.width<1||r.height<3)continue;
      const page=Math.floor((r.left-rootBox.left+1)/step),item={page:page,top:r.top-rootBox.top,bottom:r.bottom-rootBox.top,height:r.height};
      if(!first||item.page<first.page||(item.page===first.page&&item.top<first.top))first=item;
      if(!last||item.page>last.page||(item.page===last.page&&item.bottom>last.bottom))last=item;
    }
    return first&&last?{first:first,last:last}:null;
  }
  for(let i=0;i<paragraphs.length-1;i++){
    const previous=paragraphs[i],next=paragraphs[i+1];
    if(!previous||!next)continue;
    const before=bounds(previous),after=bounds(next);
    if(!before||!after||after.first.page!==before.last.page+1)continue;
    stats.cross++;
    // Range 的 rect 是字形墨迹框（本书为 27px），不是完整的 38px 行盒。
    // 只用 visibleFree-line 会把字形下方那半截 leading 当作可用段间距，
    // 本例会保留 6px，恰好仍让下一整行越出页底。将末行之后的半个
    // leading 也预留出来；只要可视空间确实达到一行，便允许把这一处
    // 段后距收紧到 0，而不会影响普通段落的用户间距。
    const free=height-before.last.bottom,lineBoxTail=Math.max(0,Math.ceil((line-before.last.height)/2)),allowed=Math.max(0,Math.floor(free-line-lineBoxTail));
    const fontSize=parseFloat(getComputedStyle(root).fontSize)||0;
    const configured=Math.max(parseFloat(getComputedStyle(previous).marginBottom)||0,Math.max(0,Number(S.paraSpacing)||0)*fontSize);
    if(free+1>=line&&allowed+1<configured){stats.fit++;previous.classList.add('rr-page-tail-tight');previous.style.setProperty('--rr-page-tail-gap',allowed+'px');stats.tightened++;}
  }
}
function applyCols(){
  let vw=window.innerWidth, vh=viewportHeight(), pageH=pagedBoxHeight(), pl=pageLayout();
  const fastLargeChapter=fastChapterLayout&&!isScrollMode();
  document.body.classList.toggle('scroll-mode',isScrollMode());
  document.body.classList.toggle('line-paged-mode',false);
  if(pageMask&&!isScrollMode())pageMask.style.height='0px';
  if(!isScrollMode()){
    // 切回分页后滚动容器虽被隐藏，scrollTop 仍会保留。若不清空，下一次
    // 切回滚动模式会把旧的纵向偏移和新的锚点恢复叠加，表现为每切一次跳一页。
    const inactiveScrollPort=scrollPort();
    if(inactiveScrollPort)inactiveScrollPort.scrollTop=0;
    scrollProgrammaticTarget=null;
    scrollActiveSlice=null;
    clearVirtualPage();clearScrollPreview();
  }
  if(!isScrollMode()&&scroller){scroller.style.clipPath='none';scroller.style.setProperty("-webkit-clip-path",'none');}
  if(isLinePagedMode()){
pager.style.clipPath='none';pager.style.setProperty("-webkit-clip-path",'none');
pager.style.top=linePagedViewportTopGapPx()+'px';
pager.style.bottom=linePagedViewportBottomGapPx()+'px';
    pager.style.height='auto';
    root.style.position='relative';
    root.style.left='0';
    root.style.top='0';
    root.style.width='100%';
    root.style.height='auto';
    root.style.minHeight=vh+'px';
    root.style.columnWidth='auto';
    root.style.columnCount='auto';
    root.style.columnGap='normal';
    root.style.columnFill='auto';
    root.style.transform='none';
    // showChapter 会在最终页位确定前隐藏新章。WebKit 对隐藏正文给出的 Range
    // 几何不稳定，随后 rebuildVisibleScrollPagination() 本来就会恢复可见并
    // 强制重建；这里若仍扫描整章，不但结果会立刻作废，还让跨章多算一遍。
    if(root.style.visibility!=='hidden')buildScrollBreaks(true);
    return;
  }
  if(!isDualPage())dualStartColumn=0;
  if(isScrollMode()){
    // 横向 viewOffset 只属于整页分栏布局。由整页切到滚动时，锚点恢复会
    // 直接设置 scrollTop，不一定经过 setViewOffset()；若不在这里清零，
    // 下次切回整页时 anchorPage() 会把旧横向偏移再加一次，恰好向后跳一页。
    viewOffset=0;
    const sb=scrollPageBox();
    pager.style.top=sb.top+'px';
    pager.style.bottom=sb.bottom+'px';
    pager.style.left='0';
    pager.style.right='0';
    pager.style.clipPath='none';pager.style.setProperty("-webkit-clip-path",'none');
    pager.style.height='auto';
    if(scroller){scroller.style.top='0';scroller.style.bottom='0';scroller.style.left='0';scroller.style.right='0';}
    root.style.position='relative';
    root.style.left='0';
    root.style.top='0';
    root.style.width='100%';
    root.style.height='auto';
    const activeScrollPort=scrollPort();
    root.style.minHeight=Math.max(1,(activeScrollPort&&activeScrollPort.clientHeight)||sb.height)+'px';
    root.style.overflow='visible';
    root.style.setProperty('--scroll-tail-space',Math.max(1,Math.ceil((activeScrollPort&&activeScrollPort.clientHeight)||sb.height||vh))+'px');
    root.style.columnWidth='auto';
    root.style.columnCount='auto';
    root.style.columnGap='normal';
    root.style.transform='none';
    // 章节装载期间的隐藏态分页既不可复用也不可相信；只保留恢复可见后的
    // 单次稳定分页，避免章末进入下一章时重复扫描全部文本行。
    if(root.style.visibility!=='hidden')buildScrollBreaks();
    return;
  }
pager.style.top='0';
pager.style.bottom='0';
pager.style.left='0';
pager.style.right='0';
if(scroller){scroller.style.top='0';scroller.style.bottom='0';scroller.style.left='0';scroller.style.right='0';}
  pager.style.height='auto';
  root.style.minHeight='';
  root.style.height=pageH+'px';
  // 多栏布局应由浏览器按完整行盒换栏；不要裁剪 .rr 本身，否则 WKWebView
  // 字形超出行盒的部分会在页底被截成半个字。
  root.style.overflow='';
  root.style.position='absolute';
  root.style.top='0';
  root.style.columnFill='auto';
  if(isDualPage()){
    // 真实双页：正文是一个横向多列条带，当前 spread 只露出两栏。
    // root 从左外边距开始。中缝小于右边距时，下一组的第一栏会
    // 侵入视口 r-gap 个像素；裁切只去掉那段空白/下一栏，不会裁到右页。
    const trailingColumnLeak=Math.max(0,pl.r-pl.gap);
    const dualClip='inset(0 '+trailingColumnLeak+'px 0 0)';
    pager.style.clipPath=dualClip;pager.style.setProperty("-webkit-clip-path",dualClip);
    root.style.left=pl.l+'px';
    root.style.width=pl.colW+'px';
    root.style.columnWidth=pl.colW+'px';
    root.style.columnCount='auto';
    root.style.columnGap=pl.gap+'px';
  }else{
    pager.style.clipPath='none';pager.style.setProperty("-webkit-clip-path",'none');
    root.style.left='0';
    root.style.width=vw+'px';
    root.style.columnWidth=pl.colW+'px';
    root.style.columnCount='auto';
    root.style.columnGap=pl.gap+'px';
  }
  // WebView2 的多栏排版会自行把完整行移到下一栏，额外缩短根容器反而会
  // 无谓挤掉一整行（底部空白看起来还能容纳文字）。只有 macOS WebKit 仍需
  // 这套校准来规避它会把末行字形裁成半截的已知问题。
  if(!isModernEpubLayout()&&!fastLargeChapter&&IS_MAC_WEBKIT)pageH=packedPagedBoxHeight(pageH);
  root.style.height=pageH+'px';
  if(!isModernEpubLayout())tightenPagedParagraphTails();
  // rr-end 只在滚动模式中提供尾部空间；分页样式会隐藏它。
  // 页数计算必须以它是否真正参与当前分栏布局为准。
  pageStep=pl.pageStep;
  pagesInCh=fastLargeChapter?fastPagedPageCount(root):pagedPageCountFromContent(root);
  if(!fastLargeChapter)pagesInCh=trimTrailingBlankPagedViews(root,pagesInCh);
}
function setViewOffset(){
  if(isLinePagedMode()){
    viewOffset=0;
    scrollActiveSlice=null;
    if(pager){
pager.style.top=linePagedViewportTopGapPx()+'px';
pager.style.bottom=linePagedViewportBottomGapPx()+'px';
      buildScrollBreaks();
      const lpTop=scrollBreaks[Math.max(0,Math.min(pageInCh,scrollBreaks.length-1))]||0;
      scrollProgrammaticUntil=Date.now()+180;
      scrollProgrammaticTarget=Math.max(0,Math.min(scrollMaxTop(),lpTop));
      const linePort=scrollPort();if(linePort)linePort.scrollTop=scrollProgrammaticTarget;
      applyScrollPageMask();
    }
    if(root)root.style.transform='none';
    refreshHighlights();
    return;
  }
  if(isScrollMode()){
    viewOffset=0;
    scrollActiveSlice=null;
    if(pager){
      const sb=scrollPageBox();
      pager.style.top=sb.top+'px';
      pager.style.bottom=sb.bottom+'px';
      pager.style.left='0';
      pager.style.right='0';
      if(scroller){scroller.style.top='0';scroller.style.bottom='0';scroller.style.left='0';scroller.style.right='0';}
      buildScrollBreaks();
      const top=scrollBreaks[Math.max(0,Math.min(pageInCh,scrollBreaks.length-1))]||0;
      scrollProgrammaticUntil=Date.now()+180;
      scrollProgrammaticTarget=Math.max(0,Math.min(scrollMaxTop(),top));
      const pagePort=scrollPort();if(pagePort)pagePort.scrollTop=scrollProgrammaticTarget;
      applyScrollPageMask();
    }
    if(root)root.style.transform='none';
    refreshHighlights();
    return;
  }
  viewOffset=pageInCh*pageStep+(isDualPage()?dualStartColumn*pageLayout().colPitch:0);
  if(pager)pager.scrollLeft=0;
  if(root)root.style.transform='translateX(-'+viewOffset+'px)';
  refreshHighlights();
}
let readerViewPaintGeneration=0,readerViewPaintFrame=0,readerViewPaintTimer: ReturnType<typeof setTimeout>|0=0;
function stabilizeProgrammaticViewPaint(){
  const generation=++readerViewPaintGeneration;
  if(readerViewPaintFrame){cancelAnimationFrame(readerViewPaintFrame);readerViewPaintFrame=0;}
  if(readerViewPaintTimer){clearTimeout(readerViewPaintTimer);readerViewPaintTimer=0;}
  readerViewPaintFrame=requestAnimationFrame(function(){requestAnimationFrame(function(){
    readerViewPaintFrame=0;
    if(generation!==readerViewPaintGeneration||!root||!pager)return;
    const pendingContinuous=typeof hasPendingContinuousPagedImageSource==='function'&&hasPendingContinuousPagedImageSource();
    if(usesLineBreakPaging()){
      // macOS WebKit 偶尔在程序化 scrollTop 后沿用上一页的虚拟图层；轻微
      // 滚动之所以能恢复，是 scroll 事件强制重画了遮罩。这里在新页首帧
      // 主动完成同一次稳定重画，图片与其后的正文无需再由用户滑动唤醒。
      settleVisibleScrollPagination();
      applyScrollPageMask(true);
      // Chromium 的字体回退/合成层有时会在首帧之后才更新行框；再次读取两次
      // 只会裁掉上下不完整行，不改页码或滚动位置，因此不会让延迟重排露出残字。
      let settlePass=0;
      const settleScrollPageMask=function(){
        readerViewPaintTimer=0;
        if(generation!==readerViewPaintGeneration||!usesLineBreakPaging()||!root||!pager)return;
        settleVisibleScrollPagination();
        applyScrollPageMask(true);
        refreshHighlights();
        if(++settlePass<2)readerViewPaintTimer=setTimeout(settleScrollPageMask,260);
      };
      readerViewPaintTimer=setTimeout(settleScrollPageMask,120);
    }else{
      // 多栏 transform 的新可视列包含大图时，WebKit 可能只提交上一合成层。
      // 读取几何并重写同一 transform，不改变页码或布局，只提交当前列。
      void root.offsetWidth;
      root.style.transform='translateX(-'+viewOffset+'px)';
    }
    // 连续图片已在 setViewOffset() 中完成裁切；这里再次计算会把已经裁过的
    // 高度当作原高。只提交合成层，不重复改变图片几何。
    if(!pendingContinuous&&typeof refreshPagedImagePreview==='function')refreshPagedImagePreview();
    refreshHighlights();
  });});
}
function rebuildVisibleScrollPagination(): void{
  if(!usesLineBreakPaging()||!root)return;
  // WebKit 对 visibility:hidden 的章节不会稳定提供 Range/文本行几何。
  // 若在隐藏状态建立分页缓存，长章节会被固化成 1 页，下一次点击直接跨章；
  // 首个虚拟页也可能只收集到标题。当前回调会在同一帧内继续定位并完成绘制，
  // 因此先恢复可见性再重建，不会把尚未定位的中间状态提交到屏幕。
  root.style.visibility='';
  scrollBreakSig='';
  invalidateScrollItemsCache();
  buildScrollBreaks(true);
}
function settleVisibleScrollPagination(): void{
  if(IS_MAC_WEBKIT||!usesLineBreakPaging()||!root)return;
  // Chromium may defer the final text run until immediately after scrollTop is
  // assigned.  Force that layout before accepting the page boundary, then build
  // the current chapter's page table from those final line boxes.  Otherwise a
  // line can first leave a blank tail, appear later, and still be repeated at
  // the next page's old start.
  void root.offsetHeight;
  rebuildVisibleScrollPagination();
  const port=scrollPort();if(!port)return;
  const top=Math.round(port.scrollTop||0);
  const index=pageIndexForScrollTop(top);
  pageInCh=Math.max(0,Math.min(pagesInCh-1,index));
  scrollActiveSlice=scrollPages[pageInCh]||null;
  scrollProgrammaticTarget=top;
}
function scrollMaxTop(){
  if(!pager)return 0;
  const port=scrollPort(),h=Math.max(root?root.scrollHeight:0,(port&&port.scrollHeight)||0);
  return Math.max(0,h-((port&&port.clientHeight)||window.innerHeight||1));
}
function scrollContentEndTop(){
  if(!pager)return 0;
  const safeH=Math.max(1,scrollVisualHeight());
  const port=scrollPort(),h=Math.max(root?root.scrollHeight:0,(port&&port.scrollHeight)||0);
  return Math.max(0,Math.min(scrollMaxTop(),h-safeH));
}
function atScrollEnd(){
  const sp=scrollPort();return !!(sp&&sp.scrollTop>=scrollContentEndTop()-2);
}
function atScrollStart(){
  const sp=scrollPort();return !!(sp&&sp.scrollTop<=2);
}
function lineHeightPx(){
  const cs=root?getComputedStyle(root):null;
  let lh=cs?parseFloat(cs.lineHeight):0;
  if(!lh||isNaN(lh)){
    const fs=cs?parseFloat(cs.fontSize):0;
    lh=fs?fs*1.5:28;
  }
  return Math.max(12,lh);
}
function visibleTextLineRects(extraTop = 0,extraBottom = 0): ReaderVisibleLineRect[]{
  if(!root||!pager)return [];
  extraTop=extraTop||0;
  extraBottom=extraBottom||0;
  const pr=viewRect();
  let out: ReaderVisibleLineRect[]=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    const text=node.nodeValue||'';
    if(!text.trim())continue;
    const range=document.createRange();
    try{range.selectNodeContents(node);}catch(e){continue;}
    const rects=range.getClientRects();
    for(let i=0;i<rects.length;i++){
      const r=rects.item(i);if(!r)continue;
      if(r.width<1||r.height<3)continue;
      if(r.bottom<pr.top-extraTop-2||r.top>pr.bottom+extraBottom+2)continue;
      out.push({top:r.top,bottom:r.bottom,height:r.height});
    }
  }
  out.sort(function(a,b){return a.top-b.top||a.bottom-b.bottom;});
  const merged: ReaderVisibleLineRect[]=[];
  for(let j=0;j<out.length;j++){
    const current=out[j];if(!current)continue;
    const last=merged[merged.length-1];
    if(last&&Math.abs(last.top-current.top)<2){
      last.bottom=Math.max(last.bottom,current.bottom);
      last.height=Math.max(last.height,current.height);
    }else merged.push(current);
  }
  return merged;
}
function hasClippedTextAtBottom(){
  if(!pager)return false;
  const pr=viewRect();
  const safeBottom=pr.bottom-scrollBottomMaskPx();
  const lines=visibleTextLineRects();
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line&&line.bottom>safeBottom-2&&line.top<safeBottom-2)return true;
  }
  return false;
}
function transparentCssColor(v: string): boolean{
  return !v||v==='transparent'||/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(v);
}
function computedLineStyleForNode(node: Text,cache: WeakMap<Element, ReaderComputedLineStyle>): ReaderComputedLineStyle | null{
  const el=node&&node.parentElement;
  if(!el)return null;
  const cached=cache.get(el);if(cached)return cached;
  const cs=window.getComputedStyle(el);
  const style: ReaderComputedLineStyle={
    color:cs.color,
    fontFamily:cs.fontFamily,
    fontSize:cs.fontSize,
    fontWeight:cs.fontWeight,
    fontStyle:cs.fontStyle,
    fontVariant:cs.fontVariant,
    lineHeight:cs.lineHeight,
    letterSpacing:cs.letterSpacing,
    wordSpacing:cs.wordSpacing,
    textDecoration:cs.textDecoration,
    textTransform:cs.textTransform
  };
  if(!transparentCssColor(cs.backgroundColor))style.backgroundColor=cs.backgroundColor;
  if(cache)cache.set(el,style);
  return style;
}
function computedLineStyleForElement(el: Element|null,cache: WeakMap<Element, ReaderComputedLineStyle>): ReaderComputedLineStyle | null{
  if(!el)return null;
  const cached=cache.get(el);if(cached)return cached;
  const cs=window.getComputedStyle(el);
  const style: ReaderComputedLineStyle={
    color:cs.color,
    fontFamily:cs.fontFamily,
    fontSize:cs.fontSize,
    fontWeight:cs.fontWeight,
    fontStyle:cs.fontStyle,
    fontVariant:cs.fontVariant,
    lineHeight:cs.lineHeight,
    letterSpacing:cs.letterSpacing,
    wordSpacing:cs.wordSpacing,
    textDecoration:cs.textDecoration,
    textTransform:cs.textTransform,
    textAlign:cs.textAlign
  };
  if(!transparentCssColor(cs.backgroundColor))style.backgroundColor=cs.backgroundColor;
  if(cache)cache.set(el,style);
  return style;
}
function sameLineKey(a: number,b: number): boolean{
  return Math.abs(a-b)<2;
}
function closestInlineNoteElement(node: Node): Element | null{
  const el: Element|null=node instanceof Element?node:node.parentElement;
  if(!el||!root)return null;
  try{
    let hit=el.closest('a,sup,sub,span');
    while(hit&&root.contains(hit)){
      const tag=(hit.tagName||'').toLowerCase();
      if(tag==='a'&&isNoteLink(hit))return hit;
      const noteA=hit.querySelector&&hit.querySelector('a[data-rr-note-ref="1"],a.rr-note-ref');
      if(noteA)return noteA;
      if(tag==='sup'||tag==='sub'){const nestedAnchor=hit.querySelector('a');if(nestedAnchor&&isNoteLink(nestedAnchor))return nestedAnchor;}
      const meta=((hit.id||'')+' '+(hit.className||'')+' '+(hit.getAttribute&&hit.getAttribute('epub:type')||'')+' '+(hit.getAttribute&&hit.getAttribute('role')||'')).toLowerCase();
      if(/noteref|annoref|footnote|endnote/.test(meta))return hit;
      hit=hit.parentElement?hit.parentElement.closest('a,sup,sub,span'):null;
    }
  }catch(_){}
  return null;
}
function appendMeasuredCharLine(linesByKey: Record<string,ReaderLineRect>,keys: number[],node: Text,ch: string,r: DOMRect,pr: DOMRect,scrollTop: number,style: ReaderComputedLineStyle|null,docIndex: number): void{
  if(!ch)return;
  const top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop,left=r.left-pr.left,right=r.right-pr.left;
  if(!isFinite(top)||!isFinite(bottom)||bottom-top<3)return;
  let key=null;
  for(let i=0;i<keys.length;i++){const existingKey=keys[i];if(existingKey!==undefined&&sameLineKey(existingKey,top)){key=existingKey;break;}}
  if(key==null){key=top;keys.push(key);linesByKey[key]={top:top,bottom:bottom,height:bottom-top,left:left,right:right,fragments:[]};}
  const line=recordValue(linesByKey,key);
  line.top=Math.min(line.top,top);line.bottom=Math.max(line.bottom,bottom);line.height=Math.max(line.height,bottom-top);line.left=Math.min(line.left,left);line.right=Math.max(line.right,right);
  const frags=line.fragments,last=frags[frags.length-1];
  if(last&&last.node===node&&Math.abs(last.top-top)<2&&Math.abs(last.right-left)<3){
    last.text+=ch;last.right=Math.max(last.right,right);last.width=Math.max(1,last.right-last.left);last.bottom=Math.max(last.bottom,bottom);last.height=Math.max(last.height,bottom-last.top);last.end=Math.max(last.end??docIndex,docIndex+1);
  }else{
    frags.push({node:node,text:ch,left:left,right:right,top:top,bottom:bottom,width:Math.max(1,right-left),height:bottom-top,style:style,start:docIndex,end:docIndex+1});
  }
}
function appendMeasuredTextRangeLine(linesByKey: Record<string,ReaderLineRect>,keys: number[],node: Text,text: string,r: DOMRect,pr: DOMRect,scrollTop: number,style: ReaderComputedLineStyle|null,start: number,end: number): void{
  if(!text||end<=start)return;
  const top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop,left=r.left-pr.left,right=r.right-pr.left;
  if(!isFinite(top)||!isFinite(bottom)||bottom-top<3)return;
  let key=null;
  for(let i=0;i<keys.length;i++){const existingKey=keys[i];if(existingKey!==undefined&&sameLineKey(existingKey,top)){key=existingKey;break;}}
  if(key==null){key=top;keys.push(key);linesByKey[key]={top:top,bottom:bottom,height:bottom-top,left:left,right:right,fragments:[]};}
  const line=recordValue(linesByKey,key);
  line.top=Math.min(line.top,top);line.bottom=Math.max(line.bottom,bottom);line.height=Math.max(line.height,bottom-top);line.left=Math.min(line.left,left);line.right=Math.max(line.right,right);
  line.fragments.push({node:node,text:text,left:left,right:right,top:top,bottom:bottom,width:Math.max(1,right-left),height:bottom-top,style:style,start:start,end:end});
}
function appendMeasuredInlineLine(linesByKey: Record<string,ReaderLineRect>,keys: number[],el: Element,r: DOMRect,pr: DOMRect,scrollTop: number,kind: "inline"|"note-number" = "inline",style?: ReaderComputedLineStyle|null,text = ""): void{
  if(!el||!r||r.width<1||r.height<3)return;
  const top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop,left=r.left-pr.left,right=r.right-pr.left;
  let key=null,bestOverlap=0,center=(top+bottom)/2,created=false;
  for(let i=0;i<keys.length;i++){
    const candidateKey=keys[i];if(candidateKey===undefined)continue;
    const cand=recordValue(linesByKey,candidateKey),over=Math.min(bottom,cand.bottom)-Math.max(top,cand.top);
    if(over>bestOverlap&&over>Math.min(bottom-top,cand.height)*0.18){bestOverlap=over;key=candidateKey;}
    else if(key==null&&center>=cand.top-Math.max(2,cand.height*.35)&&center<=cand.bottom+Math.max(2,cand.height*.35)){key=candidateKey;}
  }
  if(key==null){key=top;keys.push(key);linesByKey[key]={top:top,bottom:bottom,height:bottom-top,left:left,right:right,fragments:[]};created=true;}
  const line=recordValue(linesByKey,key),frags=line.fragments;
  if(created){
    line.top=Math.min(line.top,top);line.bottom=Math.max(line.bottom,bottom);line.height=Math.max(line.height,bottom-top);
  }
  line.left=Math.min(line.left,left);line.right=Math.max(line.right,right);
  frags.push({kind:kind||'inline',el:el,text:text||'',left:left,right:right,top:top,bottom:bottom,width:Math.max(1,right-left),height:bottom-top,style:style||null});
}
function fastDocumentTextLineRects(){
  if(!root||!pager)return [];
  const pr=viewRect(),sp=scrollPort(),scrollTop=sp?sp.scrollTop||0:0;
  let out: ReaderLineRect[]=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node: Node|null,range=document.createRange(),docPos=0;
  fastTextNodeOffsets=new WeakMap<Text,number>();
  while((node=walker.nextNode())){
    if(!(node instanceof Text))continue;
    const text=node.nodeValue||'',parent=node.parentElement;
    if(!parent||generatedTextNode(node)||closestInlineNoteElement(node))continue;
    fastTextNodeOffsets.set(node,docPos);docPos+=text.length;
    if(!text.trim())continue;
    const pcs=window.getComputedStyle(parent);
    if(pcs.display==='none'||pcs.visibility==='hidden')continue;
    // WKWebView 对一个很长的纯文本节点偶尔只返回一个跨越整章的矩形。它会
    // 让滚动分页器把整章当作一行，从而错误显示“本章 1/1 页”。先按节点
    // 测量以保持大章节性能；检测到退化矩形时再把该节点分段测量。
    const textLength=text.length;
    let rects: DOMRectList|DOMRect[]=[];
    try{range.selectNodeContents(node);rects=range.getClientRects();}catch(_){continue;}
    if(fastTextRangeNeedsChunks(rects)){
      for(let start=0;start<textLength;start+=192){
        appendFastTextRangeLines(out,node,range,start,Math.min(textLength,start+192),pr,scrollTop);
      }
    }else{
      appendFastRangeRects(out,node,rects,pr,scrollTop);
    }
  }
  out.sort(function(a,b){return a.top-b.top||a.left-b.left;});
  const merged: ReaderLineRect[]=[];
  for(let j=0;j<out.length;j++){
    const last=merged[merged.length-1],cur=out[j];
    if(!cur)continue;
    if(last&&Math.abs(last.top-cur.top)<2){
      last.top=Math.min(last.top,cur.top);last.bottom=Math.max(last.bottom,cur.bottom);last.height=Math.max(last.height,cur.height);last.left=Math.min(last.left,cur.left);last.right=Math.max(last.right,cur.right);
      if(cur.flowNodes&&cur.flowNodes.length){
        if(!last.flowNodes)last.flowNodes=[];
        for(let ni=0;ni<cur.flowNodes.length;ni++){const flowNode=cur.flowNodes[ni];if(flowNode&&last.flowNodes.indexOf(flowNode)<0)last.flowNodes.push(flowNode);}
      }
    }else merged.push(cur);
  }
  return merged;
}
function documentTextLineRects(){
  if(!root||!pager)return [];
  if(fastChapterLayout)return fastDocumentTextLineRects();
  const pr=viewRect(),sp=scrollPort(),scrollTop=sp?sp.scrollTop||0:0;
  const linesByKey: Record<string,ReaderLineRect>={},keys: number[]=[],styleCache=new WeakMap<Element,ReaderComputedLineStyle>();
  let walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node: Node|null,range=document.createRange(),docPos=0;
  while((node=walker.nextNode())){
    if(!(node instanceof Text))continue;
    const text=node.nodeValue||'';
    const parent=node.parentElement;
    if(!parent)continue;
    if(generatedTextNode(node))continue;
    if(closestInlineNoteElement(node))continue;
    const nodeStart=docPos;docPos+=text.length;
    if(!text.trim())continue;
    const pcs=window.getComputedStyle(parent);
    if(pcs.display==='none'||pcs.visibility==='hidden')continue;
    const style=computedLineStyleForNode(node,styleCache);
    for(let i=0;i<text.length;i++){
      const ch=text.charAt(i);
      if(ch==='\r'||ch==='\n'||ch==='\t')continue;
      try{range.setStart(node,i);range.setEnd(node,i+1);}catch(e){continue;}
      const rects=range.getClientRects();
      if(!rects||!rects.length)continue;
      const r=primaryCharacterRect(rects);
      if(!r||r.width<0.1&&!ch.trim())continue;
      appendMeasuredCharLine(linesByKey,keys,node,ch,r,pr,scrollTop,style,nodeStart+i);
    }
  }
  const noteEls=root.querySelectorAll<Element>('.rr-note-ref,a,sup,sub,span'),seenNotes=new WeakSet<Element>();
  for(let ne=0;ne<noteEls.length;ne++){
    const nel=noteEls.item(ne);
    const noteEl=closestInlineNoteElement(nel);
    if(!noteEl||seenNotes.has(noteEl))continue;
    seenNotes.add(noteEl);
    const ncs=window.getComputedStyle(noteEl);
    if(ncs.display==='none'||ncs.visibility==='hidden')continue;
    let nr=null;
    try{nr=noteEl.getBoundingClientRect();}catch(_){nr=null;}
    if(!nr||nr.width<1||nr.height<3)continue;
    appendMeasuredInlineLine(linesByKey,keys,noteEl,nr,pr,scrollTop);
  }
  const numEls=root.querySelectorAll<Element>('.rr-note-num');
  for(let nn=0;nn<numEls.length;nn++){
    const numEl=numEls.item(nn);
    const nns=window.getComputedStyle(numEl);
    if(nns.display==='none'||nns.visibility==='hidden')continue;
    let nr2=null;
    try{nr2=numEl.getBoundingClientRect();}catch(_){nr2=null;}
    if(!nr2||nr2.width<1||nr2.height<3)continue;
    appendMeasuredInlineLine(linesByKey,keys,numEl,nr2,pr,scrollTop,'note-number',computedLineStyleForElement(numEl,styleCache),(numEl.textContent||'').trim());
  }
  const out=keys.map(function(k: number){return recordValue(linesByKey,k);}).sort(function(a: ReaderLineRect,b: ReaderLineRect){return a.top-b.top||a.left-b.left;});
  for(let j=0;j<out.length;j++){
    arrayValue(out,j).fragments.sort(function(a,b){return a.top-b.top||a.left-b.left;});
  }
  return out;
}
function documentFlowItems(): ReaderPageFlowItem[]{
  if(!root||!pager)return [];
  const items: ReaderPageFlowItem[]=filterTextLines(documentTextLineRects()).map(function(x: ReaderLineRect){
    return {top:x.top,bottom:x.bottom,height:x.height,type:'line' as const,atomic:false};
  });
  const pr=viewRect(),sp=scrollPort(),scrollTop=sp?sp.scrollTop||0:0;
  const blockSel='figure,img,svg,canvas,table,video,pre,blockquote';
  const els=root.querySelectorAll<Element>(blockSel);
  for(let i=0;i<els.length;i++){
    const el=els.item(i);
    if(el.classList&&el.classList.contains('rr-end'))continue;
    const parentBlock=el.parentElement?el.parentElement.closest(blockSel):null;
    if(parentBlock&&parentBlock!==el&&root.contains(parentBlock))continue;
    let r=null;
    try{r=el.getBoundingClientRect();}catch(e){r=null;}
    if(!r||r.width<2||r.height<4)continue;
    const top=r.top-pr.top+scrollTop;
    const bottom=r.bottom-pr.top+scrollTop;
    const tag=(el.tagName||'').toLowerCase();
    items.push({top:top,bottom:bottom,height:bottom-top,type:'block',atomic:true,tag:tag,preview:/^(figure|img|svg|canvas|video)$/.test(tag),el:el,left:r.left-pr.left,width:r.width});
  }
  items.sort(function(a: ReaderPageFlowItem,b: ReaderPageFlowItem){return a.top-b.top||a.bottom-b.bottom||(a.type==='block'?-1:1);});
  const clean: ReaderPageFlowItem[]=[];
  for(let j=0;j<items.length;j++){
    const it=items[j];
    if(!it)continue;
    if(it.height<3)continue;
    const last=clean[clean.length-1];
    if(last&&it.type===last.type&&Math.abs(it.top-last.top)<2&&Math.abs(it.bottom-last.bottom)<2)continue;
    clean.push(it);
  }
  return clean;
}
function nextFlowItemAfter(items: readonly ReaderPageFlowItem[],y: number): ReaderPageFlowItem | null{
  for(let i=0;i<items.length;i++){const item=items[i];if(item&&item.top>y+2)return item;}
  return null;
}
function firstAtomicBlockCrossing(items: readonly ReaderPageFlowItem[],top: number,bottom: number,usableH: number): ReaderPageFlowItem | null{
  for(let i=0;i<items.length;i++){
    const it=items[i];
    if(!it)continue;
    if(it.type!=='block'||!it.atomic)continue;
    if(it.height>usableH)continue;
    if(it.top>=top-2&&it.top<bottom-2&&it.bottom>bottom)return it;
  }
  return null;
}
function scrollPageItems(): ReaderPageFlowItem[]{
  if(!root||!pager)return [];
  const sp=scrollPort();
  const cacheSig=[curCh,layoutSig(),root.scrollHeight||0,sp?sp.clientWidth:0,sp?sp.clientHeight:0,root.querySelectorAll('figure,img,svg,canvas,table,video').length].join('|');
  if(cacheSig&&cacheSig===scrollItemsSig)return scrollItemsCache;
  const lines: ReaderPageFlowItem[]=filterTextLines(documentTextLineRects()).map(function(x: ReaderLineRect,idx: number){
    return {top:x.top,bottom:x.bottom,height:x.height,type:'line' as const,atomic:false,index:idx,left:x.left,right:x.right,fragments:x.fragments||[],flowNodes:x.flowNodes||[]};
  });
  const items=lines.slice();
  const pr=viewRect(),scrollTop=sp?sp.scrollTop||0:0;
  const els=root.querySelectorAll<Element>('figure,img,svg,canvas,table,video');
  function isInlineAuxiliaryImage(el: Element|null): boolean{
    if(!el||String(el.tagName||'').toLowerCase()!=='img')return false;
    if(el.classList&&el.classList.contains('duokan-footnote'))return true;
    return !!(el.closest&&el.closest('.rr-note-ref,.rr-note-wrap,.duokan-footnote,sup a,li.duokan-footnote-item'));
  }
  function overlapsText(top: number,bottom: number): boolean{
    for(let i=0;i<lines.length;i++){
      const ln=lines[i];
      if(!ln)continue;
      if(ln.bottom<top+2)continue;
      if(ln.top>bottom-2)break;
      const overlap=Math.min(bottom,ln.bottom)-Math.max(top,ln.top);
      if(overlap>Math.min(ln.height,bottom-top)*0.35)return true;
    }
    return false;
  }
  function linePrecedesElement(line: ReaderPageFlowItem,el: Element): boolean{
    if(!line||!el)return false;
    let nodes: Node[]=[];
    if(line.flowNodes&&line.flowNodes.length)nodes=nodes.concat(line.flowNodes);
    if(line.fragments&&line.fragments.length){
      for(let fi=0;fi<line.fragments.length;fi++){
        const fragment=line.fragments[fi],fragmentNode=fragment&&fragment.node;
        if(fragmentNode&&nodes.indexOf(fragmentNode)<0)nodes.push(fragmentNode);
      }
    }
    for(let ni=0;ni<nodes.length;ni++){
      const node=nodes[ni];
      if(!node||node===el||(el.contains&&el.contains(node)))continue;
      try{
        if(node.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)return true;
      }catch(_){}
    }
    return false;
  }
  for(let i=0;i<els.length;i++){
    const el=els.item(i);
    if(el.classList&&el.classList.contains('rr-end'))continue;
    const parentBlock=el.parentElement?el.parentElement.closest('figure,img,svg,canvas,table,video'):null;
    if(parentBlock&&parentBlock!==el&&root.contains(parentBlock))continue;
    let r=null;
    try{r=el.getBoundingClientRect();}catch(e){r=null;}
    if(!r||r.width<2||r.height<4)continue;
    let top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop;
    const tag=(el.tagName||'').toLowerCase();
    // 有些 EPUB 把正文插图和图注放进同一个 <p>（如 img00 + <br> 图注）。
    // 图注的行框会与图片矩形相交，旧逻辑因此把图片当成“与正文重叠”而丢弃；
    // 这样分页器无法在图前断页。正文图片必须保留为原子块，只有脚注小图标例外。
    if(overlapsText(top,bottom)&&!(tag==='img'&&!isInlineAuxiliaryImage(el)))continue;
    // 图片的几何矩形可能被 WebView2 提前到上一段的最后几行（典型结构是
    // <p class="img00"><img><br>图注</p>）。分页顺序必须以 DOM 文档顺序
    // 为准：图片不能早于它前面的正文文本。把图片的有效起点推到所有前置
    // 文本行之后，分页器便会先把剩余正文排完，再决定本页是否还有空间预览图。
    if(tag==='img'&&!isInlineAuxiliaryImage(el)){
      let flowFloor=0;
      for(let li=0;li<lines.length;li++){
        const precedingLine=lines[li];
        if(precedingLine&&linePrecedesElement(precedingLine,el))flowFloor=Math.max(flowFloor,precedingLine.bottom||0);
      }
      if(flowFloor>top+0.5){
        const originalHeight=Math.max(1,bottom-top);
        top=flowFloor+Math.max(2,Math.ceil(lineHeightPx()*0.12));
        bottom=top+originalHeight;
      }
    }
    let src=previewSourceElement(el),sr=null;
    try{if(src)sr=src.getBoundingClientRect();}catch(_){sr=null;}
    const renderLeft=sr&&sr.width>2?sr.left-pr.left:r.left-pr.left;
    const renderTopOffset=sr&&sr.height>2?Math.max(0,sr.top-r.top):0;
    const renderWidth=sr&&sr.width>2?sr.width:r.width;
    const renderHeight=sr&&sr.height>2?sr.height:r.height;
    items.push({top:top,bottom:bottom,height:bottom-top,type:'block',atomic:true,tag:tag,preview:/^(figure|img|svg|canvas|video)$/.test(tag),el:el,left:r.left-pr.left,width:r.width,renderLeft:renderLeft,renderTopOffset:renderTopOffset,renderWidth:renderWidth,renderHeight:renderHeight});
  }
  items.sort(function(a: ReaderPageFlowItem,b: ReaderPageFlowItem){return a.top-b.top||a.bottom-b.bottom||(a.type==='block'?-1:1);});
  const clean: ReaderPageFlowItem[]=[];
  for(let j=0;j<items.length;j++){
    const it=items[j];
    if(!it)continue;
    if(it.height<3)continue;
    const last=clean[clean.length-1];
    if(last&&Math.abs(it.top-last.top)<2&&Math.abs(it.bottom-last.bottom)<2)continue;
    clean.push(it);
  }
  scrollItemsSig=cacheSig;
  scrollItemsCache=clean;
  return clean;
}
function isPreviewableBlock(it: ReaderPageFlowItem | null): boolean{
  if(!it||it.type!=='block')return false;
  return /^(figure|img|svg|canvas|video)$/.test(it.tag||'');
}
function pageBottomForSlice(pageTop: number,viewH: number,_endItem: ReaderPageFlowItem|null,nextItem: ReaderPageFlowItem|null,_bottomGuard: number): number{
  return ReaderPageScrollRules.pageBottomForSlice(pageTop,viewH,nextItem);
}
function firstUnfinishedScrollItemIndex(items: readonly ReaderPageFlowItem[],startIdx: number,bottom: number): number{
  return ReaderPageScrollRules.firstUnfinishedItemIndex(items,startIdx,bottom);
}
function scrollLineTopAtOrBefore(lines: readonly ReaderLineLike[],target: number,maxTop: number): number{
  target=Math.max(0,Math.min(maxTop,target||0));
  let best=0;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(!line)continue;
    const top=Math.max(0,Math.min(maxTop,Math.round(line.top||0)));
    if(top<=target+1)best=top;else break;
  }
  return best;
}
function readableScrollEndTop(lines: readonly ReaderLineRect[]): number{
  if(!pager)return 0;
  const safeH=scrollVisualHeight();
  const topPad=lineBreakTopPadPx();
  const last=lines&&lines.length?lines[lines.length-1]:null;
  const byLine=last?Math.max(0,last.bottom-safeH+topPad+Math.max(2,lineHeightPx()*0.12)):scrollContentEndTop();
  return Math.max(0,Math.min(scrollMaxTop(),byLine));
}
function readableNavMaxTop(lines: readonly ReaderLineLike[],maxTop: number): number{
  maxTop=Math.max(0,maxTop||0);
  if(!lines||!lines.length)return maxTop;
  const last=lines[lines.length-1];
  return scrollLineTopAtOrBefore(lines,last?Math.round(last.top||0):0,maxTop);
}
function scrollPageTopForStartItem(items: readonly ReaderPageFlowItem[],startIdx: number,navMaxTop: number,topPad: number): number{
  return ReaderPageScrollRules.pageTopForStartItem(items,startIdx,navMaxTop,topPad);
}
function scrollAlignedPageStart(items: readonly ReaderPageFlowItem[],startIdx: number,navMaxTop: number,topPad: number): ReaderAlignedScrollStart{
  return ReaderPageScrollRules.alignedPageStart(items,startIdx,navMaxTop,topPad);
}
function nearestScrollBreakIndex(top: number): number{
  return ReaderPageScrollRules.nearestBreakIndex(scrollBreaks,top);
}
function pageIndexForScrollTop(top: number): number{
  return ReaderPageScrollRules.pageIndexForTop(scrollBreaks,top,2);
}
function snapScrollTopToBreak(target: number): ReaderScrollNav{
  buildScrollBreaks(false);
  if(!scrollBreaks.length)return {top:0,index:0};
  target=Math.max(0,Math.min(scrollMaxTop(),Math.round(target||0)));
  const idx=pageIndexForScrollTop(target);
  const top=Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[idx]||0));
  return {top:top,index:idx};
}
function currentScrollPageIndexForNav(top: number): number{
  buildScrollBreaks(false);
  if(!scrollBreaks.length)return 0;
  top=Math.max(0,Math.min(scrollMaxTop(),Math.round(top||0)));
  const eps=Math.max(3,Math.ceil(lineHeightPx()*0.20));
  const idx=pageIndexForScrollTop(top);
  if(idx<scrollBreaks.length-1&&Math.abs((scrollBreaks[idx+1]||0)-top)<=eps)return idx+1;
  if(Math.abs((scrollBreaks[idx]||0)-top)<=eps)return idx;
  return idx;
}
function scrollBreakForNav(top: number,dir: ReaderDirection): ReaderScrollNav|null{
  if(!scrollBreaks.length)buildScrollBreaks(false);
  if(!scrollBreaks.length)return null;
  const idx=currentScrollPageIndexForNav(top);
  const eps=Math.max(3,Math.ceil(lineHeightPx()*0.20));
  if(dir>0){
    for(let i=idx+1;i<scrollBreaks.length;i++){
      if((scrollBreaks[i]||0)>top+eps)return {index:i,top:scrollBreaks[i]||0};
    }
    return null;
  }
  if(Math.abs((scrollBreaks[idx]||0)-top)>eps){
    return {index:idx,top:scrollBreaks[idx]||0};
  }
  if(idx>0)return {index:idx-1,top:scrollBreaks[idx-1]||0};
  return null;
}
function scrollSliceFromCanonicalBreak(nav: ReaderScrollNav|null): ReaderScrollSlice|null{
  if(!nav)return null;
  buildScrollBreaks(false);
  if(!scrollBreaks.length)return null;
  const idx=Math.max(0,Math.min(scrollBreaks.length-1,nav.index||0));
  const top=Math.max(0,Math.min(scrollMaxTop(),Math.round(nav.top==null?(scrollBreaks[idx]||0):nav.top)));
  const page=scrollPages&&scrollPages[idx]?scrollPages[idx]:null;
  if(!page){
    const port=scrollPort(),viewH=Math.max(1,(port&&port.clientHeight)||window.innerHeight||1);
    return {top:top,bottom:top+viewH,nextTop:top,startIndex:0,endIndex:0,nextIndex:0,end:idx>=scrollBreaks.length-1,index:idx};
  }
  return Object.assign({top:top,bottom:page.bottom,index:idx},
    page.nextTop===undefined?{}:{nextTop:page.nextTop},
    page.startIndex===undefined?{}:{startIndex:page.startIndex},
    page.endIndex===undefined?{}:{endIndex:page.endIndex},
    page.nextIndex===undefined?{}:{nextIndex:page.nextIndex},
    page.previewIndex===undefined?{}:{previewIndex:page.previewIndex},
    page.previewItem===undefined?{}:{previewItem:page.previewItem},
    page.virtualLayout===undefined?{}:{virtualLayout:page.virtualLayout},
    page.virtualBottom===undefined?{}:{virtualBottom:page.virtualBottom},
    page.end===undefined?{}:{end:page.end});
}
function canonicalScrollSliceForNav(top: number,dir: ReaderDirection): ReaderScrollSlice|null{
  return scrollSliceFromCanonicalBreak(scrollBreakForNav(top,dir));
}
function computeScrollPageSlice(cur: number,items?: readonly ReaderPageFlowItem[]): ReaderScrollSlice|null{
  const sp=scrollPort();
  if(!sp||!root)return null;
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  const safe=scrollGlyphSafePx(),bottomGuard=scrollBottomSafePx(),bottomTolerance=clickPagedBottomOverflowTolerancePx();
  const usableH=Math.max(1,viewH-safe-bottomGuard);
  items=items||documentFlowItems();
  if(!items.length)return null;
  const maxTop=scrollMaxTop();
  cur=Math.max(0,Math.min(maxTop,Math.round(cur||0)));
  const top=cur+safe,hardBottom=cur+viewH-bottomGuard+bottomTolerance;
  let sliceBottom=cur+viewH;
  let nextTop=maxTop;
  const crossing=firstAtomicBlockCrossing(items,top,hardBottom,usableH);
  if(crossing&&crossing.top>top+Math.max(6,lineHeightPx()*0.35)){
    sliceBottom=Math.max(top,crossing.top-safe);
    nextTop=crossing.top-safe;
    return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:Math.max(0,Math.min(maxTop,Math.round(nextTop)))};
  }
  let last=null;
  for(let i=0;i<items.length;i++){
    const it=items[i];
    if(!it)continue;
    if(it.bottom<=top+2)continue;
    if(it.bottom<=hardBottom){last=it;continue;}
    if(it.top>=hardBottom)break;
  }
  if(last){
    sliceBottom=Math.max(top,Math.min(cur+viewH,last.bottom+Math.min(safe,bottomGuard)));
    const afterLast=nextFlowItemAfter(items,last.bottom);
    if(!afterLast){
      return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:maxTop,end:true};
    }
    nextTop=afterLast.top-safe;
    if(nextTop<=cur+Math.max(4,lineHeightPx()*0.25)){
      const later=nextFlowItemAfter(items,top+lineHeightPx());
      nextTop=later?later.top-safe:Math.min(maxTop,cur+usableH);
    }
    return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:Math.max(0,Math.min(maxTop,Math.round(nextTop)))};
  }
  const next=nextFlowItemAfter(items,top);
  if(next){
    nextTop=next.top-safe;
    sliceBottom=Math.max(cur,Math.min(cur+viewH,next.top-safe));
  }else{
    return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:maxTop,end:true};
  }
  return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:Math.max(0,Math.min(maxTop,Math.round(nextTop)))};
}
function scrollNextTopFromDocument(cur: number,dir: ReaderDirection): number|null{
  if(dir>0){const s=computeScrollPageSlice(cur);return s&&typeof s.nextTop==='number'?s.nextTop:null;}
  const sp=scrollPort();
  if(!sp||!root)return null;
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1),safe=scrollGlyphSafePx();
  const items=documentFlowItems(),maxTop=scrollMaxTop();
  if(!items.length)return null;
  cur=Math.max(0,Math.min(maxTop,cur||0));
  if(cur<=scrollStartEpsilonPx())return 0;
  let target=cur-viewH+safe,prev=null;
  for(let j=0;j<items.length;j++){const item=items[j];if(item&&item.top<=target+1)prev=item;else break;}
  if(prev)return Math.max(0,Math.min(maxTop,Math.round(prev.top-safe)));
  return 0;
}
function clearScrollPreview(){
  if(!scrollPreview)return;
  scrollPreview._rrPreviewSource=null;
  scrollPreview._rrReservedBlank=0;
  scrollPreview.style.display='none';
  scrollPreview.style.height='0px';
  scrollPreview.innerHTML='';
}
function activeScrollSliceAtTop(top: number): ReaderScrollSlice|null{
  top=Math.round(top||0);
  if(scrollActiveSlice&&Math.abs(Math.round(scrollActiveSlice.top||0)-top)<=3)return scrollActiveSlice;
  if(scrollPages&&scrollPages.length){
    const idx=pageIndexForScrollTop(top);
    const page=scrollPages[Math.max(0,Math.min(scrollPages.length-1,idx))];
    // 恢复书签/阅读进度后，WebKit 的最终 scrollTop 可能比稳定页首偏移数像素。
    // 点击分页仍应使用当前页切片；只有自由滚动状态才要求坐标严格对齐。
    if(page&&(scrollPagedView||Math.abs(Math.round(page.top||0)-top)<=3))return page;
  }
  return null;
}
function stripCloneIds(el: Element): void{
  if(!el)return;
  try{if(el.removeAttribute)el.removeAttribute('id');}catch(_){}
  let all: Element[]=[];
  try{all=Array.from(el.querySelectorAll<Element>('[id]'));}catch(_){all=[];}
  for(let i=0;i<all.length;i++){try{all[i]?.removeAttribute('id');}catch(_){}}
}
function previewSourceElement(el: Element): Element | null{
  if(!el)return null;
  const tag=(el.tagName||'').toLowerCase();
  if(tag==='figure'){
    const inner=el.querySelector&&el.querySelector('img,svg,canvas,video');
    return inner||el;
  }
  return el;
}
function clonePreviewElement(el: Element): HTMLElement | SVGElement | null{
  const source=previewSourceElement(el);
  if(!source)return null;
  let tag=(source.tagName||'').toLowerCase(),clone: Node;
  if(tag==='canvas'&&source instanceof HTMLCanvasElement){
    try{const image=document.createElement('img');image.src=source.toDataURL('image/png');clone=image;}
    catch(_){clone=source.cloneNode(true);}
  }else clone=source.cloneNode(true);
  if(!(clone instanceof HTMLElement||clone instanceof SVGElement))return null;
  stripCloneIds(clone);
  try{clone.removeAttribute('loading');}catch(_){}
  clone.style.display='block';
  clone.style.margin='0';
  clone.style.padding='0';
  clone.style.border='0';
  clone.style.maxWidth='none';
  clone.style.width='auto';
  clone.style.height='auto';
  return clone;
}
let imageVisualAnchorFrame=0;
function visiblePreviewLayerForSource(source: Element): {layer:ReaderPreviewElement;rect:DOMRect}|null{
  const layers: ReaderPreviewElement[]=[];
  if(typeof pagedImagePreview!=='undefined'&&pagedImagePreview)layers.push(pagedImagePreview);
  if(scrollPreview)layers.push(scrollPreview);
  for(let i=0;i<layers.length;i++){
    const layer=layers[i];
    if(!layer)continue;
    if(layer._rrPreviewSource!==source||layer.style.display==='none')continue;
    let r=null;try{r=layer.getBoundingClientRect();}catch(_){r=null;}
    if(r&&r.width>1&&r.height>1&&r.bottom>0&&r.top<viewportHeight())return {layer:layer,rect:r};
  }
  return null;
}
function captureImageVisualAnchor(): ReaderImageAnchor|null{
  const layers: ReaderPreviewElement[]=[];
  if(typeof pagedImagePreview!=='undefined'&&pagedImagePreview)layers.push(pagedImagePreview);
  if(scrollPreview)layers.push(scrollPreview);
  for(let i=0;i<layers.length;i++){
    const layer=layers[i];if(!layer)continue;
    const source=layer._rrPreviewSource;
    if(!source||layer.style.display==='none')continue;
    let r=null;try{r=layer.getBoundingClientRect();}catch(_){r=null;}
    if(r&&r.width>1&&r.height>1&&r.bottom>0&&r.top<viewportHeight())return {source:source,top:r.top};
  }
  return null;
}
function restoreImageVisualAnchor(anchor: ReaderImageAnchor | null): boolean{
  if(!anchor||!anchor.source)return false;
  const match=visiblePreviewLayerForSource(anchor.source);
  if(!match)return false;
  const delta=anchor.top-match.rect.top;
  if(Math.abs(delta)<0.5)return true;
  const top=parseFloat(match.layer.style.top);
  if(!isFinite(top))return false;
  match.layer.style.top=Math.round(top+delta)+'px';
  return true;
}
function scheduleImageVisualAnchorRestore(anchor: ReaderImageAnchor | null): void{
  if(imageVisualAnchorFrame){cancelAnimationFrame(imageVisualAnchorFrame);imageVisualAnchorFrame=0;}
  if(!anchor)return;
  let attempts=3;
  function tick(){
    imageVisualAnchorFrame=0;
    if(restoreImageVisualAnchor(anchor)||--attempts<=0)return;
    imageVisualAnchorFrame=requestAnimationFrame(tick);
  }
  imageVisualAnchorFrame=requestAnimationFrame(tick);
}
function clearVirtualPage(){
  if(!virtualPage)return;
  virtualPage.style.display='none';
  virtualPage.innerHTML='';
  sideAnchorVirtualOffset=null;
}
function invalidateScrollItemsCache(){
  macVirtualPagePrefetchTimers.forEach(function(timer){clearTimeout(timer);});macVirtualPagePrefetchTimers.clear();
  scrollItemsSig='';
  scrollItemsCache=[];
  scrollMaskSig='';
  macVirtualPageCacheKey='';
  macVirtualPageCache=null;
  fastTextNodeOffsets=new WeakMap<Text,number>();
  macVirtualPageCacheByKey.clear();
}
function ensureVirtualPage(){
  if(virtualPage&&virtualPage.isConnected)return virtualPage;
  if(!pager)return null;
  virtualPage=document.getElementById('virtual-page');
  if(!virtualPage){virtualPage=document.createElement('div');virtualPage.id='virtual-page';pager.appendChild(virtualPage);}
  return virtualPage;
}
function readerSideVirtualDiag(offset: number,phase: string,detail?: ReaderPageTraceDetail): void{
  const payload: ReaderPageTraceDetail={
    phase:phase,offset:offset,flow:S.flowMode,pageMode:S.pageMode,
    page:pageInCh+1,pages:pagesInCh,width:Math.round(window.innerWidth||0)
  };
  if(detail)for(const k in detail){const value=detail[k];if(value!==undefined)payload[k]=value;}
  parent.postMessage({readerPerf:'ai_side_virtual '+JSON.stringify(payload)},'*');
}
function renderSideAnchorFallbackPage(offset: number,source: Range,reason: string): boolean{
  if(!source||!root||!pager)return false;
  let rects: DOMRect[]=[];try{rects=Array.from(source.getClientRects());}catch(_){rects=[];}
  const target=rects.find(function(r: DOMRect){return r.width>0&&r.height>0;})||null;
  const vp=ensureVirtualPage();
  if(!target||!vp)return false;
  vp.innerHTML='';
  const cloneNode=root.cloneNode(true);
  if(!(cloneNode instanceof HTMLElement))return false;
  const clone=cloneNode;
  clone.removeAttribute('id');
  clone.style.cssText=root.style.cssText;
  clone.style.position='absolute';
  clone.style.left=root.style.left||'0';
  clone.style.top=root.style.top||'0';
  clone.style.pointerEvents='none';
  clone.style.margin='0';
  const pr=pager.getBoundingClientRect();
  const desiredTop=pr.top+Math.max(0,mg(S.marginTop));
  const deltaY=Math.round(desiredTop-target.top);
  clone.style.transform='translate3d(-'+Math.round(viewOffset||0)+'px,'+deltaY+'px,0)';
  vp.appendChild(clone);
  vp.style.display='block';
  vp.style.pointerEvents='none';
  sideAnchorVirtualOffset=offset;
  refreshHighlights();
  readerSideVirtualDiag(offset,'fallback_shown',{reason:reason||'clone_failed',targetTop:Math.round(target.top),deltaY:deltaY});
  return true;
}
// 整页模式改变宽度后，一个旧页的中部文字可能落入新页的中部；若强行只显示
// 完整页，就只能跳回该页开头。此处以源文本 Range 克隆“从锚点开始”的临时页，
// 让智读开关前后的视口仍从同一段文字开始。下一次翻页会清除该临时页并回归正常分页。
function renderSideAnchorVirtualPage(offset: number): boolean{
  if(isScrollMode()){readerSideVirtualDiag(offset,'skipped_scroll');return false;}
  if(offset==null||!root||!pager){readerSideVirtualDiag(offset,'missing_context',{root:!!root,pager:!!pager});return false;}
  const source=sourceRangeForOffsets(offset,offset+1);
  if(!source){readerSideVirtualDiag(offset,'missing_source');return false;}
  // Range 截断会丢失首个段落的 DOM 上下文，导致首句和段距错位。
  // 完整 clone 再将稳定锚点对齐，才不会破坏当前页的排版。
  return renderSideAnchorFallbackPage(offset,source,'preserve_full_layout');
}
function consumeSideAnchorVirtualPage(){
  if(sideAnchorVirtualOffset==null)return false;
  const offset=sideAnchorVirtualOffset;
  const range=sourceRangeForOffsets(offset,offset+1);
  clearVirtualPage();
  if(range){
    const anchor={range:range};
    pageInCh=anchorPage(anchor);
    setViewOffset();
    captureAnchor();
  }
  return true;
}
function clickPagedBottomOverflowTolerancePx(): number{
  // Browser Range bounds can overshoot the visual glyph by a few pixels. In
  // click-paged scroll mode, consume that small tail on this page rather than
  // repeat the line as the first row of the following page.
  if(IS_MAC_WEBKIT)return 0;
  // Windows 的 Range 行框在楷体、上下标和脚注标记附近，实际会比可见字形
  // 多出约半行的下沿；7px 的旧阈值仍会把“已经贴近页尾”的完整行挪到下一页。
  // 此处只容忍最多 16px 的测量尾差，超过该值仍按下一页处理，避免把真正的大段
  // 残字当作完整行。
  return Math.max(6,Math.min(16,Math.ceil(lineHeightPx()*0.5)));
}
function virtualItemVisualBounds(it: ReaderPageFlowItem|null|undefined): {top:number;bottom:number;height:number}{
  const lh=lineHeightPx();
  if(!it)return {top:0,bottom:lh,height:lh};
  let top=isFinite(it.top)?it.top:0,bottom=isFinite(it.bottom)?it.bottom:top+Math.max(8,it.height||lh);
  // 行的合并矩形在 WebKit 中不一定包住上下标、注释角标和楷体字形。
  // 虚拟页真正绘制的是 fragments，因此页界和摆放原点也必须按它们的
  // 真实外接范围计算，否则会出现“底下留了空白，最后一行却仍被切掉”。
  if(it.type==='line'&&it.fragments&&it.fragments.length){
    for(let i=0;i<it.fragments.length;i++){
      const fragment=it.fragments[i];if(!fragment)continue;
      if(isFinite(fragment.top))top=Math.min(top,fragment.top);
      if(isFinite(fragment.bottom))bottom=Math.max(bottom,fragment.bottom);
    }
  }
  if(bottom<=top)bottom=top+Math.max(8,it.height||lh);
  return {top:top,bottom:bottom,height:bottom-top};
}
function virtualItemHeight(it: ReaderPageFlowItem|null|undefined): number{
  return Math.max(8,Math.ceil(virtualItemVisualBounds(it).height));
}
function virtualGapBetween(prev: ReaderPageFlowItem|null|undefined,it: ReaderPageFlowItem|null|undefined): number{
  if(!prev||!it)return 0;
  const gap=Math.max(0,(it.top||0)-(prev.bottom||0));
  const lh=lineHeightPx();
  if(prev.type==='line'&&it.type==='line')return Math.min(gap,Math.max(0,lh*0.08));
  return Math.min(gap,Math.max(2,lh*0.32));
}
function virtualLineAdvanceCap(prev: {height:number},current: {height:number}): number{
  const lh=lineHeightPx(),fontSize=Math.max(1,Number(S.fontSize)||lh);
  const paragraphGap=Math.max(0,Number(S.paraSpacing)||0)*fontSize;
  return Math.max(lh,prev.height||0,current.height||0)+paragraphGap+2;
}
function virtualExactBandTailProbePx(): number{
  const lh=lineHeightPx(),fontSize=Math.max(1,Number(S.fontSize)||lh);
  const paragraphGap=Math.max(0,Number(S.paraSpacing)||0)*fontSize;
  // 快速分页器可以在页尾回收段间距，把原始 top 已经低于视口底部的
  // 下一整行放进本页。精确逐字测量必须连同“一整行＋段距＋字形余量”
  // 一起探测；只多扫段距时，候选行的字形仍完全在 band 之外，表现为
  // 页尾留白，而基础分页已经消费掉这一行。
  return Math.max(4,Math.ceil(Math.max(lh,fontSize)+paragraphGap+scrollGlyphSafePx()+2));
}
function virtualExactBandBottomForSlice(page: ReaderScrollSlice,viewH: number): number{
  const pageTop=Math.max(0,Math.round(page&&page.top||0)),tail=virtualExactBandTailProbePx();
  let bandBottom=pageTop+viewH+tail;
  if(!fastChapterLayout||!scrollItemsCache.length)return bandBottom;
  const startIdx=Math.max(0,Math.min(scrollItemsCache.length-1,Number(page.startIndex)||0));
  let verticalShift=0,previousItem: ReaderPageFlowItem|null=null,previousBounds: {top:number;bottom:number;height:number}|null=null,previousRenderedTop=0;
  for(let i=startIdx;i<scrollItemsCache.length;i++){
    const item=scrollItemsCache[i];if(!item)continue;
    const bounds=virtualItemVisualBounds(item);
    if(previousItem&&previousBounds&&previousItem.type==='line'&&item.type==='line'){
      const sourceAdvance=Math.max(0,bounds.top-previousBounds.top);
      const cappedAdvance=Math.min(sourceAdvance,virtualLineAdvanceCap(previousBounds,bounds));
      const naturalTop=bounds.top-pageTop-verticalShift;
      const cappedTop=previousRenderedTop+cappedAdvance;
      if(naturalTop>cappedTop)verticalShift+=naturalTop-cappedTop;
    }
    const renderedTop=Math.max(0,bounds.top-pageTop-verticalShift),renderedBottom=renderedTop+bounds.height;
    // 章首常用多个空 br 制造题名间距。虚拟页会收紧这些大间隔，
    // 精确测量带也要同步向源文档后伸，否则收紧后的空间没有后续行可填。
    bandBottom=Math.max(bandBottom,Math.ceil(bounds.bottom+tail));
    if(renderedBottom>viewH+tail)break;
    previousItem=item;previousBounds=bounds;previousRenderedTop=renderedTop;
  }
  return bandBottom;
}
function buildVirtualPageFromIndex(items: readonly ReaderPageFlowItem[],startIdx: number,viewH: number,navMaxTop: number,forcedPageTop?: number): ReaderScrollSlice{
  startIdx=Math.max(0,Math.min(items.length-1,startIdx||0));
  // 虚拟文字由绝对定位 span 重绘，WebKit 对克隆后的字体基线可能比原 Range
  // 矩形再向下溢出数像素。文字行已经使用 fragment 的真实外接 bottom 判断
  // 完整性，页尾只需保留少量字形余量；固定预留一整行会让本可完整显示的
  // 下一行提前移到下一页，形成接近两行高的空白。
  const lh=lineHeightPx(),glyphPad=scrollGlyphSafePx(),bottomGuard=IS_MAC_WEBKIT?Math.max(glyphPad,scrollBottomSafePx()):Math.max(2,Math.ceil(lh*0.08));
  // 点击整页翻页的起点和终点都要给字形留出安全空间。自由滚动不会走这条
  // 虚拟分页路径，因此仍保持连续浏览的原始行为。
  const startItem=items[startIdx],startBounds=virtualItemVisualBounds(startItem);
  const pageTop=forcedPageTop==null
    ?(startIdx>0?Math.max(0,Math.min(navMaxTop,Math.round(startBounds.top-glyphPad))):0)
    :Math.max(0,Math.round(forcedPageTop));
  const fitLimit=viewH-bottomGuard+0.5+clickPagedBottomOverflowTolerancePx();
  let y=0,endIdx=startIdx-1,layout: ReaderVirtualLayoutEntry[]=[],previewIndex=-1,guard=0,verticalShift=0,previousItem: ReaderPageFlowItem|null=null,previousBounds: {top:number;bottom:number;height:number}|null=null,previousRenderedTop=0;
  for(let i=startIdx;i<items.length&&guard++<1000;i++){
    const it=items[i];
    if(!it)continue;
    const bounds=virtualItemVisualBounds(it),h=Math.max(8,Math.ceil(bounds.height));
    if(IS_MAC_WEBKIT&&previousItem&&previousBounds&&previousItem.type==='line'&&it.type==='line'){
      // WKWebView 偶尔会让段落边界两行的 Range top 相差远大于实际行高，
      // 虚拟页若原样使用会在页尾凭空留出数行。仅夹住超过“字形高度＋
      // 用户段距”的异常跳变；普通行距和正常段距不会触发。
      const sourceAdvance=Math.max(0,bounds.top-previousBounds.top);
      const cappedAdvance=Math.min(sourceAdvance,virtualLineAdvanceCap(previousBounds,bounds));
      const naturalTop=bounds.top-pageTop-verticalShift;
      const cappedTop=previousRenderedTop+cappedAdvance;
      if(naturalTop>cappedTop)verticalShift+=naturalTop-cappedTop;
    }
    let y0=Math.max(0,bounds.top-pageTop-verticalShift),renderedBottom=y0+bounds.height;
    // macOS 的 1.0 行距下，相邻字形矩形会彼此重叠。以该行真实 bottom
    // 判断是否完整可见，而不是以行高或下一行 top 放置水平裁切线。
    let fits=renderedBottom<=fitLimit;
    if(!fits&&IS_MAC_WEBKIT&&previousItem&&previousBounds){
      // 只有当段间距恰好把一整行挡在页外时，才在这一张虚拟页中收紧
      // 该处间距。正文行高、字形位置与其他段落间距均不改变。
      const sourceGap=Math.max(0,bounds.top-previousBounds.bottom);
      const compactGap=Math.max(0,virtualGapBetween(previousItem,it));
      // 楷体及上下标的 fragment bottom 可能伸出行框，使 bottom→top 间隙
      // 小于真正的段落附加间距。再以相邻行 top 的推进量减去正常行高计算
      // 一次，避免只差几像素时误判下一整行放不下。只在当前行原本不适配
      // 页尾时回收所需部分，因此普通段距和正文行高保持不变。
      const renderedAdvance=Math.max(0,y0-previousRenderedTop);
      const normalAdvance=Math.max(lh,previousBounds.height||0,bounds.height||0);
      const advanceGap=Math.max(0,renderedAdvance-normalAdvance);
      const reducible=Math.max(0,sourceGap-compactGap,advanceGap);
      const overflow=Math.max(0,renderedBottom-fitLimit);
      const reduction=Math.min(reducible,Math.ceil(overflow));
      if(reduction>0){
        verticalShift+=reduction;
        y0=Math.max(0,bounds.top-pageTop-verticalShift);
        renderedBottom=y0+bounds.height;
        fits=renderedBottom<=fitLimit;
      }
    }
    if(!fits){
      if(it.type==='block'&&isPreviewableBlock(it)){
        previewIndex=i;
      }
      break;
    }
    layout.push({index:i,type:it.type,top:y0,height:h,sourceTop:bounds.top,item:it});
    y=Math.max(y,renderedBottom);
    endIdx=i;
    previousItem=it;previousBounds=bounds;previousRenderedTop=y0;
  }
  if(!layout.length){
    const first=items[startIdx],firstBounds=virtualItemVisualBounds(first),firstH=Math.min(viewH-bottomGuard,virtualItemHeight(first));
    if(!first)return {top:pageTop,bottom:pageTop+viewH,nextTop:navMaxTop,startIndex:startIdx,endIndex:startIdx,nextIndex:items.length,previewIndex:-1,previewItem:null,virtualLayout:layout,virtualBottom:0,end:true};
    layout.push({index:startIdx,type:first.type,top:0,height:firstH,sourceTop:firstBounds.top,item:first});
    endIdx=startIdx;
    y=Math.min(firstH,firstBounds.height);
  }
  let nextIdx=endIdx+1;
  if(previewIndex>=0)nextIdx=previewIndex;
  const isEnd=nextIdx>=items.length;
  const nextItem=items[nextIdx],nextBounds=virtualItemVisualBounds(nextItem);
  const nextTop=isEnd?navMaxTop:Math.max(0,Math.min(navMaxTop,Math.round(nextBounds.top-glyphPad)));
  return {top:pageTop,bottom:pageTop+viewH,nextTop:nextTop,startIndex:startIdx,endIndex:endIdx,nextIndex:nextIdx,previewIndex:previewIndex,previewItem:previewIndex>=0?(items[previewIndex]||null):null,virtualLayout:layout,virtualBottom:y,end:isEnd};
}
function applyVirtualFragmentStyle(el: HTMLElement,style: ReaderComputedLineStyle|null|undefined): void{
  if(!style)return;
  Object.assign(el.style,style);
}
function cssContentText(v: string): string{
  if(!v||v==='none'||v==='normal')return '';
  if((v.charAt(0)==='"'&&v.charAt(v.length-1)==='"')||(v.charAt(0)==="'"&&v.charAt(v.length-1)==="'"))return v.slice(1,-1);
  return '';
}
function noteLinkInfo(el: Element|null|undefined): {anchor:Element;href:string;frag:string;targetChapter:number|null}|null{
  if(!el)return null;
  let a: Element|null=(el.tagName&&el.tagName.toLowerCase()==='a')?el:null;
  // Character-range measurement can identify the generated badge span rather than
  // its enclosing EPUB link. Recover that ancestor before cloning the fragment so
  // clicking “注” is consumed by the footnote popup instead of the page-turn zone.
  if(!a&&el.closest)a=el.closest('a[href]');
  if(!a&&el.querySelector)a=el.querySelector('a[href]');
  const href=a?a.getAttribute('href'):(el.getAttribute&&el.getAttribute('href'));
  const tail=href&&href.indexOf('#')>=0?href.split('#').pop():'';
  let frag=tail||'';
  try{if(frag)frag=decodeURIComponent(frag);}catch(_){}
  let targetChapter: number|null=null;
  const compound=/^c(\d+)~(.+)$/.exec(frag);
  if(compound){targetChapter=parseInt(compound[1]||'',10);frag=compound[2]||'';}
  return frag?{anchor:a||el,href:href||'',frag:frag,targetChapter:targetChapter}:null;
}
function bindVirtualNoteClick(el: HTMLElement,info: {anchor:Element;href:string;frag:string;targetChapter:number|null}|null): void{
  if(!el||!info)return;
  el.style.cursor='pointer';
  el.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    readerBugTrace('footnote','virtual_click',e,{note_marker:true,note_virtual:true,note_link_present:true,note_fragment_present:true,note_click_consumed:true});
    if(pageDebugSettingOn('reader_footnotes'))showFootnote(el,info.targetChapter===null?curCh:info.targetChapter,info.frag,info.targetChapter!==null);
    else readerBugTrace('footnote','disabled',e,{note_marker:true,note_virtual:true,note_click_consumed:true});
  });
}
function inlineCloneHasVisibleContent(el: HTMLElement): boolean{
  if(!el)return false;
  if((el.textContent||'').replace(/\s+/g,'').length>0)return true;
  if(el.querySelector&&el.querySelector('img,svg,canvas,video'))return true;
  const nodes: Element[]=[el],kids=el.querySelectorAll('*');
  for(let i=0;i<kids.length;i++)nodes.push(kids.item(i));
  for(let j=0;j<nodes.length;j++){
    const node=nodes[j];if(!node)continue;
    try{
      const cs=window.getComputedStyle(node);
      if(cs.backgroundImage&&cs.backgroundImage!=='none')return true;
      const before=cssContentText(window.getComputedStyle(node,'::before').content);
      const after=cssContentText(window.getComputedStyle(node,'::after').content);
      if(before||after)return true;
    }catch(_){}
  }
  return false;
}
function noteFontSizePx(){
  let n=Number(S.noteFontSize);
  if(!isFinite(n))n=14;
  return Math.max(10,Math.min(22,n));
}
function noteBadgeSizePx(){return 14;}
function inlineNoteAnchor(a: Element|null|undefined): boolean{
  if(!a||!a.tagName||a.tagName.toLowerCase()!=='a')return false;
  const href=a.getAttribute('href')||'',id=a.getAttribute('id')||'';
  const cls=String(a.className||'');
  const meta=((a.getAttribute('epub:type')||'')+' '+(a.getAttribute('role')||'')+' '+cls).toLowerCase();
  if(a.getAttribute('data-rr-note-ref')==='1'||/\brr-note-ref\b/.test(cls))return true;
  if(/noteref|annoref/.test(meta))return true;
  if(/^noteBack[_-]?\d*$/i.test(id))return true;
  if(/^[\[【（(]?\s*(?:注|註)\s*\d{1,5}\s*[\]】）)]?$/.test((a.textContent||'').trim()))return true;
  let frag=href&&href.indexOf('#')>=0?href.split('#').pop():'';
  if(!frag||/back/i.test(frag))return false;
  try{frag=decodeURIComponent(frag);}catch(_){} if(/^zww\d{1,5}$/i.test(id)&&/^zw\d{1,5}$/i.test(frag.replace(/^c\d+~/i,'')))return true;
  return /^(note|footnote|endnote|fn|n)[_\-]?\d{1,5}$/i.test(frag);
}
function ensureNoteBadgeForAnchor(a: Element): Element|null{
  if(!a||!inlineNoteAnchor(a))return null;
  if(a.getAttribute('data-rr-note-ref')!=='1'){
    const raw=(a.textContent||'').trim();
    if(raw)a.setAttribute('data-rr-note-text',raw);
    a.setAttribute('data-rr-note-ref','1');
    a.classList.add('rr-note-ref');
    a.setAttribute('aria-label',raw?('注释 '+raw):'注释');
    while(a.firstChild)a.removeChild(a.firstChild);
  }else{
    a.classList.add('rr-note-ref');
  }
  let badge=null;
  for(let i=0;i<a.children.length;i++){
    const child=a.children.item(i);if(child&&child.classList.contains('rr-note-badge')){badge=child;break;}
  }
  if(!badge){
    badge=document.createElement('span');
    badge.className='rr-note-badge';
    badge.setAttribute('data-generated','1');
    a.appendChild(badge);
  }
  badge.textContent='注';
  let p=a.parentElement;
  while(p&&p!==root&&/^(SUP|SUB|SPAN|SMALL|FONT|B|I|EM|STRONG)$/.test(p.nodeName)){
    p.classList.add('rr-note-wrap');
    if(p.parentElement&&p.parentElement.children&&p.parentElement.children.length===1)p=p.parentElement;
    else break;
  }
  return a;
}
function normalizeInlineNoteRefs(){
  if(!root)return;
  const anchors=root.querySelectorAll('a[href*="#"],a[id^="noteBack"],a[epub\\:type*="noteref"],a[role~="doc-noteref"],a[data-rr-note-ref="1"]');
  for(let i=0;i<anchors.length;i++)ensureNoteBadgeForAnchor(anchors.item(i));
  sourceTextCache=null;
}
function styleSyntheticNoteBadge(badge: HTMLElement,el: Element|null): void{
  if(!badge)return;
  let cs=null;
  try{cs=el?window.getComputedStyle(el):null;}catch(_){}
  const size=Math.round(noteBadgeSizePx());
  badge.textContent='注';
  badge.style.display='inline-flex';
  badge.style.alignItems='center';
  badge.style.justifyContent='center';
  badge.style.width=size+'px';
  badge.style.height=size+'px';
  badge.style.boxSizing='border-box';
  badge.style.borderRadius='50%';
  badge.style.background='#f3f6fa';
  badge.style.border='1px solid #b7c7da';
  badge.style.color='#2f6fad';
  badge.style.fontFamily=cs&&cs.fontFamily?cs.fontFamily:"system-ui,'Microsoft YaHei',sans-serif";
  badge.style.fontSize=Math.max(9,Math.round(size*0.62))+'px';
  badge.style.fontWeight='700';
  badge.style.lineHeight='1';
  badge.style.verticalAlign='middle';
  badge.style.textDecoration='none';
  badge.style.overflow='hidden';
  badge.style.pointerEvents='auto';
}
function makeSyntheticNoteBadge(el: Element|null): HTMLSpanElement{
  const badge=document.createElement('span');
  styleSyntheticNoteBadge(badge,el);
  badge.setAttribute('data-vnote-badge','1');
  return badge;
}
function copyInlineComputedStyle(src: Element,dst: HTMLElement): void{
  if(!src||!dst)return;
  const props: Array<keyof CSSStyleDeclaration>=['display','width','height','minWidth','minHeight','maxWidth','maxHeight','color','backgroundColor','backgroundImage','backgroundSize','backgroundRepeat','backgroundPosition','backgroundClip','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderRadius','boxShadow','fontFamily','fontSize','fontWeight','fontStyle','fontVariant','lineHeight','letterSpacing','wordSpacing','textDecoration','textAlign','verticalAlign','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft'];
  const cs=window.getComputedStyle(src);
  for(let i=0;i<props.length;i++){const property=props[i];if(property===undefined)continue;try{dst.style.setProperty(String(property).replace(/[A-Z]/g,function(letter){return '-'+letter.toLowerCase();}),String(cs[property]||''));}catch(_){}}
}
function cloneInlineNoteFragment(el: Element|null|undefined): HTMLElement|null{
  if(!el)return null;
  const info=noteLinkInfo(el);
  const src=el.classList&&el.classList.contains('rr-note-ref')?el:(el.querySelector&&el.querySelector('.rr-note-ref'));
  const cloneNode=src?src.cloneNode(true):makeSyntheticNoteBadge(el);
  if(!(cloneNode instanceof HTMLElement))return null;
  const clone=cloneNode;
  clone.removeAttribute('id');
  if(src){
    copyInlineComputedStyle(src,clone);
    const srcBadge=src.querySelector<HTMLElement>('.rr-note-badge');
    const cloneBadge=clone.querySelector<HTMLElement>('.rr-note-badge');
    if(srcBadge&&cloneBadge)copyInlineComputedStyle(srcBadge,cloneBadge);
  }
  clone.style.position='static';
  clone.style.pointerEvents='auto';
  clone.style.display='inline-flex';
  clone.style.width='100%';
  clone.style.height='100%';
  clone.style.minWidth='0';
  clone.style.minHeight='0';
  clone.style.margin='0';
  clone.style.verticalAlign='middle';
  const badge=clone.querySelector<HTMLElement>('.rr-note-badge');
  if(badge){
    badge.style.width='100%';
    badge.style.height='100%';
    badge.style.margin='0';
  }
  bindVirtualNoteClick(clone,info);
  return clone;
}
function renderVirtualLine(entry: ReaderVirtualLayoutEntry): HTMLElement|null{
  const it=entry&&entry.item;
  if(!it||!it.fragments||!it.fragments.length)return null;
  const line=document.createElement('div');
  line.className='vp-line';
  line.style.top=entry.top+'px';
  line.style.height=Math.max(1,Math.ceil(entry.height))+'px';
  for(let i=0;i<it.fragments.length;i++){
    const f=it.fragments[i];
    if(!f)continue;
    const span=document.createElement('span');
    span.className=f.kind==='inline'?'vp-inline':'vp-frag';
    if(f.kind==='note-number')span.classList.add('vp-note-num');
    span.style.left=(f.left||0)+'px';
    span.style.top=((f.top||entry.sourceTop||0)-entry.sourceTop)+'px';
    span.style.height=Math.max(1,Math.ceil(f.height||it.height||entry.height))+'px';
    if(f.width&&f.kind)span.style.width=Math.max(1,Math.ceil(f.width))+'px';
    if(f.kind==='note-number'){
      if(!f.text)continue;
      span.textContent=f.text;
      span.style.left=Math.max(6,Math.round(f.left||0))+'px';
      span.style.width=Math.max(1,Math.ceil(f.width||0)+2)+'px';
      span.style.minWidth=span.style.width;
      applyVirtualFragmentStyle(span,f.style);
    }else if(f.kind==='inline'){
      const clone=cloneInlineNoteFragment(f.el);
      if(!clone)continue;
      const noteW=Math.max(1,Math.ceil(f.width||noteBadgeSizePx()));
      const noteH=Math.max(1,Math.ceil(f.height||noteBadgeSizePx()));
      span.style.left=Math.round(f.left||0)+'px';
      span.style.top=Math.round((f.top||entry.sourceTop||0)-entry.sourceTop)+'px';
      span.style.height=noteH+'px';
      span.style.width=noteW+'px';
      span.style.overflow='visible';
      bindVirtualNoteClick(span,noteLinkInfo(f.el));
      span.appendChild(clone);
    }else{
      if(!f.text)continue;
      span.textContent=f.text;
      if(f.start!=null)span.setAttribute('data-vstart',String(f.start));
      if(f.end!=null)span.setAttribute('data-vend',String(f.end));
      const hi=highlightIndexForRange(f.start,f.end);
      if(hi>=0){span.classList.add('vp-hl');span.setAttribute('data-hi',String(hi));}
      // 普通文字使用其本身的固有宽度。把 Range 测得宽度再次设为 span 宽度，
      // WKWebView 会把最右侧字形按整数像素二次取整，曾造成右边切字。
      if(f.width&&f.kind)span.style.minWidth=Math.max(1,Math.ceil(f.width))+'px';
      applyVirtualFragmentStyle(span,f.style);
    }
    line.appendChild(span);
  }
  return line.childNodes.length?line:null;
}
function sizeVirtualPreviewClone(clone: HTMLElement|SVGElement,it: ReaderPageFlowItem): void{
  if(!clone||!it)return;
  const w=Math.max(1,Math.round(it.renderWidth||it.width||0));
  const h=Math.max(1,Math.round(it.renderHeight||it.height||0));
  clone.style.width=w+'px';
  clone.style.height=h+'px';
  clone.style.maxWidth='none';
  clone.style.maxHeight='none';
  clone.style.objectFit='fill';
}
function renderVirtualBlockSlice(_page: ReaderScrollSlice,entry: ReaderVirtualLayoutEntry): HTMLElement{
  const it=entry.item,box=document.createElement('div');
  box.className='vp-block';
  box.style.top=Math.round(entry.top+(it.renderTopOffset||0))+'px';
  box.style.height=Math.max(1,Math.ceil(Math.min(entry.height,entry.height-(it.renderTopOffset||0)+(it.renderHeight||entry.height))))+'px';
  box.style.left=Math.max(0,Math.round(it.renderLeft!=null?it.renderLeft:(it.left||0)))+'px';
  box.style.width=Math.max(1,Math.round(it.renderWidth||it.width||1))+'px';
  let clone=it.el?clonePreviewElement(it.el):null;
  if(!clone&&it.el){const fallbackClone=it.el.cloneNode(true);if(fallbackClone instanceof HTMLElement||fallbackClone instanceof SVGElement){clone=fallbackClone;stripCloneIds(clone);}}
  if(clone){sizeVirtualPreviewClone(clone,it);box.appendChild(clone);}
  return box;
}
function renderVirtualPreview(page: ReaderScrollSlice,viewH: number): HTMLElement|null{
  const it=page&&page.previewItem?page.previewItem:null;
  if(!it||!isPreviewableBlock(it)||!it.el)return null;
  const y=Math.max(0,Math.round(page.virtualBottom||0)+imagePreviewGapPx());
  const h=Math.floor(viewH-y);
  if(h<Math.max(24,Math.ceil(lineHeightPx()*0.75)))return null;
  const box=document.createElement('div');
  box.className='vp-block vp-preview';
  box.style.top=y+'px';
  box.style.height=h+'px';
  box.style.left=Math.max(0,Math.round(it.renderLeft!=null?it.renderLeft:(it.left||0)))+'px';
  box.style.width=Math.max(1,Math.round(it.renderWidth||it.width||1))+'px';
  const clone=clonePreviewElement(it.el);
  if(!clone)return null;
  sizeVirtualPreviewClone(clone,it);
  box.appendChild(clone);
  return box;
}
function renderVirtualScrollPage(pageOverride?: ReaderScrollSlice|null): boolean{
  if(!isScrollMode()||!scrollPagedView||!pager||!root){clearVirtualPage();return false;}
  const sp=scrollPort();
  if(!sp){clearVirtualPage();return false;}
  const layer=ensureVirtualPage() as ReaderPreviewElement|null;
  if(!layer)return false;
  const top=Math.round(sp.scrollTop||0),viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  const page=pageOverride||activeScrollSliceAtTop(top);
  if(!page){clearVirtualPage();return false;}
  const layout=page.virtualLayout||[];
  layer.innerHTML='';
  for(let i=0;i<layout.length;i++){
    const entry=layout[i];if(!entry)continue;
    const node=entry.type==='block'?renderVirtualBlockSlice(page,entry):renderVirtualLine(entry);
    if(node)layer.appendChild(node);
  }
  const preview=renderVirtualPreview(page,viewH);
  if(preview)layer.appendChild(preview);
  layer._rrRenderLayoutCount=layout.length;
  layer._rrRenderNodeCount=layer.childNodes.length;
  if(!layer.childNodes.length){clearVirtualPage();return false;}
  layer.style.display='block';
  return true;
}
function virtualScrollPageHasCompleteText(page: ReaderScrollSlice): boolean{
  const layout=page&&page.virtualLayout?page.virtualLayout:[];
  if(!layout.length)return false;
  for(let i=0;i<layout.length;i++){
    const entry=layout[i],it=entry&&entry.item;
    if(entry&&entry.type==='line'&&(!it||!it.fragments||!it.fragments.length))return false;
  }
  return true;
}
function macVirtualPageForSlice(page: ReaderScrollSlice): ReaderScrollSlice|null{
  if(!page||!pager)return null;
  if(!fastChapterLayout&&virtualScrollPageHasCompleteText(page)){
    page._rrExactLineCount=page.virtualLayout?page.virtualLayout.length:0;
    page._rrFragmentCount=(page.virtualLayout||[]).reduce(function(n,x){return n+(x&&x.item&&x.item.fragments?x.item.fragments.length:0);},0);
    return page;
  }
  const sp=scrollPort(),viewH=Math.max(1,(sp&&sp.clientHeight)||window.innerHeight||1);
  const top=Math.round(page.top||0),key=[curCh,top,viewH,layoutSig()].join('|');
  if(key===macVirtualPageCacheKey&&macVirtualPageCache)return macVirtualPageCache;
  const cachedPage=macVirtualPageCacheByKey.get(key);
  if(cachedPage){
    macVirtualPageCacheByKey.delete(key);macVirtualPageCacheByKey.set(key,cachedPage);
    macVirtualPageCacheKey=key;macVirtualPageCache=cachedPage;
    return cachedPage;
  }
  const exact=exactTextLineItemsForBand(top,virtualExactBandBottomForSlice(page,viewH)).filter(function(line){return !!line&&line.top>=top-1;});
  // 大章节只逐字测量当前视口，再交给与普通章节完全相同的分页器。过去这里
  // 直接把 band 内所有行塞入视口，既绕过页尾安全区，也保留了 WebKit 偶发的
  // 多行 Range 间隙，表现为底部切字或大段空白。
  const exactPage=exact.length?buildVirtualPageFromIndex(exact,0,viewH,top+viewH,top):null;
  const layout: ReaderVirtualLayoutEntry[]=exactPage&&exactPage.virtualLayout?exactPage.virtualLayout.slice():[];
  let fragmentCount=0;
  for(let i=0;i<layout.length;i++){const entry=layout[i];if(entry&&entry.type==='line')fragmentCount+=entry.item&&entry.item.fragments?entry.item.fragments.length:0;}
  // 图片和其他原子块沿用快速分页器已经生成的布局；文字行使用当前页精确结果。
  const oldLayout=page.virtualLayout||[];
  for(let j=0;j<oldLayout.length;j++){const oldEntry=oldLayout[j];if(oldEntry&&oldEntry.type==='block')layout.push(oldEntry);}
  layout.sort(function(a,b){return a.top-b.top||(a.type==='block'?-1:1);});
  if(!layout.length)return null;
  const rebuilt=Object.assign({},page,{virtualLayout:layout,virtualBottom:exactPage?exactPage.virtualBottom:layout.reduce(function(m,x){return Math.max(m,(x.top||0)+(x.height||0));},0)});
  rebuilt._rrExactLineCount=exact.length;
  rebuilt._rrFragmentCount=fragmentCount;
  macVirtualPageCacheKey=key;
  macVirtualPageCache=rebuilt;
  macVirtualPageCacheByKey.set(key,rebuilt);
  while(macVirtualPageCacheByKey.size>48){const oldest=macVirtualPageCacheByKey.keys().next().value;if(typeof oldest!=='string')break;macVirtualPageCacheByKey.delete(oldest);}
  return rebuilt;
}
function macVirtualPagePrefetchKey(page: ReaderScrollSlice,viewH: number): string{
  return [curCh,Math.round(page.top||0),viewH,layoutSig()].join('|');
}
function queueMacVirtualPagePrefetch(page: ReaderScrollSlice,pageIndex: number,delay: number): void{
  const sp=scrollPort(),viewH=Math.max(1,(sp&&sp.clientHeight)||window.innerHeight||1),key=macVirtualPagePrefetchKey(page,viewH);
  if(macVirtualPageCacheByKey.has(key)||macVirtualPagePrefetchTimers.has(key)||macVirtualPagePrefetchTimers.size>=6)return;
  const chapter=curCh,signature=layoutSig(),started=performance.now();
  const timer=setTimeout(function(){
    macVirtualPagePrefetchTimers.delete(key);
    if(curCh!==chapter||layoutSig()!==signature||scrollPages[pageIndex]!==page)return;
    const prefetched=macVirtualPageForSlice(page);
    reportReaderPaintPerf('page_prefetch',started,'chapter='+chapter+' page='+(pageIndex+1)+' ready='+(prefetched?1:0));
  },delay);
  macVirtualPagePrefetchTimers.set(key,timer);
}
function scheduleMacVirtualPagePrefetch(page: ReaderScrollSlice|null): void{
  if(!IS_MAC_WEBKIT||!scrollPagedView||!page||!scrollPages.length)return;
  const pageIndex=scrollPages.indexOf(page);
  if(pageIndex<0)return;
  const next=scrollPages[pageIndex+1],following=scrollPages[pageIndex+2];
  // 每一页的预取单独排队，而不是新一页出现就撤销旧定时器。快速连续点击时，
  // 用户下一页通常正好落在前一次预取的目标上，避免重新做逐字精确测量。
  if(next)queueMacVirtualPagePrefetch(next,pageIndex+1,18);
  if(following)queueMacVirtualPagePrefetch(following,pageIndex+2,48);
}
function scrollImagePreviewEligible(next: ReaderPageFlowItem,slice: ReaderScrollSlice,nextIdx: number,pageBottom: number): boolean{
  if(!next||!slice)return false;
  if(next.top>=pageBottom-2)return true;
  return next.bottom>pageBottom+0.5&&(slice.previewItem===next||slice.previewIndex===nextIdx);
}
function scrollPagePreviewCandidate(slice: ReaderScrollSlice|null,top: number,viewH: number): ReaderPageFlowItem|null{
  if(!slice)return null;
  const items=scrollPageItems();
  const nextIdx=typeof slice.nextIndex==='number'?slice.nextIndex:-1;
  if(nextIdx<0||nextIdx>=items.length)return null;
  const next=items[nextIdx];
  if(!next||!isPreviewableBlock(next)||!next.el)return null;
  return scrollImagePreviewEligible(next,slice,nextIdx,Math.round(top||0)+Math.max(1,viewH||1))?next:null;
}
function applyScrollImagePreview(){
  if(!isScrollMode()||!scrollPagedView||!pager||!root){clearScrollPreview();return;}
  const sp=scrollPort();
  if(!sp){clearScrollPreview();return;}
  if(!scrollPreview){
    scrollPreview=document.getElementById('scroll-preview');
    if(!scrollPreview&&pager){scrollPreview=document.createElement('div');scrollPreview.id='scroll-preview';pager.appendChild(scrollPreview);}
  }
  if(!scrollPreview)return;
  const top=Math.round(sp.scrollTop||0);
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  const pageBottom=top+viewH;
  const slice=activeScrollSliceAtTop(top);
  if(!slice){clearScrollPreview();return;}
  const items=scrollPageItems();
  if(!items.length){clearScrollPreview();return;}
  const next=scrollPagePreviewCandidate(slice,top,viewH);
  if(!next){clearScrollPreview();return;}
  const nextIdx=typeof slice.nextIndex==='number'?slice.nextIndex:-1;
  let contentBottom=top;
  const start=Math.max(0,Math.min(items.length-1,slice.startIndex||0));
  const end=Math.max(start,Math.min(items.length-1,slice.endIndex==null?nextIdx-1:slice.endIndex));
  for(let i=start;i<=end;i++){
    const it=items[i];
    if(!it||it.top<top-2||it.bottom>pageBottom+0.5)continue;
    contentBottom=Math.max(contentBottom,it.bottom);
  }
  if(contentBottom<=top+1){
    for(let j=0;j<items.length;j++){
      const it2=items[j];
      if(!it2||it2.top<top-2||it2.bottom>pageBottom+0.5)continue;
      contentBottom=Math.max(contentBottom,it2.bottom);
    }
  }
  const gapTop=Math.max(0,Math.round(contentBottom-top)+imagePreviewGapPx());
  const gapH=Math.floor(viewH-gapTop);
  if(gapH<Math.max(24,Math.ceil(lineHeightPx()*0.75))){clearScrollPreview();return;}
  if(!next.el){clearScrollPreview();return;}
  const clone=clonePreviewElement(next.el);
  if(!clone){clearScrollPreview();return;}
  sizeVirtualPreviewClone(clone,next);
  let src=previewSourceElement(next.el),r: DOMRect|null=null,pr=viewRect();
  if(src)try{r=src.getBoundingClientRect();}catch(_){r=null;}
  scrollPreview.innerHTML='';
  scrollPreview.style.display='block';
  scrollPreview.style.top=gapTop+'px';
  scrollPreview.style.height=gapH+'px';
  scrollPreview.style.bottom='auto';
  // 预览是覆盖层；同时把同等高度从原始正文的可见区扣掉，
  // 否则原图/后续文字仍会在预览层下绘制，视觉上就像图片压住正文。
  scrollPreview._rrReservedBlank=Math.max(0,Math.ceil(viewH-gapTop));
  scrollPreview._rrPreviewSource=src;
  const inner=document.createElement('div');
  inner.className='rr-preview-inner';
  if(r&&r.width>2){
    inner.style.left=Math.max(0,Math.round(r.left-pr.left))+'px';
    inner.style.width=Math.round(r.width)+'px';
  }else{
    inner.style.left='0px';
    inner.style.right='0px';
  }
  inner.style.height=Math.max(1,Math.ceil(next.height||gapH))+'px';
  inner.appendChild(clone);
  scrollPreview.appendChild(inner);
}
function applyScrollPageMask(force = false): void{
  const maskPort=scrollPort();
  const maskTop=maskPort?Math.round(maskPort.scrollTop||0):0;
  const maskSlice=scrollActiveSlice;
  const maskSig=[curCh,maskTop,scrollPagedView?1:0,maskSlice?maskSlice.startIndex:-1,maskSlice?maskSlice.endIndex:-1,maskSlice?maskSlice.nextIndex:-1,layoutSig(),scrollBreakSig].join('|');
  // WebKit 会在一次程序化翻页中依次触发设置 scrollTop、scroll 事件、页码同步和
  // 注释刷新。它们过去会对同一页重复执行 3–4 次完整遮罩渲染。
  if(!force&&maskSig===scrollMaskSig)return;
  scrollMaskSig=maskSig;
  if(typeof clearPagedImagePreview==='function')clearPagedImagePreview();
  if(pageMask){
    pageMask.style.height='0px';
    pageMask.style.display='none';
  }
  clearVirtualPage();
  clearScrollPreview();
  const virtualSlice=activeScrollSliceAtTop(maskTop);
  // macOS 的相邻字形矩形在 1.0 行距下会重叠，任何水平 clip-path 都会切到
  // 上一行字底或露出下一行字头。逐行绘制本页完整行，下一页首行不加入当前
  // 图层；因此无需水平裁切，也不改变字号、行高、行数或正文位置。
  if(IS_MAC_WEBKIT){
    // 用户手动滚动必须维持连续正文；只有点击整页翻页才启用完整字形视页。
    if(!scrollPagedView){
      if(scroller){scroller.style.clipPath='none';scroller.style.setProperty("-webkit-clip-path",'none');}
      refreshHighlights();
      return;
    }
    // 大章节先用分段行几何定位页界，再只对当前页逐字取真实片段；不会逐字
    // 扫描整章，也不会退回会在页底裁到字形的原滚动正文。
    const macPage=virtualSlice?macVirtualPageForSlice(virtualSlice):null;
    const rendered=!!(macPage&&renderVirtualScrollPage(macPage));
    if(rendered)scheduleMacVirtualPagePrefetch(virtualSlice);
    if(scroller){
      if(rendered){
        scroller.style.clipPath='none';scroller.style.setProperty("-webkit-clip-path",'none');
      }else{
        applyMacReadableScrollClip(virtualSlice,maskPort?maskPort.clientHeight:0);
      }
    }
    const diagSig=[curCh,pageInCh,rendered?1:0,macPage&&macPage.virtualLayout?macPage.virtualLayout.length:0,macPage&&macPage._rrFragmentCount||0].join('|');
    if(diagSig!==macPageRenderDiagSig){
      macPageRenderDiagSig=diagSig;
      parent.postMessage({readerPerf:'mac_page_render chapter='+curCh+' page='+(pageInCh+1)+' virtual='+(rendered?1:0)
        +' items='+(macPage&&macPage.virtualLayout?macPage.virtualLayout.length:0)
        +' exact='+(macPage&&macPage._rrExactLineCount||0)+' fragments='+(macPage&&macPage._rrFragmentCount||0)
        +' nodes='+(virtualPage instanceof HTMLElement&&'_rrRenderNodeCount' in virtualPage?Number((virtualPage as ReaderPreviewElement)._rrRenderNodeCount)||0:0)},'*');
    }
    refreshHighlights();
    return;
  }
  // 图片恰好跨越分页底部时，不能在原始滚动正文上叠一张预览图：原书的
  // 浮动/绝对定位图片会让文字继续排在图旁或图下。此时使用分页器已经算好的
  // virtualLayout 重绘本页：只绘制图片前的正文，再把剩余空间交给图片预览。
  // 下一页仍从原图片本身开始，因而会显示完整原图。
  const virtualPreview=virtualSlice?scrollPagePreviewCandidate(virtualSlice,maskTop,maskPort?maskPort.clientHeight:0):null;
  if(virtualSlice&&virtualPreview){
    // 图片既可能跨过页底，也可能恰好从下一页起点开始。两种情况都必须使用
    // 虚拟页，否则后一种会退回旧覆盖层并让原正文从图片下方穿过。
    const virtualPageSlice=virtualSlice.previewItem===virtualPreview?virtualSlice:Object.assign({},virtualSlice,{previewItem:virtualPreview,previewIndex:virtualSlice.nextIndex});
    renderVirtualScrollPage(virtualPageSlice);
    if(virtualPage&&virtualPage.style.display==='block'){
      if(scroller){scroller.style.clipPath='none';scroller.style.setProperty("-webkit-clip-path",'none');}
      refreshHighlights();
      return;
    }
  }
  const clipInsets=currentScrollPageClipInsets();
  const viewH=Math.max(1,maskPort?maskPort.clientHeight:window.innerHeight||1);
  const topBlank=Math.max(0,Math.min(viewH-1,Math.round(clipInsets.top||0)));
  let blank=clipInsets.bottom;
  applyScrollImagePreview();
  const previewBlank=scrollPreview&&scrollPreview.style.display!=='none'
    ?Math.max(0,Number(scrollPreview._rrReservedBlank)||0):0;
  blank=Math.max(blank,previewBlank);
  blank=Math.max(0,Math.min(Math.max(0,viewH-topBlank-1),Math.round(blank||0)));
  if(scroller){
    if(topBlank>1||blank>1){
      const clip='inset('+topBlank+'px 0px '+blank+'px 0px)';
      scroller.style.clipPath=clip;
      scroller.style.setProperty("-webkit-clip-path",clip);
    }else{
      scroller.style.clipPath='none';
      scroller.style.setProperty("-webkit-clip-path",'none');
    }
  }
  // 仅记录分页几何，便于区分“逻辑页跳过了首条注文”与“后续重排改变了
  // 原始行位置”。不读取或发送正文、DOM 路径、链接、书籍文件或账户信息。
  const maskItems=scrollPageItems();
  const tailIndex=maskSlice&&typeof maskSlice.endIndex==='number'?maskSlice.endIndex:-1;
  const nextIndex=maskSlice&&typeof maskSlice.nextIndex==='number'?maskSlice.nextIndex:-1;
  const tailItem=tailIndex>=0&&tailIndex<maskItems.length?maskItems[tailIndex]:null;
  const nextItem=nextIndex>=0&&nextIndex<maskItems.length?maskItems[nextIndex]:null;
  const tailBottom=tailItem?Math.round((tailItem.bottom||0)-maskTop):-1;
  const nextTop=nextItem?Math.round((nextItem.top||0)-maskTop):-1;
  const nextBottom=nextItem?Math.round((nextItem.bottom||0)-maskTop):-1;
  // 使用统一的页内记录器，避免页面重载期间的裸 postMessage 被外层遗漏。
  readerBugTrace('scroll_mask',topBlank>1||blank>1?'clip_applied':'clear',null,{
    scroll_top:maskTop,
    scroll_view_height:Math.max(0,Math.round(maskPort?maskPort.clientHeight:0)),
    scroll_content_height:Math.max(0,Math.round(root.scrollHeight||0)),
    scroll_item_count:maskItems.length,
    scroll_slice_start:maskSlice&&typeof maskSlice.startIndex==='number'?maskSlice.startIndex:-1,
    scroll_slice_end:maskSlice&&typeof maskSlice.endIndex==='number'?maskSlice.endIndex:-1,
    scroll_slice_next:maskSlice&&typeof maskSlice.nextIndex==='number'?maskSlice.nextIndex:-1,
    scroll_slice_top:maskSlice?Math.round(maskSlice.top||0):-1,
    scroll_slice_bottom:maskSlice?Math.round(maskSlice.bottom||0):-1,
    scroll_mask_top:topBlank,
    scroll_mask_blank:Math.max(0,Math.round(blank)),
    scroll_clip_active:topBlank>1||blank>1,
    scroll_tail_bottom:tailBottom,
    scroll_tail_overflow:tailBottom>=0?tailBottom-Math.round(maskPort?maskPort.clientHeight:0):-1,
    scroll_next_top:nextTop,
    scroll_next_bottom:nextBottom,
    scroll_next_overflow:nextBottom>=0?nextBottom-Math.round(maskPort?maskPort.clientHeight:0):-1,
    scroll_page_tolerance:clickPagedBottomOverflowTolerancePx(),
    scroll_page_guard:Math.max(2,Math.ceil(lineHeightPx()*0.08)),
    scroll_break_count:scrollBreaks.length,
    scroll_break_last:scrollBreaks.length?Math.round(scrollBreaks[scrollBreaks.length-1]||0):0
  });
  refreshHighlights();
}
function applyMacReadableScrollClip(slice: ReaderScrollSlice|null,viewH: number): void{
  if(!scroller)return;
  viewH=Math.max(1,viewH||scroller.clientHeight||window.innerHeight||1);
  const rawBottom=slice&&slice.virtualBottom;
  // 从自由滚动首次切回点击分页时，实时切片过去没有 virtualBottom。
  // 把“未知”当成 0 会生成接近整屏高度的底部 clip-path，正文实际已经
  // 滚到新页却被全部裁掉；用户轻微滚动关闭遮罩后才重新出现。几何未知时
  // 必须保留原正文，不能用一个推测值裁切整页。
  if(typeof rawBottom!=='number'||!isFinite(rawBottom)||rawBottom<=0){
    scroller.style.clipPath='none';scroller.style.setProperty("-webkit-clip-path",'none');
    return;
  }
  const lh=lineHeightPx(),bottom=Math.max(0,rawBottom);
  // 退化测量期间宁可少显示末行，也绝不显示半个字；下一次点击从该完整行的
  // 后续行开始。未得到切片时留出一整行，防止短暂重排露出切字。
  const visibleBottom=Math.max(0,Math.min(viewH,bottom+Math.max(3,Math.ceil(lh*0.14))));
  const blank=slice?Math.max(0,Math.ceil(viewH-visibleBottom)):Math.ceil(lh*1.15);
  if(blank>1){
    scroller.style.clipPath='inset(0px 0px '+blank+'px 0px)';
    scroller.style.setProperty("-webkit-clip-path",'inset(0px 0px '+blank+'px 0px)');
  }else{
    scroller.style.clipPath='none';scroller.style.setProperty("-webkit-clip-path",'none');
  }
}
function currentScrollPageClipInsets(): {top:number;bottom:number}{
  if(!isScrollMode()||!scrollPagedView||!pager||!root)return {top:0,bottom:0};
  const sp=scrollPort();
  if(!sp)return {top:0,bottom:0};
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  const top=Math.round(sp.scrollTop||0);
  const pr=viewRect();
  let maskTop=0,maskBlank=0;
  const pageBottom=top+viewH;
  const slice=activeScrollSliceAtTop(top);
  // scrollPageItems 已在章节首次排版时生成并缓存。直接在当前页附近查找跨越页底
  // 的文本行，避免每次翻页再次调用 documentTextLineRects 扫描整章 DOM。
  const items=scrollPageItems();
  let scanStart=0,scanEnd=items.length;
  if(slice){
    scanStart=Math.max(0,Math.min(items.length,slice.startIndex||0)-2);
    scanEnd=Math.min(items.length,Math.max(slice.endIndex||0,slice.nextIndex||0)+3);
  }else if(items.length){
    let lo=0,hi=items.length;
    while(lo<hi){const mid=(lo+hi)>>1,midItem=items[mid];if(midItem&&(midItem.bottom||0)<=pageBottom)lo=mid+1;else hi=mid;}
    scanStart=Math.max(0,lo-3);scanEnd=Math.min(items.length,lo+4);
  }
  for(let i=scanStart;i<scanEnd;i++){
    const ln=items[i];
    if(!ln||ln.type!=='line')continue;
    if(ln.top<top-0.5&&ln.bottom>top+0.5)maskTop=Math.max(maskTop,Math.ceil(ln.bottom-top+1));
    if(ln.top>=pageBottom-1)break;
    if(ln.bottom>pageBottom+0.5){maskBlank=Math.max(maskBlank,Math.ceil(pageBottom-ln.top+1));break;}
  }
  // Cached chapter geometry is used for navigation, but Chromium can update a
  // glyph run after that cache was built.  In click-paged scroll mode the
  // visible edge must always be checked against the live Range rectangles:
  // retaining a stale "complete" result is what lets half a glyph escape.
  if(maskTop<=1||maskBlank<=1){
    const lines=visibleTextLineRects(0,Math.ceil(lineHeightPx()*0.4));
    for(let j=0;j<lines.length;j++){
      const vl=lines[j];
      if(!vl)continue;
      if(vl.top<pr.top-0.5&&vl.bottom>pr.top+0.5)maskTop=Math.max(maskTop,Math.ceil(vl.bottom-pr.top+1));
      if(vl.top<pr.bottom-0.5&&vl.bottom>pr.bottom+clickPagedBottomOverflowTolerancePx())maskBlank=Math.max(maskBlank,Math.ceil(pr.bottom-vl.top+1));
    }
  }
  let blank=0;
  blank=Math.max(blank,maskBlank);
  if(slice){
    // Windows 保留原始滚动正文，不会像 macOS 一样以 virtualLayout 重绘每一行。
    // 压缩段间距后的虚拟页底部坐标若直接用作原 DOM 的
    // clip-path，页尾的第一条注文可能在上一页被遮住，而下一页已从第二条开始。
    // 此处只裁掉真实跨越视口边界的半行（maskBlank）；完整正文绝不能因虚拟页
    // 的几何优化而被隐藏。macOS 在 applyScrollPageMask 的前置分支中独立绘制。
    const bottom=Math.max(top,Math.min(top+viewH,Math.round(slice.bottom==null?top+viewH:slice.bottom)));
    const nextIdx=typeof slice.nextIndex==='number'?slice.nextIndex:-1;
    const next=nextIdx>=0&&nextIdx<items.length?items[nextIdx]:null;
    if(bottom<top+viewH-1){
      if(next&&next.type==='block'&&next.atomic&&!isPreviewableBlock(next)){
        blank=Math.max(blank,Math.ceil(top+viewH-bottom));
      }
    }
  }
  return {
    top:maskTop<=1?0:Math.max(0,Math.min(viewH-1,maskTop)),
    bottom:blank<=1?0:Math.max(0,Math.min(viewH-1,blank))
  };
}
function currentScrollPageClipBlank(){
  return currentScrollPageClipInsets().bottom;
}
function buildScrollBreaks(syncIndex = false): void{
  const sp=scrollPort();
  if(!isScrollMode()||!pager||!root||!sp){scrollBreaks=[0];scrollPages=[{top:0,bottom:0,nextTop:0,startIndex:0,endIndex:0,end:true}];return;}
  const oldTop=sp.scrollTop||0;
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  const contentH=Math.max(root.scrollHeight||0,sp.scrollHeight||0,viewH);
  const maxTop=Math.max(0,contentH-viewH);
  const items=scrollPageItems();
  const navMaxTop=items.length?readableNavMaxTop(items,maxTop):Math.max(0,maxTop);
  const sig=[curCh,layoutSig(),contentH,viewH,navMaxTop,items.length,root.querySelectorAll('img,svg,canvas,table,figure,video').length].join('|');
  if(sig===scrollBreakSig&&scrollBreaks.length&&scrollPages.length){
    pagesInCh=scrollBreaks.length;
    if(syncIndex)pageInCh=pageIndexForScrollTop(oldTop);
    applyScrollPageMask();
    return;
  }
  scrollActiveSlice=null;
  scrollPages=[];scrollBreaks=[];
  if(!items.length){
    scrollBreaks=[0];scrollPages=[{top:0,bottom:viewH,nextTop:0,startIndex:0,endIndex:0,end:true}];
    scrollBreakSig=sig;pagesInCh=1;if(syncIndex)pageInCh=0;applyScrollPageMask();return;
  }
  let guard=0,startIdx=0,lastTop=-999999;
  while(startIdx<items.length&&guard++<3000){
    const page=buildVirtualPageFromIndex(items,startIdx,viewH,navMaxTop);
    const pageTop=page.top,nextIdx=page.nextIndex??items.length,isEnd=page.end;
    if(!scrollBreaks.length||Math.abs(pageTop-lastTop)>2){
      scrollBreaks.push(pageTop);scrollPages.push(page);lastTop=pageTop;
    }else{
      const prev=scrollPages[scrollPages.length-1];
      if(!prev)break;
      prev.bottom=Math.max(prev.bottom,page.bottom);
      prev.endIndex=Math.max(prev.endIndex??0,page.endIndex??0);
      if(page.nextIndex!==undefined)prev.nextIndex=page.nextIndex;
      if(page.nextTop!==undefined)prev.nextTop=page.nextTop;
      if(page.previewIndex!==undefined)prev.previewIndex=page.previewIndex;
      if(page.previewItem!==undefined)prev.previewItem=page.previewItem;
      if(page.virtualLayout!==undefined)prev.virtualLayout=page.virtualLayout;
      if(page.virtualBottom!==undefined)prev.virtualBottom=page.virtualBottom;
      if(page.end!==undefined)prev.end=page.end;
    }
    if(isEnd)break;
    if(nextIdx<=startIdx)break;
    startIdx=nextIdx;
  }
  if(!scrollBreaks.length){scrollBreaks=[0];scrollPages=[{top:0,bottom:viewH,nextTop:maxTop,startIndex:0,endIndex:items.length-1,end:true}];}
  scrollBreakSig=sig;
  pagesInCh=scrollBreaks.length;
  if(syncIndex)pageInCh=pageIndexForScrollTop(oldTop);
  readerBugTrace('scroll_layout','rebuilt',null,{
    scroll_top:Math.round(oldTop),
    scroll_view_height:Math.round(viewH),
    scroll_content_height:Math.round(contentH),
    scroll_item_count:items.length,
    scroll_break_count:scrollBreaks.length,
    scroll_break_last:Math.round(scrollBreaks[scrollBreaks.length-1]||0),
    scroll_page_tolerance:clickPagedBottomOverflowTolerancePx(),
    scroll_page_guard:Math.max(2,Math.ceil(lineHeightPx()*0.08))
  });
  applyScrollPageMask();
}
function buildLinePagedBreaks(lines: readonly ReaderLineRect[],topPad: number,viewH: number,maxTop: number): number[]{
  if(!lines||!lines.length)return [0];
  const lh=lineHeightPx();
  let breaks=[0],curTop=0;
  const minAdvance=Math.max(2,lh*0.35);
  let guard=0;
  while(guard++<2000){
    const bottom=curTop+viewH-2;
    let nextIdx=null;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];if(line&&line.bottom>bottom){
        nextIdx=i;
        break;
      }
    }
    if(nextIdx==null)break;
    let next: number|null=scrollTopForLineIndex(lines,nextIdx,topPad);
    if(next<=curTop+minAdvance){
      next=null;
      const minTop=curTop+Math.max(lh*3,viewH*0.55);
      for(let j=nextIdx+1;j<lines.length;j++){
        const t=scrollTopForLineIndex(lines,j,topPad);
        if(t>=minTop){next=t;break;}
      }
      if(next==null)break;
    }
    next=Math.max(0,Math.min(maxTop,next));
    if(next<=curTop+minAdvance)break;
    const previousBreak=breaks[breaks.length-1];
    if(previousBreak!==undefined&&Math.abs(next-previousBreak)<=2)break;
    breaks.push(Math.round(next));
    curTop=next;
    if(curTop>=maxTop-2)break;
  }
  return breaks.length?breaks:[0];
}
function trimScrollBottomToWholeLine(){
  return 0;
}
function canLeaveScrollChapter(dir: ReaderDirection): boolean{
  if(!pager)return false;
  buildScrollBreaks(false);
  if(!scrollBreaks.length)return true;
  const port=scrollPort();if(!port)return false;const cur=port.scrollTop||0;
  const eps=Math.max(3,lineHeightPx()*0.25);
  const idx=pageIndexForScrollTop(cur);
  if(dir>0){
    return idx>=scrollBreaks.length-1&&cur>=(scrollBreaks[idx]||0)-eps;
  }
  if(dir<0){
    return idx<=0&&cur<=(scrollBreaks[0]||0)+eps;
  }
  return false;
}
function snapScrollToReadableLine(dir: ReaderDirection): void{
  if(!isScrollMode()||!pager||!root)return;
  const maxTop=scrollMaxTop();
  const port=scrollPort();if(!port||port.scrollTop<=1||port.scrollTop>=maxTop-1)return;
  const pr=viewRect();
  const lines=visibleTextLineRects();
  if(!lines.length)return;
  let topLine=null;
  for(let i=0;i<lines.length;i++){const line=lines[i];if(line&&line.bottom>pr.top+2){topLine=line;break;}}
  if(!topLine)return;
  const tolerance=2;
  const lh=lineHeightPx();
  if(topLine.top<pr.top-tolerance){
    const delta=(dir<0)?topLine.top-pr.top:topLine.bottom-pr.top+Math.max(1,lh*0.08);
    port.scrollTop=Math.max(0,Math.min(maxTop,port.scrollTop+delta));
    applyScrollPageMask();
  }else if(topLine.top>pr.top+lh*0.85){
    port.scrollTop=Math.max(0,Math.min(maxTop,port.scrollTop+(topLine.top-pr.top)));
    applyScrollPageMask();
  }
}
function syncScrollPageFromTop(){
  if(!usesLineBreakPaging()||!pager)return;
  const sp=scrollPort();
  if(!sp)return;
  const top=Math.round(sp.scrollTop||0);
  if(Date.now()<scrollProgrammaticUntil||(scrollProgrammaticTarget!=null&&Math.abs(top-scrollProgrammaticTarget)<=2)){
    if(scrollPagedView)applyScrollPageMask();
    return;
  }
  if(scrollPagedView){
    buildScrollBreaks(false);
    const idx=pageIndexForScrollTop(top);
    const breakTop=Math.round(scrollBreaks[idx]||0);
    if(Math.abs(breakTop-top)<=Math.max(3,Math.ceil(lineHeightPx()*0.20))){
      pageInCh=idx;
      scrollActiveSlice=scrollPages[idx]||scrollActiveSlice;
      applyScrollPageMask();
      return;
    }
  }
  scrollProgrammaticTarget=null;
  scrollActiveSlice=null;
  scrollPagedView=false;
  applyScrollPageMask();
  const old=pageInCh;
  buildScrollBreaks(true);
  pageInCh=pageIndexForScrollTop(top);
  if(old!==pageInCh)report();
  if(scrollCaptureTimer)clearTimeout(scrollCaptureTimer);
  scrollCaptureTimer=setTimeout(function(){captureAnchor();report(true);},160);
}
function scrollTopForLine(line: ReaderLineRect|null|undefined,topPad: number): number{
  return Math.max(0,Math.min(scrollMaxTop(),Math.round((line?line.top:0)-topPad)));
}
function scrollTopForLineIndex(lines: readonly ReaderLineRect[],idx: number,topPad: number): number{
  if(!lines||!lines.length)return 0;
  idx=Math.max(0,Math.min(lines.length-1,idx||0));
  return scrollTopForLine(lines[idx],topPad);
}
function scrollTopForItemIndex(items: readonly ReaderPageFlowItem[],idx: number,topPad: number): number{
  if(!items||!items.length)return 0;
  idx=Math.max(0,Math.min(items.length-1,idx||0));
  const item=items[idx];
  return Math.max(0,Math.min(scrollMaxTop(),Math.round((item?item.top:0)-topPad)));
}
function scrollLineIndexAtTop(lines: readonly ReaderLineRect[],cur: number,topPad: number): number{
  if(!lines||!lines.length)return 0;
  const y=(cur||0)+topPad+1;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(line&&line.bottom>y)return i;
  }
  return Math.max(0,lines.length-1);
}
function scrollItemIndexAtTop(items: readonly ReaderPageFlowItem[],cur: number,topPad: number): number{
  if(!items||!items.length)return 0;
  const y=(cur||0)+topPad+1;
  for(let i=0;i<items.length;i++){
    const item=items[i];if(item&&item.bottom>y)return i;
  }
  return Math.max(0,items.length-1);
}
function scrollSnapTopForTarget(lines: readonly ReaderLineRect[],target: number,topPad: number): number{
  target=Math.max(0,Math.min(scrollMaxTop(),target||0));
  if(!lines||!lines.length)return target;
  const lh=lineHeightPx();
  const idx=scrollLineIndexAtTop(lines,target,topPad);
  let snapped=scrollTopForLineIndex(lines,idx,topPad);
  if(snapped<target-lh*0.75){
    for(let i=idx+1;i<lines.length;i++){
      const t=scrollTopForLineIndex(lines,i,topPad);
      if(t>=target-lh*0.2){snapped=t;break;}
    }
  }
  return Math.max(0,Math.min(scrollMaxTop(),snapped));
}
function scrollVisibleLineCount(lines: readonly ReaderLineRect[],cur: number,topPad: number): number{
  if(!lines||!lines.length||!pager)return 1;
  const top=(cur||0)+topPad+1;
  const bottom=(cur||0)+scrollVisualHeight()-2;
  let n=0;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(!line)continue;
    if(line.bottom<=top)continue;
    if(line.top>=bottom)break;
    n++;
  }
  return Math.max(3,n);
}
function scrollNextLineIndex(lines: readonly ReaderLineRect[],cur: number,topPad: number,topIdx?: number|null): number|null{
  if(!lines||!lines.length||!pager)return null;
  topIdx=Math.max(0,Math.min(lines.length-1,topIdx==null?scrollLineIndexAtTop(lines,cur,topPad):topIdx));
  const viewH=scrollVisualHeight();
  const lh=lineHeightPx();
  const bottom=(cur||0)+viewH-2;
  let targetIdx=null;
  for(let i=topIdx;i<lines.length;i++){
    const line=lines[i];if(line&&line.bottom>bottom){
      targetIdx=i;
      break;
    }
  }
  if(targetIdx==null)return null;
  if(targetIdx<=topIdx){
    const n=scrollVisibleLineCount(lines,cur,topPad);
    targetIdx=Math.min(lines.length-1,topIdx+Math.max(1,n-1));
  }
  const targetTop=scrollTopForLineIndex(lines,targetIdx,topPad);
  if(targetIdx<=topIdx+1||targetTop<=(cur||0)+Math.max(lh*3,viewH*0.28)){
    const minTop=(cur||0)+Math.max(lh*4,viewH*0.62);
    let fallback=null;
    for(let k=Math.max(topIdx+1,targetIdx+1);k<lines.length;k++){
      if(scrollTopForLineIndex(lines,k,topPad)>=minTop){fallback=k;break;}
    }
    if(fallback==null)return null;
    targetIdx=fallback;
  }
  return targetIdx;
}
function updateScrollPageAfterProgrammatic(){
  buildScrollBreaks(true);
  const port=scrollPort();scrollProgrammaticTarget=pager&&port?Math.round(port.scrollTop||0):scrollProgrammaticTarget;
  pageInCh=pageIndexForScrollTop(pager&&port?port.scrollTop||0:0);
  captureAnchor();
  report(true);
  scheduleNoteNumberDisplayRefresh();
}
function firstLineAfter(lines: readonly ReaderLineRect[],y: number): ReaderLineRect|null{
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(line&&line.bottom>y)return line;
  }
  return null;
}
function firstLineStartingAtOrAfter(lines: readonly ReaderLineRect[],y: number): ReaderLineRect|null{
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(line&&line.top>=y-1)return line;
  }
  return null;
}
function liveNextScrollTop(){
  if(!pager)return null;
  buildScrollBreaks(false);
  const port=scrollPort();if(!port)return null;const cur=port.scrollTop||0;
  const eps=Math.max(2,lineHeightPx()*0.20);
  const idx=pageIndexForScrollTop(cur);
  for(let i=Math.max(0,idx+1);i<scrollBreaks.length;i++){
    if((scrollBreaks[i]||0)>cur+eps)return Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[i]||0));
  }
  return null;
}
function livePrevScrollTop(){
  if(!pager)return null;
  buildScrollBreaks(true);
  const port=scrollPort();if(!port)return null;const cur=port.scrollTop||0;
  const eps=Math.max(2,lineHeightPx()*0.20);
  const idx=pageIndexForScrollTop(cur);
  if(idx>0)return Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[idx-1]||0));
  for(let i=scrollBreaks.length-1;i>=0;i--){
    if((scrollBreaks[i]||0)<cur-eps)return Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[i]||0));
  }
  return null;
}
let sameBookResumeReportDetail: ReaderSameBookResumeReport|null=null;
function report(commitPosition = false,restoredPosition = false,positionSnapshotRequestId: string|number = 0): void{
  if(initialResumePending)return;
  let useScrollPagesForReport=false;
  if(isScrollMode()&&pager){
    buildScrollBreaks(true);
    const port=scrollPort();pageInCh=pageIndexForScrollTop(port?port.scrollTop||0:0);
    useScrollPagesForReport=true;
    var chFrac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
  }else{
    var chFrac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
  }
  const measuredChapterPages=chapterPages[curCh];
  const progressPagesInCh=(measureDone&&measuredChapterPages)?measuredChapterPages:Math.max(1,pagesInCh||1);
  // 双页展示一次翻两页，但右上角仍显示左页在整本书中的真实页码（1、3、5…）。
  const progressPage=isDualPage()&&!useScrollPagesForReport
    ?Math.min(Math.max(0,progressPagesInCh-1),pageInCh*2+dualStartColumn)
    :Math.round(chFrac*Math.max(0,progressPagesInCh-1));
  let gP=0,gT=0;
  if(measureDone){
    for(let i=0;i<CH;i++)gT+=chapterPages[i]||1;
    for(let j=0;j<curCh;j++)gP+=chapterPages[j]||1;
    gP+=progressPage+1;
  }
  // 进度优先按“整书页位置”算（章节大小不均时仍平滑）；未测量完再退回按章节估算
  // 用 0 基：首页(gP=1)=0%、末页(gP=gT)=100%
  let prog;
  if(measureDone&&gT>0)prog=gT>1?((gP-1)/(gT-1))*100:0;
  else prog=CH>0?((curCh+chFrac)/CH)*100:0;
  const L=computeLogical();
  const pageChars=pagesInCh>0?Math.round(chapChars/pagesInCh):chapChars; // 当前页约略字数（按本章字数/页数均摊）
  parent.postMessage({chapter:curCh,chFrac:chFrac,page:pageInCh+1,total:pagesInCh,totalCh:CH,progress:prog,gPage:gP,gTotal:gT,logicalCh:L.lc,logicalTotal:L.lt,pageChars:pageChars,dualContinuationChapter:visibleDualContinuationChapter(),anchor:persistentReadingAnchor(),positionCommit:commitPosition?1:0,positionRestored:restoredPosition?1:0,positionSnapshotRequestId:positionSnapshotRequestId||0,sameBookResumeState:restoredPosition?sameBookResumeReportDetail:null},'*');
  if(restoredPosition)sameBookResumeReportDetail=null;
  // 注意：不在这里记录锚点。report() 也会被 relayout() 调到；若每次都重取锚点，
  // 拖动字号滑块时会把“重排后已偏移的顶部”当成新锚点，逐步累积漂移→整页跑掉。
  // 锚点只在用户“导航”（翻页/跳章/跳搜索命中）时更新，见 captureAnchor()。
}
// 记录当前页顶部锚点（精确到字符）。仅在用户主动导航后调用，供之后的重排锁定位置。
function captureAnchor(){
  let anchor=topAnchor();
  const rect=anchorRect(anchor),view=viewRect();
  const leadingRight=view?(isDualPage()?view.left+view.width/2:view.right):0;
  const visible=!!(rect&&view&&rect.bottom>view.top+1&&rect.top<view.bottom-1&&rect.right>view.left+1&&rect.left<leadingRight-1);
  // caretRangeFromPoint 落在题图或大块留白附近时，WebView2 偶尔返回屏幕外
  // 分栏中的最近文本。只接受当前左页内的锚点，否则从真实可见行重新采样。
  if(!visible)anchor=visibleTopTextAnchor()||anchor;
  if(anchorValid(anchor))curTopAnchor=anchor;
  modeSwitchRecoveryOffset=null;
  return curTopAnchor;
}
// 滚动条按“全书页位置”精确定位：已测量完→映射到具体章+页（同章直接翻页，平滑；跨章才加载）；
// 未测量完→退回按章节粗跳。这样点滑块附近不再原地跳，拖动也能平滑跟随。
function gotoGlobalFrac(frac: number): void{
  frac=Math.max(0,Math.min(1,frac));
  if(measureDone){
    let gt=0,i;for(i=0;i<CH;i++)gt+=chapterPages[i]||1;if(gt<1)gt=1;
    let gp=Math.round(frac*(gt-1)),acc=0,tc=CH-1,tp=0;
    for(i=0;i<CH;i++){const cp=chapterPages[i]||1;if(gp<acc+cp){tc=i;tp=gp-acc;break;}acc+=cp;}
    const displayPage=isDualPage()?Math.floor(Math.max(0,tp-dualStartColumn)/2):tp;
    if(tc===curCh)gotoPage(displayPage);else showChapter(tc,displayPage);
  }else{
    showChapter(Math.min(CH-1,Math.floor(frac*CH)),'start');
  }
}
function gotoPage(p: number,dir: ReaderDirection = 1): void{
  const next=Math.max(0,Math.min(pagesInCh-1,p));
  if(usesLineBreakPaging())scrollPagedView=true;
  beginTurnFx(dir,function(){
    pageInCh=next;
    setViewOffset();
    if(usesLineBreakPaging()){
      syncScrollPageFromTop();
    }
    captureAnchor();report(true);notifyReaderEndIfReached(dir);scheduleNoteNumberDisplayRefresh();
    stabilizeProgrammaticViewPaint();
  });
}
function filterTextLines<T extends ReaderVisibleLineRect>(lines: readonly T[]): T[]{
  if(!lines||!lines.length)return [];
  const heights=lines.map(function(x: T){return x.height||0;}).filter(function(x: number){return x>2;}).sort(function(a: number,b: number){return a-b;});
  const median=heights[Math.floor(heights.length/2)]||lineHeightPx();
  const maxLineHeight=median*1.9;
  return lines.filter(function(x: T){return x.height<=maxLineHeight;}).sort(function(a: T,b: T){return a.top-b.top||a.bottom-b.bottom;});
}
function filteredVisibleLines(){
  return filterTextLines(visibleTextLineRects());
}
function filteredDocumentLines(){
  return filterTextLines(documentTextLineRects());
}
function firstDocumentLineAfter(y: number): ReaderLineRect|null{
  const lines=filteredDocumentLines();
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(line&&line.top>=y-1)return line;
  }
  return null;
}
function scrollTargetFromVisibleLines(dir: ReaderDirection): number|null{
  const sp=scrollPort();
  if(!pager||!root||!sp)return null;
  const cur=sp.scrollTop||0;
  return scrollNextTopFromDocument(cur,dir);
}
function scrollSliceFromStartIndex(items: readonly ReaderPageFlowItem[],startIdx: number): ReaderScrollSlice|null{
  const sp=scrollPort();
  if(!sp||!items||!items.length)return null;
  startIdx=Math.max(0,Math.min(items.length-1,startIdx||0));
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  const maxTop=scrollMaxTop();
  const navMaxTop=items.length?readableNavMaxTop(items,maxTop):maxTop;
  const bottomGuard=Math.max(2,Math.ceil(lineHeightPx()*0.08)),bottomTolerance=clickPagedBottomOverflowTolerancePx();
  // `startIdx` is the first original line not consumed by the preceding page.
  // Do not move it backwards merely because adjacent glyph bounding boxes touch:
  // that turns the previous page's final full line into this page's first line.
  // A genuine partial line above this exact source start is handled by the mask.
  const pageTop=scrollPageTopForStartItem(items,startIdx,navMaxTop,0);
  const hardBottom=pageTop+viewH-bottomGuard+bottomTolerance;
  let endIdx=startIdx-1;
  for(let i=startIdx;i<items.length;i++){
    const item=items[i];if(item&&item.bottom<=hardBottom+0.5){endIdx=i;continue;}
    break;
  }
  if(endIdx<startIdx)endIdx=startIdx;
  const rawNextIdx=endIdx+1;
  const pageBottom=pageBottomForSlice(pageTop,viewH,items[endIdx]||null,items[rawNextIdx]||null,bottomGuard);
  let nextIdx=firstUnfinishedScrollItemIndex(items,startIdx,pageBottom+bottomTolerance);
  if(nextIdx<=startIdx)nextIdx=Math.max(rawNextIdx,startIdx+1);
  const lastVisible=items[endIdx]||null;
  const virtualBottom=lastVisible
    ?Math.max(0,Math.min(viewH,Math.ceil((lastVisible.bottom||pageTop)-pageTop)))
    :0;
  return {top:pageTop,bottom:pageBottom,index:pageIndexForScrollTop(pageTop),startIndex:startIdx,endIndex:endIdx,nextIndex:nextIdx,virtualBottom:virtualBottom,end:nextIdx>=items.length};
}
function firstVisibleScrollItemIndex(items: readonly ReaderPageFlowItem[],top: number): number{
  if(!items||!items.length)return -1;
  const eps=Math.max(2,Math.ceil(lineHeightPx()*0.12));
  for(let i=0;i<items.length;i++){const item=items[i];if(item&&item.bottom>top+eps)return i;}
  return items.length-1;
}
function scrollPrevSliceFromVisibleTop(items: readonly ReaderPageFlowItem[],top: number): ReaderScrollSlice|null{
  const sp=scrollPort();
  if(!sp||!items||!items.length)return null;
  const firstIdx=firstVisibleScrollItemIndex(items,top);
  if(firstIdx<=0)return null;
  const endIdx=firstIdx-1;
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  const maxTop=scrollMaxTop();
  const navMaxTop=items.length?readableNavMaxTop(items,maxTop):maxTop;
  const bottomGuard=Math.max(2,Math.ceil(lineHeightPx()*0.08));
  const endItem=items[endIdx];if(!endItem)return null;
  const desiredBottom=endItem.bottom+bottomGuard;
  const minTop=desiredBottom-viewH;
  let startIdx=endIdx;
  while(startIdx>0){const previousItem=items[startIdx-1];if(previousItem&&previousItem.top>=minTop-0.5)startIdx--;else break;}
  const aligned=scrollAlignedPageStart(items,startIdx,navMaxTop,0);
  startIdx=aligned.startIdx;
  const pageTop=aligned.pageTop;
  const pageBottom=pageBottomForSlice(pageTop,viewH,endItem,items[firstIdx]||null,bottomGuard);
  return {top:pageTop,bottom:pageBottom,index:pageIndexForScrollTop(pageTop),startIndex:startIdx,endIndex:endIdx,nextIndex:firstIdx,end:false};
}
function scrollNextSliceFromVisiblePage(items: readonly ReaderPageFlowItem[],top: number): ReaderScrollSlice|null{
  const sp=scrollPort();
  if(!sp||!items||!items.length)return null;
  const firstIdx=firstVisibleScrollItemIndex(items,top);
  if(firstIdx<0)return null;
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  const bottomGuard=Math.max(2,Math.ceil(lineHeightPx()*0.08)),bottomTolerance=clickPagedBottomOverflowTolerancePx();
  const hardBottom=top+viewH-bottomGuard+bottomTolerance;
  let endIdx=firstIdx-1;
  for(let i=firstIdx;i<items.length;i++){
    const item=items[i];if(item&&item.bottom<=hardBottom+0.5){endIdx=i;continue;}
    break;
  }
  if(endIdx<firstIdx)return scrollSliceFromStartIndex(items,firstIdx);
  const rawNextIdx=endIdx+1;
  const pageBottom=pageBottomForSlice(top,viewH,items[endIdx]||null,items[rawNextIdx]||null,bottomGuard);
  let nextIdx=firstUnfinishedScrollItemIndex(items,firstIdx,pageBottom+bottomTolerance);
  if(nextIdx<=firstIdx)nextIdx=Math.max(rawNextIdx,firstIdx+1);
  if(nextIdx>=items.length)return null;
  return scrollSliceFromStartIndex(items,nextIdx);
}
function scrollSliceForNav(top: number,dir: ReaderDirection): ReaderScrollSlice|null{
  const items=scrollPageItems();
  if(!items.length)return scrollSliceFromCanonicalBreak(scrollBreakForNav(top,dir));
  const target=dir<0?scrollPrevSliceFromVisibleTop(items,top):scrollNextSliceFromVisiblePage(items,top);
  return target||scrollSliceFromCanonicalBreak(scrollBreakForNav(top,dir));
}
function scrollPageBy(dir: ReaderDirection): boolean{
  if(!isScrollMode()||!pager)return false;
  const sp=scrollPort();
  if(!sp)return false;
  const wasPaged=scrollPagedView;
  buildScrollBreaks(false);
  const cur=sp.scrollTop||0;
  let aligned=false;
  if(wasPaged&&scrollBreaks.length){
    const idx=pageIndexForScrollTop(cur);
    const breakTop=Math.round(scrollBreaks[idx]||0);
    aligned=Math.abs(breakTop-Math.round(cur))<=Math.max(3,Math.ceil(lineHeightPx()*0.20));
  }
  let target=(wasPaged&&aligned)?canonicalScrollSliceForNav(cur,dir):scrollSliceForNav(cur,dir);
  scrollPagedView=true;
  // 个别 EPUB 的可读行几何在图片/注释重排后会短暂缺一段，导致按正文
  // 推导的下一页为空。此时仍在当前章的已计算分页内，绝不能误判为跨章。
  // 先按稳定的章节分页兜底；只有真正停在首/末页时才允许进入相邻章节。
  const atChapterBoundary=canLeaveScrollChapter(dir);
  if(!target&&!atChapterBoundary){
    const currentIndex=pageIndexForScrollTop(cur);
    const fallbackIndex=Math.max(0,Math.min(scrollBreaks.length-1,currentIndex+(dir>0?1:-1)));
    if(fallbackIndex!==currentIndex)target=scrollSliceFromCanonicalBreak({index:fallbackIndex,top:scrollBreaks[fallbackIndex]||0});
  }
  if(!target){
    if(!atChapterBoundary){
      pageInCh=Math.max(0,Math.min(pagesInCh-1,pageIndexForScrollTop(cur)));
      captureAnchor();report(true);
      return true;
    }
    if(dir>0&&curCh<CH-1){beginChapterTurnFx(dir,curCh+1,'start');return true;}
    if(dir<0&&curCh>0){beginChapterTurnFx(dir,curCh-1,'end');return true;}
    notifyReaderEndIfReached(dir,dir>0);
    return true;
  }
  const next=Math.max(0,Math.min(scrollMaxTop(),Math.round(target.top||0)));
  if(Math.abs(next-cur)<2){
    if(dir>0&&curCh<CH-1&&canLeaveScrollChapter(1)){
      beginChapterTurnFx(dir,curCh+1,'start');
      return true;
    }
    if(dir<0&&curCh>0&&canLeaveScrollChapter(-1)){
      beginChapterTurnFx(dir,curCh-1,'end');
      return true;
    }
    pageInCh=Math.max(0,Math.min(pagesInCh-1,target.index||0));
    scrollActiveSlice=target;
    scrollProgrammaticTarget=next;
    applyScrollPageMask();
    captureAnchor();report(true);notifyReaderEndIfReached(dir);
    return true;
  }
  const stableTarget=target,stablePort=sp;
  beginTurnFx(dir,function(){
    pageInCh=Math.max(0,Math.min(pagesInCh-1,stableTarget.index||0));
    scrollActiveSlice=stableTarget;
    scrollProgrammaticUntil=Date.now()+180;
    scrollProgrammaticTarget=next;
    stablePort.scrollTop=next;
    settleVisibleScrollPagination();
    updateScrollPageAfterProgrammatic();
    notifyReaderEndIfReached(dir);
    stabilizeProgrammaticViewPaint();
  });
  return true;
}
function pageOf(el: ReaderRectProvider): number{
  const r=el.getBoundingClientRect(),pr=viewRect();
  if(usesLineBreakPaging()){
    const port=scrollPort(),y=r.top-pr.top+(port?port.scrollTop:0);
    buildScrollBreaks();
    return pageIndexForScrollTop(y);
  }
  const x=r.left-pr.left+viewOffset;
  if(isDualPage()){
    const pl=pageLayout(),physical=Math.max(0,Math.floor((x-pl.l+1)/pl.colPitch));
    return Math.max(0,Math.floor(Math.max(0,physical-dualStartColumn)/2));
  }
  return Math.floor((x+1)/pageStep);
}
// 将当前视口锚点转为可持久化的“源文本坐标”。它不携带物理页码，
// 所以字体、页宽、单双页、智读侧栏变化后仍能定位同一段文字。
function persistentReadingAnchor(){
  const anchor=anchorValid(curTopAnchor)?curTopAnchor:null;
  if(!anchor)return null;
  const offset=anchorTextOffset(anchor);
  if(offset==null)return null;
  const node=anchor.range?anchor.range.startContainer:(anchor.el||null);
  let el: Element|null=node instanceof Element?node:node?.parentElement||null;
  const parts=[];
  while(el&&el!==root&&parts.length<12){
    const parent=el.parentElement;
    if(!parent)break;
    let index=0,sibling=parent.firstElementChild;
    while(sibling&&sibling!==el){index++;sibling=sibling.nextElementSibling;}
    parts.unshift((el.tagName||'node').toLowerCase()+':'+index);
    el=parent;
  }
  const rect=anchorRect(anchor),view=viewRect();
  return {
    chapter:curCh,
    dom_path:parts.join('/'),
    text_offset:Math.max(0,Math.round(offset)),
    context_before:sourceTextAround(Math.max(0,offset-72),offset,0,0),
    context_after:sourceTextAround(offset,offset+112,0,0),
    viewport_offset:rect&&view?Math.max(0,Math.round(rect.top-view.top)):0
  };
}
function invalidateScrollBreaksSoon(){
  if(!isScrollMode())return;
  scrollBreakSig='';
  invalidateScrollItemsCache();
  setTimeout(function(){
    if(!isScrollMode()||!root)return;const port=scrollPort();if(!port)return;
    buildScrollBreaks(true);
    pageInCh=pageIndexForScrollTop(port.scrollTop||0);
    report();
  },80);
}
function refreshLayoutAfterMedia(){
  modeSwitchDiagEvent('media_refresh');
  invalidateScrollBreaksSoon();
  setTimeout(schedulePagedImagePreview,0);
}
function watchFlowMedia(){
  if(!root)return;
  const imgs=root.querySelectorAll<ReaderFlowElement>('img,svg,canvas,video');
  for(let i=0;i<imgs.length;i++){
    const el=imgs.item(i);
    if(el.__kpFlowWatch)continue;
    el.__kpFlowWatch=true;
    el.addEventListener('load',refreshLayoutAfterMedia,{once:false});
    el.addEventListener('error',refreshLayoutAfterMedia,{once:false});
    if(el instanceof HTMLImageElement&&el.complete&&el.naturalWidth>0)setTimeout(refreshLayoutAfterMedia,0);
  }
}
function activeReaderFontReady(): boolean{
  if(!document.fonts||typeof document.fonts.check!=='function')return false;
  try{
    const style=getComputedStyle(root),fontSize=Math.max(1,parseFloat(style.fontSize)||Number(S.fontSize)||18);
    const fontFamily=style.fontFamily||S.fontFamily||'serif';
    return document.fonts.check(fontSize+'px '+fontFamily,'中文Aa');
  }catch(_){return false;}
}
function waitForFlowResources(timeoutMs = 1600): Promise<void>{
  const jobs: Promise<void>[]=[],limit=Math.max(1,Number(timeoutMs)||1600);
  // EPUB 可能声明与当前正文无关、迟迟不结束的远端字体。活动字体已经可用时
  // 不等待整个 FontFaceSet；真正尚未就绪的正文字体仍保持原来的等待门禁。
  if(document.fonts&&document.fonts.ready&&!activeReaderFontReady())jobs.push(Promise.resolve(document.fonts.ready).then(function(){return;},function(){return;}));
  const imgs=root.querySelectorAll<HTMLImageElement>('img');
  for(let i=0;i<imgs.length;i++){
    var img=imgs.item(i);if(img.complete)continue;
    jobs.push(new Promise<void>(function(resolve){
      const target=img,done=function(){target.removeEventListener('load',done);target.removeEventListener('error',done);resolve();};
      target.addEventListener('load',done);target.addEventListener('error',done);
    }));
  }
  if(!jobs.length)return Promise.resolve();
  return Promise.race<void>([Promise.allSettled(jobs).then(function(){return;}),new Promise<void>(function(resolve){setTimeout(resolve,limit);})]);
}
function markNoteSeparators(){
  if(!root)return;
  if(!root.querySelector('hr'))return;
  const els=Array.from(root.querySelectorAll<Element>('*'));
  const noteMark=/^(?:[\[\(（]?\d+[\]\)）\.．、\s]|[①②③④⑤⑥⑦⑧⑨⑩])/;
  for(let i=0;i<els.length;i++){
    const hr=els[i];
    if(!hr)continue;
    if((hr.tagName||'').toLowerCase()!=='hr')continue;
    let next: Element|null=null;
    for(let j=i+1;j<els.length;j++){
      const candidate=els[j];if(!candidate)continue;
      if(hr.contains(candidate))continue;
      const txt=(candidate.textContent||'').replace(/\s+/g,' ').trim();
      if(txt){next=candidate;break;}
    }
    if(!next)continue;
    const meta=((hr.id||'')+' '+(hr.className||'')+' '+(hr.getAttribute('epub:type')||'')+' '+(next.id||'')+' '+(next.className||'')+' '+(next.getAttribute('epub:type')||'')).toLowerCase();
    const nextText=(next.textContent||'').replace(/\s+/g,' ').trim();
    if(/footnote|endnote|note|annotation|fn|注|註/.test(meta)||noteMark.test(nextText)){
      hr.classList.add('rr-note-sep');
    }
  }
}
function isExistingNoteNumberText(text: string): boolean{
  return /^(?:\s*(?:\d{1,3}[\.\、．)]|[\(（]\d{1,3}[\)）]|[①②③④⑤⑥⑦⑧⑨⑩]))/.test(text||'');
}
function noteEntryText(el: Element|null): string{
  return (el&&el.textContent||'').replace(/\s+/g,' ').trim();
}
function isNoteEntryElement(el: Element|null): boolean{
  if(!el||el.nodeType!==1)return false;
  if(el.classList&&(el.classList.contains('rr-end')||el.classList.contains('rr-note-num')))return false;
  const tag=(el.tagName||'').toLowerCase();
  if(tag==='script'||tag==='style'||tag==='hr')return false;
  if(!noteEntryText(el))return false;
  return /^(p|li|dd|dt|a|div|blockquote|aside|section)$/i.test(tag);
}
function directNoteEntries(container: Element|null): Element[]{
  const out: Element[]=[];
  if(!container||!container.children)return out;
  for(let i=0;i<container.children.length;i++){
    const child=container.children.item(i);
    if(child&&isNoteEntryElement(child))out.push(child);
  }
  return out;
}
function isNoteListElement(el: Element|null): el is HTMLOListElement|HTMLUListElement{
  if(!el||el.nodeType!==1)return false;
  const tag=(el.tagName||'').toLowerCase();
  return tag==='ol'||tag==='ul';
}
function directListNoteItems(list: Element|null): HTMLLIElement[]{
  const out: HTMLLIElement[]=[];
  if(!list||!list.children)return out;
  for(let i=0;i<list.children.length;i++){
    const child=list.children.item(i);
    if(child instanceof HTMLLIElement&&noteEntryText(child))out.push(child);
  }
  return out;
}
function addNoteNumber(el: Element|null,num: number): boolean{
  if(!el||el.nodeType!==1||el.getAttribute('data-rr-note-numbered'))return false;
  const txt=noteEntryText(el);
  if(!txt)return false;
  el.setAttribute('data-rr-note-numbered','1');
  if(isExistingNoteNumberText(txt))return true;
  const span=document.createElement('span');
  span.className='rr-note-num';
  span.textContent=num+'.';
  el.insertBefore(span,el.firstChild);
  return true;
}
function wrapNoteListItemBody(li: HTMLLIElement): void{
  if(!li)return;
  for(let i=0;i<li.children.length;i++){
    const child=li.children.item(i);if(child&&child.classList.contains('rr-note-body'))return;
  }
  const body=document.createElement('div');
  body.className='rr-note-body';
  while(li.firstChild)body.appendChild(li.firstChild);
  li.appendChild(body);
}
function numberBrSeparatedNotes(el: Element|null,num: number): number{
  if(!el||!el.childNodes||el.getAttribute('data-rr-note-br-numbered'))return num;
  const brs=el.querySelectorAll?el.querySelectorAll('br').length:0;
  if(brs<1)return num;
  let segs: Array<{node:Node;text:string}>=[],start: Node|null=null,txt='';
  function closeSeg(){
    const t=(txt||'').replace(/\s+/g,' ').trim();
    if(start&&t)segs.push({node:start,text:t});
    start=null;txt='';
  }
  for(let i=0;i<el.childNodes.length;i++){
    const nd=el.childNodes.item(i);if(!nd)continue;
    if(nd instanceof Element&&nd.tagName.toLowerCase()==='br'){closeSeg();continue;}
    const t=nd.textContent||'';
    if(!t.replace(/\s+/g,''))continue;
    if(!start)start=nd;
    txt+=t;
  }
  closeSeg();
  if(segs.length<2)return num;
  el.setAttribute('data-rr-note-br-numbered','1');
  for(let j=0;j<segs.length;j++){
    const segment=segs[j];if(!segment)continue;
    if(!isExistingNoteNumberText(segment.text)){
      const span=document.createElement('span');
      span.className='rr-note-num';
      span.textContent=num+'.';
      el.insertBefore(span,segment.node);
    }
    num++;
  }
  return num;
}
function numberListNotes(list: Element|null,num: number): number{
  if(!isNoteListElement(list)||list.getAttribute('data-rr-note-list-numbered'))return num;
  const items=directListNoteItems(list);
  if(!items.length)return num;
  list.setAttribute('data-rr-note-list-numbered','1');
  list.classList.add('rr-note-list');
  list.style.listStyleType='none';
  list.style.listStylePosition='inside';
  list.style.marginLeft='0';
  list.style.paddingLeft='0';
  for(let i=0;i<items.length;i++){
    const item=items[i];if(!item)continue;
    wrapNoteListItemBody(item);
    item.style.listStyleType='none';
    item.style.marginLeft='0';
    item.style.paddingLeft='0';
    if(addNoteNumber(item,num))num++;
  }
  return num;
}
let noteNumbersReady=false,noteNumberDisplayRefreshPending=false;
function numberEndNotes(){
  if(!root)return;
  const seps=Array.prototype.slice.call(root.querySelectorAll('hr.rr-note-sep'));
  for(let si=0;si<seps.length;si++){
    let n=1,el=seps[si].nextElementSibling;
    while(el&&!(el.classList&&el.classList.contains('rr-end'))){
      const next=el.nextElementSibling;
      if(isNoteListElement(el)){
        n=numberListNotes(el,n);
      }else if(isNoteEntryElement(el)){
        const entries=directNoteEntries(el).filter(function(child){
          return noteEntryText(child).length>0;
        });
        if(entries.length>1){
          for(let i=0;i<entries.length;i++){const entry=entries[i];if(entry&&addNoteNumber(entry,n))n++;}
        }else{
          const target=entries.length===1?(entries[0]||el):el;
          const nextN=numberBrSeparatedNotes(target,n);
          if(nextN>n)n=nextN;
          else if(addNoteNumber(el,n))n++;
        }
      }
      el=next;
    }
  }
}
function ensureNoteNumbers(){
  if(!root)return;
  if(noteNumbersReady)return;
  markNoteSeparators();
  numberEndNotes();
  noteNumbersReady=true;
}
function refreshNoteNumberDisplay(){
  if(!root)return;
  ensureNoteNumbers();
  if(usesLineBreakPaging())applyScrollPageMask();
}
function scheduleNoteNumberDisplayRefresh(){
  if(noteNumberDisplayRefreshPending)return;
  noteNumberDisplayRefreshPending=true;
  requestAnimationFrame(function(){
    refreshNoteNumberDisplay();
    requestAnimationFrame(function(){
      noteNumberDisplayRefreshPending=false;
      refreshNoteNumberDisplay();
    });
  });
}
function chapterHasVisibleContent(){if(!root)return false;let walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node,parent;while((node=walker.nextNode())){parent=node.parentElement;if(parent&&parent.closest&&parent.closest('script,style,template,.rr-end,.rr-dual-continuation'))continue;if((node.nodeValue||'').replace(/[\s\u00a0\u200b\ufeff]/g,''))return true;}return !!root.querySelector('img,svg,canvas,video,object,embed,iframe,table');}
function lastDualTextColumn(){
  if(!root||!isDualPage())return -1;
  let base=root.getBoundingClientRect().left,pl=pageLayout(),right=0;
  let walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    const parent=node.parentElement;
    if(parent&&parent.closest&&parent.closest('.rr-end,.rr-dual-continuation'))continue;
    let range=document.createRange(),rects: DOMRectList|DOMRect[]=[];
    try{range.selectNodeContents(node);rects=range.getClientRects();}catch(_){continue;}
    for(let i=0;i<rects.length;i++){const rect=rects[i];if(rect&&rect.width>0&&rect.height>0)right=Math.max(right,rect.right-base);}
  }
  return right>0?Math.max(0,Math.floor((right-1)/pl.colPitch)):-1;
}
function dualContinuationNeeded(){
  const lastColumn=lastDualTextColumn();
  return !fastChapterLayout&&curCh<CH-1&&lastColumn>=0&&lastColumn%2===0;
}
function appendDualChapterContinuation(conversion: "original"|"t2s"|"s2t"): Promise<boolean>{
  if(!dualContinuationNeeded())return Promise.resolve(false);
  const next=curCh+1;
  return loadChapterPayload(next,conversion).then(function(d){
    if(!isDualPage()||next!==curCh+1||!d||!d.body)return false;
    const headReady=d.head?injectHead(d.head,headSeen):Promise.resolve();
    return headReady.then(function(){
      if(!isDualPage()||next!==curCh+1)return false;
      root.insertAdjacentHTML('beforeend','<section class="rr-dual-continuation" data-reader-chapter="'+next+'">'+d.body+'</section>');
      dualContinuationChapter=next;
      return true;
    });
  },function(){return false;});
}
function visibleDualContinuationChapter(){
  return isDualPage()&&dualContinuationChapter===curCh+1&&pageInCh===pagesInCh-1?dualContinuationChapter:-1;
}
function chapterPayloadKey(chapter: number,conversion: 'original'|'t2s'|'s2t'): string{
  return chapter+'|'+conversion;
}
function rememberChapterPayload(key: string,payload: Required<ReaderChapterPayload>): Required<ReaderChapterPayload>{
  chapterPayloadCache.delete(key);chapterPayloadCache.set(key,payload);
  while(chapterPayloadCache.size>4){const oldest=chapterPayloadCache.keys().next().value;if(typeof oldest!=='string')break;chapterPayloadCache.delete(oldest);}
  return payload;
}
function loadChapterPayload(chapter: number,conversion: 'original'|'t2s'|'s2t'): Promise<Required<ReaderChapterPayload>>{
  const key=chapterPayloadKey(chapter,conversion),cached=chapterPayloadCache.get(key);
  if(cached){chapterPayloadCache.delete(key);chapterPayloadCache.set(key,cached);return Promise.resolve(cached);}
  const loading=chapterPayloadLoads.get(key);if(loading)return loading;
  const request=fetch(location.origin+'/chapter/'+ID+'/'+chapter+'/'+conversion).then(function(r){return r.json();}).then(function(data){
    return rememberChapterPayload(key,{body:typeof data?.body==='string'?data.body:'',head:typeof data?.head==='string'?data.head:''});
  });
  chapterPayloadLoads.set(key,request);
  return request.then(function(payload){chapterPayloadLoads.delete(key);return payload;},function(error){chapterPayloadLoads.delete(key);throw error;});
}
// 跨章的真正首屏仍要由下方的精确虚拟分页生成；不过在 macOS 上那段工作可能
// 占住主线程数百毫秒。正文预取命中后，先准备一个只读、不可交互的章首表面，
// 供 turn-fx 在真正分页落地前遮住旧章。它完全不参与页码、锚点、脚注或正文
// DOM，因此不会重走曾出现文字重叠的 Range 分段测量路径。
const CHAPTER_OPENING_SNAPSHOT_BYTES=32*1024;
function buildChapterOpeningSnapshot(body: string): HTMLElement|null{
  if(!IS_MAC_WEBKIT||!usesLineBreakPaging()||!root||!pager||!body)return null;
  const page=document.createElement('div');page.className='turn-fx-page turn-fx-incoming turn-fx-prefetched';
  const preview=root.cloneNode(false) as HTMLElement;
  preview.removeAttribute('id');preview.classList.remove('turn-fx-moving');
  preview.style.visibility='';preview.style.display='block';preview.style.position='absolute';preview.style.left='0';preview.style.top='0';preview.style.width='100%';preview.style.height='auto';preview.style.minHeight='0';preview.style.transform='none';preview.style.pointerEvents='none';
  // 一屏正文远小于此上限。避免在用户仍阅读当前章时解析整章数百 KiB 的 DOM，
  // 同时保留原始 HTML 让标题、行内样式和首段排版与真实章节保持一致。
  preview.innerHTML=body.slice(0,CHAPTER_OPENING_SNAPSHOT_BYTES);
  // 快照被暂时插入现有 document；移除可执行/全局样式节点以及正文 ID，避免它
  // 影响当前章的样式、锚点查找和脚注目标。真正切章时仍会完整注入原始正文与 head。
  const unsafe=preview.querySelectorAll('script,style,link,base,[id]');
  for(let i=0;i<unsafe.length;i++){const el=unsafe.item(i);if(!el)continue;if(/^(?:SCRIPT|STYLE|LINK|BASE)$/u.test(el.tagName))el.remove();else el.removeAttribute('id');}
  page.appendChild(preview);return page;
}
function scheduleChapterOpeningSnapshotPrefetch(chapter: number,conversion: 'original'|'t2s'|'s2t',payload: Required<ReaderChapterPayload>): void{
  if(!IS_MAC_WEBKIT||!usesLineBreakPaging()||chapter!==curCh+1||!payload.body)return;
  const key=chapterPayloadKey(chapter,conversion);
  if(chapterOpeningSnapshotTimers.has(key))return;
  const started=performance.now(),timer=setTimeout(function(){
    chapterOpeningSnapshotTimers.delete(key);
    // 阅读器已换章、模式/字体设置已变或预取已经被反向导航替代时，不保留旧几何。
    if(chapter!==curCh+1||!IS_MAC_WEBKIT||!usesLineBreakPaging())return;
    const page=buildChapterOpeningSnapshot(payload.body);if(!page)return;
    cacheChapterBoundarySnapshot(chapter,'start',page);
    reportReaderPaintPerf('chapter_opening_snapshot_prefetch',started,'chapter='+chapter+' bytes='+Math.min(payload.body.length,CHAPTER_OPENING_SNAPSHOT_BYTES));
  },120);
  chapterOpeningSnapshotTimers.set(key,timer);
}
function scheduleAdjacentChapterPayloadPrefetch(chapter: number,conversion: 'original'|'t2s'|'s2t'): void{
  const schedule=function(target: number,delay: number){
    if(target<0||target>=CH)return;
    const key=chapterPayloadKey(target,conversion);
    if(chapterPayloadCache.has(key)||chapterPayloadLoads.has(key)||chapterPayloadPrefetchTimers.has(key))return;
    const started=performance.now(),timer=setTimeout(function(){
      chapterPayloadPrefetchTimers.delete(key);
      loadChapterPayload(target,conversion).then(function(payload){
        reportReaderPaintPerf('chapter_prefetch',started,'chapter='+target+' bytes='+payload.body.length);
        if(target===chapter+1)scheduleChapterOpeningSnapshotPrefetch(target,conversion,payload);
      },function(){});
    },delay);
    chapterPayloadPrefetchTimers.set(key,timer);
  };
  // 前进方向优先；反方向用于用户在章节边界立即翻回时避免再次读取正文。
  schedule(chapter+1,72);schedule(chapter-1,180);
}
function showChapter(i: number,where: ReaderWhere,frag: string|null = null,skippedBlankChapters = 0): Promise<void>{
  i=Math.max(0,Math.min(CH-1,i));
  runtime.chapterLoadFailed=false;
  let showStarted=performance.now(),fetchDone=showStarted,bugTraceToken=beginChapterBugTrace(i,where);
  const conversion: 'original'|'t2s'|'s2t'=S.textConversion==='t2s'||S.textConversion==='s2t'?S.textConversion:'original';
  return loadChapterPayload(i,conversion).then(function(d){
    fetchDone=performance.now();
    const body=d.body||'';fastChapterLayout=largeChapterFastLayout(body);
    // EPUB 章节样式通过 reader:// link 异步加载。必须等样式成功、失败或超时后
    // 再计算分栏；否则同一章可能先按无样式正文算 36 页，随后变成 12 页，
    // 保存的章内比例在重开时就会落到相邻页甚至相邻章节。
    const headReady=d.head?injectHead(d.head,headSeen):Promise.resolve();
    return headReady.then(function(){
      const enteringAfterDualContinuation=where==='after-dual-continuation';
      curCh=i;pageInCh=0;dualStartColumn=enteringAfterDualContinuation?1:0;dualContinuationEntry=enteringAfterDualContinuation;dualContinuationChapter=-1;scrollBreakSig='';invalidateScrollItemsCache();sourceTextCache=null;scrollBreaks=[0];scrollActiveSlice=null;scrollProgrammaticUntil=Date.now()+180;scrollProgrammaticTarget=0;const port=scrollPort();if(port)port.scrollTop=0;/* 最终页位移确定前不绘制新章节，避免跨章时短暂露出错误页。 */root.style.visibility='hidden';root.innerHTML=body;normalizeInlineNoteRefs();noteNumbersReady=false;ensureNoteNumbers();watchFlowMedia();
      if(!chapterHasVisibleContent()&&(skippedBlankChapters||0)<16){const nextBlankChapter=where==='end'?i-1:i+1;if(nextBlankChapter>=0&&nextBlankChapter<CH)return showChapter(nextBlankChapter,where==='end'?'end':'start',null,(skippedBlankChapters||0)+1);}
      chapChars=(fastChapterLayout?(root.textContent||''):sourceTextAround(0,Number.MAX_SAFE_INTEGER,0,0)).replace(/\s/g,'').length;applyStyle();applyCols();clearHighlights();
      return appendDualChapterContinuation(conversion).then(function(){
        // 双页末栏只预览下一章的第一栏；翻到下一跨时以偏移一栏的方式继续，
        // 不重复这段文字。顶部通过 dualContinuationChapter 明确标出左右两章。
        root.insertAdjacentHTML('beforeend','<div class="rr-end"></div>');
        normalizeInlineNoteRefs();noteNumbersReady=false;ensureNoteNumbers();watchFlowMedia();
        return waitForFlowResources().then(function(){return new Promise<void>(function(resolve){
        requestAnimationFrame(function(){requestAnimationFrame(function(){
          applyStyle();applyCols();
          const finishChapterLayout=function(){
            if(fastChapterLayout){
              if(!isScrollMode())pagesInCh=fastPagedPageCount(root);
            }else{
              scrollBreakSig='';invalidateScrollItemsCache();
            }
            if(usesLineBreakPaging())rebuildVisibleScrollPagination();
            pageInCh=0;
            if(where==='end')pageInCh=pagesInCh-1;else if(typeof where==='number')pageInCh=Math.max(0,Math.min(pagesInCh-1,where));
            if(frag){const el=document.getElementById(frag);if(el)pageInCh=pageOf(el);}
            setViewOffset();root.style.visibility='';refreshHighlights();captureAnchor();report(true);notifyReaderEndIfReached(0);scheduleNoteNumberDisplayRefresh();stabilizeProgrammaticViewPaint();
            const rrBox=root.getBoundingClientRect(),pagerBox=pager.getBoundingClientRect(),rrStyle=getComputedStyle(root);
            reportReaderPaintPerf(
              'chapter_ready',
              showStarted,
              'chapter='+i+' bytes='+body.length+' fetch_ms='+(fetchDone-showStarted).toFixed(1)
                +' mac_webkit='+(IS_MAC_WEBKIT?1:0)+' font_px='+parseFloat(rrStyle.fontSize).toFixed(1)
                +' line_px='+parseFloat(rrStyle.lineHeight).toFixed(1)+' viewport_h='+viewportHeight()
                +' pager_h='+pagerBox.height.toFixed(1)+' root_h='+rrBox.height.toFixed(1)
            );scheduleAdjacentChapterPayloadPrefetch(i,conversion);resolve();
          };
          // 向前进入大章节时先绘制精确首屏并撤掉旧章覆盖层。整章分页推迟到
          // 下一帧继续，用户先看到新章正文；向后进入章尾仍需等待完整页表。
          if(where==='start'&&!frag&&paintFastChapterOpeningPage()){
            clearTurnFx();
            reportReaderPaintPerf(
              'chapter_first_page',
              showStarted,
              'chapter='+i+' bytes='+body.length+' fetch_ms='+(fetchDone-showStarted).toFixed(1)
                +' exact='+(scrollPages[0]&&scrollPages[0]._rrExactLineCount||0)
                +' items='+(scrollPages[0]&&scrollPages[0].virtualLayout?scrollPages[0].virtualLayout.length:0)
                +' line_nodes='+lastExactBandFastNodes+' char_nodes='+lastExactBandCharNodes
            );
            requestAnimationFrame(finishChapterLayout);
            return;
          }
          finishChapterLayout();
        });});
        });});
      });
    });
  }).then(function(value){runtime.chapterLoadFailed=false;finishChapterBugTrace(bugTraceToken,true,pageInCh);return value;},function(){runtime.chapterLoadFailed=true;root.style.visibility='';finishChapterBugTrace(bugTraceToken,false,0);});
}
var curTopAnchor: ReaderPageAnchor|null=null; // 实时记录的当前页顶部锚点（精确到字符）
// 一次模式重排若没有把目标字符放在可见首行，就保留切换前的源偏移。
// 用户真实翻页或跳转时 captureAnchor() 会清空它，因此只保护紧接着的模式互切。
var modeSwitchRecoveryOffset: number|null=null;
// 视口左上角对应的"字符级"锚点。长段落跨多列时，元素级锚点的 left 是段首所在列，
// 会让重排后跳回段首（如金庸全集的超长段落）；用 caret 定位到具体字符即可避免。
function anchorNodeInReader(n: Node|null): boolean{return !!(n&&root&&root.contains(n)&&!generatedTextNode(n));}
function caretRangeInReader(x: number,y: number): Range|null{
  let oldVirtual='',rng: Range|null=null;
  if(virtualPage){oldVirtual=virtualPage.style.pointerEvents;virtualPage.style.pointerEvents='none';}
  try{
    if(document.caretRangeFromPoint){rng=document.caretRangeFromPoint(x,y);}
    else if(document.caretPositionFromPoint){const cp=document.caretPositionFromPoint(x,y);if(cp){rng=document.createRange();rng.setStart(cp.offsetNode,cp.offset);rng.collapse(true);}}
  }catch(_){}finally{
    if(virtualPage)virtualPage.style.pointerEvents=oldVirtual;
  }
  return anchorNodeInReader(rng&&rng.startContainer)?rng:null;
}
// 仅用于“布局将要切换”的瞬间，找当前真正露在视口里的首个文字行。
//
// 不能用 marginTop+8 作为取点：EPUB 章节常在页顶放一段留白、题图或大标题，
// 该坐标会落在空白处。此前取点失败后 runtime 会沿用旧的 curTopAnchor，
// 于是用户明明停在第二页首行，单双页互切却被送回前面某一页。这里直接从
// 文本 Range 的真实屏幕矩形反查 caret，确保锚点就是当前可见正文的第一行。
// 双页以左页优先，符合“切换后原来的第一行仍在新左页第一行”的阅读顺序。
function visibleTopTextAnchor(){
  if(!root||!pager)return null;
  let pr=viewRect(),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  let best: {node:Node;rect:DOMRect;pageRank:number}|null=null,dualBoundary=pr.left+(pr.width/2);
  while((node=walker.nextNode())){
    if(!anchorNodeInReader(node)||!(node.nodeValue||'').trim())continue;
    const range=document.createRange();
    try{range.selectNodeContents(node);}catch(_){continue;}
    const rects=range.getClientRects();
    for(let i=0;i<rects.length;i++){
      const r=rects.item(i);if(!r)continue;
      if(r.width<1||r.height<3||r.bottom<=pr.top+1||r.top>=pr.bottom-1||r.right<=pr.left+1||r.left>=pr.right-1)continue;
      const pageRank=isDualPage()&&r.left>=dualBoundary?1:0;
      if(!best||pageRank<best.pageRank||(pageRank===best.pageRank&&(r.top<best.rect.top-1||(Math.abs(r.top-best.rect.top)<=1&&r.left<best.rect.left)))){
        best={node:node,rect:r,pageRank:pageRank};
      }
    }
  }
  if(!best)return null;
  const bestRect=best.rect;
  // 尽量取这一行的第一个字符，而不是向右偏 6px；中文字宽较大，偏移过多会把
  // 第二、第三个字符保存成锚点，模式来回切换时会产生可见的横向漂移。
  const x=Math.max(pr.left+1,Math.min(pr.right-2,bestRect.left+1));
  const y=Math.max(pr.top+2,Math.min(pr.bottom-2,bestRect.top+Math.min(Math.max(2,bestRect.height/2),8)));
  const rng=caretRangeInReader(x,y);
  if(rng){
    try{
      const n=rng.startContainer,o=rng.startOffset;
      const value=n.nodeValue;if(n.nodeType===Node.TEXT_NODE&&value!==null&&o<value.length)rng.setEnd(n,o+1);
      if(anchorNodeInReader(n))return {range:rng};
    }catch(_){}
  }
  // 极少数 WebView 在文字装饰上不能给 caret，仍返回当前行的文本节点，
  // 而不是退回旧缓存锚点。常规浏览器路径始终会走上面的字符级 caret。
  let text=best.node.nodeValue||'',at=0;
  while(at<text.length&&!text.charAt(at).trim())at++;
  try{
    const fallback=document.createRange();
    fallback.setStart(best.node,Math.min(at,text.length));
    fallback.setEnd(best.node,Math.min(text.length,at+1));
    return {range:fallback};
  }catch(_){return null;}
}
function topAnchor(){
  const hm=hMargins();
  let x=Math.max(2,hm.l+8), y=Math.max(2,mg(S.marginTop)+8);
  if(isScrollMode()&&pager){
    const pr=viewRect();
    // 滚动容器只扣除了上下边距，左右边距位于正文根节点的 padding 内。
    x=Math.max(2,pr.left+hm.l+8);
    y=Math.max(2,pr.top+8);
  }
  const rng=caretRangeInReader(x,y);
  if(rng){
    try{const n=rng.startContainer,o=rng.startOffset,value=n.nodeValue;if(n.nodeType===Node.TEXT_NODE&&value!==null&&o<value.length)rng.setEnd(n,o+1);if(anchorNodeInReader(n))return {range:rng};}catch(e){}
  }
  let el=document.elementFromPoint(x,y);
  while(el&&el!==root){ if(anchorNodeInReader(el)&&(el.textContent||'').trim()) return {el:el}; el=el.parentElement; }
  const media=topVisibleOriginalMedia();
  if(media)return {el:media,media:true};
  return null;
}
// 取得视口内真正最靠上的一行正文。多栏分页下，固定的左上角可能是留白或
// 相邻栏的溢出节点，不能用它作为开关侧栏后的阅读锚点。
function topVisibleOriginalMedia(){
  if(!root||!pager)return null;
  const pr=viewRect(),topBand=pr.top+Math.max(48,lineHeightPx()*2.2);
  const media=root.querySelectorAll('img,svg,canvas,video');
  let best=null,bestTop=Number.POSITIVE_INFINITY;
  for(let i=0;i<media.length;i++){
    const el=media.item(i);
    if(el.closest&&el.closest('sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap'))continue;
    let r=null;try{r=el.getBoundingClientRect();}catch(_){r=null;}
    if(!r||r.width<80||r.height<80||r.bottom<=pr.top+8||r.top>=pr.bottom-8||r.top>topBand)continue;
    if(r.top<bestTop){best=el;bestTop=r.top;}
  }
  return best;
}
function anchorValid(a: ReaderPageAnchor|null|undefined): a is ReaderPageAnchor{
  if(!a)return false;
  if(a.range){return anchorNodeInReader(a.range.startContainer);}
  if(a.el){return anchorNodeInReader(a.el);}
  return false;
}
function anchorTextOffset(a: ReaderPageAnchor|null): number|null{
  if(!a||!anchorValid(a))return null;
  if(a.range)return sourceBoundaryOffset(a.range.startContainer,a.range.startOffset);
  const node=a.el;
  if(!node)return null;
  const range=document.createRange();
  try{range.selectNodeContents(node);range.collapse(true);}catch(_){return null;}
  return sourceBoundaryOffset(range.startContainer,range.startOffset);
}
function anchorRect(a: ReaderPageAnchor|null): DOMRect|null{
  if(!a||!anchorValid(a))return null;
  let r=null;
  try{
    if(a.range){
      r=a.range.getBoundingClientRect();
      if(r&&!r.width&&!r.height&&!r.left&&!r.top){const rs=a.range.getClientRects();if(rs&&rs.length)r=rs.item(0);}
    }else if(a.el){
      r=a.el.getBoundingClientRect();
    }
  }catch(_){r=null;}
  return r;
}
function restoreScrollAnchorToBreak(anchor: ReaderPageAnchor|null): boolean{
  if(!anchor||!isScrollMode()||!pager)return false;
  const sp=scrollPort();
  if(!sp)return false;
  const r=anchorRect(anchor);
  if(!r)return false;
  buildScrollBreaks(false);
  const pr=viewRect();
  const y=r.top-pr.top+(sp.scrollTop||0);
  let idx=pageIndexForScrollTop(y);
  idx=Math.max(0,Math.min(scrollBreaks.length-1,idx));
  const top=Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[idx]||0));
  pageInCh=idx;
  scrollActiveSlice=scrollPages[idx]||null;
  scrollProgrammaticUntil=Date.now()+180;
  scrollProgrammaticTarget=top;
  sp.scrollTop=top;
  applyScrollPageMask();
  return true;
}
function restoreScrollAnchorExact(anchor: ReaderPageAnchor|null,offset: number|null = null): boolean{
  if(!anchor||!isScrollMode()||!pager)return false;
  const sp=scrollPort();
  if(!sp)return false;
  const r=anchorRect(anchor);
  if(!r)return false;
  buildScrollBreaks(false);
  const pr=viewRect();
  const y=r.top-pr.top+(sp.scrollTop||0);
  const top=Math.max(0,Math.min(scrollMaxTop(),Math.round(y-(offset==null?8:offset))));
  pageInCh=pageIndexForScrollTop(top);
  scrollActiveSlice=null;
  scrollProgrammaticUntil=Date.now()+180;
  scrollProgrammaticTarget=top;
  sp.scrollTop=top;
  applyScrollPageMask();
  return true;
}
function relayout(opts: ReaderRelayoutOptions = {}): {modeSwitchVerified:boolean; anchorOffset:number|null}{
  if(!root)return {modeSwitchVerified:false,anchorOffset:null};
  // 用"重排前"就记好的锚点（resize 时浏览器已先重排，临时再取就晚了）
  opts=opts||{};
  let anchor=anchorValid(opts.anchor)?opts.anchor:(anchorValid(curTopAnchor)?curTopAnchor:topAnchor());
  const anchorOffset=opts.anchorOffset??null;
  // 滚动模式不需要列起点；离开分页时及时移除临时标记。
  if(opts.modeSwitch&&isScrollMode())clearModeSwitchAnchor();
  if(isScrollMode()){scrollActiveSlice=null;scrollBreakSig='';invalidateScrollItemsCache();}
  applyStyle();applyCols();
  if(anchorOffset!=null){
    const restoredRange=sourceAnchorRangeForOffset(anchorOffset);
    if(restoredRange)anchor={range:restoredRange};
  }
  let forcedMarker=null;
  if(opts.forceAnchorColumn&&anchorOffset!=null){
    clearModeSwitchAnchor();
    forcedMarker=forceModeSwitchAnchorColumn(anchorOffset,!!opts.preserveLeadMedia);
    if(forcedMarker){
      // 标记会增加一个物理栏，必须在它已进入 DOM 后重新计算页数和栏坐标。
      applyStyle();applyCols();
      if(padModeSwitchAnchorToColumnTop(forcedMarker))applyCols();
      const columnStartRange=sourceAnchorRangeForOffset(anchorOffset);
      // 以强制分栏标记的真实物理栏定位；文字 Range 只作为下一次切换的字符锚点。
      anchor={el:forcedMarker,modeSwitchMarker:true};
      if(columnStartRange)curTopAnchor={range:columnStartRange};
    }
  }
  const dualAligned=opts.alignDualAnchor&&alignDualAnchorToLeftPage(anchor);
  const restoredScroll=opts.exactScroll?restoreScrollAnchorExact(anchor,opts.scrollOffset):restoreScrollAnchorToBreak(anchor);
  if(!restoredScroll){
    if(anchor&&!dualAligned){ pageInCh=anchorPage(anchor); }
    else if(pageInCh>pagesInCh-1){ pageInCh=pagesInCh-1; }
    setViewOffset();
  }
  let modeSwitchVerified=true;
  if(opts.modeSwitch&&anchorOffset!=null){
    modeSwitchVerified=modeSwitchAnchorAtVisibleTop(anchorOffset);
    const stableRange=sourceAnchorRangeForOffset(anchorOffset);
    if(stableRange)curTopAnchor={range:stableRange};
  }
  // 模式切换只沿用切换前的字符锚点，避免两套坐标的取整误差累积成跳页。
  if(!opts.modeSwitch)captureAnchor();
  report();
  scheduleNoteNumberDisplayRefresh();
  return {modeSwitchVerified:modeSwitchVerified,anchorOffset:anchorOffset};
}
function schedulePageTurnBugTrace(trace: ReaderPageTurnTrace): void{setTimeout(function(){finishPageTurnBugTrace(trace);},520);}
function nextPage(){
  if(queueChapterTurnInput(1)){readerBugTrace('click','chapter_queued');return;}
  if(chapterPending>0){readerBugTrace('click','chapter_pending');return;}
  const trace=beginPageTurnBugTrace('forward');
  consumeSideAnchorVirtualPage();
  if(usesLineBreakPaging()&&scrollPageBy(1)){schedulePageTurnBugTrace(trace);return;}
  if(pageInCh<pagesInCh-1)gotoPage(pageInCh+1,1);else if(visibleDualContinuationChapter()>=0)beginChapterTurnFx(1,visibleDualContinuationChapter(),'after-dual-continuation');else if(curCh<CH-1)beginChapterTurnFx(1,curCh+1,'start');else notifyReaderEndIfReached(1,true);
  schedulePageTurnBugTrace(trace);
}
function prevPage(){
  if(queueChapterTurnInput(-1)){readerBugTrace('click','chapter_queued');return;}
  if(chapterPending>0){readerBugTrace('click','chapter_pending');return;}
  const trace=beginPageTurnBugTrace('backward');
  consumeSideAnchorVirtualPage();
  if(usesLineBreakPaging()&&scrollPageBy(-1)){schedulePageTurnBugTrace(trace);return;}
  if(isDualPage()&&dualStartColumn>0&&pageInCh===0&&dualContinuationEntry&&curCh>0)beginChapterTurnFx(-1,curCh-1,'end');else if(pageInCh>0)gotoPage(pageInCh-1,-1);else if(curCh>0)beginChapterTurnFx(-1,curCh-1,'end');
  schedulePageTurnBugTrace(trace);
}
runtime.replayQueuedChapterTurn=function(direction: number): void{
  if(direction>0)nextPage();else if(direction<0)prevPage();
};
function wheelDeltaPx(e: WheelEvent|ReaderWheelReplayEvent): number{
  let d=Math.abs(e.deltaY)>=Math.abs(e.deltaX)?e.deltaY:e.deltaX;
  if(e.deltaMode===1)d*=lineHeightPx();
  else if(e.deltaMode===2)d*=(pager?pager.clientHeight:window.innerHeight);
  return d;
}
function reveal(){document.body.classList.add('ready');}
// ---- 读到全书末页 ----
// 进入末页时必须让正文保持完整可见；只有用户已经在末页、再次向后翻页时才通知。
// 离开末页后重新启用，避免关闭推荐后原地重复弹出。
let readerEndNotified=false;
function notifyReaderEndIfReached(dir: number,boundaryAttempt = false): boolean{
  const atEnd=curCh>=CH-1&&pageInCh>=pagesInCh-1;
  if(!atEnd){readerEndNotified=false;return false;}
  if(dir>0&&boundaryAttempt===true&&!readerEndNotified){readerEndNotified=true;parent.postMessage({bookEnd:true},'*');return true;}
  return false;
}
// ---- 分页几何：单页/双页判定、版式签名与页数换算 ----
// 此文件与 reader-page-layout.js 在编译期拼成同一个 <script>；
// 保留原有全局函数名，让阅读页其余模块无需改变调用方式。
function requiredArrayItem<T>(items: ArrayLike<T>,index: number): T{
  const item=items[index];
  if(item===undefined)throw new RangeError('Missing reader array item at '+index);
  return item;
}
function requiredRecordValue<T>(record: Record<string,T>,key: string): T{
  const value=record[key];
  if(value===undefined)throw new RangeError('Missing reader record value at '+key);
  return value;
}
function isScrollMode(){return S.flowMode==='scroll';}
function isDualPage(){return !isScrollMode()&&S.pageMode==='dual'&&window.innerWidth>=900;}
function isLinePagedMode(){return false;}
function usesLineBreakPaging(){return isScrollMode();}
function columnsPerView(){return isDualPage()?2:1;}
function columnPitch(){return window.innerWidth/columnsPerView();}
function fastDualPagedPageCount(el: HTMLElement|null): number{
  if(!el)return 1;
  let base=el.getBoundingClientRect().left,pl=pageLayout(),right=0;
  // 大章节不逐字扫描整章；只读取末尾可见正文块的行矩形。scrollWidth 会把
  // rr-end 的强制空栏算进去，双页模式因此可能凭空多出一整个 spread。
  const blocks=el.querySelectorAll('p,li,blockquote,h1,h2,h3,h4,h5,h6,pre,figure,img,svg,canvas,table');
  for(let i=blocks.length-1;i>=0&&right<1;i--){
    const block=requiredArrayItem(blocks,i);
    if(block.closest&&block.closest('.rr-end,.rr-dual-continuation'))continue;
    let range=document.createRange(),rects: DOMRectList|DOMRect[]=[];
    try{range.selectNodeContents(block);rects=range.getClientRects();}catch(_){rects=block.getClientRects();}
    for(let j=0;j<rects.length;j++){const blockRect=requiredArrayItem(rects,j);if(blockRect.width>0&&blockRect.height>0)right=Math.max(right,blockRect.right-base);}
  }
  const physical=right>0?Math.max(1,Math.ceil((right+1)/pl.colPitch)):1;
  const bias=typeof dualStartColumn==='number'?dualStartColumn:0;
  return Math.max(1,Math.ceil(Math.max(1,physical-bias)/2));
}
function fastPagedPageCount(el: HTMLElement|null): number{
  if(!el)return 1;
  if(isDualPage())return fastDualPagedPageCount(el);
  const hasEnd=pagedEndOccupiesColumn(el);
  return columnCountFromWidth(el.scrollWidth||0,hasEnd);
}
function pagedEndOccupiesColumn(el: HTMLElement|null): boolean{
  if(!el||isScrollMode())return false;
  const end=el.querySelector<HTMLElement>('.rr-end');
  if(!end)return false;
  const rects=end.getClientRects();
  for(let i=0;i<rects.length;i++){
    const rect=requiredArrayItem(rects,i);
    if(rect.width>0||rect.height>0)return true;
  }
  return false;
}
// 全书页数按没有打开智读侧栏时的阅读窗口宽度统计。智读只临时压缩正文，
// 不应产生另一套页数缓存；真正调整窗口时由父页面更新此宽度。
let pageCountViewportWidth=Math.max(1,Math.round(window.innerWidth||1));
function pageCountWidth(){return Math.max(1,Math.round(pageCountViewportWidth||window.innerWidth||1));}
// 版式签名：窗口尺寸+字体/字号/行距/段距/字间距/页边距必须一致。
function layoutSig(){return [window.innerWidth,viewportHeight(),S.styleMode,S.fontSize,S.noteFontSize,S.lineHeight,S.paraSpacing,S.letterSpacing,S.fontFamily,S.marginTop,S.marginBottom,S.marginLeft,S.marginRight,S.dualPageGap,S.pageMode,S.flowMode].join('|');}
// 书籍总页数以单页版式为基准：双页只改变一次展示几页，不能把总页数除以二。
// 因此页数缓存不包含 pageMode；智读侧栏宽度也不参与；滚动模式的页高口径不同，仍独立缓存。
function pageCountSig(){return [pageCountWidth(),viewportHeight(),S.styleMode,S.fontSize,S.noteFontSize,S.lineHeight,S.paraSpacing,S.letterSpacing,S.fontFamily,S.marginTop,S.marginBottom,S.marginLeft,S.marginRight,S.flowMode].join('|');}

function scrollBottomBuffer(){
  if(!usesLineBreakPaging())return 0;
  return mg(S.marginBottom)+Math.ceil(lineHeightPx()*0.9);
}
function scrollBottomMaskPx(){
  return 0;
}
function scrollSafeBottomGapPx(){
  if(!usesLineBreakPaging())return 0;
  const raw=window.innerHeight||1;
  const lh=Math.max(12,Math.ceil((Number(S.fontSize)||18)*(Number(S.lineHeight)||1.7)));
  const topPad=Math.max(2,mg(S.marginTop));
  const minGap=mg(S.marginBottom)+2;
  const maxVisible=Math.max(1,raw-minGap);
  const usable=Math.max(0,maxVisible-topPad);
  const wholeLines=Math.max(1,Math.floor((usable-1)/lh));
  const visible=Math.max(1,Math.min(maxVisible,topPad+wholeLines*lh));
  return Math.max(minGap,Math.ceil(raw-visible));
}
function scrollViewportTopGapPx(){
  return 0;
}
function linePagedViewportTopGapPx(){
  return 0;
}
function lineBreakViewportTopGapPx(){
  return 0;
}
function lineBreakTopPadPx(){
  return 0;
}
function scrollViewportBottomGapPx(){
  return 0;
}
function linePagedViewportBottomGapPx(){
  return 0;
}
function lineBreakViewportBottomGapPx(){
  return 0;
}
function viewportHeight(){
  const h=document.documentElement.clientHeight||window.innerHeight||(pager&&pager.clientHeight)||1;
  return Math.max(1,Math.floor(h));
}
function scrollPageBox(){
  const raw=viewportHeight();
  const top=mg(S.marginTop),bottom=mg(S.marginBottom),pl=pageLayout();
  const usable=Math.max(1,raw-top-bottom);
  return {top:top,bottom:bottom,left:pl.l,right:pl.r,height:usable};
}
function pagedBoxHeight(){
  return viewportHeight();
}
function scrollVisualHeight(){
  const sp=scrollPort();const raw=sp?(sp.clientHeight||scrollPageBox().height||window.innerHeight||1):(window.innerHeight||1);
  return Math.max(1,Math.floor(raw));
}
function lineBreakPagerHeight(){
  return Math.max(1,(window.innerHeight||1)-lineBreakViewportTopGapPx()-lineBreakViewportBottomGapPx());
}
function lineBreakVisibleHeight(){
  return lineBreakPagerHeight();
}
// 页边距夹到非负且有上限：负内边距会破坏分栏排版（正文溢出/整体变形）
function mg(v: string|number): number{const n=parseInt(String(v),10);if(isNaN(n)||n<0)return 0;return n>240?240:n;}
function dualPageGapPx(){const v=Math.round(Number(S.dualPageGap));return isFinite(v)?Math.max(0,Math.min(120,v)):40;}
function pageLayout(){
  let vw=window.innerWidth,l=mg(S.marginLeft),r=mg(S.marginRight);
  if(isDualPage()){
    const gap=dualPageGapPx();
    const maxOuter=Math.max(0,vw-gap-320);
    if(l+r>maxOuter&&l+r>0){
      const s=maxOuter/(l+r);
      l=Math.floor(l*s);r=Math.floor(r*s);
    }
    const colW=Math.max(120,Math.floor((vw-l-r-gap)/2));
    const colPitch=colW+gap;
    return {l:l,r:r,gap:gap,colW:colW,colPitch:colPitch,pageStep:colPitch*2};
  }
  const maxTotal=Math.max(0,vw-160);
  if(l+r>maxTotal&&l+r>0){
    const ss=maxTotal/(l+r);
    l=Math.floor(l*ss);r=Math.floor(r*ss);
  }
  const singleW=Math.max(100,vw-l-r);
  return {l:l,r:r,gap:l+r,colW:singleW,colPitch:vw,pageStep:vw};
}
function hMargins(){
  return pageLayout();
}
function columnCountFromWidth(w: number,hasEnd = false): number{
  if(usesLineBreakPaging()){
    const h=measurer&&measurer.innerHTML?measurer.scrollHeight:(root?root.scrollHeight:0);
    const step=lineBreakVisibleHeight();
    return Math.max(1,Math.ceil(h/step));
  }
  const pl=pageLayout();
  if(isDualPage()){
    // w 是横向多列条带的 scrollWidth。双页模式下 UI 翻动的是 spread，
    // 每个 spread 包含两个物理栏，所以页数 = 物理栏数 / 2 向上取整。
    let physical=Math.max(1,Math.round((w-pl.l+pl.gap)/pl.colPitch));
    if(hasEnd)physical=Math.max(1,physical-1);
    const bias=typeof dualStartColumn==='number'?dualStartColumn:0;
    return Math.max(1,Math.ceil(Math.max(1,physical-bias)/2));
  }
  let count=Math.max(1,Math.round(w/pl.pageStep));
  if(hasEnd)count=Math.max(1,count-1);
  return count;
}
function contentRectExtent(el: HTMLElement|null): number{
  if(!el)return 0;
  let base=el.getBoundingClientRect().left,maxRight=0;
  function addRect(r: DOMRect): void{
    if(!r||r.width<1||r.height<1)return;
    maxRight=Math.max(maxRight,r.right-base);
  }
  let walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    const parent=node.parentElement;
    if(parent&&parent.closest&&parent.closest('.rr-end,.rr-dual-continuation'))continue;
    const range=document.createRange();
    try{range.selectNodeContents(node);}catch(e){continue;}
    const rects=range.getClientRects();
    for(let i=0;i<rects.length;i++)addRect(requiredArrayItem(rects,i));
  }
  // 文本节点上面的 Range 已经给出了真实字形的最右边界。不能再读取 p/li/h*
  // 的盒子：在多栏排版中，段后的 margin 可能单独被推入下一栏，盒子虽存在
  // 却没有任何文字，若把它计入便会在章节末尾虚构一整张空白 spread。
  // 这里仅补充无文本也应占页的真实媒体。
  const els=el.querySelectorAll('img,svg,canvas,video,object,embed,iframe');
  for(let j=0;j<els.length;j++){
    const mediaElement=requiredArrayItem(els,j);
    if(mediaElement.closest&&mediaElement.closest('.rr-end,.rr-dual-continuation'))continue;
    const rs=mediaElement.getClientRects();
    for(let k=0;k<rs.length;k++)addRect(requiredArrayItem(rs,k));
  }
  return Math.max(0,maxRight);
}
function physicalPageCountFromContent(el: HTMLElement|null): number{
  const pl=pageLayout(),extent=contentRectExtent(el);
  if(extent<2)return 1;
  if(isDualPage())return Math.max(1,Math.ceil((extent+1)/pl.colPitch));
  return Math.max(1,Math.ceil((extent+1)/pl.pageStep));
}
function pagedPageCountFromContent(el: HTMLElement|null): number{
  const physical=physicalPageCountFromContent(el);
  const bias=typeof dualStartColumn==='number'?dualStartColumn:0;
  const textCount=isDualPage()?Math.max(1,Math.ceil(Math.max(1,physical-bias)/2)):physical;
  // 新版排版在 WKWebView 偶尔会把多栏 Range 的 getClientRects() 限在首栏，
  // 使 textCount 错报为 1。scrollWidth 不依赖该 Range 几何，作为只增不减的
  // 回退可防止一次点击/滑动直接被误判为章节边界；末尾空栏仍由后续 trim 保留处理。
  return isModernEpubLayout()?Math.max(textCount,fastPagedPageCount(el)):textCount;
}
// 浏览器的 column flow 偶尔会在正文之后留下只含段距或强制换栏标记的列。
// 几何宽度会把这些列算进去，但用户实际看到的是整张空白页。按真实文字行和
// 非文本媒体逐页复核末尾，可作为所有页数估算路径的最终兜底。
function pagedViewHasVisibleContent(el: HTMLElement|null,index: number): boolean{
  if(!el||isScrollMode())return true;
  const base=el.getBoundingClientRect().left,pl=pageLayout();
  const start=isDualPage()?index*2+(typeof dualStartColumn==='number'?dualStartColumn:0):index;
  const width=isDualPage()?pl.colPitch:pl.pageStep;
  const count=isDualPage()?2:1;
  function inView(r: DOMRect): boolean{
    if(!r||r.width<1||r.height<3)return false;
    const column=Math.floor((r.left-base+1)/width);
    return column>=start&&column<start+count;
  }
  let walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    const parent=node.parentElement;
    if(parent&&parent.closest&&parent.closest('.rr-end,.rr-dual-continuation'))continue;
    const range=document.createRange();
    try{range.selectNodeContents(node);}catch(_){continue;}
    const rects=range.getClientRects();
    for(let i=0;i<rects.length;i++)if(inView(requiredArrayItem(rects,i)))return true;
  }
  const media=el.querySelectorAll('img,svg,canvas,video,object,embed,iframe');
  for(let j=0;j<media.length;j++){
    const mediaElement=requiredArrayItem(media,j);
    if(mediaElement.closest&&mediaElement.closest('.rr-end,.rr-dual-continuation'))continue;
    const mediaRects=mediaElement.getClientRects();
    for(let k=0;k<mediaRects.length;k++)if(inView(requiredArrayItem(mediaRects,k)))return true;
  }
  return false;
}
function trimTrailingBlankPagedViews(el: HTMLElement|null,count: number): number{
  let pages=Math.max(1,Math.floor(Number(count)||1));
  // 新版 WebKit 的 Range 列表偶发只含首栏；此时把 Range 当尾栏内容判断会把
  // 已由 scrollWidth 确认的章节页数又一路裁到 1，随后下一次翻页直接跨章。
  // 新版计数已在 fastPagedPageCount 中排除 rr-end 占位栏，不能再用不可靠的
  // Range 反向裁剪。
  if(isModernEpubLayout())return pages;
  while(pages>1&&!pagedViewHasVisibleContent(el,pages-1))pages--;
  return pages;
}
function pageCountLayout(){
  let vw=pageCountWidth(),l=mg(S.marginLeft),r=mg(S.marginRight);
  const maxTotal=Math.max(0,vw-160);
  if(l+r>maxTotal&&l+r>0){
    const s=maxTotal/(l+r);l=Math.floor(l*s);r=Math.floor(r*s);
  }
  return {width:vw,colW:Math.max(100,vw-l-r),gap:l+r,pageStep:vw};
}
function pageCountFromMeasuredContent(el: HTMLElement|null): number{
  const extent=contentRectExtent(el),pl=pageCountLayout();
  if(extent<2)return 1;
  return Math.max(1,Math.ceil((extent+1)/pl.pageStep));
}

// 单页/双页切换使用字符锚点，而不是把旧页码按二换算。若锚点在标准
// spread 的右栏，则把该物理栏作为新双页的左栏，避免视口向前跳一整页。
function anchorPage(a: ReaderPageAnchor|null): number{
  if(!anchorValid(a))return pageInCh;
  let r=null;
  if(a.range){const rs=a.range.getClientRects();r=rs&&rs.length?rs[0]:a.range.getBoundingClientRect();}
  else if(a.el)r=a.el.getBoundingClientRect();
  if(!r)return pageInCh;
  const pr=viewRect();
  if(usesLineBreakPaging()){
    const port=scrollPort(),y=r.top-pr.top+(port?port.scrollTop:0);
    buildScrollBreaks();
    return pageIndexForScrollTop(y);
  }
  const x=r.left-pr.left+viewOffset;
  if(isDualPage()){
    const pl=pageLayout(),physical=Math.max(0,Math.floor((x-pl.l+1)/pl.colPitch));
    return Math.max(0,Math.min(pagesInCh-1,Math.floor(Math.max(0,physical-dualStartColumn)/2)));
  }
  return Math.max(0,Math.min(pagesInCh-1,Math.floor((x+1)/pageStep)));
}
function alignDualAnchorToLeftPage(a: ReaderPageAnchor|null): boolean{
  if(!isDualPage()||!anchorValid(a))return false;
  const r=anchorRect(a),pr=viewRect(),pl=pageLayout();
  if(!r)return false;
  const x=r.left-pr.left+viewOffset-pl.l;
  const physical=Math.max(0,Math.floor((x+1)/pl.colPitch));
  dualStartColumn=physical%2;
  pagesInCh=fastChapterLayout?fastPagedPageCount(root):pagedPageCountFromContent(root);
  if(!fastChapterLayout)pagesInCh=trimTrailingBlankPagedViews(root,pagesInCh);
  pageInCh=Math.max(0,Math.min(pagesInCh-1,Math.floor((physical-dualStartColumn)/2)));
  return true;
}
// ---- 全书页数：增量测量、缓存与加载状态 ----
// 右上角的全书页数、进度滑块都依赖这个后台测量。
// 测量结果按章增量缓存，超大书即使中途退出也不会从头再来。
var measurer: HTMLElement,chapterPages: number[]=[],measureDone=false,measureToken=0,measureTimer: ReturnType<typeof setTimeout>|null=null,pageSig='',measurePaused=false;
const fullBookMeasureEnabled=true;

function fastTextRangeNeedsChunks(rects: DOMRectList|DOMRect[]): boolean{
  let limit=Math.max(24,lineHeightPx()*2.4),seen=0;
  for(let i=0;i<(rects?rects.length:0);i++){
    const r=rects[i];
    if(!r||r.width<1||r.height<3)continue;
    seen++;
    if(r.height>limit)return true;
  }
  return seen===0;
}
function appendFastRangeRects(out: ReaderLineRect[],node: Text,rects: DOMRectList|DOMRect[],pr: DOMRect,scrollTop: number): void{
  for(let i=0;i<(rects?rects.length:0);i++){
    const r=rects[i];
    if(!r||r.width<1||r.height<3)continue;
    out.push({top:r.top-pr.top+scrollTop,bottom:r.bottom-pr.top+scrollTop,height:r.height,left:r.left-pr.left,right:r.right-pr.left,fragments:[],flowNodes:[node]});
  }
}
function appendFastTextRangeLines(out: ReaderLineRect[],node: Text,range: Range,start: number,end: number,pr: DOMRect,scrollTop: number): void{
  let rects: DOMRectList|DOMRect[]=[];
  try{range.setStart(node,start);range.setEnd(node,end);rects=range.getClientRects();}catch(_){return;}
  if(!fastTextRangeNeedsChunks(rects)){appendFastRangeRects(out,node,rects,pr,scrollTop);return;}
  // 极少数电子书会把每个 192 字片段也合成一个高矩形；仅对该小片段退回逐字
  // 测量，确保页面可读，而不会把整章都变成逐字扫描。
  for(let i=start;i<end;i++){
    try{range.setStart(node,i);range.setEnd(node,i+1);rects=range.getClientRects();}catch(_){continue;}
    appendFastRangeRects(out,node,rects,pr,scrollTop);
  }
}
function imagePreviewGapPx(){return 4;}
function primaryCharacterRect(rects: DOMRectList|DOMRect[]): DOMRect|null{
  if(!rects||!rects.length)return null;
  let best=null,bestScore=-1;
  for(let i=0;i<rects.length;i++){
    const r=rects[i];
    if(!r||r.height<3)continue;
    const score=Math.max(0,r.width)*r.height;
    // 行尾换行字符在 WKWebView 中可能同时返回“上一行零宽占位矩形”和
    // “下一行真实字形矩形”。每个字符只能采用面积最大的那个矩形。
    if(score>bestScore){best=r;bestScore=score;}
  }
  return best;
}
// 大章节的全章分页只测量文本节点的整行矩形，避免 WKWebView 逐字扫描卡顿。
// 真正显示某一页时，只对与该页相交的文本节点做逐字测量，既保留快速打开，
// 又能构造不含下一页首行的完整文字图层。
function exactBandCandidateTextNodes(bandTop: number,bandBottom: number,extra: number): Array<{node: Text;start: number}>|null{
  if(!fastChapterLayout||!scrollItemsCache.length)return null;
  const seen=new WeakSet<Text>(),out: Array<{node: Text;start: number}>=[];
  for(let i=0;i<scrollItemsCache.length;i++){
    const item=scrollItemsCache[i];
    if(!item||item.type!=='line'||item.bottom<bandTop-extra)continue;
    if(item.top>bandBottom+extra)break;
    const nodes: Node[]=[];
    if(item.flowNodes&&item.flowNodes.length)nodes.push(...item.flowNodes);
    if(item.fragments&&item.fragments.length){
      for(let fi=0;fi<item.fragments.length;fi++){const fragment=item.fragments[fi],fragmentNode=fragment&&fragment.node;if(fragmentNode)nodes.push(fragmentNode);}
    }
    for(let ni=0;ni<nodes.length;ni++){
      const node=nodes[ni];
      if(!(node instanceof Text)||seen.has(node))continue;
      const start=fastTextNodeOffsets.get(node);
      // 粗分页与源位置索引必须来自同一次排版。只要有节点
      // 无法对应，就回退到全文遍历，避免使用错位的批注偏移。
      if(typeof start!=='number')return null;
      seen.add(node);out.push({node:node,start:start});
    }
  }
  return out.length?out:null;
}
function exactTextLineItemsForBand(bandTop: number,bandBottom: number): ReaderPageFlowItem[]{
  if(!root||!pager)return [];
  lastExactBandFastNodes=0;lastExactBandCharNodes=0;
  const pr=viewRect(),sp=scrollPort(),scrollTop=sp?sp.scrollTop||0:0;
  const linesByKey: Record<string,ReaderLineRect>={},keys: number[]=[],styleCache=new WeakMap<Element,ReaderComputedLineStyle>();
  const range=document.createRange();
  const extra=Math.max(4,lineHeightPx()*0.25);
  // macOS WebKit 在大章节上逐字符调用 getClientRects() 的代价非常高。对于普通
  // 文本节点，整段 Range 已经会给出每一视觉行的矩形；用屏幕 caret 反查该行的
  // 源偏移，只需按行取样。若任一行无法精确反查到同一 Text 节点，立刻回退到
  // 原逐字路径，宁可慢一点也不拿错误的片段破坏兼容排版、批注或点击命中。
  function caretOffsetInTextNode(node: Text,r: DOMRect): number|null{
    const xs=[r.left+0.25,r.left+Math.min(1,Math.max(0.25,r.width/4))];
    const y=r.top+Math.max(0.5,Math.min(r.height-0.5,r.height/2));
    for(let xi=0;xi<xs.length;xi++){
      const caret=caretRangeInReader(requiredArrayItem(xs,xi),y);
      if(caret&&caret.startContainer===node&&caret.startOffset>=0&&caret.startOffset<=(node.nodeValue||'').length)return caret.startOffset;
    }
    return null;
  }
  function measureSimpleTextNodeByLine(node: Text,text: string,nodeStart: number,style: ReaderComputedLineStyle|null): boolean{
    if(!fastChapterLayout)return false;
    let rects: DOMRectList|DOMRect[]=[];
    try{range.selectNodeContents(node);rects=range.getClientRects();}catch(_){return false;}
    if(!rects||!rects.length)return false;
    const rows: DOMRect[]=[];
    for(let ri=0;ri<rects.length;ri++){
      const r=requiredArrayItem(rects,ri);
      if(!r||r.width<0.5||r.height<3)return false;
      // 这是 WebKit 偶发把长段落压成一个“跨越很多行”的矩形的退化情形；不能
      // 把它误当作单行，否则会重新引入章首只显示一行/大量空白的老问题。
      if(r.height>Math.max(lineHeightPx()*1.8,48))return false;
      const prior=rows[rows.length-1];
      // 同一文本节点的正常 LTR 流必须保持视觉顺序；双向、分栏或异常矩形交给
      // 已验证多年的逐字算法，避免错误拼接成一行。
      if(prior&&(r.top<prior.top-1||(Math.abs(r.top-prior.top)<2&&r.left<prior.left-1)))return false;
      rows.push(r);
    }
    const selected: number[]=[];
    for(let ri=0;ri<rows.length;ri++){
      const r=requiredArrayItem(rows,ri),top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop;
      if(bottom>=bandTop-extra&&top<=bandBottom+extra)selected.push(ri);
    }
    if(!selected.length)return true;
    if(rows.length===1){
      const only=requiredArrayItem(rows,0);
      appendMeasuredTextRangeLine(linesByKey,keys,node,text,only,pr,scrollTop,style,nodeStart,nodeStart+text.length);
      return true;
    }
    const first=requiredArrayItem(selected,0),last=requiredArrayItem(selected,selected.length-1);
    const offsets: Record<string,number>={};
    for(let ri=first;ri<=Math.min(rows.length-1,last+1);ri++){
      const offset=caretOffsetInTextNode(node,requiredArrayItem(rows,ri));
      if(offset==null)return false;
      offsets[ri]=offset;
    }
    for(let ri=first;ri<=last;ri++){
      const start=recordValue(offsets,ri),end=ri+1<rows.length?recordValue(offsets,ri+1):text.length;
      if(start<0||end<=start||end>text.length)return false;
      appendMeasuredTextRangeLine(linesByKey,keys,node,text.slice(start,end),requiredArrayItem(rows,ri),pr,scrollTop,style,nodeStart+start,nodeStart+end);
    }
    return true;
  }
  function measureNode(node: Text,nodeStart: number,verifyBand: boolean): void{
    const text=node.nodeValue||'';
    const parent=node.parentElement;
    if(!parent||generatedTextNode(node)||closestInlineNoteElement(node)||!text.trim())return;
    const pcs=window.getComputedStyle(parent);
    if(pcs.display==='none'||pcs.visibility==='hidden')return;
    if(verifyBand){
      let nodeVisible=false;
      try{
        range.selectNodeContents(node);
        const nodeRects=range.getClientRects();
        for(let nri=0;nri<nodeRects.length;nri++){
          const nr=requiredArrayItem(nodeRects,nri),nt=nr.top-pr.top+scrollTop,nb=nr.bottom-pr.top+scrollTop;
          if(nb>=bandTop-extra&&nt<=bandBottom+extra){nodeVisible=true;break;}
        }
      }catch(_){nodeVisible=false;}
      if(!nodeVisible)return;
    }
    const style=computedLineStyleForNode(node,styleCache);
    if(measureSimpleTextNodeByLine(node,text,nodeStart,style)){lastExactBandFastNodes++;return;}
    lastExactBandCharNodes++;
    for(let i=0;i<text.length;i++){
      const ch=text.charAt(i);
      if(ch==='\r'||ch==='\n'||ch==='\t')continue;
      try{range.setStart(node,i);range.setEnd(node,i+1);}catch(e){continue;}
      const rects=range.getClientRects();
      if(!rects||!rects.length)continue;
      const r=primaryCharacterRect(rects);
      if(!r)continue;
      const top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop;
      if(bottom<bandTop-extra||top>bandBottom+extra||r.width<0.1&&!ch.trim())continue;
      appendMeasuredCharLine(linesByKey,keys,node,ch,r,pr,scrollTop,style,nodeStart+i);
    }
  }
  const candidates=exactBandCandidateTextNodes(bandTop,bandBottom,extra);
  if(candidates){
    for(let ci=0;ci<candidates.length;ci++){const candidate=requiredArrayItem(candidates,ci);measureNode(candidate.node,candidate.start,false);}
  }else{
    let walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node: Node|null,docPos=0;
    while((node=walker.nextNode())){
      if(!(node instanceof Text))continue;
      const text=node.nodeValue||'',parent=node.parentElement;
      if(!parent||generatedTextNode(node)||closestInlineNoteElement(node))continue;
      const nodeStart=docPos;docPos+=text.length;
      // 大章章首会先精确绘制约两屏正文，让用户无需等待整章粗分页。
      // 此时尚无 scrollItemsCache 可缩小候选节点；文本节点按文档顺序排列，
      // 一旦已经越过章首测量带即可停止，避免为了首屏再次遍历整章。
      if(fastChapterLayout&&bandTop<=1&&text.trim()){
        let startsAfterBand=false;
        try{
          range.selectNodeContents(node);
          const nodeRects=range.getClientRects();
          let minTop=Number.POSITIVE_INFINITY;
          for(let nri=0;nri<nodeRects.length;nri++){
            const nr=requiredArrayItem(nodeRects,nri);
            if(nr&&nr.width>0&&nr.height>0)minTop=Math.min(minTop,nr.top-pr.top+scrollTop);
          }
          startsAfterBand=isFinite(minTop)&&minTop>bandBottom+extra;
        }catch(_){startsAfterBand=false;}
        if(startsAfterBand)break;
      }
      measureNode(node,nodeStart,true);
    }
  }
  const noteEls=root.querySelectorAll<Element>('.rr-note-ref,a,sup,sub,span'),seenNotes=new WeakSet<Element>();
  for(let ne=0;ne<noteEls.length;ne++){
    const noteEl=closestInlineNoteElement(requiredArrayItem(noteEls,ne));
    if(!noteEl||seenNotes.has(noteEl))continue;
    seenNotes.add(noteEl);
    const ncs=window.getComputedStyle(noteEl);
    if(ncs.display==='none'||ncs.visibility==='hidden')continue;
    let nrect=null;try{nrect=noteEl.getBoundingClientRect();}catch(_){nrect=null;}
    if(!nrect||nrect.width<1||nrect.height<3)continue;
    const ntop=nrect.top-pr.top+scrollTop,nbottom=nrect.bottom-pr.top+scrollTop;
    if(nbottom<bandTop-extra||ntop>bandBottom+extra)continue;
    appendMeasuredInlineLine(linesByKey,keys,noteEl,nrect,pr,scrollTop);
  }
  const out: ReaderLineRect[]=keys.map(function(k){return requiredRecordValue(linesByKey,String(k));}).sort(function(a,b){return a.top-b.top||a.left-b.left;});
  for(let j=0;j<out.length;j++)requiredArrayItem(out,j).fragments.sort(function(a,b){return a.top-b.top||a.left-b.left;});
  return filterTextLines(out).map(function(line,idx){
    return {top:line.top,bottom:line.bottom,height:line.height,type:'line',atomic:false,index:idx,left:line.left,right:line.right,fragments:line.fragments||[],flowNodes:line.flowNodes||[]};
  });
}

function measureChapterPages(html: string): number{
  if(!measurer)return 1;
  const vw=pageCountWidth(),vh=pagedBoxHeight(),pl=pageCountLayout();
  if(isScrollMode()){
    measurer.style.minHeight='';
    measurer.style.height='auto';
    measurer.style.width=pl.colW+'px';
    measurer.style.columnWidth='auto';
    measurer.style.columnCount='auto';
    measurer.style.columnGap='normal';
    measurer.innerHTML=html;
    const contentH=Math.max(measurer.scrollHeight||0,Math.ceil(measurer.getBoundingClientRect().height||0));
    const pageH=Math.max(1,scrollPageBox().height||scrollVisualHeight()||viewportHeight());
    const step=Math.max(1,pageH-Math.max(2,Math.ceil(lineHeightPx()*0.08)));
    return Math.max(1,Math.ceil(contentH/step));
  }
  measurer.style.minHeight='';
  measurer.style.height=vh+'px';
  measurer.style.width=vw+'px';
  measurer.style.columnWidth=pl.colW+'px';
  measurer.style.columnCount='auto';
  measurer.style.columnGap=pl.gap+'px';
  measurer.innerHTML=html;
  return pageCountFromMeasuredContent(measurer);
}
function publishPageCache(complete: boolean): void{
  if(!pageSig||chapterPages.length!==CH)return;
  parent.postMessage({pageCache:{sig:pageSig,pages:chapterPages.slice(),complete:!!complete}},'*');
}
function measureAll(){
  if(!fullBookMeasureEnabled)return;
  if(measurePaused){perfLog('measure.skip','paused-before-start');scheduleMeasure(900);return;}
  if(measureDone&&pageSig===pageCountSig())return; // 版式没变、已有页数 → 不重算
  const sig=pageCountSig();
  // 版式相同的未完成缓存保留已经测过的章节；只有版式变化时才整本失效。
  if(pageSig!==sig||chapterPages.length!==CH)chapterPages=new Array(CH).fill(0);
  pageSig=sig;measureDone=false;
  const tok=++measureToken;
  let i=0,tAll=performance.now();
  perfLog('measure.start','chapters='+CH);
  function step(){
    if(tok!==measureToken)return;
    while(i<CH&&(chapterPages[i]??0)>0)i++;
    if(measurePaused){perfLog('measure.pause','chapter='+i);scheduleMeasure(900);return;}
    if(i>=CH){if(measurer)measurer.innerHTML='';measureDone=true;report();
      perfLog('measure.end','chapters='+CH+' dt='+(performance.now()-tAll).toFixed(1)+'ms');
      publishPageCache(true);return;}
    const tStep=performance.now(),idx=i;
    fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
      if(tok!==measureToken)return;if(measurePaused){perfLog('measure.pause','chapter='+idx+' after-fetch');scheduleMeasure(900);return;}chapterPages[i]=measureChapterPages(d.body||'');
      const dt=performance.now()-tStep;if(dt>40)perfLog('measure.chapter','chapter='+idx+' dt='+dt.toFixed(1)+'ms html='+(d.body||'').length);
      i++;if(i%4===0)publishPageCache(false);
      // 本地章节读取通常很快，不必每章固定等待一帧；每 8 章或遇到重章时
      // 主动让出一次界面线程，兼顾统计速度与阅读交互响应。
      setTimeout(step,dt>30?16:(i%8===0?8:0));
    }).catch(function(){if(tok!==measureToken)return;if(measurePaused){perfLog('measure.pause','chapter='+idx+' after-error');scheduleMeasure(900);return;}chapterPages[i]=1;i++;if(i%4===0)publishPageCache(false);setTimeout(step,16);});
  }
  step();
}
// 外壳送来缓存的页数：完整缓存直接采用；未完成缓存从第一个空章继续。
function applyPageCache(pc: ReaderPageCache): void{
  if(!pc||!pc.pages||pc.pages.length!==CH)return;
  if(pc.sig!==pageCountSig())return; // 版式变了，缓存作废，照常测量
  measureToken++; // 作废可能在跑的测量
  chapterPages=pc.pages.map(function(p){p=Number(p)||0;return p>0?Math.floor(p):0;});
  measureDone=!!pc.complete||chapterPages.every(function(p){return p>0;});pageSig=pc.sig;
  if(measureTimer){clearTimeout(measureTimer);measureTimer=null;}
  report();
  // 回填的完整缓存同样要通知外壳：统一任务中心才能把“统计总页数”
  // 立即标为完成，而不是留下一个没有实际工作的 running 任务。
  publishPageCache(measureDone);
  if(!measureDone)scheduleMeasure(60);
}
function invalidateMeasure(){measureToken++;measureDone=false;pageSig='';chapterPages=new Array(CH).fill(0);}
function scheduleMeasure(delay = 1200): void{if(!fullBookMeasureEnabled)return;if(measureTimer)clearTimeout(measureTimer);measureTimer=setTimeout(measureAll,delay||1200);}
function setMeasurePaused(paused: boolean): void{
  measurePaused=!!paused;
  perfLog('measure.paused',measurePaused?1:0);
  if(measurePaused){
    // 拖动窗口或离开阅读器时也保留未满 4 章的尾段，避免最后几章白测。
    publishPageCache(false);
    measureToken++;
    if(measureTimer){clearTimeout(measureTimer);measureTimer=null;}
    if(measurer)measurer.innerHTML='';
  }else if(!measureDone){
    scheduleMeasure(1200);
  }
}
// ---- 高亮菜单纯矩形规则 ----
// 与阅读页的其他模块在编译期拼接为同一份脚本。这里不读取 DOM、设置或
// 全局状态；调用方传入已测得的矩形、指针位置和分页键，仍由批注模块负责
// 选区、渲染、事件、IPC 与 EPUB/PDF 命令式阅读引擎。
const ReaderPageHighlightRules=(function(){
  function finite(value: number|string|null|undefined,fallback = 0): number{
    const number=Number(value);
    return Number.isFinite(number)?number:(fallback||0);
  }
  function envelope(rects: readonly RectLike[]): RectLike{
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    (rects||[]).forEach(function(rect){
      left=Math.min(left,finite(rect&&rect.left));
      top=Math.min(top,finite(rect&&rect.top));
      right=Math.max(right,finite(rect&&rect.right));
      bottom=Math.max(bottom,finite(rect&&rect.bottom));
    });
    if(!Number.isFinite(left))return {left:0,top:0,right:0,bottom:0,width:0,height:0};
    return {left:left,top:top,right:right,bottom:bottom,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
  }
  function nearestRect(rects: readonly RectLike[],pointer: PointerLike|null): RectLike|null{
    if(!rects||!rects.length)return null;
    if(!pointer||!Number.isFinite(Number(pointer.x))||!Number.isFinite(Number(pointer.y)))return requiredArrayItem(rects,0);
    let x=Number(pointer.x),y=Number(pointer.y),best=requiredArrayItem(rects,0),bestDistance=Infinity;
    for(let i=0;i<rects.length;i++){
      const rect=requiredArrayItem(rects,i),left=finite(rect.left),right=finite(rect.right),top=finite(rect.top),bottom=finite(rect.bottom);
      if(x>=left-3&&x<=right+3&&y>=top-5&&y<=bottom+5)return rect;
      const cx=Math.max(left,Math.min(right,x)),cy=Math.max(top,Math.min(bottom,y));
      const dx=x-cx,dy=y-cy,distance=dx*dx+dy*dy;
      if(distance<bestDistance){bestDistance=distance;best=rect;}
    }
    return best;
  }
  function groupedEnvelopes(items: readonly RectLike[],groupKey: (item:RectLike)=>string|number): RectLike[]{
    const groups: Record<string,RectLike[]>={};
    (items||[]).forEach(function(item){
      const key=String(groupKey(item));
      (groups[key]||(groups[key]=[])).push(item);
    });
    return Object.keys(groups).map(function(key){return envelope(requiredRecordValue(groups,key));});
  }
  function placement(rects: readonly RectLike[],pointer: PointerLike|null,pageKey: (r:RectLike)=>string|number,lineKey: (r:RectLike)=>string|number): HighlightPlacement|null{
    if(!rects||!rects.length)return null;
    const pages: Record<string,RectLike[]>={};
    rects.forEach(function(rect){
      const key=String(pageKey(rect));
      (pages[key]||(pages[key]=[])).push(rect);
    });
    const pageKeys=Object.keys(pages).sort(function(a,b){return Number(a)-Number(b);});
    if(pageKeys.length>1){const firstPageKey=requiredArrayItem(pageKeys,0);return {rect:envelope(requiredRecordValue(pages,firstPageKey)),above:true};}
    const lines=groupedEnvelopes(rects,lineKey);
    if(lines.length<=1){const nearest=nearestRect(rects,pointer);return nearest?{rect:nearest,above:false}:null;}
    let last=requiredArrayItem(lines,0);
    lines.forEach(function(rect){if(rect.bottom>last.bottom||(rect.bottom===last.bottom&&rect.right>last.right))last=rect;});
    return {rect:last,above:false};
  }
  return Object.freeze({envelope:envelope,nearestRect:nearestRect,groupedEnvelopes:groupedEnvelopes,placement:placement});
})();
// ---- 高亮/批注 ----
// This file runs inside the chapter iframe, isolated from reader-i18n.js.  It
// receives S.uiLanguage from the reader shell and keeps every transient menu
// in the same language as the surrounding reader.
const READER_PAGE_COPY: Record<string,ReaderPageCopy>={
  'zh-CN':{yellow:'黄色',green:'绿色',blue:'蓝色',pink:'粉色',web:'网页搜索',dict:'词典',translate:'翻译',copy:'复制',highlight:'高亮',correct:'改错',excerpt:'书摘',cross:'跨书搜索',semantic:'相似语义',aiReader:'智读',note:'批注',bookmark:'书签',removeHighlight:'取消高亮',display:'显示',both:'图文',text:'文字',icon:'图标',colorful:'多彩高亮',layout:'布局',row:'横排',grid:'九宫格',size:'大小',small:'小',medium:'中',large:'大',dragSort:'拖动排序',searchEngineGoogle:'谷歌',searchEngineBaidu:'百度',original:'原文',cancel:'取消',save:'保存',downloadImage:'下载图片',generatingImage:'正在生成图片…',downloadStarted:'已开始下载',source:'原文',translation:'译文',loading:'加载中…',autoDetect:'自动检测',chinese:'中文',english:'英文',japanese:'日文',korean:'韩文',systemLanguage:'系统语言',translationFailed:'翻译失败',fillCredential:'请填写',checkCredential:'正在检查凭据配置…',savingCredential:'正在安全保存凭据…',dictionarySettings:'词典增强设置',lookingUp:'查词中…',meaningHint:'词义提示',possibleSenses:'可能义项',contextHint:'结合当前句子',hypernyms:'上位词',synonyms:'近义',antonyms:'反义',dictionaryEnhancementUnavailable:'当前词没有可用的“{option}”数据，未开启。',notFoundDefinition:'（未找到该词的释义）',noDefinition:'（无释义）',pronunciation:'发音',externalDictionary:'外置词典',footnoteLoading:'加载中…',footnoteNotFound:'（未找到注释内容）',footnoteFailed:'（注释加载失败）'},
  'zh-TW':{yellow:'黃色',green:'綠色',blue:'藍色',pink:'粉色',web:'網頁搜尋',dict:'詞典',translate:'翻譯',copy:'複製',highlight:'螢光標記',correct:'校正',excerpt:'書摘',cross:'跨書搜尋',semantic:'相似語義',aiReader:'智讀',note:'批註',bookmark:'書籤',removeHighlight:'取消標記',display:'顯示',both:'圖文',text:'文字',icon:'圖示',colorful:'多彩標記',layout:'版面',row:'橫排',grid:'九宮格',size:'大小',small:'小',medium:'中',large:'大',dragSort:'拖曳排序',searchEngineGoogle:'Google',searchEngineBaidu:'百度',original:'原文',cancel:'取消',save:'儲存',downloadImage:'下載圖片',generatingImage:'正在產生圖片…',downloadStarted:'已開始下載',source:'原文',translation:'譯文',loading:'載入中…',autoDetect:'自動偵測',chinese:'中文',english:'英文',japanese:'日文',korean:'韓文',systemLanguage:'系統語言',translationFailed:'翻譯失敗',fillCredential:'請填寫',checkCredential:'正在檢查憑據設定…',savingCredential:'正在安全儲存憑據…',dictionarySettings:'詞典增強設定',lookingUp:'查詞中…',meaningHint:'詞義提示',possibleSenses:'可能義項',contextHint:'結合目前句子',hypernyms:'上位詞',synonyms:'近義詞',antonyms:'反義詞',notFoundDefinition:'（找不到該詞釋義）',noDefinition:'（無釋義）',pronunciation:'發音',externalDictionary:'外部詞典',footnoteLoading:'載入中…',footnoteNotFound:'（找不到註釋內容）',footnoteFailed:'（註釋載入失敗）'},
  en:{yellow:'Yellow',green:'Green',blue:'Blue',pink:'Pink',web:'Web search',dict:'Dictionary',translate:'Translate',copy:'Copy',highlight:'Highlight',correct:'Correct',excerpt:'Excerpt',cross:'Search library',semantic:'Similar meaning',aiReader:'AI Reader',note:'Note',bookmark:'Bookmark',removeHighlight:'Remove highlight',display:'Display',both:'Icon + text',text:'Text',icon:'Icon',colorful:'Highlight colors',layout:'Layout',row:'Row',grid:'Grid',size:'Size',small:'Small',medium:'Medium',large:'Large',dragSort:'Drag to reorder',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu',original:'Original',cancel:'Cancel',save:'Save',downloadImage:'Download image',generatingImage:'Creating image…',downloadStarted:'Download started',source:'Source',translation:'Translation',loading:'Loading…',autoDetect:'Detect automatically',chinese:'Chinese',english:'English',japanese:'Japanese',korean:'Korean',systemLanguage:'System language',translationFailed:'Translation failed',fillCredential:'Enter',checkCredential:'Checking credential setup…',savingCredential:'Saving credentials securely…',dictionarySettings:'Dictionary options',lookingUp:'Looking up…',meaningHint:'Meaning hint',possibleSenses:'Possible senses',contextHint:'In this context',hypernyms:'Broader terms',synonyms:'Synonyms',antonyms:'Antonyms',dictionaryEnhancementUnavailable:'No {option} data is available for this word, so it remains off.',notFoundDefinition:'(No definition found)',noDefinition:'(No definition)',pronunciation:'Pronunciation',externalDictionary:'External dictionary',footnoteLoading:'Loading…',footnoteNotFound:'(Footnote not found)',footnoteFailed:'(Could not load footnote)'},
  ja:{yellow:'黄色',green:'緑色',blue:'青色',pink:'ピンク',web:'ウェブ検索',dict:'辞書',translate:'翻訳',copy:'コピー',highlight:'ハイライト',correct:'修正',excerpt:'抜粋',cross:'本棚を検索',semantic:'類似した意味',aiReader:'AI 読解',note:'注釈',bookmark:'しおり',removeHighlight:'ハイライトを削除',display:'表示',both:'アイコンと文字',text:'文字',icon:'アイコン',colorful:'色付きハイライト',layout:'レイアウト',row:'横並び',grid:'グリッド',size:'サイズ',small:'小',medium:'中',large:'大',dragSort:'ドラッグして並べ替え',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu',original:'原文',cancel:'キャンセル',save:'保存',downloadImage:'画像をダウンロード',generatingImage:'画像を作成中…',downloadStarted:'ダウンロードを開始しました',source:'原文',translation:'翻訳',loading:'読み込み中…',autoDetect:'自動検出',chinese:'中国語',english:'英語',japanese:'日本語',korean:'韓国語',systemLanguage:'システム言語',translationFailed:'翻訳に失敗しました',fillCredential:'入力してください:',checkCredential:'認証情報を確認中…',savingCredential:'認証情報を安全に保存中…',dictionarySettings:'辞書の設定',lookingUp:'検索中…',meaningHint:'語義のヒント',possibleSenses:'候補の語義',contextHint:'文脈での意味',hypernyms:'上位語',synonyms:'類義語',antonyms:'対義語',notFoundDefinition:'（定義が見つかりません）',noDefinition:'（定義がありません）',pronunciation:'発音',externalDictionary:'外部辞書',footnoteLoading:'読み込み中…',footnoteNotFound:'（注釈が見つかりません）',footnoteFailed:'（注釈を読み込めません）'}
};
const READER_HIGHLIGHT_COPY: Record<string,ReaderPageCopy>={
  'zh-CN':{highlightMenuSettings:'高亮菜单设置'},
  'zh-TW':{highlightMenuSettings:'螢光標記選單設定'},
  en:{highlightMenuSettings:'Highlight menu settings'},
  ja:{highlightMenuSettings:'ハイライトメニュー設定'},
  ko:{yellow:'노란색',green:'초록색',blue:'파란색',pink:'분홍색',web:'웹 검색',dict:'사전',translate:'번역',copy:'복사',highlight:'하이라이트',correct:'교정',excerpt:'발췌',cross:'서재 검색',semantic:'유사 의미',aiReader:'AI 읽기',note:'주석',bookmark:'책갈피',removeHighlight:'하이라이트 삭제',highlightMenuSettings:'하이라이트 메뉴 설정',display:'표시',both:'아이콘 + 텍스트',text:'텍스트',icon:'아이콘',colorful:'하이라이트 색상',layout:'레이아웃',row:'가로 배열',grid:'격자',size:'크기',small:'작게',medium:'보통',large:'크게',dragSort:'끌어서 순서 변경',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  fr:{yellow:'Jaune',green:'Vert',blue:'Bleu',pink:'Rose',web:'Recherche Web',dict:'Dictionnaire',translate:'Traduire',copy:'Copier',highlight:'Surligner',correct:'Corriger',excerpt:'Extrait',cross:'Rechercher dans la bibliothèque',semantic:'Sens similaire',aiReader:'Lecture IA',note:'Note',bookmark:'Signet',removeHighlight:'Supprimer le surlignage',highlightMenuSettings:'Réglages du menu de surlignage',display:'Affichage',both:'Icône + texte',text:'Texte',icon:'Icône',colorful:'Couleurs de surlignage',layout:'Disposition',row:'Ligne',grid:'Grille',size:'Taille',small:'Petite',medium:'Moyenne',large:'Grande',dragSort:'Faire glisser pour réorganiser',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  de:{yellow:'Gelb',green:'Grün',blue:'Blau',pink:'Rosa',web:'Websuche',dict:'Wörterbuch',translate:'Übersetzen',copy:'Kopieren',highlight:'Markieren',correct:'Korrigieren',excerpt:'Auszug',cross:'Bibliothek durchsuchen',semantic:'Ähnliche Bedeutung',aiReader:'KI-Lesen',note:'Notiz',bookmark:'Lesezeichen',removeHighlight:'Markierung entfernen',highlightMenuSettings:'Einstellungen des Markierungsmenüs',display:'Anzeige',both:'Symbol + Text',text:'Text',icon:'Symbol',colorful:'Markierungsfarben',layout:'Layout',row:'Zeile',grid:'Raster',size:'Größe',small:'Klein',medium:'Mittel',large:'Groß',dragSort:'Zum Sortieren ziehen',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  es:{yellow:'Amarillo',green:'Verde',blue:'Azul',pink:'Rosa',web:'Búsqueda web',dict:'Diccionario',translate:'Traducir',copy:'Copiar',highlight:'Resaltar',correct:'Corregir',excerpt:'Extracto',cross:'Buscar en la biblioteca',semantic:'Significado similar',aiReader:'Lectura con IA',note:'Nota',bookmark:'Marcador',removeHighlight:'Quitar resaltado',highlightMenuSettings:'Ajustes del menú de resaltado',display:'Visualización',both:'Icono + texto',text:'Texto',icon:'Icono',colorful:'Colores de resaltado',layout:'Diseño',row:'Fila',grid:'Cuadrícula',size:'Tamaño',small:'Pequeño',medium:'Mediano',large:'Grande',dragSort:'Arrastrar para reordenar',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  ru:{yellow:'Жёлтый',green:'Зелёный',blue:'Синий',pink:'Розовый',web:'Поиск в интернете',dict:'Словарь',translate:'Перевести',copy:'Копировать',highlight:'Выделить',correct:'Исправить',excerpt:'Цитата',cross:'Поиск по библиотеке',semantic:'Похожий смысл',aiReader:'ИИ-чтение',note:'Примечание',bookmark:'Закладка',removeHighlight:'Удалить выделение',highlightMenuSettings:'Настройки меню выделения',display:'Отображение',both:'Значок + текст',text:'Текст',icon:'Значок',colorful:'Цвета выделения',layout:'Макет',row:'Строка',grid:'Сетка',size:'Размер',small:'Маленький',medium:'Средний',large:'Большой',dragSort:'Перетащите для изменения порядка',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  'pt-BR':{yellow:'Amarelo',green:'Verde',blue:'Azul',pink:'Rosa',web:'Pesquisa na Web',dict:'Dicionário',translate:'Traduzir',copy:'Copiar',highlight:'Destacar',correct:'Corrigir',excerpt:'Trecho',cross:'Pesquisar na biblioteca',semantic:'Sentido semelhante',aiReader:'Leitura com IA',note:'Nota',bookmark:'Marcador',removeHighlight:'Remover destaque',highlightMenuSettings:'Configurações do menu de destaque',display:'Exibição',both:'Ícone + texto',text:'Texto',icon:'Ícone',colorful:'Cores de destaque',layout:'Layout',row:'Linha',grid:'Grade',size:'Tamanho',small:'Pequeno',medium:'Médio',large:'Grande',dragSort:'Arraste para reordenar',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'}
};
Object.keys(READER_HIGHLIGHT_COPY).forEach(function(locale){
  READER_PAGE_COPY[locale]=Object.assign(READER_PAGE_COPY[locale]||{},READER_HIGHLIGHT_COPY[locale]);
});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'zh-CN'),{gray:'灰色'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'zh-TW'),{gray:'灰色'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'en'),{gray:'Gray'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'ja'),{gray:'グレー'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'ko'),{gray:'회색'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'fr'),{gray:'Gris'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'de'),{gray:'Grau'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'es'),{gray:'Gris'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'ru'),{gray:'Серый'});
Object.assign(requiredRecordValue(READER_PAGE_COPY,'pt-BR'),{gray:'Cinza'});
function readerPageLanguage(){const raw=(S&&S.uiLanguage)||document.documentElement.lang||'zh-CN';if(READER_PAGE_COPY[raw])return raw;const base=String(raw).split('-')[0]??'';return base==='zh'?'zh-CN':(READER_PAGE_COPY[base]?base:'en');}
function readerPageText(key: string): string{const lang=readerPageLanguage(),english=requiredRecordValue(READER_PAGE_COPY,'en'),copy=READER_PAGE_COPY[lang]||english;return copy[key]||english[key]||key;}
// 初次排版本章首页后才能恢复锚点；恢复完成前禁止持久化这个临时位置。
var initialResumePending=true;
let HL: HighlightRecord[]=[]; // 全书高亮 [{chapter,start,end,text,note}]，数组下标即后端 index
var hlOverlay: HTMLElement|null=null,sourceTextCache: ReaderSourceRecord[]|null=null,highlightRenderTimer: number|null=null;
function generatedTextNode(node: Node|null): boolean{
  const el: Element|null=node instanceof Element?node:node?.parentElement??null;
  // rr-mode-switch-anchor 承载的是从原段落拆出的真实正文，不是生成文字；
  // 必须参与原文偏移、高亮和搜索，否则切换模式后所有后续偏移都会错位。
  return !!(el&&el.closest&&el.closest('.rr-note-num,#hl-overlay,#virtual-page,#scroll-preview,#turn-fx-sheet,#page-mask'));
}
function sourceTextRecords(): ReaderSourceRecord[]{
  if(sourceTextCache)return sourceTextCache;
  let out: ReaderSourceRecord[]=[],pos=0;
  if(!root)return out;
  let walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node instanceof Text))continue;
    const text=node.nodeValue||'';
    if(generatedTextNode(node))continue;
    if(closestInlineNoteElement(node))continue;
    out.push({node:node,start:pos,end:pos+text.length});
    pos+=text.length;
  }
  sourceTextCache=out;
  return out;
}

function paintFastChapterOpeningPage(): boolean{
  if(!root||!pager||!fastChapterLayout||!IS_MAC_WEBKIT||!usesLineBreakPaging()||!isScrollMode())return false;
  const sp=scrollPort();
  if(!sp)return false;
  const viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  root.style.visibility='';
  invalidateScrollItemsCache();
  // 绝大多数章首在一屏源范围内已有足够正文；先只逐字测量一屏，
  // 避免每次跨章都为不会立即显示的第二屏付费。只有题名空 br 使收紧后的
  // 首页仍明显未填满时，才扩展到两屏重测，保留原有兼容排版行数。
  const tail=virtualExactBandTailProbePx(),initialBottom=viewH+tail;
  let exact=exactTextLineItemsForBand(0,initialBottom);
  if(!exact.length)return false;
  let first=buildVirtualPageFromIndex(exact,0,viewH,Math.max(viewH,root.scrollHeight-viewH),0);
  if(first&&Number(first.virtualBottom||0)<viewH-Math.max(lineHeightPx()*3,72)){
    const expanded=exactTextLineItemsForBand(0,viewH*2+tail);
    if(expanded.length>exact.length){exact=expanded;first=buildVirtualPageFromIndex(exact,0,viewH,Math.max(viewH,root.scrollHeight-viewH),0);}
  }
  if(!first||!first.virtualLayout||!first.virtualLayout.length)return false;
  first.index=0;
  first._rrExactLineCount=exact.length;
  first._rrFragmentCount=first.virtualLayout.reduce(function(total,entry){
    return total+(entry&&entry.type==='line'&&entry.item&&entry.item.fragments?entry.item.fragments.length:0);
  },0);
  scrollBreaks=[0];scrollPages=[first];pagesInCh=1;pageInCh=0;scrollActiveSlice=first;
  scrollProgrammaticUntil=Date.now()+180;scrollProgrammaticTarget=0;sp.scrollTop=0;
  const rendered=renderVirtualScrollPage(first);
  if(rendered&&scroller){scroller.style.clipPath='none';scroller.style.setProperty('-webkit-clip-path','none');}
  return rendered;
}
function sourceTextAround(s: number,e: number,pre: number,post: number): string{
  const recs=sourceTextRecords(),a=Math.max(0,(s||0)-(pre||0)),b=Math.max(a,(e||0)+(post||0)),parts=[];
  for(let i=0;i<recs.length;i++){
    const r=requiredArrayItem(recs,i);
    if(r.end<=a)continue;
    if(r.start>=b)break;
    const from=Math.max(0,a-r.start),to=Math.min((r.node.nodeValue||'').length,b-r.start);
    if(from<to)parts.push((r.node.nodeValue||'').slice(from,to));
  }
  return parts.join('');
}
function compareBoundaryToNodeOffset(container: Node,offset: number,node: Text,nodeOffset: number): number{
  const a=document.createRange(),b=document.createRange();
  a.setStart(container,offset);a.collapse(true);
  b.setStart(node,nodeOffset);b.collapse(true);
  return a.compareBoundaryPoints(Range.START_TO_START,b);
}
function sourceBoundaryOffset(container: Node|null,offset: number): number|null{
  if(!root||!container)return null;
  if(container.nodeType===3&&generatedTextNode(container))return null;
  const recs=sourceTextRecords();
  for(let i=0;i<recs.length;i++){
    const r=requiredArrayItem(recs,i),len=(r.node.nodeValue||'').length;
    if(container===r.node)return r.start+Math.max(0,Math.min(len,offset||0));
    let beforeStart=false,afterEnd=false;
    try{
      beforeStart=compareBoundaryToNodeOffset(container,offset,r.node,0)<=0;
      afterEnd=compareBoundaryToNodeOffset(container,offset,r.node,len)>=0;
    }catch(_){continue;}
    if(beforeStart)return r.start;
    if(afterEnd)continue;
    let lo=0,hi=len;
    while(lo<hi){
      const mid=Math.floor((lo+hi)/2);
      const cmp=compareBoundaryToNodeOffset(container,offset,r.node,mid);
      if(cmp<=0)hi=mid;else lo=mid+1;
    }
    return r.start+lo;
  }
  return recs.length?requiredArrayItem(recs,recs.length-1).end:0;
}
function sourceRangeForOffsets(s: number,e: number): Range|null{
  const recs=sourceTextRecords();
  s=Math.max(0,parseInt(String(s),10)||0);e=Math.max(s,parseInt(String(e),10)||0);
  if(!recs.length||e<=s)return null;
  let start=null,end=null;
  for(let i=0;i<recs.length;i++){
    const r=requiredArrayItem(recs,i),len=(r.node.nodeValue||'').length;
    if(!start&&s<=r.end)start={node:r.node,offset:Math.max(0,Math.min(len,s-r.start))};
    if(e<=r.end){end={node:r.node,offset:Math.max(0,Math.min(len,e-r.start))};break;}
  }
  if(!start||!end)return null;
  const range=document.createRange();
  try{range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);}catch(_){return null;}
  return range;
}
// 智读侧栏开关专用的锚点事务。它不依赖第一次 resize 事件：父窗口会给出真实
// iframe 宽度，正文页等到该宽度连续两帧不变后才恢复，避免重排后又被后续 resize 覆盖。
let readerSideViewportRestoreRaf=0;
function readerSideViewportDiag(tx: ReaderSideViewportTransaction|null,phase: string,extra: ReaderPageTraceDetail = {}): void{
  if(!tx)return;
  let sampled=null,sampledOffset=null;
  try{sampled=topAnchor();sampledOffset=sideAnchorVirtualOffset!=null?sideAnchorVirtualOffset:anchorTextOffset(sampled);}catch(_){}
  const payload: ReaderPageTraceDetail={
    id:tx.id,phase:phase,chapter:curCh,page:pageInCh+1,pages:pagesInCh,
    targetOffset:tx.offset,sampledOffset:sampledOffset,width:Math.round(window.innerWidth||0),
    expectedWidth:tx.expectedWidth||0,preparedWidth:tx.preparedWidth||0,
    flow:S.flowMode,pageMode:S.pageMode,virtualOffset:sideAnchorVirtualOffset
  };
  if(extra)for(const k in extra){const value=extra[k];if(value!==undefined)payload[k]=value;}
  parent.postMessage({readerPerf:'ai_side_anchor '+JSON.stringify(payload)},'*');
}
function finishReaderSideViewportRestore(tx: ReaderSideViewportTransaction,reason: string): void{
  if(!tx||tx!==window.__readerSideViewportTxn||tx.finished)return;
  tx.finished=true;
  const range=sourceRangeForOffsets(tx.offset,tx.offset+1);
  if(range){
    curTopAnchor={range:range};
    relayout({
      anchor:curTopAnchor,anchorOffset:tx.offset,sidePaneResize:true,
      exactScroll:isScrollMode(),scrollOffset:tx.viewportOffset
    });
  }
  requestAnimationFrame(function(){
    if(tx!==window.__readerSideViewportTxn)return;
    // 再以同一原始偏移定位一次，确保浏览器在本帧完成列宽计算后不会覆盖落点。
    const latestRange=sourceRangeForOffsets(tx.offset,tx.offset+1);
    if(latestRange){
      curTopAnchor={range:latestRange};
      relayout({
        anchor:curTopAnchor,anchorOffset:tx.offset,sidePaneResize:true,
        exactScroll:isScrollMode(),scrollOffset:tx.viewportOffset
      });
      captureAnchor();
      // 常规整页只能显示页首；这里在上层展示从原阅读锚点开始的临时页，
      // 让开/关智读不会把当前文字吸回宽页的章节开头。
      if(!isScrollMode())renderSideAnchorVirtualPage(tx.offset);
    }
    readerSideViewportDiag(tx,'restored',{reason:reason||'stable'});
    window.__readerSideViewportTxn=null;
  });
}
function scheduleReaderSideViewportRestore(tx: ReaderSideViewportTransaction): void{
  if(!tx||tx!==window.__readerSideViewportTxn||!tx.committed||tx.finished)return;
  if(readerSideViewportRestoreRaf)cancelAnimationFrame(readerSideViewportRestoreRaf);
  let started=performance.now(),lastWidth=-1,stableFrames=0;
  function waitForStableWidth(){
    if(tx!==window.__readerSideViewportTxn||tx.finished)return;
    const width=Math.round(window.innerWidth||0),expected=Math.round(tx.expectedWidth||0);
    const matches=!expected||Math.abs(width-expected)<=2;
    stableFrames=(matches&&width===lastWidth)?stableFrames+1:0;
    lastWidth=width;
    if(matches&&stableFrames>=2){finishReaderSideViewportRestore(tx,'stable');return;}
    if(performance.now()-started>1200){finishReaderSideViewportRestore(tx,'timeout');return;}
    readerSideViewportRestoreRaf=requestAnimationFrame(waitForStableWidth);
  }
  readerSideViewportRestoreRaf=requestAnimationFrame(waitForStableWidth);
}
function ensureHighlightOverlay(){
  if(!hlOverlay){
    hlOverlay=document.getElementById('hl-overlay');
    if(!hlOverlay){hlOverlay=document.createElement('div');hlOverlay.id='hl-overlay';document.body.appendChild(hlOverlay);}
  }
  return hlOverlay;
}
function highlightRegistry(): ReaderHighlightRegistry|null{
  const registry=CSS.highlights;
  if(!registry)return null;
  const candidate=Object(registry) as {set?:ReaderHighlightRegistry['set'];delete?:ReaderHighlightRegistry['delete']};
  return typeof candidate.set==='function'&&typeof candidate.delete==='function'?candidate as ReaderHighlightRegistry:null;
}
function clearHighlightOverlay(){
  const registry=highlightRegistry();if(registry)try{registry.delete('reader-hl');}catch(_){}
  if(hlOverlay)hlOverlay.innerHTML='';
}
function clearLegacyHighlightMarks(){
  if(!root)return;
  const ms=root.querySelectorAll('mark.hl');
  for(let i=0;i<ms.length;i++){
    const m=requiredArrayItem(ms,i);
    if(m.parentNode)m.parentNode.replaceChild(document.createTextNode(m.getAttribute('data-orig')||m.textContent||''),m);
  }
  if(ms.length){root.normalize();sourceTextCache=null;}
}
function clearHighlights(){
  clearLegacyHighlightMarks();
  clearHighlightOverlay();
}
function highlightDisplayText(h: HighlightRecord|null): string{
  const t=h&&typeof h.corrected_text==='string'?h.corrected_text:'';
  return t?t:((h&&h.text)||'');
}
function highlightIndexForRange(s: number|string|undefined,e: number|string|undefined): number{
  if(s==null||e==null)return -1;
  const start=parseInt(String(s),10),end=parseInt(String(e),10);
  if(!isFinite(start)||!isFinite(end))return -1;
  for(let i=0;i<HL.length;i++){
    const h=HL[i];
    if(!h||h.chapter!==curCh)continue;
    const hs=parseInt(String(h.start),10),he=parseInt(String(h.end),10);
    if(!isFinite(hs)||!isFinite(he))continue;
    if(start<he&&end>hs)return i;
  }
  return -1;
}
function highlightRange(idx: number): Range|null{
  const h=HL[idx];
  if(!h||h.chapter!==curCh)return null;
  return sourceRangeForOffsets(parseInt(String(h.start),10),parseInt(String(h.end),10));
}
function visibleHighlightRect(idx: number): DOMRect|null{
  const range=highlightRange(idx);
  if(!range)return null;
  let rects: DOMRect[]=[];try{rects=Array.from(range.getClientRects()).filter(function(r: DOMRect){return r.width>0&&r.height>0;});}catch(_){rects=[];}
  if(!rects.length)return null;
  const vw=window.innerWidth||1,vh=window.innerHeight||1;
  for(let i=0;i<rects.length;i++){
    const r=requiredArrayItem(rects,i);
    if(r.right>=0&&r.left<=vw&&r.bottom>=0&&r.top<=vh)return r;
  }
  return requiredArrayItem(rects,0);
}
function applyHighlights(){
  clearHighlights();
  if(!root)return;
  const overlay=ensureHighlightOverlay();
  if(virtualPage&&virtualPage.style.display==='block'){overlay.innerHTML='';return;}
  const ranges=[];
  for(let i=0;i<HL.length;i++){
    const h=HL[i];if(!h||h.chapter!==curCh)continue;
    const range=sourceRangeForOffsets(parseInt(String(h.start),10),parseInt(String(h.end),10));if(!range)continue;
    ranges.push(range);
    let rects: DOMRect[]=[];try{rects=Array.from(range.getClientRects());}catch(_){rects=[];}
    for(let j=0;j<rects.length;j++){
      const r=rects[j];
      if(!r||r.width<1||r.height<3)continue;
      if(r.right<0||r.left>(window.innerWidth||0)||r.bottom<0||r.top>(window.innerHeight||0))continue;
      const d=document.createElement('span');
      d.className='hl-rect'+(h.note?' has-note':'');
      d.setAttribute('data-hi',String(i));
      d.style.setProperty('--hl-color',highlightColorValue(h.color||'y'));
      if(h.note)d.title=h.note;
      d.style.left=Math.round(r.left)+'px';
      d.style.top=Math.round(r.top)+'px';
      d.style.width=Math.max(1,Math.ceil(r.width))+'px';
      d.style.height=Math.max(1,Math.ceil(r.height))+'px';
      overlay.appendChild(d);
    }
  }
  const registry=highlightRegistry();if(registry&&ranges.length){
    try{registry.set('reader-hl',new Highlight(...ranges));}catch(_){}
  }
}
function scheduleHighlightRender(){
  if(highlightRenderTimer)cancelAnimationFrame(highlightRenderTimer);
  highlightRenderTimer=requestAnimationFrame(function(){highlightRenderTimer=null;applyHighlights();});
}
function refreshHighlights(){scheduleHighlightRender();}
function virtualSelectionActive(){
  const sel=window.getSelection?window.getSelection():null;
  if(!sel||!sel.rangeCount||!virtualPage||virtualPage.style.display!=='block')return false;
  const r=sel.getRangeAt(0),n=r.commonAncestorContainer;
  return !!(n&&virtualPage.contains(n.nodeType===1?n:n.parentNode));
}
function virtualBoundaryOffset(container: Node|null,offset: number,isEnd: boolean): number|null{
  const el: Element|null=container instanceof Element?container:container?.parentElement??null;
  const frag=el&&el.closest?el.closest('.vp-frag'):null;
  if(!frag)return null;
  const s=parseInt(frag.getAttribute('data-vstart')||'',10),e=parseInt(frag.getAttribute('data-vend')||'',10);
  if(!isFinite(s)||!isFinite(e))return null;
  if(container&&container.nodeType===3)return Math.max(s,Math.min(e,s+(offset||0)));
  return isEnd?e:s;
}
function virtualSelectionOffsets(): SelectionOffsets|null{
  const sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return null;
  const r=sel.getRangeAt(0),t=sel.toString();if(!t||!t.length)return null;
  if(!virtualSelectionActive())return null;
  let start=virtualBoundaryOffset(r.startContainer,r.startOffset,false);
  let end=virtualBoundaryOffset(r.endContainer,r.endOffset,true);
  if(start==null||end==null){
    if(!virtualPage)return null;
    const spans=virtualPage.querySelectorAll('.vp-frag[data-vstart][data-vend]');
    for(let i=0;i<spans.length;i++){
      let span=requiredArrayItem(spans,i),hit=false;try{hit=r.intersectsNode(span);}catch(_){hit=false;}
      if(!hit)continue;
      const s=parseInt(span.getAttribute('data-vstart')||'',10),e=parseInt(span.getAttribute('data-vend')||'',10);
      if(!isFinite(s)||!isFinite(e))continue;
      if(start==null||s<start)start=s;
      if(end==null||e>end)end=e;
    }
  }
  if(start==null||end==null||end<=start)return null;
  return {start:start,end:end,text:t};
}
function selOffsets(): SelectionOffsets|null{
  const sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return null;
  const vo=virtualSelectionOffsets();if(vo)return vo;
  const r=sel.getRangeAt(0);const t=r.toString();if(!t||!t.length)return null;
  let start=sourceBoundaryOffset(r.startContainer,r.startOffset);
  let end=sourceBoundaryOffset(r.endContainer,r.endOffset);
  if(start==null||end==null)return null;
  if(end<start){const tmp=start;start=end;end=tmp;}
  return {start:start,end:end,text:t,range_anchor:{start:sourceOffsetAnchor(start),end:sourceOffsetAnchor(end)}};
}
function sourceOffsetAnchor(offset: number): ReaderStoredAnchor{
  offset=Math.max(0,parseInt(String(offset),10)||0);
  return {
    chapter:curCh,
    dom_path:'',
    text_offset:offset,
    context_before:sourceTextAround(Math.max(0,offset-72),offset,0,0),
    context_after:sourceTextAround(offset,offset+112,0,0),
    viewport_offset:0
  };
}
function injectHead(htmlStr: string,seen: Record<string,Promise<void>>): Promise<void>{
  const tmp=document.createElement('div');tmp.innerHTML=htmlStr;
  const nodes=tmp.querySelectorAll('link,style');
  const waits: Promise<void>[]=[];
  for(let i=0;i<nodes.length;i++){
    var node=requiredArrayItem(nodes,i),key=node.outerHTML;
    const existing=seen[key];if(existing){waits.push(existing);continue;}
    if(node instanceof HTMLLinkElement&&String(node.rel||node.getAttribute('rel')||'').toLowerCase()==='stylesheet'){
      seen[key]=new Promise(function(resolve){
        let settled=false,timer: ReturnType<typeof setTimeout>|null=null;
        function done(){if(settled)return;settled=true;if(timer)clearTimeout(timer);resolve();}
        node.addEventListener('load',done,{once:true});node.addEventListener('error',done,{once:true});
        timer=setTimeout(done,2000);document.head.appendChild(node);
      });
    }else{
      document.head.appendChild(node);seen[key]=Promise.resolve();
    }
    waits.push(requiredRecordValue(seen,key));
  }
  return Promise.all(waits).then(function(){return;});
}
function restoreStoredReadingAnchor(anchor: ReaderStoredAnchor): boolean{
  if(!anchor||typeof sourceRangeForOffsets!=='function')return false;
  let offset=Math.max(0,parseInt(String(anchor.text_offset),10)||0);
  const before=String(anchor.context_before||''),after=String(anchor.context_after||'');
  // 若书籍导入后 HTML 略有变化，优先用附近上下文校验；偏移已不可靠时再在本章中寻找锚点。
  const directBefore=before?sourceTextAround(Math.max(0,offset-before.length),offset,0,0):'';
  const directAfter=after?sourceTextAround(offset,offset+after.length,0,0):'';
  if((before&&directBefore!==before)||(after&&directAfter!==after)){
    const probe=after||before;
    if(probe){
      const whole=sourceTextAround(0,Number.MAX_SAFE_INTEGER,0,0);
      const found=nearestTextOccurrence(whole,probe,after?offset:Math.max(0,offset-probe.length));
      if(found>=0)offset=after?found:found+probe.length;
    }
  }
  const range=sourceRangeForOffsets(offset,offset+1);
  if(!range)return false;
  let rect: DOMRect|null=null;try{rect=range.getBoundingClientRect();}catch(_){rect=null;}
  if(!rect)return false;
  const sp=scrollPort();if(isScrollMode()&&sp){
    const pr=viewRect();
    const top=Math.max(0,Math.round((sp.scrollTop||0)+rect.top-pr.top-(Number(anchor.viewport_offset)||0)));
    scrollProgrammaticUntil=Date.now()+180;scrollProgrammaticTarget=top;sp.scrollTop=top;
    pageInCh=pageIndexForScrollTop(top);
  }else{
    const pageAnchor={range:range};
    if(isDualPage()&&typeof alignDualAnchorToLeftPage==='function'&&alignDualAnchorToLeftPage(pageAnchor))setViewOffset();
    else {const stableRect=rect;gotoPage(pageOf({getBoundingClientRect:function(){return stableRect;}}));}
  }
  curTopAnchor={range:range};
  return true;
}
let sameBookResumeRestoreGeneration=0,sameBookResizeSequence=0;
function restoreSameBookResumeAnchor(request: ReaderSameBookResumeRequest): boolean{
  if(!request||request.chapter!==curCh||!request.anchor)return false;
  const offset=Math.max(0,Math.round(Number(request.anchor.text_offset)));
  if(!Number.isFinite(offset))return false;
  const viewportOffset=Math.max(0,Math.round(Number(request.anchor.viewport_offset)||0));
  const range=sourceRangeForOffsets(offset,offset+1);
  if(!range)return false;
  curTopAnchor={range:range};
  relayout({anchor:curTopAnchor,anchorOffset:offset,exactScroll:isScrollMode(),scrollOffset:viewportOffset});
  // relayout() 会按新分页捕获可见页首。隐藏窗口恢复必须继续以关闭前的字符
  // 为唯一锚点，避免下一帧或下一次 reopen 把分页取整误差永久写回数据库。
  const stableRange=sourceRangeForOffsets(offset,offset+1);
  if(stableRange)curTopAnchor={range:stableRange};
  return true;
}
function scheduleSameBookResumeRestore(request: ReaderSameBookResumeRequest): void{
  const generation=++sameBookResumeRestoreGeneration;
  const started=performance.now(),beforePage=pageInCh;
  let lastWidth=-1,lastHeight=-1,lastResizeSequence=-1,stableFrames=0;
  function finish(reason: string): void{
    if(generation!==sameBookResumeRestoreGeneration)return;
    const first=restoreSameBookResumeAnchor(request);
    requestAnimationFrame(function(){
      if(generation!==sameBookResumeRestoreGeneration)return;
      const second=restoreSameBookResumeAnchor(request);
      const restored=first||second;
      if(restored){
        const finalRange=sourceRangeForOffsets(request.anchor.text_offset,request.anchor.text_offset+1);
        if(finalRange)curTopAnchor={range:finalRange};
        stabilizeProgrammaticViewPaint();
      }
      const restoredOffset=anchorTextOffset(curTopAnchor);
      sameBookResumeReportDetail={
        reason:reason,
        before_page:beforePage,
        after_page:pageInCh,
        before_anchor_offset:request.anchor.text_offset,
        after_anchor_offset:restoredOffset==null?request.anchor.text_offset:Math.max(0,Math.round(restoredOffset)),
        resize_sequence:sameBookResizeSequence,
        layout_width:Math.max(0,Math.round(window.innerWidth||0)),
        layout_height:Math.max(0,Math.round(window.innerHeight||0)),
        restore_pending:false
      };
      report(false,true);
      readerBugTrace('same_book_resume',restored?'restored':'anchor_missing',null,{
        before_page:beforePage,
        after_page:pageInCh,
        duration_ms:Math.max(0,Math.round(performance.now()-started)),
        input:reason
      });
    });
  }
  function waitForStableViewport(): void{
    if(generation!==sameBookResumeRestoreGeneration)return;
    const width=Math.round(window.innerWidth||0),height=Math.round(window.innerHeight||0),resizeSequence=sameBookResizeSequence;
    const unchanged=width===lastWidth&&height===lastHeight&&resizeSequence===lastResizeSequence;
    stableFrames=unchanged?stableFrames+1:0;
    lastWidth=width;lastHeight=height;lastResizeSequence=resizeSequence;
    if(stableFrames>=2){finish('stable');return;}
    if(performance.now()-started>=900){finish('timeout');return;}
    requestAnimationFrame(waitForStableViewport);
  }
  requestAnimationFrame(waitForStableViewport);
}
function nearestTextOccurrence(whole: string,probe: string,expected: number): number{
  if(!whole||!probe)return -1;
  expected=Math.max(0,parseInt(String(expected),10)||0);
  let best=-1,bestDistance=Number.POSITIVE_INFINITY,from=0;
  while(from<=whole.length){
    const found=whole.indexOf(probe,from);
    if(found<0)break;
    const distance=Math.abs(found-expected);
    if(distance<bestDistance){best=found;bestDistance=distance;}
    if(distance===0)break;
    from=found+1;
  }
  return best;
}
function loadInit(){
  const p=new URLSearchParams(location.search);
  const benchmark=p.get('benchmark')==='1';
  try{S=Object.assign(S,JSON.parse(decodeURIComponent(p.get('s')||'{}')));}catch(e){}
  let storedPosition: ReaderStoredPosition|null=null;try{storedPosition=JSON.parse(decodeURIComponent(p.get('ra')||'null')) as ReaderStoredPosition|null;}catch(_){storedPosition=null;}
  let rc=parseInt(p.get('rc')||'0',10)||0, rf=parseFloat(p.get('rf')||'0')||0;
  if(storedPosition&&storedPosition.anchor&&Number.isFinite(storedPosition.chapter))rc=storedPosition.chapter;
  showChapter(rc,'start').then(function(){
    let resumePage=Math.round(rf*(pagesInCh-1));
    const restored=storedPosition&&storedPosition.anchor&&restoreStoredReadingAnchor(storedPosition.anchor);
    // 双页续读以保存时的 spread 为准。字符锚点只负责找到同一段文字，不能
    // 在重开时把右栏改成新的左栏；那会引入 dualStartColumn=1，并让页数
    // 恰好漂移一页。恢复后统一回到标准偶数列起始，再按保存比例定位 spread。
    if(restored&&isDualPage()){
      dualStartColumn=0;
      pagesInCh=fastChapterLayout?fastPagedPageCount(root):pagedPageCountFromContent(root);
      resumePage=Math.round(rf*(pagesInCh-1));
      pageInCh=Math.max(0,Math.min(pagesInCh-1,resumePage));
      setViewOffset();
    }else if(restored&&resumePage>0&&Math.abs(pageInCh-resumePage)>0){
      pageInCh=Math.max(0,Math.min(pagesInCh-1,resumePage));
      setViewOffset();
    }
    if(!restored){
      if(resumePage>0)gotoPage(resumePage);
      else if(isScrollMode()){const initialPort=scrollPort();if(initialPort){pageInCh=0;initialPort.scrollTop=0;scrollProgrammaticTarget=0;}}
    }
    // 第一次上报只更新页码显示，不得立即覆盖已保存位置；用户真正翻页或
    // 关闭窗口时，reader shell 才会提交恢复后的稳定锚点。
    initialResumePending=false;
    captureAnchor();
    report(false,true);
    reveal();
    if(benchmark){
      parent.postMessage({readerPerf:'page_layout_ready'},'*');
      requestAnimationFrame(function(){requestAnimationFrame(function(){parent.postMessage({readerPerf:'page_displayed'},'*');});});
    }
    parent.postMessage({ready:1},'*');
    scheduleMeasure(500);
  });
}
function requiredHtmlElement(id: string): HTMLElement { const element=document.getElementById(id); if(!(element instanceof HTMLElement)) throw new Error('Missing reader page element: '+id); return element; }
function requireReaderRoot(id: string): ReaderPageRootElement { const element=requiredHtmlElement(id); return element; }
function init(){
  pager=requiredHtmlElement('pager');scroller=requiredHtmlElement('scroller');root=requireReaderRoot('reader-root');measurer=requiredHtmlElement('measurer');
  pageMask=document.getElementById('page-mask');
  if(!pageMask&&pager){pageMask=document.createElement('div');pageMask.id='page-mask';pager.appendChild(pageMask);}
  virtualPage=document.getElementById('virtual-page');
  if(!virtualPage&&pager){virtualPage=document.createElement('div');virtualPage.id='virtual-page';pager.appendChild(virtualPage);}
  hlOverlay=ensureHighlightOverlay();
  scrollPreview=document.getElementById('scroll-preview');
  if(!scrollPreview&&pager){scrollPreview=document.createElement('div');scrollPreview.id='scroll-preview';pager.appendChild(scrollPreview);}
  const initialScrollPort=scrollPort();
  if(!initialScrollPort)throw new Error('Missing reader scroll port');
  initialScrollPort.addEventListener('scroll',syncScrollPageFromTop,{passive:true});
  loadInit();
  setTimeout(function(){reveal();parent.postMessage({ready:1},'*');},8000); // 兜底
  // 记录是否发生了拖动（用于区分“单击翻页”与“拖动选字”）
  // 使用 Pointer Events 并捕获指针：通过触控板远程操作时，旧 mouseup 可能在
  // 指针离开正文 iframe 后丢失，外层就收不到完整手势，造成书架可用而阅读页无效。
  let readerGestureDrawing=false,readerGesturePointerId: number|null=null,readerGestureSource:''|'pointer'|'mouse'='';
  function reportReaderGesture(phase: string,e: MouseEvent|PointerEvent){parent.postMessage({readerGesture:{phase:phase,x:e.clientX,y:e.clientY}},'*');}
  function startReaderGesture(e: MouseEvent|PointerEvent,source:'pointer'|'mouse'){if(readerGestureDrawing)return;readerGestureDrawing=true;readerGestureSource=source;readerGesturePointerId=source==='pointer'&&e instanceof PointerEvent?e.pointerId:null;if(source==='pointer'&&e instanceof PointerEvent)try{document.documentElement.setPointerCapture(e.pointerId);}catch(_){}reportReaderGesture('start',e);e.preventDefault();}
  function finishReaderGesture(e: MouseEvent|PointerEvent,phase: string){if(!readerGestureDrawing)return;readerGestureDrawing=false;readerGesturePointerId=null;readerGestureSource='';reportReaderGesture(phase,e);e.preventDefault();}
  document.addEventListener('pointerdown',function(e){if(e.button===2)startReaderGesture(e,'pointer');},true);
  document.addEventListener('pointermove',function(e){if(!readerGestureDrawing||readerGestureSource!=='pointer'||e.pointerId!==readerGesturePointerId)return;reportReaderGesture('move',e);e.preventDefault();},true);
  document.addEventListener('pointerup',function(e){if(readerGestureDrawing&&readerGestureSource==='pointer'&&e.pointerId===readerGesturePointerId)finishReaderGesture(e,'end');},true);
  document.addEventListener('pointercancel',function(e){if(readerGestureDrawing&&readerGestureSource==='pointer'&&e.pointerId===readerGesturePointerId)finishReaderGesture(e,'cancel');},true);
  // ToSwak 等远程触控板有时只注入 MouseEvent，不会同时产生 PointerEvent。
  // 保留这条兜底链，且以 source 标记与上面的 pointer 链互斥。
  document.addEventListener('mousedown',function(e){if(e.button===2)startReaderGesture(e,'mouse');},true);
  document.addEventListener('mousemove',function(e){if(!readerGestureDrawing||readerGestureSource!=='mouse')return;reportReaderGesture('move',e);e.preventDefault();},true);
  document.addEventListener('mouseup',function(e){if(readerGestureDrawing&&readerGestureSource==='mouse')finishReaderGesture(e,'end');},true);
  window.addEventListener('blur',function(){if(!readerGestureDrawing)return;readerGestureDrawing=false;readerGesturePointerId=null;readerGestureSource='';parent.postMessage({readerGesture:{phase:'cancel',x:0,y:0}},'*');},true);
  document.addEventListener('contextmenu',function(e){if(readerGestureDrawing)e.preventDefault();},true);
  document.addEventListener('mousedown',function(e){downX=e.clientX;downY=e.clientY;didDrag=false;if(e.detail>1)e.preventDefault();}); // e.detail>1：双击/三击 → 阻止浏览器选词/选段（连点翻页常被当双击而误选）
  document.addEventListener('mousemove',function(e){if(downX!==null&&downY!==null&&(Math.abs(e.clientX-downX)>4||Math.abs(e.clientY-downY)>4))didDrag=true;});
  document.addEventListener('mouseup',function(){downX=null;downY=null;});
  let macFastTap: ReaderTapSnapshot|null=null;
  const isMacWebKit=IS_MAC_WEBKIT;
  function tapHasSelection(){
    const sel=window.getSelection?window.getSelection():null;
    return !!(sel&&!sel.isCollapsed&&sel.toString().trim());
  }
  function normalizedTapZones(): ReaderClickZone[]{
    const defaults: ReaderClickZone[]=[{id:'zone-1',action:'prev',x:0,y:0,width:400,height:1000},{id:'zone-2',action:'center',x:400,y:0,width:200,height:1000},{id:'zone-3',action:'next',x:600,y:0,width:400,height:1000}];
    const supplied=Array.isArray(S.clickZones)?S.clickZones.filter(function(item: ReaderClickZone){return !!item;}):[];
    const source=(supplied.length?supplied:defaults).slice(0,12);
    function overlaps(a: ReaderClickZone,b: ReaderClickZone): boolean{return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
    function trim(zone: ReaderClickZone,blocker: ReaderClickZone): ReaderClickZone|null{
      if(!overlaps(zone,blocker))return zone;
      const l=Math.max(zone.x,blocker.x),t=Math.max(zone.y,blocker.y),r=Math.min(zone.x+zone.width,blocker.x+blocker.width),b=Math.min(zone.y+zone.height,blocker.y+blocker.height);
      const parts=[Object.assign({},zone,{width:l-zone.x}),Object.assign({},zone,{x:r,width:zone.x+zone.width-r}),Object.assign({},zone,{height:t-zone.y}),Object.assign({},zone,{y:b,height:zone.y+zone.height-b})].filter(function(part){return part.width>=20&&part.height>=20;});
      parts.sort(function(a: ReaderClickZone,b: ReaderClickZone){return b.width*b.height-a.width*a.height;});return parts[0]||null;
    }
    const normalized: ReaderClickZone[]=source.map(function(raw: ReaderClickZone,index: number){
      const fallback=defaults[index]||{id:'zone-'+(index+1),action:'none',x:350,y:350,width:300,height:300};
      const x=Math.max(0,Math.min(980,Math.round(Number(raw.x)||0))),y=Math.max(0,Math.min(980,Math.round(Number(raw.y)||0)));
      return{id:typeof raw.id==='string'?raw.id:fallback.id,action:['prev','center','next','none'].indexOf(raw.action)>=0?raw.action:fallback.action,x:x,y:y,width:Math.max(20,Math.min(1000-x,Math.round(Number(raw.width)||fallback.width))),height:Math.max(20,Math.min(1000-y,Math.round(Number(raw.height)||fallback.height)))};
    });
    const accepted: ReaderClickZone[]=[];normalized.forEach(function(zone: ReaderClickZone){let candidate: ReaderClickZone|null=zone;accepted.forEach(function(blocker: ReaderClickZone){if(candidate)candidate=trim(candidate,blocker);});if(candidate)accepted.push(candidate);});return accepted;
  }
  function tapActionAt(x: number,y: number): ReaderClickAction{
    const nx=Math.max(0,Math.min(1000,Number(x)/Math.max(1,window.innerWidth)*1000)),ny=Math.max(0,Math.min(1000,Number(y)/Math.max(1,window.innerHeight)*1000));
    const match=normalizedTapZones().find(function(zone){return nx>=zone.x&&nx<=zone.x+zone.width&&ny>=zone.y&&ny<=zone.y+zone.height;});
    return match?match.action:'none';
  }
  function rememberReaderJump(kind: 'footnote'|'link'){
    const frac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
    parent.postMessage({readerJump:{kind:kind==='footnote'?'footnote':'link',chapter:Math.max(0,curCh||0),chFrac:Math.max(0,Math.min(1,frac))}},'*');
  }
  function handleReaderTap(e: MouseEvent|PointerEvent){
    if(typeof queuePendingReaderModeInput==='function'&&queuePendingReaderModeInput({kind:'tap',event:e})){
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const target=e.target instanceof Element?e.target:null;
    if(!target)return;
    const inFootnote=!!(target.closest&&target.closest('#fn-pop'));
    const targetAnchor=target.closest?target.closest('a'):null;
    // 注释角标与其弹层是独立交互：不能把这次点击冒充成正文点击，
    // 否则外壳会打开/关闭工具栏，和脚注弹层争夺同一次操作。
    if(!inFootnote&&!(targetAnchor&&isNoteLink(targetAnchor)))parent.postMessage({uiClick:1},'*');
    const tapAction=tapActionAt(e.clientX,e.clientY);
    if(chapterPending>0||runtime.chapterTurnPending){
      if(tapAction==='next'){nextPage();return;}
      if(tapAction==='prev'){prevPage();return;}
      readerBugTrace('click','chapter_pending',e);return;
    }
    if(overlayOpen){
      readerBugTrace('click','overlay',e);
      // 关闭浮层的同一次中间点击也切换工具栏，不要求用户再点一次。
      if(tapAction==='center')parent.postMessage({centerTap:1},'*');
      return;
    }
    // 点到已高亮的文字 → 出高亮菜单，不翻页
    const hm=target.closest?target.closest('.hl-rect[data-hi],mark.hl'):null;
    if(hm){readerBugTrace('click','highlight',e);e.stopPropagation();showHlMenu(parseInt(hm.getAttribute('data-hi')||'',10),true,hm,e);return;}
    const a=targetAnchor;
    if(inFootnote&&!a){readerBugTrace('click','footnote',e);return;} // 注释弹窗正文：不翻页
    if(a){const href=a.getAttribute('href')||'';
      readerBugTrace('click',inFootnote?'footnote':'link',e);
      if(href.charAt(0)==='#'){e.preventDefault();e.stopPropagation();
        const m=/^#c(\d+)(?:~(.+))?$/.exec(href);
        const frag=m?(m[2]||''):href.slice(1), ciT=m?parseInt(m[1]||'',10):curCh;
        const footnoteJump=inFootnote||isNoteLink(a);
        if(!inFootnote&&pageDebugSettingOn('reader_footnotes')&&footnoteJump&&frag){showFootnote(a,ciT,frag,!!m);return;} // 正文注释角标 → 弹注释正文
        if(m){
          const ci=ciT,fr=frag;
          if(ci===curCh){
            if(fr){const el=document.getElementById(fr);if(el){const targetPage=pageOf(el);hideFn();if(targetPage!==pageInCh){rememberReaderJump(footnoteJump?'footnote':'link');gotoPage(targetPage);}}}
          }else{rememberReaderJump(footnoteJump?'footnote':'link');hideFn();showChapter(ci,'start',fr);}
        }else{
          const el2=document.getElementById(href.slice(1));
          if(el2){const targetPage2=pageOf(el2);hideFn();if(targetPage2!==pageInCh){rememberReaderJump(footnoteJump?'footnote':'link');gotoPage(targetPage2);}}
        }
      }
      return;
    }
    hideFn(); // 点别处 → 收起注释弹窗
    // 拖动选字（或存在选中文字）时不翻页，让 web 搜索菜单稳定停在高亮处
    if(didDrag){readerBugTrace('click','drag',e);return;}
    // mouseup 后清理短暂选区的定时器晚于 click。若本次没有真实拖动，
    // 直接清掉浏览器偶发产生的残留选区并继续翻页，避免第一次点击被吞。
    if(tapHasSelection()){
      const tapSelection=window.getSelection?window.getSelection():null;if(tapSelection)tapSelection.removeAllRanges();
      hideSelMenu();
    }
    const tapStarted=performance.now();
    if(tapAction==='next'){readerBugTrace('click','page_next',e);parent.postMessage({readerNavigated:1},'*');markPageTurnInput('tap');nextPage();reportReaderPaintPerf('tap_next',tapStarted,'chapter='+curCh);}
    else if(tapAction==='prev'){readerBugTrace('click','page_prev',e);parent.postMessage({readerNavigated:1},'*');markPageTurnInput('tap');prevPage();reportReaderPaintPerf('tap_prev',tapStarted,'chapter='+curCh);}
    else if(tapAction==='center'){readerBugTrace('click','center',e);parent.postMessage({centerTap:1},'*');}
    else readerBugTrace('click','none',e);
  }
  // macOS 的 WKWebView 在部分点击序列中较晚派发 click。只对正文空白/文字区
  // 使用更早的 pointerup 翻页，并吞掉紧随其后的 click，避免 Windows 行为变化。
  if(isMacWebKit)document.addEventListener('pointerup',function(e){
    if(e.button!==0||e.isPrimary===false||didDrag)return;
    const pointerTarget=e.target instanceof Element?e.target:null;
    if(pointerTarget&&pointerTarget.closest('a,button,input,select,textarea,#fn-pop,.hl-rect[data-hi],mark.hl,[data-vnote-badge="1"],.rr-note-badge,.rr-note-ref,[data-rr-note-ref="1"],.vp-inline'))return;
    macFastTap={at:Date.now(),x:e.clientX,y:e.clientY,target:e.target};
    handleReaderTap(e);
  });
  document.addEventListener('click',function(e){
    // pointerup 引发跨章时会替换整个正文 DOM，同一次物理点击随后的 click
    // 因此可能落在新节点上。用时间和坐标识别这个重复 click，不再在新章
    // 落地后盲目屏蔽 320 ms；用户的第二次 pointerup 仍会立即翻页。
    if(macFastTap&&Date.now()-macFastTap.at<700&&Math.abs(macFastTap.x-e.clientX)<5&&Math.abs(macFastTap.y-e.clientY)<5){
      readerBugTrace('click','mac_duplicate',e);macFastTap=null;e.preventDefault();e.stopPropagation();return;
    }
    macFastTap=null;
    handleReaderTap(e);
  });
  document.addEventListener('keydown',function(e){if(((e.ctrlKey||e.metaKey)&&(e.key==='f'||e.key==='F'))||e.key==='F3')e.preventDefault();},true); // 禁用浏览器自带查找
  function handleReaderKey(e: KeyboardEvent){
    if(e.key==='PageDown'||e.key==='ArrowRight'||e.key==='ArrowDown'||(e.key===' '&&!e.shiftKey)){readerBugTrace('key','page_next',null,{direction:'forward',key:e.key===' '?'space':e.key});e.preventDefault();userNav();markPageTurnInput('keyboard');nextPage();}
    else if(e.key==='PageUp'||e.key==='ArrowLeft'||e.key==='ArrowUp'||(e.key===' '&&e.shiftKey)){readerBugTrace('key','page_prev',null,{direction:'backward',key:e.key===' '?'space':e.key});e.preventDefault();userNav();markPageTurnInput('keyboard');prevPage();}
  }
  document.addEventListener('keydown',function(e){
    if(e.isComposing||e.key==='Process'||e.keyCode===229)return;
    if(typeof queuePendingReaderModeInput==='function'&&queuePendingReaderModeInput({kind:'key',event:e})){e.preventDefault();return;}
    handleReaderKey(e);
  });
  // 触控板一次滑动会产生多个 wheel。macOS 整屏模式已在原生层去除
  // momentumPhase 尾流；此处仅把同一段直接输入合并，微小 delta 会先累计，
  // 避免轻划被随机丢弃。
  let pageWheelGesture: ReaderWheelGesture|null=null,pageWheelGestureTimer: ReturnType<typeof setTimeout>|null=null,pageWheelStartDelta=0,pageWheelTraceEvents=0,pageWheelGestureTraceEvents=0,pageWheelLastTraceAt=0,scrollChapterLock=false;
  const PAGE_WHEEL_QUIET_MS=64,PAGE_WHEEL_START_DELTA_PX=2;
  function armPageWheelGestureQuietTimer(gesture: ReaderWheelGesture){
    if(pageWheelGestureTimer)clearTimeout(pageWheelGestureTimer);
    pageWheelGestureTimer=setTimeout(function(){
      if(pageWheelGesture===gesture){
        pageWheelGesture=null;pageWheelStartDelta=0;
        tracePageWheel('rearmed',null,null,0,{direction:gesture.direction,wheel_timer_active:false});
        pageWheelGestureTraceEvents=0;
      }
      pageWheelGestureTimer=null;
    },PAGE_WHEEL_QUIET_MS);
  }
  // 不限制单一触控板手势的诊断条数：问题记录本身只保留最近两分钟，
  // 同时只写入脱敏的输入几何和状态，不记录书籍正文、坐标或任何用户内容。
  function tracePageWheel(phase: string,e: WheelEvent|ReaderWheelReplayEvent|null,gesture: ReaderWheelGesture|null,delta: number,extra?: ReaderPageTraceDetail){
    pageWheelGestureTraceEvents++;
    pageWheelTraceEvents++;
    const now=performance.now(),gap=pageWheelLastTraceAt?Math.round(now-pageWheelLastTraceAt):-1;
    pageWheelLastTraceAt=now;
    function num(value: number|null|undefined){return Math.round(Number(value||0)*100)/100;}
    const age=gesture&&gesture.started?Math.round(now-gesture.started):-1;
    const data: ReaderPageTraceDetail={direction:gesture?gesture.direction:null,wheel_seq:pageWheelTraceEvents,wheel_delta_x:num(e&&e.deltaX),wheel_delta_y:num(e&&e.deltaY),wheel_delta_px:num(delta),wheel_delta_mode:Math.round(e&&e.deltaMode||0),wheel_gap_ms:gap,wheel_accumulated_px:num(pageWheelStartDelta),wheel_threshold_px:PAGE_WHEEL_START_DELTA_PX,wheel_quiet_ms:PAGE_WHEEL_QUIET_MS,wheel_gesture_age_ms:age,wheel_gesture_active:!!gesture,wheel_timer_active:!!pageWheelGestureTimer,wheel_event_cancelable:!!(e&&e.cancelable),wheel_replay:!!(e&&'replay' in e&&e.replay),wheel_mode_pending:!!(extra&&extra.wheel_mode_pending)};
    readerBugTrace('wheel',phase,null,data);
    parent.postMessage({readerPerf:'page_wheel '+JSON.stringify({
      n:pageWheelTraceEvents,phase:phase,dx:data.wheel_delta_x,dy:data.wheel_delta_y,px:data.wheel_delta_px,
      gap:data.wheel_gap_ms,accumulated:data.wheel_accumulated_px,mode:data.wheel_delta_mode,cancelable:data.wheel_event_cancelable,gesture:data.wheel_gesture_active,replay:data.wheel_replay,modePending:data.wheel_mode_pending,ts:Math.round(e&&e.timeStamp||0)
    })},'*');
    return data;
  }
  function handleReaderWheel(e: WheelEvent|ReaderWheelReplayEvent){
    if(isScrollMode()){
      userNav();
      scrollProgrammaticTarget=null;
      if(scrollPagedView){
        const sp0=scrollPort(),top0=sp0?Math.round(sp0.scrollTop||0):0;
        const slice0=activeScrollSliceAtTop(top0);
        let d0=wheelDeltaPx(e);
        if(Math.abs(d0)<4)d0=0;
        let stableTop=top0;
        if(slice0&&sp0){
          stableTop=Math.max(0,Math.min(scrollMaxTop(),Math.round(slice0.top||top0)));
        }
        const targetTop=sp0?Math.max(0,Math.min(scrollMaxTop(),stableTop+d0)):stableTop;
        scrollProgrammaticUntil=Date.now()+120;
        scrollProgrammaticTarget=targetTop;
        if(sp0)sp0.scrollTop=targetTop;
        pageInCh=pageIndexForScrollTop(targetTop);
        scrollPagedView=false;
        scrollActiveSlice=null;
        applyScrollPageMask();
        report();
        if(scrollCaptureTimer)clearTimeout(scrollCaptureTimer);
        scrollCaptureTimer=setTimeout(function(){captureAnchor();report();},160);
        e.preventDefault();
        return;
      }
      scrollPagedView=false;
      applyScrollPageMask();
      if(!pager||scrollChapterLock)return;
      const d=wheelDeltaPx(e);
      if(d>0&&curCh<CH-1&&canLeaveScrollChapter(1)){
        e.preventDefault();scrollChapterLock=true;showChapter(curCh+1,'start').finally(function(){setTimeout(function(){scrollChapterLock=false;},180);});
      }else if(d<0&&curCh>0&&canLeaveScrollChapter(-1)){
        e.preventDefault();scrollChapterLock=true;showChapter(curCh-1,'end').finally(function(){setTimeout(function(){scrollChapterLock=false;},180);});
      }else if('replay' in e&&e.replay){
        // 原始 wheel 已在等待重排时被取消；把首条输入的位移精确交给新滚动容器。
        const replayPort=scrollPort();
        if(replayPort){
          const replayTop=Math.max(0,Math.min(scrollMaxTop(),(replayPort.scrollTop||0)+d));
          replayPort.scrollTop=replayTop;
          pageInCh=pageIndexForScrollTop(replayTop);
          report();
        }
        e.preventDefault();
      }
      return;
    }
    e.preventDefault();
    let delta=wheelDeltaPx(e),gesture=pageWheelGesture;
    if(gesture){
      tracePageWheel('ignored',e,gesture,delta);
      // 所有连续 wheel 都属于同一触控板手势，惯性强弱与方向抖动都不另翻页。
      armPageWheelGestureQuietTimer(gesture);
      return;
    }
    // macOS 触控板刚触碰时经常先给出 1px 左右的 delta。累计后再判定方向，
    // 不要求某一单独事件恰好超过阈值，连续滑动就不会出现“有时不翻页”。
    pageWheelStartDelta+=delta;
    const magnitude=Math.abs(pageWheelStartDelta);
    if(magnitude<PAGE_WHEEL_START_DELTA_PX){tracePageWheel('accumulating',e,null,delta);return;}
    const direction: ReaderDirection=pageWheelStartDelta>0?1:-1;
    pageWheelStartDelta=0;
    const activeGesture: ReaderWheelGesture={direction:direction,started:performance.now()};
    gesture=activeGesture;pageWheelGesture=activeGesture;
    pageWheelGestureTraceEvents=0;
    const wheelTurnTrace=tracePageWheel('turn',e,gesture,delta);
    userNav();markPageTurnInput('wheel',wheelTurnTrace);
    if(direction>0)nextPage();else prevPage();
    armPageWheelGestureQuietTimer(activeGesture);
  }
  function readerModeWheelReplay(e: WheelEvent): ReaderModeReplayInput{
    return {kind:'wheel',event:{deltaX:e.deltaX,deltaY:e.deltaY,deltaMode:e.deltaMode,timeStamp:e.timeStamp,replay:true,preventDefault:function(){}}};
  }
  window.replayPendingReaderModeInput=function(input: ReaderModeReplayInput){
    if(!input)return;
    if(input.kind==='tap'){handleReaderTap(input.event);return;}
    if(input.kind==='key'){handleReaderKey(input.event);return;}
    if(input.kind==='wheel'){handleReaderWheel(input.event);}
  };
  document.addEventListener('wheel',function(e){
    if(typeof queuePendingReaderModeInput==='function'&&queuePendingReaderModeInput(readerModeWheelReplay(e))){tracePageWheel('mode_pending',e,pageWheelGesture,wheelDeltaPx(e),{wheel_mode_pending:true});e.preventDefault();return;}
    handleReaderWheel(e);
  },{passive:false});
  window.addEventListener('resize',function(){
    sameBookResizeSequence++;
    const sideTxn=window.__readerSideViewportTxn;
    modeSwitchDiagEvent('resize_before');
    // 智读只改变临时正文宽度：保留已完成/增量页数缓存，也不把右上角页数
    // 切回加载图标。真实窗口变化会由父页面发送新的稳定统计宽度。
    if(!sideTxn){
      if(pageSig&&pageSig!==pageCountSig())invalidateMeasure();
      parent.postMessage({layoutBusy:1},'*');
    }
    // commit 前的瞬间 resize 不使用新页面顶部作为锚点；commit 后由事务在最终宽度稳定时恢复。
    if(sideTxn&&sideTxn.committed&&!sideTxn.finished)scheduleReaderSideViewportRestore(sideTxn);
    else if(!sideTxn)relayout();
    modeSwitchDiagEvent('resize_after');
    if(!sideTxn)scheduleMeasure();
  });
  setupSelMenu();
  setupHlUi();
  setupFn();
  setupDict();
  document.addEventListener('contextmenu',function(e){e.preventDefault();}); // 禁用浏览器右键菜单
}
// 选中文字后弹出“web搜索”菜单 → 通知父窗口用浏览器搜索
let selMenu: ReaderMenuElement|null=null,hlSettingsPop: HTMLDivElement|null=null,selMenuItems: HighlightMenuItem[]=[],hlMenuItems: HighlightMenuItem[]=[];
const HL_MENU_CFG_KEY='highlightMenuActionsV1';
const HL_MENU_CFG_VERSION_KEY='highlightMenuActionsVersionV1';
const HL_MENU_MODE_KEY='highlightMenuDisplayModeV1';
const HL_MENU_SIZE_KEY='highlightMenuSizeV1';
const HL_MENU_LAYOUT_KEY='highlightMenuLayoutV1';
const HL_WEB_ENGINE_KEY='highlightWebSearchEngineV1';
const HL_MENU_COLOR_KEY='highlightMenuMultiColorV1';
const HL_SELECTED_COLOR_KEY='highlightMenuColorV1';
let hlMenuPreferencesRestoring=false,hlMenuPreferencesSynced=false;
const HL_COLORS: HighlightColor[]=[
  {key:'y',labelKey:'gray',value:'rgba(126,136,148,.34)'},
  {key:'g',labelKey:'green',value:'rgba(135,220,151,.42)'},
  {key:'b',labelKey:'blue',value:'rgba(119,185,255,.42)'},
  {key:'p',labelKey:'pink',value:'rgba(255,143,184,.42)'}
];
const HL_MENU_ACTIONS: HighlightAction[]=[
  {key:'web',icon:'web'}, {key:'dict',icon:'dict'}, {key:'translate',icon:'translate'},
  {key:'copy',icon:'copy'}, {key:'highlight',icon:'highlight'}, {key:'correct',icon:'correct'},
  {key:'excerpt',icon:'excerpt'}, {key:'cross',icon:'cross'}, {key:'semantic',icon:'semantic'},
  {key:'aiReader',icon:'aiReader'}, {key:'note',icon:'note'}, {key:'bookmark',icon:'bookmark'}
];
function defaultHlMenuConfig(): HighlightMenuConfig[]{return HL_MENU_ACTIONS.map(function(a){return {key:a.key,show:true};});}
function hlActionLabel(key: HighlightActionKey): string{return readerPageText(key);}
function hlActionIcon(key: HighlightActionKey): string{for(let i=0;i<HL_MENU_ACTIONS.length;i++){const action=requiredArrayItem(HL_MENU_ACTIONS,i);if(action.key===key)return action.icon||'';}return '';}
function hlActionIconMarkup(key: string): string{
  const icons: Record<string,string>={
    web:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.7"/><path d="m15.1 15.1 4.2 4.2"/></svg>',
    dict:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.3c3.1-1.2 5.5-.7 7.5 1.1v12c-2-1.8-4.4-2.3-7.5-1.1zM19.5 5.3c-3.1-1.2-5.5-.7-7.5 1.1v12c2-1.8 4.4-2.3 7.5-1.1z"/></svg>',
    translate:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h8M8.5 4.5c0 5.1-1.9 8.5-4.5 10.5M5.7 11.5c1.4 1.4 3.1 2.5 5.3 3.1M15.2 7.5l4.3 10M16.7 14h5.1"/></svg>',
    copy:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="7" width="10" height="12" rx="1.8"/><path d="M15.5 7V5.8A1.8 1.8 0 0 0 13.7 4H6.8A1.8 1.8 0 0 0 5 5.8v8.7a1.8 1.8 0 0 0 1.8 1.8H8"/></svg>',
    highlight:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5.3 15.8 8.9-8.9 3.4 3.4-8.9 8.9-4.2.8zM13.3 7.8l1.4-1.4a1.7 1.7 0 0 1 2.4 0l1.2 1.2a1.7 1.7 0 0 1 0 2.4l-1.4 1.4M4 21h16"/></svg>',
    remove:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 7.5h13M9 7.5V5.7h6v1.8M7.5 7.5l.8 11h7.4l.8-11M10.2 11v4.2M13.8 11v4.2"/></svg>',
    correct:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m8.3 12.1 2.3 2.4 5.1-5.2"/></svg>',
    excerpt:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 9.1H5.8A1.8 1.8 0 0 0 4 10.9v3.3A1.8 1.8 0 0 0 5.8 16h1.7v-3.2H5.8M15.5 9.1h1.7a1.8 1.8 0 0 1 1.8 1.8v3.3a1.8 1.8 0 0 1-1.8 1.8h-1.7v-3.2h1.7"/></svg>',
    cross:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h8v13H5zM13 8h6v10h-6zM7.5 9h3M7.5 12h3M15.2 11h1.8M15.2 14h1.8"/></svg>',
    semantic:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.2" cy="12" r="1.7"/><circle cx="17.8" cy="6.5" r="1.7"/><circle cx="17.8" cy="17.5" r="1.7"/><path d="m7.7 11.3 8.5-4M7.7 12.7l8.5 4"/></svg>',
    aiReader:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.2L18.5 10l-5 1.7L12 17l-1.5-5.3L5.5 10l5-1.8zM18.4 15.1l.7 2.4 2.4.7-2.4.7-.7 2.4-.7-2.4-2.4-.7 2.4-.7z"/></svg>',
    note:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5h13v10.2h-7l-4.2 3v-3H5.5zM8.5 9h7M8.5 12h4.8"/></svg>',
    bookmark:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10v15l-5-3.3-5 3.3z"/></svg>'
  };
  return icons[key]||'';
}
function hlColorLabel(color: HighlightColor): string{return readerPageText((color&&color.labelKey)||'yellow');}
function readHlMenuMode(){let m='';try{m=localStorage.getItem(HL_MENU_MODE_KEY)||'';}catch(_){}return (m==='text'||m==='icon'||m==='both')?m:'text';}
function saveHlMenuMode(mode: HighlightMode): void{try{localStorage.setItem(HL_MENU_MODE_KEY,mode);}catch(_){}notifyHighlightMenuPreferences();}
function readHlMenuSize(){let s='';try{s=localStorage.getItem(HL_MENU_SIZE_KEY)||'';}catch(_){}return (s==='medium'||s==='large'||s==='small')?s:'medium';}
function saveHlMenuSize(size: HighlightSize): void{try{localStorage.setItem(HL_MENU_SIZE_KEY,size);}catch(_){}notifyHighlightMenuPreferences();}
function readHlMenuLayout(){let s='';try{s=localStorage.getItem(HL_MENU_LAYOUT_KEY)||'';}catch(_){}return s==='row'?'row':'grid';}
function saveHlMenuLayout(layout: HighlightLayout): void{try{localStorage.setItem(HL_MENU_LAYOUT_KEY,layout==='grid'?'grid':'row');}catch(_){}notifyHighlightMenuPreferences();}
function readHlWebEngine(){let s='';try{s=localStorage.getItem(HL_WEB_ENGINE_KEY)||'';}catch(_){}return s==='google'?'google':'baidu';}
function saveHlWebEngine(engine: WebEngine): void{try{localStorage.setItem(HL_WEB_ENGINE_KEY,engine==='google'?'google':'baidu');}catch(_){}notifyHighlightMenuPreferences();}
function readHlMenuColorEnabled(){let s='';try{s=localStorage.getItem(HL_MENU_COLOR_KEY)||'';}catch(_){}return s!=='0';}
function saveHlMenuColorEnabled(enabled: boolean): void{try{localStorage.setItem(HL_MENU_COLOR_KEY,enabled?'1':'0');}catch(_){}notifyHighlightMenuPreferences();}
function readHlColor(): HighlightColorKey{let s='';try{s=localStorage.getItem(HL_SELECTED_COLOR_KEY)||'';}catch(_){}const found=HL_COLORS.find(function(c){return c.key===s;});return found?found.key:'y';}
function saveHlColor(color: HighlightColorKey): void{try{localStorage.setItem(HL_SELECTED_COLOR_KEY,HL_COLORS.some(function(c){return c.key===color;})?color:'y');}catch(_){}}
function highlightColorValue(color: HighlightColorKey): string{for(let i=0;i<HL_COLORS.length;i++){const item=requiredArrayItem(HL_COLORS,i);if(item.key===color)return item.value;}return requiredArrayItem(HL_COLORS,0).value;}
function updateMenuSizeClass(container: ReaderMenuElement|null): void{
  if(!container)return;
  const size=readHlMenuSize();
  container.classList.remove('hm-size-small','hm-size-medium','hm-size-large');
  container.classList.add('hm-size-'+size);
}
function updateActionButton(it: HighlightMenuItem): void{
  if(!it||!it.button)return;
  const mode=readHlMenuMode(),label=it.labelKey?readerPageText(it.labelKey):(it.label||hlActionLabel(it.key)),icon=it.icon||hlActionIcon(it.key);
  it.button.title=label;it.button.setAttribute('aria-label',label);
  const iconMarkup=hlActionIconMarkup(icon);
  if(mode==='icon')it.button.innerHTML=iconMarkup||label;
  else if(mode==='text')it.button.textContent=label;
  else it.button.innerHTML=(iconMarkup?'<span class="hm-icon">'+iconMarkup+'</span>':'')+'<span class="hm-label">'+label+'</span>';
}
function refreshConfiguredMenus(){
  applyConfiguredMenu(selMenu,selMenuItems,selMenu?selMenu._setBtn:undefined);
  applyConfiguredMenu(hlMenu,hlMenuItems,hlMenu?hlMenu._setBtn:undefined);
  // 切换横排/九宫格、字号、显示方式或多彩高亮都会改变菜单尺寸；
  // 可见菜单必须立即按新尺寸重算，不能沿用切换前的 top。
  repositionVisibleHighlightMenu(selMenu);
  repositionVisibleHighlightMenu(hlMenu);
}
function readHlMenuConfig(): HighlightMenuConfig[]{
  let raw=null;try{raw=JSON.parse(localStorage.getItem(HL_MENU_CFG_KEY)||'null');}catch(_){}
  const known: Partial<Record<HighlightActionKey,true>>={};HL_MENU_ACTIONS.forEach(function(a){known[a.key]=true;});
  let out: HighlightMenuConfig[]=[],seen: Partial<Record<HighlightActionKey,true>>={},changed=false;
  if(Array.isArray(raw)){
    raw.forEach(function(x){
      const key=String((x&&x.key)||'') as HighlightActionKey;
      if(!known[key]||seen[key])return;
      seen[key]=true;out.push({key:key,show:x.show!==false});
    });
  }
  function insertMissingAction(a: HighlightAction): void{
    const canonicalIndex=HL_MENU_ACTIONS.findIndex(function(x){return x.key===a.key;});
    let insertAt=out.length;
    for(let i=canonicalIndex-1;i>=0;i--){
      var prevKey=requiredArrayItem(HL_MENU_ACTIONS,i).key;
      const prevPos=out.findIndex(function(x){return x.key===prevKey;});
      if(prevPos>=0){insertAt=prevPos+1;break;}
    }
    if(insertAt===out.length){
      for(let j=canonicalIndex+1;j<HL_MENU_ACTIONS.length;j++){
        var nextKey=requiredArrayItem(HL_MENU_ACTIONS,j).key;
        const nextPos=out.findIndex(function(x){return x.key===nextKey;});
        if(nextPos>=0){insertAt=nextPos;break;}
      }
    }
    out.splice(insertAt,0,{key:a.key,show:true});
    seen[a.key]=true;
    changed=true;
  }
  HL_MENU_ACTIONS.forEach(function(a){if(!seen[a.key])insertMissingAction(a);});
  try{
    const ver=localStorage.getItem(HL_MENU_CFG_VERSION_KEY)||'';
    if(ver!=='2'){changed=true;localStorage.setItem(HL_MENU_CFG_VERSION_KEY,'2');}
    if(changed)saveHlMenuConfig(out);
  }catch(_){}
  return out;
}
function saveHlMenuConfig(cfg: HighlightMenuConfig[]): void{try{localStorage.setItem(HL_MENU_CFG_KEY,JSON.stringify(cfg));}catch(_){}notifyHighlightMenuPreferences();}
// This compact, content-free shape is the only part of the selection menu
// configuration used by the original reader preferences panel. The reader page retains
// ownership of the actual selection, menu DOM and action handlers.
function highlightMenuPreferencesSnapshot(){
  return {
    displayMode:readHlMenuMode(),
    layout:readHlMenuLayout(),
    size:readHlMenuSize(),
    webSearchEngine:readHlWebEngine(),
    colorful:readHlMenuColorEnabled(),
    actions:readHlMenuConfig().map(function(item){return {key:item.key,visible:item.show!==false};})
  };
}
function notifyHighlightMenuPreferences(){
  if(hlMenuPreferencesRestoring||!hlMenuPreferencesSynced)return;
  try{parent.postMessage({readerHighlightMenuPreferences:highlightMenuPreferencesSnapshot()},'*');}catch(_){}
}
function normalizeHighlightMenuActions(value: HighlightMenuPreferencesInput['actions']|null): HighlightMenuConfig[]|null{
  if(!Array.isArray(value))return null;
  const known: Partial<Record<HighlightActionKey,true>>={},out: HighlightMenuConfig[]=[];
  HL_MENU_ACTIONS.forEach(function(action){known[action.key]=true;});
  value.slice(0,HL_MENU_ACTIONS.length).forEach(function(item){
    const key=String((item&&item.key)||'') as HighlightActionKey;
    if(!known[key]||out.some(function(existing){return existing.key===key;}))return;
    out.push({key:key,show:item.visible!==false});
  });
  HL_MENU_ACTIONS.forEach(function(action){if(!out.some(function(item){return item.key===action.key;}))out.push({key:action.key,show:true});});
  return out;
}
function updateHighlightMenuPreferences(value: HighlightMenuPreferencesInput): object{
  if(!value||typeof value!=='object'||Array.isArray(value))return highlightMenuPreferencesSnapshot();
  hlMenuPreferencesRestoring=true;
  try{
    if(value.displayMode==='text'||value.displayMode==='icon'||value.displayMode==='both')saveHlMenuMode(value.displayMode);
    if(value.layout==='grid'||value.layout==='row')saveHlMenuLayout(value.layout);
    if(value.size==='small'||value.size==='medium'||value.size==='large')saveHlMenuSize(value.size);
    if(value.webSearchEngine==='baidu'||value.webSearchEngine==='google')saveHlWebEngine(value.webSearchEngine);
    if(typeof value.colorful==='boolean')saveHlMenuColorEnabled(value.colorful);
    const actions=normalizeHighlightMenuActions(value.actions);
    if(actions)saveHlMenuConfig(actions);
  }catch(_){}
  hlMenuPreferencesRestoring=false;
  hlMenuPreferencesSynced=true;
  refreshConfiguredMenus();
  if(hlSettingsPop&&hlSettingsPop.style.display!=='none')renderHlSettings();
  const snapshot=highlightMenuPreferencesSnapshot();
  notifyHighlightMenuPreferences();
  return snapshot;
}
window.ReaderHighlightMenuSettings=Object.freeze({
  get:function(){return highlightMenuPreferencesSnapshot();},
  update:function(value){return updateHighlightMenuPreferences(value);},
  activate:function(){hlMenuPreferencesSynced=true;return highlightMenuPreferencesSnapshot();}
});
function applyConfiguredMenu(container: ReaderMenuElement|null,items: HighlightMenuItem[],setBtn?: HTMLButtonElement): void{
  if(!container)return;
  updateMenuSizeClass(container);
  const layout=readHlMenuLayout();
  container.classList.toggle('hm-layout-grid',layout==='grid');
  container.classList.toggle('hm-layout-row',layout!=='grid');
  const actionHost=container._actionHost||document.createElement('span');actionHost.className='hm-action-host';container._actionHost=actionHost;
  const colorHost=container._colorHost||document.createElement('span');colorHost.className='hm-color-host';container._colorHost=colorHost;
  const cfg=readHlMenuConfig(),map: Partial<Record<HighlightActionKey,HighlightMenuItem>>={};
  items.forEach(function(it){map[it.key]=it;});
  items.forEach(function(it){const node=it.host||it.button;if(node&&node.parentNode)node.parentNode.removeChild(node);});
  if(actionHost.parentNode)actionHost.parentNode.removeChild(actionHost);
  if(colorHost.parentNode)colorHost.parentNode.removeChild(colorHost);
  if(setBtn&&setBtn.parentNode)setBtn.parentNode.removeChild(setBtn);
  cfg.forEach(function(c){const it=map[c.key];if(it&&c.show!==false){updateActionButton(it);const node=it.host||it.button;node.classList.add('hm-menu-item');actionHost.appendChild(node);}});
  container.appendChild(actionHost);
  const useColors=readHlMenuColorEnabled();
  container.classList.toggle('hm-with-colors',useColors);
  if(useColors){
    colorHost.innerHTML='';
    const selected=readHlColor();
    HL_COLORS.forEach(function(c){
      const b=document.createElement('button');b.type='button';b.className='hm-color-button'+(c.key===selected?' selected':'');b.title=readerPageText('highlight')+' · '+hlColorLabel(c);b.setAttribute('aria-label',b.title);b.style.setProperty('--hm-color',c.value);
      b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});
      b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();saveHlColor(c.key);if(typeof container._onColorPick==='function')container._onColorPick(c.key);refreshConfiguredMenus();});
      colorHost.appendChild(b);
    });
    container.appendChild(colorHost);
  }
  if(setBtn){const settingsLabel=readerPageText('highlightMenuSettings');setBtn.classList.add('hm-settings-button');setBtn.title=settingsLabel;setBtn.setAttribute('aria-label',settingsLabel);container.appendChild(setBtn);}
}
function renderHlSettings(){
  if(!hlSettingsPop)return;
  const settingsPop=hlSettingsPop;
  const cfg=readHlMenuConfig();
  settingsPop.setAttribute('aria-label',readerPageText('highlightMenuSettings'));
  settingsPop.innerHTML='<div class="hs-mode hs-appearance"><span class="hs-mode-label">'+readerPageText('display')+'</span><span class="hs-mode-buttons hs-display-buttons"><button type="button" data-mode="both">'+readerPageText('both')+'</button><button type="button" data-mode="text">'+readerPageText('text')+'</button><button type="button" data-mode="icon">'+readerPageText('icon')+'</button></span><span class="hs-mode-label hs-color-label">'+readerPageText('colorful')+'</span><label class="hs-switch"><input class="hs-color-enabled" type="checkbox"><span class="hs-slider"></span></label></div><div class="hs-mode hs-layout-size"><span class="hs-mode-label">'+readerPageText('layout')+'</span><span class="hs-mode-buttons hs-layout-buttons"><button type="button" data-layout="row">'+readerPageText('row')+'</button><button type="button" data-layout="grid">'+readerPageText('grid')+'</button></span><span class="hs-mode-label">'+readerPageText('size')+'</span><span class="hs-mode-buttons hs-size-buttons"><button type="button" data-size="small">'+readerPageText('small')+'</button><button type="button" data-size="medium">'+readerPageText('medium')+'</button><button type="button" data-size="large">'+readerPageText('large')+'</button></span></div><div class="hs-list"></div>';
  const mode=readHlMenuMode();
  Array.from(settingsPop.querySelectorAll<HTMLButtonElement>('.hs-display-buttons button')).forEach(function(b){
    b.className=b.dataset.mode===mode?'on':'';
    b.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();const value=b.dataset.mode;if(value==='text'||value==='icon'||value==='both')saveHlMenuMode(value);
      renderHlSettings();refreshConfiguredMenus();
    });
  });
  const size=readHlMenuSize();
  Array.from(settingsPop.querySelectorAll<HTMLButtonElement>('.hs-size-buttons button')).forEach(function(b){
    b.className=b.dataset.size===size?'on':'';
    b.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();const value=b.dataset.size;if(value==='small'||value==='medium'||value==='large')saveHlMenuSize(value);
      renderHlSettings();refreshConfiguredMenus();
    });
  });
  const layout=readHlMenuLayout();
  Array.from(settingsPop.querySelectorAll<HTMLButtonElement>('.hs-layout-buttons button')).forEach(function(b){
    b.className=b.dataset.layout===layout?'on':'';
    b.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();const value=b.dataset.layout;if(value==='row'||value==='grid')saveHlMenuLayout(value);
      renderHlSettings();refreshConfiguredMenus();
    });
  });
  const colorEnabled=requiredDescendant(settingsPop,'.hs-color-enabled',HTMLInputElement);
  colorEnabled.checked=readHlMenuColorEnabled();
  colorEnabled.addEventListener('change',function(){saveHlMenuColorEnabled(colorEnabled.checked);refreshConfiguredMenus();});
  let list=requiredDescendant(settingsPop,'.hs-list',HTMLDivElement),dragState: MenuDragState|null=null;
  function saveCurrentOrder(){
    const old=readHlMenuConfig(),show: Partial<Record<HighlightActionKey,boolean>>={};old.forEach(function(x){show[x.key]=x.show!==false;});
    const next=Array.from(list.querySelectorAll<HTMLElement>('.hs-row')).flatMap(function(r){const key=r.dataset.key as HighlightActionKey|undefined;return key?[{key:key,show:show[key]!==false}]:[];});
    saveHlMenuConfig(next);refreshConfiguredMenus();
  }
  function animateRowsAroundInsert(beforeNode: Node|null): void{
      if(!dragState)return;
      const ph=dragState.placeholder;
      if((beforeNode&&beforeNode===ph)||ph.nextSibling===beforeNode)return;
      if(!beforeNode&&ph===list.lastElementChild)return;
      if(!readerAnimationSettingOn('highlightSettings')){list.insertBefore(ph,beforeNode||null);return;}
      const beforePos=new Map<Element,number>();
      const activeDrag=dragState;Array.from(list.children).forEach(function(r){if(r!==activeDrag.row)beforePos.set(r,r.getBoundingClientRect().top);});
      list.insertBefore(ph,beforeNode||null);
      Array.from(list.children).forEach(function(r){
        if(r===activeDrag.row)return;
        const first=beforePos.get(r);if(first===undefined)return;
        const last=r.getBoundingClientRect().top,dy=first-last;
        if(!dy)return;
        if(!(r instanceof HTMLElement))return;r.style.transition='none';r.style.transform='translateY('+dy+'px)';
        r.getBoundingClientRect();
        requestAnimationFrame(function(){r.style.transition='transform .18s cubic-bezier(.2,.8,.2,1),background .16s ease,border-color .16s ease,box-shadow .16s ease';r.style.transform='';});
      });
  }
  function moveDraggedRow(clientY: number): void{
    if(!dragState)return;
    const row=dragState.row;
    const bounds=list.getBoundingClientRect();
    const maxTop=Math.max(bounds.top,bounds.bottom-row.offsetHeight);
    const top=Math.max(bounds.top,Math.min(maxTop,clientY-dragState.offsetY));
    const probeY=Math.max(bounds.top,Math.min(bounds.bottom,clientY));
    row.style.top=top+'px';
    const rows=Array.from(list.querySelectorAll<HTMLElement>('.hs-row')).filter(function(r){return r!==row;});
    for(let i=0;i<rows.length;i++){
      const candidate=requiredArrayItem(rows,i),box=candidate.getBoundingClientRect();
      if(probeY<box.top+box.height/2){animateRowsAroundInsert(candidate);return;}
    }
    animateRowsAroundInsert(null);
  }
  cfg.forEach(function(c){
    const row=document.createElement('div');row.className='hs-row';row.dataset.key=c.key;
    const name=document.createElement('span');name.className='hs-name';name.textContent=hlActionLabel(c.key);
    const sw=document.createElement('label');sw.className='hs-switch';
    const input=document.createElement('input');input.type='checkbox';input.checked=c.show!==false;
    const slider=document.createElement('span');slider.className='hs-slider';sw.append(input,slider);
    const grip=document.createElement('button');grip.type='button';grip.className='hs-grip';grip.title=readerPageText('dragSort');
    if(c.key==='web'){
      row.classList.add('hs-web-row');
      const engines=document.createElement('span');engines.className='hs-mode-buttons hs-engine-buttons';
      (['baidu','google'] as WebEngine[]).forEach(function(engine){
        const b=document.createElement('button');b.type='button';b.dataset.engine=engine;b.textContent=engine==='google'?readerPageText('searchEngineGoogle'):readerPageText('searchEngineBaidu');
        b.className=readHlWebEngine()===engine?'on':'';
        b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();saveHlWebEngine(engine);renderHlSettings();});
        engines.appendChild(b);
      });
      row.append(name,engines,sw,grip);
    }else row.append(name,sw,grip);
    list.appendChild(row);
    input.addEventListener('change',function(){
      const next=readHlMenuConfig();next.forEach(function(x){if(x.key===c.key)x.show=input.checked;});
      saveHlMenuConfig(next);refreshConfiguredMenus();
    });
    grip.addEventListener('pointerdown',function(e){
      e.preventDefault();e.stopPropagation();
      const box=row.getBoundingClientRect();
      const ph=document.createElement('div');ph.className='hs-placeholder';
      list.insertBefore(ph,row.nextSibling);
      row.classList.add('dragging');
      row.style.position='fixed';row.style.left=box.left+'px';row.style.top=box.top+'px';row.style.width=box.width+'px';row.style.height=box.height+'px';
      dragState={row:row,placeholder:ph,offsetY:e.clientY-box.top};
      try{grip.setPointerCapture(e.pointerId);}catch(_){}
    });
    grip.addEventListener('pointermove',function(e){
      if(!dragState)return;
      e.preventDefault();e.stopPropagation();moveDraggedRow(e.clientY);
    });
    function finishDrag(e?: PointerEvent): void{
      if(!dragState)return;
      if(e){e.preventDefault();e.stopPropagation();try{grip.releasePointerCapture(e.pointerId);}catch(_){}}
      const st=dragState;dragState=null;
      list.insertBefore(st.row,st.placeholder);
      st.placeholder.remove();
      st.row.classList.remove('dragging');
      st.row.style.position='';st.row.style.left='';st.row.style.top='';st.row.style.width='';st.row.style.height='';
      saveCurrentOrder();
    }
    grip.addEventListener('pointerup',finishDrag);
    grip.addEventListener('pointercancel',finishDrag);
  });
}
function hideSelMenu(){if(selMenu)selMenu.style.display='none';}
function hideHlSettings(){if(hlSettingsPop){hlSettingsPop.style.display='none';hlSettingsPop.classList.remove('hs-opening');}}
let hlTextPop: HTMLDivElement|null=null,excerptPage: HTMLDivElement|null=null,excerptText='',correctDraft: SelectionOffsets|null=null;
function hideHlTextPop(){if(hlTextPop)hlTextPop.style.display='none';}
function ensureHighlightTextPop(){
  if(!hlTextPop){
    const pop=document.createElement('div');hlTextPop=pop;pop.id='hl-text-pop';
    pop.innerHTML='<button class="ht-close" type="button">×</button><div class="ht-title">'+readerPageText('correct')+'</div><div class="ht-original"></div><textarea></textarea><div class="ht-row"><button class="act cancel" type="button">'+readerPageText('cancel')+'</button><button class="act save" type="button">'+readerPageText('save')+'</button></div>';
    document.body.appendChild(pop);
    ['mousedown','mouseup','click','wheel'].forEach(function(t){pop.addEventListener(t,function(e){e.stopPropagation();});});
    requiredDescendant(pop,'.ht-close',HTMLButtonElement).addEventListener('click',hideHlTextPop);
    requiredDescendant(pop,'.cancel',HTMLButtonElement).addEventListener('click',hideHlTextPop);
    requiredDescendant(pop,'.save',HTMLButtonElement).addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      const text=requiredDescendant(pop,'textarea',HTMLTextAreaElement).value;
      if(correctDraft){
        const d=Object.assign({},correctDraft,{correctedText:text});
        parent.postMessage({addHighlightCorrectDraft:d},'*');
        correctDraft=null;
      }else if(activeHi>=0)parent.postMessage({setHighlightText:{index:activeHi,text:text}},'*');
      hideHlTextPop();
    });
    document.addEventListener('mousedown',function(e){if(pop.style.display==='block'&&e.target instanceof Node&&!pop.contains(e.target))hideHlTextPop();},true);
  }
}
function placeHighlightTextPop(rect: RectLike|null): void{
  const pop=hlTextPop;if(!pop)return;
  const r=rect||{left:window.innerWidth/2,top:window.innerHeight/2,right:window.innerWidth/2,bottom:window.innerHeight/2,width:0,height:0};
  pop.style.display='block';
  const w=pop.offsetWidth||520,hp=pop.offsetHeight||260;
  let left=r.left+(r.width||0)/2-w/2;left=Math.max(8,Math.min(window.innerWidth-w-8,left));
  let top=r.bottom+10;if(top+hp>window.innerHeight-8)top=r.top-hp-10;if(top<8)top=8;
  pop.style.left=left+'px';pop.style.top=top+'px';
  const stablePop=pop;setTimeout(function(){try{const textarea=requiredDescendant(stablePop,'textarea',HTMLTextAreaElement);textarea.focus();textarea.select();}catch(_){}},0);
}
function showHighlightTextEditor(idx: number): void{
  const h=HL[idx];if(!h)return;
  ensureHighlightTextPop();
  const pop=hlTextPop;if(!pop)return;
  correctDraft=null;
  activeHi=idx;
  requiredDescendant(pop,'.ht-original',HTMLElement).textContent=readerPageText('original')+'：'+(h.text||'');
  requiredDescendant(pop,'textarea',HTMLTextAreaElement).value=highlightDisplayText(h);
  const el=markEl(idx),r: RectLike=el?el.getBoundingClientRect():{left:window.innerWidth/2,top:window.innerHeight/2,right:window.innerWidth/2,bottom:window.innerHeight/2,width:0,height:0};
  placeHighlightTextPop(r);
}
function showCorrectionDraft(o: SelectionOffsets,rect: DOMRect|null): void{
  if(!o)return;
  ensureHighlightTextPop();
  const pop=hlTextPop;if(!pop)return;
  correctDraft=o;
  activeHi=-1;
  requiredDescendant(pop,'.ht-original',HTMLElement).textContent=readerPageText('original')+'：'+(o.text||'');
  requiredDescendant(pop,'textarea',HTMLTextAreaElement).value=o.text||'';
  placeHighlightTextPop(rect);
}
function hideExcerptPage(){if(excerptPage)excerptPage.style.display='none';}
function closeReaderPageGestureSurface(){
  if(excerptPage&&excerptPage.style.display==='block'){hideExcerptPage();return true;}
  if(hlTextPop&&hlTextPop.style.display==='block'){hideHlTextPop();return true;}
  return false;
}
function showExcerptPage(text: string): void{
  const t=(text||'').trim();if(!t)return;
  excerptText=t;
  if(!excerptPage){
    const page=document.createElement('div');excerptPage=page;page.id='excerpt-page';
    page.innerHTML='<div class="ex-card"><div class="ex-head"><div class="ex-title">'+readerPageText('excerpt')+'</div><button class="ex-close" type="button">×</button></div><div class="ex-body"><div class="ex-quote"></div></div><div class="ex-foot"><span class="ex-status"></span><button class="ex-download" type="button">'+readerPageText('downloadImage')+'</button></div></div>';
    document.body.appendChild(page);
    requiredDescendant(page,'.ex-close',HTMLButtonElement).addEventListener('click',hideExcerptPage);
    requiredDescendant(page,'.ex-download',HTMLButtonElement).addEventListener('click',downloadExcerptImage);
    page.addEventListener('mousedown',function(e){if(e.target===page)hideExcerptPage();e.stopPropagation();});
    page.addEventListener('wheel',function(e){e.stopPropagation();},{passive:true});
  }
  const page=excerptPage;if(!page)return;
  requiredDescendant(page,'.ex-quote',HTMLElement).textContent=t;
  const st=page.querySelector('.ex-status');if(st)st.textContent='';
  page.style.display='block';
}
function canvasWrappedLines(ctx: CanvasRenderingContext2D,text: string,maxW: number): string[]{
  const out: string[]=[],paras=String(text||'').split(/\n/);
  paras.forEach(function(p,pi){
    let line='';
    for(let i=0;i<p.length;i++){
      const character=p.charAt(i),next=line+character;
      if(line&&ctx.measureText(next).width>maxW){out.push(line);line=character;}
      else line=next;
    }
    out.push(line);
    if(pi<paras.length-1)out.push('');
  });
  return out;
}
function downloadExcerptImage(){
  const text=excerptText||'';if(!text.trim())return;
  const st=excerptPage&&excerptPage.querySelector?excerptPage.querySelector('.ex-status'):null;
  if(st)st.textContent=readerPageText('generatingImage');
  const scale=Math.max(2,Math.min(3,window.devicePixelRatio||2));
  const cssW=900,pad=72,font=34,lineH=62;
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('2D canvas unavailable');
  ctx.font=font+'px "Microsoft YaHei", system-ui, sans-serif';
  const lines=canvasWrappedLines(ctx,text,cssW-pad*2);
  const cssH=Math.max(520,pad*2+lines.length*lineH+90);
  canvas.width=Math.round(cssW*scale);canvas.height=Math.round(cssH*scale);
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.fillStyle='#fbf7ed';ctx.fillRect(0,0,cssW,cssH);
  const g=ctx.createLinearGradient(0,0,cssW,cssH);g.addColorStop(0,'rgba(255,255,255,.55)');g.addColorStop(1,'rgba(210,185,135,.2)');ctx.fillStyle=g;ctx.fillRect(0,0,cssW,cssH);
  ctx.fillStyle='#2b2419';ctx.font=font+'px "Microsoft YaHei", system-ui, sans-serif';ctx.textBaseline='top';
  for(let i=0;i<lines.length;i++)ctx.fillText(requiredArrayItem(lines,i),pad,pad+i*lineH);
  ctx.fillStyle='rgba(75,58,37,.54)';ctx.font='22px "Microsoft YaHei", system-ui, sans-serif';ctx.fillText(readerPageText('excerpt'),pad,cssH-pad+18);
  const dataUrl=canvas.toDataURL('image/png');
  try{
    if(parent&&parent!==window){
      parent.postMessage({downloadImage:{name:readerPageText('excerpt')+'.png',dataUrl:dataUrl}},'*');
      return;
    }
  }catch(_){}
  const a=document.createElement('a');a.download=readerPageText('excerpt')+'.png';a.href=dataUrl;document.body.appendChild(a);a.click();a.remove();
  if(st)st.textContent=readerPageText('downloadStarted');
}
function copyTextToClipboard(text: string): void{
  const t=(text||'').trim();if(!t)return;
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).catch(function(){fallbackCopyText(t);});return;}
  fallbackCopyText(t);
}
function fallbackCopyText(t: string): void{
  try{
    const ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.left='-9999px';ta.style.top='0';
    document.body.appendChild(ta);ta.focus();ta.select();document.execCommand('copy');ta.remove();
  }catch(_){}
}
function showHlSettings(anchor: ReaderMenuElement|null): void{
  if(!hlSettingsPop){
    const created=document.createElement('div');hlSettingsPop=created;created.id='hl-settings-pop';
    document.body.appendChild(created);
    ['mousedown','mouseup','click','wheel'].forEach(function(t){created.addEventListener(t,function(e){e.stopPropagation();});});
    document.addEventListener('mousedown',function(e){if(!hlSettingsPop||hlSettingsPop.style.display==='none')return;const target=e.target;if(target instanceof Node&&hlSettingsPop.contains(target))return;hideHlSettings();},true);
  }
  renderHlSettings();
  const r=(anchor&&anchor._anchorRect)||(anchor?anchor.getBoundingClientRect():{left:window.innerWidth/2,top:window.innerHeight/2,right:window.innerWidth/2,bottom:window.innerHeight/2,width:0,height:0});
  let w=340,h=Math.min(420,window.innerHeight-18),left=r.left+(r.width||0)/2-w/2;
  left=Math.max(8,Math.min(window.innerWidth-w-8,left));
  let top=r.top-h-10;if(top<8)top=r.bottom+10;
  if(top+h>window.innerHeight-8)top=Math.max(8,window.innerHeight-h-8);
  const settingsPop=hlSettingsPop;if(!settingsPop)return;
  settingsPop.style.left=left+'px';settingsPop.style.top=top+'px';settingsPop.style.display='block';
  settingsPop.classList.remove('hs-opening');
  if(readerAnimationSettingOn('highlightSettings')){void settingsPop.offsetWidth;settingsPop.classList.add('hs-opening');}
}
function requiredDescendant<T extends Element>(host: ParentNode,selector: string,ctor: {new():T}): T{
  const element=host.querySelector(selector);
  if(!(element instanceof ctor))throw new Error('Missing reader popup element: '+selector);
  return element;
}
function isTranslationProvider(value: string): value is TranslationProvider{return value==='baidu'||value==='tencent'||value==='deepl'||value==='google';}
// ---- 翻译面板：UI 先就位；实际 API 需用户配置后才发送文本到外部服务 ----
let trPop: HTMLDivElement|null=null,trRect: DOMRect|null=null,trText='',trCredentialDirty=false,trCredentialStatus: Partial<Record<TranslationProvider,TranslationProfile>>={};
function hideTranslate(){if(trPop)trPop.style.display='none';}
function setupTranslate(){
  const pop=document.createElement('div');trPop=pop;pop.id='tr-pop';
  pop.innerHTML='<div class="tr-row"><div><div class="tr-title">'+readerPageText('source')+'</div><div class="tr-text tr-src"></div></div><select class="tr-select tr-source"><option value="auto">'+readerPageText('autoDetect')+'</option><option value="zh-CN">'+readerPageText('chinese')+'</option><option value="en">'+readerPageText('english')+'</option><option value="ja">'+readerPageText('japanese')+'</option><option value="ko">'+readerPageText('korean')+'</option></select></div><div class="tr-sep"></div><div class="tr-row"><div><div class="tr-title">'+readerPageText('translation')+'</div><div class="tr-text tr-dst tr-muted">'+readerPageText('loading')+'</div></div><select class="tr-select tr-target"><option value="system">'+readerPageText('systemLanguage')+'</option><option value="zh-CN">'+readerPageText('chinese')+'</option><option value="en">'+readerPageText('english')+'</option><option value="ja">'+readerPageText('japanese')+'</option><option value="ko">'+readerPageText('korean')+'</option></select></div><div class="tr-provider"><select class="tr-select tr-api"><option value="baidu">Baidu</option><option value="tencent">Tencent</option><option value="deepl">DeepL</option><option value="google">Google</option></select></div><div class="tr-api-fields"><input class="tr-input tr-api-id"><input class="tr-input tr-api-key" type="password"></div>';
  document.body.appendChild(pop);
  const apiSelect=requiredDescendant(pop,'.tr-api',HTMLSelectElement),sourceSelect=requiredDescendant(pop,'.tr-source',HTMLSelectElement),targetSelect=requiredDescendant(pop,'.tr-target',HTMLSelectElement);
  try{
    apiSelect.value=localStorage.getItem('translateProvider')||'baidu';
    sourceSelect.value=localStorage.getItem('translateSourceLang')||'auto';
    targetSelect.value=localStorage.getItem('translateTargetLang')||'system';
  }catch(_){}
  pop.addEventListener('mousedown',function(e){e.stopPropagation();});
  pop.addEventListener('click',function(e){e.stopPropagation();});
  [sourceSelect,targetSelect].forEach(function(select){select.addEventListener('change',function(){saveTranslatePrefs();requestTranslate();});});
  apiSelect.addEventListener('change',function(){try{localStorage.setItem('translateProvider',apiSelect.value);}catch(_){} parent.postMessage({setTranslationActiveProvider:apiSelect.value},'*');updateTranslateApiFields();requestTranslate();});
  [requiredDescendant(pop,'.tr-api-id',HTMLInputElement),requiredDescendant(pop,'.tr-api-key',HTMLInputElement)].forEach(function(input){input.addEventListener('input',function(){trCredentialDirty=true;});input.addEventListener('change',function(){requestTranslate();});});
  document.addEventListener('mousedown',function(e){const target=e.target;if(trPop&&trPop.style.display==='block'&&target instanceof Node&&!trPop.contains(target))hideTranslate();});
  document.addEventListener('wheel',function(){hideTranslate();},{passive:true});
  migrateLegacyTranslateCredentials();updateTranslateApiFields();
}
function translateApiStorageKey(provider: TranslationProvider,field: "id"|"key"): string{
  if(provider==='baidu')return field==='id'?'translateBaiduAppId':'translateBaiduKey';
  return 'translate_'+provider+'_'+field;
}
function translateApiLabel(provider: TranslationProvider): {id:string;key:string}{
  if(provider==='baidu')return {id:'Baidu AppID',key:'Baidu API key'};
  if(provider==='tencent')return {id:'Tencent SecretId',key:'Tencent SecretKey'};
  if(provider==='deepl')return {id:'DeepL API key',key:'DeepL API key (optional)'};
  if(provider==='google')return {id:'Google API key',key:'Google API key (optional)'};
  return {id:'AppID / API key',key:'API key'};
}
function applyTranslationProfiles(status: TranslationProfileStatus): void{
  if(!trPop||!status)return;
  const select=requiredDescendant(trPop,'.tr-api',HTMLSelectElement),profiles=Array.isArray(status.profiles)?status.profiles.filter(function(p){return p&&p.configured;}):[];
  if(!profiles.length)return;
  const current=status.activeProvider||status.active_provider||select.value;
  select.innerHTML='';
  profiles.forEach(function(profile){const opt=document.createElement('option');opt.value=profile.provider;opt.textContent=translateApiLabel(profile.provider).id.replace(/ AppID| SecretId| API Key/,'');select.appendChild(opt);trCredentialStatus[profile.provider]=profile;});
  select.value=profiles.some(function(profile){return profile.provider===current;})?current:requiredArrayItem(profiles,0).provider;
  try{localStorage.setItem('translateProvider',select.value);}catch(_){}
  updateTranslateApiFields();
}
function saveTranslatePrefs(){
  if(!trPop)return;
  try{
    const provider=requiredDescendant(trPop,'.tr-api',HTMLSelectElement).value;
    localStorage.setItem('translateProvider',provider);
    localStorage.setItem('translateSourceLang',requiredDescendant(trPop,'.tr-source',HTMLSelectElement).value);
    localStorage.setItem('translateTargetLang',requiredDescendant(trPop,'.tr-target',HTMLSelectElement).value);
  }catch(_){}
}
function migrateLegacyTranslateCredentials(){
  (['baidu','tencent','deepl','google'] as TranslationProvider[]).forEach(function(provider){
    try{
      const idKey=translateApiStorageKey(provider,'id'),secretKey=translateApiStorageKey(provider,'key');
      const apiId=(localStorage.getItem(idKey)||'').trim(),apiKey=(localStorage.getItem(secretKey)||'').trim();
      localStorage.removeItem(idKey);localStorage.removeItem(secretKey);
      if(apiId&&((provider!=='baidu'&&provider!=='tencent')||apiKey)){
        parent.postMessage({saveTranslationCredential:{provider:provider,apiId:apiId,apiKey:apiKey}},'*');
      }
    }catch(_){}
  });
}
function updateTranslateApiFields(){
  if(!trPop)return;
  const providerValue=requiredDescendant(trPop,'.tr-api',HTMLSelectElement).value;
  if(!isTranslationProvider(providerValue))return;
  const provider=providerValue;
  const label=translateApiLabel(provider);
  const idInput=requiredDescendant(trPop,'.tr-api-id',HTMLInputElement),keyInput=requiredDescendant(trPop,'.tr-api-key',HTMLInputElement);
  const profile=trCredentialStatus[provider],configured=!!(profile&&profile.configured);
  idInput.placeholder=label.id+(configured?'（已安全保存，留空沿用）':'');
  keyInput.placeholder=label.key+(configured?'（已安全保存，留空沿用）':'');
  idInput.value='';keyInput.value='';trCredentialDirty=false;
  parent.postMessage({getTranslationCredentialStatus:provider},'*');
}
function placeTranslate(){
  if(!trPop)return;
  trPop.style.display='block';
  const ph=trPop.offsetHeight,r=trRect||{left:window.innerWidth/2,right:window.innerWidth/2,top:120,bottom:120,width:0};
  const pw=trPop.offsetWidth||520;
  let left=r.left+(r.width||0)/2-pw/2;left=Math.max(8,Math.min(window.innerWidth-pw-8,left));
  let top=r.bottom+10;if(top+ph>window.innerHeight-8)top=r.top-ph-10;
  if(top<8)top=8;
  trPop.style.left=left+'px';trPop.style.top=top+'px';
}
function openTranslate(text: string,rect: DOMRect|null): void{
  const t=(text||'').trim();if(!t)return;
  if(!trPop)setupTranslate();
  if(!trPop)return;
  trText=t;trRect=rect||null;
  requiredDescendant(trPop,'.tr-src',HTMLElement).textContent=t;
  requiredDescendant(trPop,'.tr-dst',HTMLElement).textContent=readerPageText('loading');
  requiredDescendant(trPop,'.tr-dst',HTMLElement).className='tr-text tr-dst tr-muted';
  placeTranslate();requestTranslate();parent.postMessage({getTranslationProfiles:1},'*');
}
function requestTranslate(){
  if(!trPop||trPop.style.display==='none')return;
  const apiValue=requiredDescendant(trPop,'.tr-api',HTMLSelectElement).value;
  if(!isTranslationProvider(apiValue))return;
  const api=apiValue;
  const dst=requiredDescendant(trPop,'.tr-dst',HTMLElement);
  saveTranslatePrefs();
  const apiId=requiredDescendant(trPop,'.tr-api-id',HTMLInputElement).value.trim(),apiKey=requiredDescendant(trPop,'.tr-api-key',HTMLInputElement).value.trim();
  if(trCredentialDirty){
    if(!apiId||(api==='baidu'||api==='tencent')&&!apiKey){
      const dirtyLabel=translateApiLabel(api);
      dst.textContent=readerPageText('fillCredential')+' '+dirtyLabel.id+(api==='deepl'||api==='google'?'。':' + '+dirtyLabel.key+'。');
      dst.className='tr-text tr-dst tr-error';placeTranslate();return;
    }
    dst.textContent=readerPageText('savingCredential');dst.className='tr-text tr-dst tr-muted';placeTranslate();
    parent.postMessage({saveTranslationCredential:{provider:api,apiId:apiId,apiKey:apiKey}},'*');return;
  }
  const status=trCredentialStatus[api];
  if(!status){dst.textContent=readerPageText('checkCredential');dst.className='tr-text tr-dst tr-muted';parent.postMessage({getTranslationCredentialStatus:api},'*');placeTranslate();return;}
  if(!status.configured){
    const label=translateApiLabel(api);
    dst.textContent=readerPageText('fillCredential')+' '+label.id+(api==='deepl'||api==='google'?'。':' + '+label.key+'。');
    dst.className='tr-text tr-dst tr-error';
    placeTranslate();return;
  }
  dst.textContent=readerPageText('loading');dst.className='tr-text tr-dst tr-muted';placeTranslate();
  parent.postMessage({translateText:{text:trText,source:requiredDescendant(trPop,'.tr-source',HTMLSelectElement).value,target:requiredDescendant(trPop,'.tr-target',HTMLSelectElement).value,provider:api,credentialConfigId:status.config_id||('translate:'+api)}},'*');
}
function showTranslateResult(r: TranslationResult): void{
  if(!trPop)return;
  const dst=requiredDescendant(trPop,'.tr-dst',HTMLElement);
  if(r&&r.ok){dst.textContent=r.translated||'';dst.className='tr-text tr-dst';}
  else{dst.textContent=(r&&r.error)||readerPageText('translationFailed');dst.className='tr-text tr-dst tr-error';}
  placeTranslate();
}
// Called after the shell posts a new S.uiLanguage.  The iframe has no access
// to the parent window's i18n module, so visible transient controls must be
// rebuilt here rather than waiting for the next selection.
function refreshReaderPageLanguage(){
  if(selMenu)applyConfiguredMenu(selMenu,selMenuItems,selMenu._setBtn);
  if(hlMenu)applyConfiguredMenu(hlMenu,hlMenuItems,hlMenu._setBtn);
  if(hlSettingsPop&&hlSettingsPop.style.display!=='none')renderHlSettings();
  if(hlTextPop){
    const title=hlTextPop.querySelector('.ht-title'),cancel=hlTextPop.querySelector('.cancel'),save=hlTextPop.querySelector('.save');
    if(title)title.textContent=readerPageText('correct');if(cancel)cancel.textContent=readerPageText('cancel');if(save)save.textContent=readerPageText('save');
    const original=hlTextPop.querySelector('.ht-original');if(original)original.textContent=readerPageText('original')+'：'+(original.textContent||'').replace(/^[^：:]+[：:]/,'');
  }
  if(excerptPage){const exTitle=excerptPage.querySelector('.ex-title'),exDownload=excerptPage.querySelector('.ex-download');if(exTitle)exTitle.textContent=readerPageText('excerpt');if(exDownload)exDownload.textContent=readerPageText('downloadImage');}
  if(dictPop){const gear=dictPop.querySelector<HTMLButtonElement>('.dc-gear');if(gear)gear.title=readerPageText('dictionarySettings');if(lastDict)renderDict();}
  // Translation labels are part of generated select markup.  Recreate only
  // an open panel; hidden panels can be rebuilt lazily without a visual jump.
  if(trPop){const open=trPop.style.display==='block',text=trText,rect=trRect;trPop.remove();trPop=null;if(open&&text)openTranslate(text,rect);}
}
function setupSelMenu(){
  const menu=document.createElement('div') as ReaderMenuElement;selMenu=menu;menu.id='sel-menu';
  menu._onColorPick=function(color){
    const o=selOffsets();
    if(o){o.chapter=curCh;o.context=getSelContext();o.color=color;parent.postMessage({addHighlight:o},'*');}
    const selection=window.getSelection?window.getSelection():null;if(selection)selection.removeAllRanges();
    hideSelMenu();
  };
  const btn=document.createElement('button');btn.type='button';
  const btnDict=document.createElement('button');btnDict.type='button';
  const btnTr=document.createElement('button');btnTr.type='button';
  const btnCopy=document.createElement('button');btnCopy.type='button';
  const btnHL=document.createElement('button');btnHL.type='button';
  const btnCorrect=document.createElement('button');btnCorrect.type='button';
  const btnExcerpt=document.createElement('button');btnExcerpt.type='button';
  const btnCross=document.createElement('button');btnCross.type='button';
  const btnSemantic=document.createElement('button');btnSemantic.type='button';
  const btnAiReader=document.createElement('button');btnAiReader.type='button';
  const btnNote=document.createElement('button');btnNote.type='button';
  const btnBm=document.createElement('button');btnBm.type='button';
  const btnSet=document.createElement('button');btnSet.type='button';btnSet.textContent='⚙';
  selMenuItems=[
    {key:'web',button:btn},
    {key:'dict',button:btnDict},
    {key:'translate',button:btnTr},
    {key:'copy',button:btnCopy},
    {key:'highlight',button:btnHL},
    {key:'correct',button:btnCorrect},
    {key:'excerpt',button:btnExcerpt},
    {key:'cross',button:btnCross},
    {key:'semantic',button:btnSemantic},
    {key:'aiReader',button:btnAiReader},
    {key:'note',button:btnNote},
    {key:'bookmark',button:btnBm}
  ];
  menu._setBtn=btnSet;
  applyConfiguredMenu(menu,selMenuItems,btnSet);
  document.body.appendChild(menu);
  [btn,btnDict,btnTr,btnCopy,btnHL,btnCorrect,btnExcerpt,btnCross,btnSemantic,btnAiReader,btnNote,btnBm,btnSet].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  btnDict.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const selection=window.getSelection?window.getSelection():null,t=(selection?selection.toString():'').trim();
    if(t)openDict(t,getSelContext());
    hideSelMenu();
  });
  btnTr.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const selection=window.getSelection?window.getSelection():null,t=(selection?selection.toString():'').trim();
    let r=null;try{const s=window.getSelection();r=(s&&s.rangeCount)?s.getRangeAt(0).getBoundingClientRect():null;}catch(_){}
    if(t)openTranslate(t,r);
    hideSelMenu();
  });
  btnBm.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const selection=window.getSelection?window.getSelection():null,t=(selection?selection.toString():'').trim();
    const frac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
    parent.postMessage({addBookmark:{chapter:curCh,frac:frac,label:t.slice(0,40)}},'*');
    hideSelMenu();
  });
  btn.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const selection=window.getSelection?window.getSelection():null,t=(selection?selection.toString():'').trim();
    if(t)parent.postMessage({webSearch:{term:t,engine:readHlWebEngine()}},'*');
    hideSelMenu();
  });
  btnHL.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();o.color=readHlColor();parent.postMessage({addHighlight:o},'*');}
    const selection=window.getSelection?window.getSelection():null;if(selection)selection.removeAllRanges();
    hideSelMenu();
  });
  btnCorrect.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    let r=null;try{const s=window.getSelection();r=(s&&s.rangeCount)?s.getRangeAt(0).getBoundingClientRect():null;}catch(_){}
    const o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();showCorrectionDraft(o,r);}
    const selection=window.getSelection?window.getSelection():null;if(selection)selection.removeAllRanges();
    hideSelMenu();
  });
  btnExcerpt.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const selection=window.getSelection?window.getSelection():null,t=(selection?selection.toString():'').trim();
    hideSelMenu();
    if(t)showExcerptPage(t);
  });
  btnCross.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const selection=window.getSelection?window.getSelection():null,t=(selection?selection.toString():'').trim();
    if(t)parent.postMessage({crossSearch:t},'*');
    hideSelMenu();
  });
  btnSemantic.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const selection=window.getSelection?window.getSelection():null,t=(selection?selection.toString():'').trim();
    if(t)parent.postMessage({semanticSearch:t},'*');
    hideSelMenu();
  });
  btnAiReader.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var selection=window.getSelection?window.getSelection():null,o=selOffsets(),t=(o?o.text:(selection?selection.toString():''))||'';t=t.trim();
    if(t)parent.postMessage({aiReader:{text:t,anchorStart:o&&o.start,anchorEnd:o&&o.end}},'*');
    var selection=window.getSelection?window.getSelection():null;if(selection)selection.removeAllRanges();
    hideSelMenu();
  });
  btnNote.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();o.color=readHlColor();parent.postMessage({addHighlightNote:o},'*');}
    const selection=window.getSelection?window.getSelection():null;if(selection)selection.removeAllRanges();
    hideSelMenu();
  });
  btnCopy.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    const selection=window.getSelection?window.getSelection():null,t=(selection?selection.toString():'').trim();
    copyTextToClipboard(t);
    hideSelMenu();
  });
  btnSet.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();showHlSettings(menu);hideSelMenu();});
  function showSelMenuAtSelection(){
    const sel=window.getSelection?window.getSelection():null;
    const t=sel?sel.toString().trim():'';
    if(!t){hideSelMenu();return;}
    const hi=selectedHighlightIndex();
    if(hi>=0){hideSelMenu();showHlMenu(hi,true);return;}
    hideHlMenu(); // 出选区菜单时，先收起"已高亮"菜单，保证同时只有一个
    if(!sel||sel.rangeCount===0){hideSelMenu();return;}
    let rect;try{rect=sel.getRangeAt(0).getBoundingClientRect();}catch(_){hideSelMenu();return;}
    if(!rect||(!rect.width&&!rect.height)){hideSelMenu();return;}
    menu._anchorRect=rect;
    menu._menuPreferredAbove=false;
    menu._menuPointerX=rect.left+rect.width/2;
    applyConfiguredMenu(menu,selMenuItems,menu._setBtn);
    menu.style.display='block';
    repositionVisibleHighlightMenu(menu);
  }
  document.addEventListener('mouseup',function(e){
    const target=e.target;if(target instanceof Node&&menu.contains(target))return; // 在选区菜单上松开（如点"高亮"按钮）：保留选区，别清
    if(target instanceof Node&&((dictPop&&dictPop.contains(target))||(fnPop&&fnPop.contains(target))))return; // 在词典/注释弹窗内选字：正常选中、不弹高亮菜单
    setTimeout(function(){
      // 非拖动（单击/双击/连点翻页）：清掉任何选区并收菜单，避免单击误选/误高亮文本
      if(!didDrag){const selection=window.getSelection?window.getSelection():null;if(selection)selection.removeAllRanges();hideSelMenu();return;}
      showSelMenuAtSelection(); // 只有按住拖动选择才弹菜单
    },0);
  });
  document.addEventListener('mousedown',function(e){const target=e.target;if(target instanceof Node&&!menu.contains(target))hideSelMenu();});
  document.addEventListener('wheel',hideSelMenu,{passive:true});
  document.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.shiftKey&&(e.key==='s'||e.key==='S'))return; // 截图快捷键：保留菜单，方便截到高亮工具栏
    hideSelMenu();
  });
}
// ---- 点击/悬停"已高亮文字" → 一个菜单（web搜索 / 取消高亮 / 批注）；批注用父窗口的大批注页 ----
var hlMenu: ReaderMenuElement|null=null,activeHi=-1,hlHideTimer: ReturnType<typeof setTimeout>|null=null;
function mkBtn(txt: string): HTMLButtonElement{const b=document.createElement('button');b.type='button';b.textContent=txt;return b;}
function hideHlMenu(){if(hlMenu)hlMenu.style.display='none';}
function markEl(idx: number): Element|null{return (hlOverlay&&hlOverlay.querySelector('.hl-rect[data-hi="'+idx+'"]'))||(root?root.querySelector('mark.hl[data-hi="'+idx+'"]'):null);}
function virtualMarkEl(idx: number): Element|null{return virtualPage?virtualPage.querySelector('.vp-hl[data-hi="'+idx+'"]'):null;}
function selActive(){const s=window.getSelection?window.getSelection():null;return !!(s&&!s.isCollapsed&&s.toString().trim());}
function anchorRectForElement(el: Element|null,evt: MouseEvent|null): DOMRect|RectLike{
  if(!el||!el.getBoundingClientRect)return {left:window.innerWidth/2,top:window.innerHeight/2,right:window.innerWidth/2,bottom:window.innerHeight/2,width:0,height:0};
  let rects: DOMRect[]=[];try{rects=Array.from(el.getClientRects()).filter(function(r: DOMRect){return r.width>0&&r.height>0;});}catch(_){rects=[];}
  if(!rects.length)return el.getBoundingClientRect();
  if(evt&&typeof evt.clientX==='number'&&typeof evt.clientY==='number'){
    let x=evt.clientX,y=evt.clientY,best=requiredArrayItem(rects,0),bestD=Infinity;
    for(let i=0;i<rects.length;i++){
      const r=requiredArrayItem(rects,i);
      if(x>=r.left-3&&x<=r.right+3&&y>=r.top-5&&y<=r.bottom+5)return r;
      const cx=Math.max(r.left,Math.min(r.right,x)),cy=Math.max(r.top,Math.min(r.bottom,y));
      const dx=x-cx,dy=y-cy,d=dx*dx+dy*dy;
      if(d<bestD){bestD=d;best=r;}
    }
    return best;
  }
  return requiredArrayItem(rects,0);
}
function selectedHighlightIndex(){
  const o=selOffsets();
  return o?highlightIndexForRange(o.start,o.end):-1;
}
function visibleHighlightLineRects(idx: number,fallbackEl: Element|null = null): DOMRect[]{
  let rects: DOMRect[]=[],range=highlightRange(idx);
  try{if(range)rects=Array.from(range.getClientRects());}catch(_){rects=[];}
  if(!rects.length&&fallbackEl&&fallbackEl.getClientRects){try{rects=Array.from(fallbackEl.getClientRects());}catch(_){rects=[];}}
  const vw=window.innerWidth||1,vh=window.innerHeight||1;
  return rects.filter(function(r){return r&&r.width>0&&r.height>0&&r.right>0&&r.left<vw&&r.bottom>0&&r.top<vh;});
}
function highlightPageKey(rect: RectLike): number{
  // 与 anchorPage() 一致：分页模式用横向列位置区分页；滚动模式没有“跨页菜单”概念。
  if(typeof usesLineBreakPaging==='function'&&usesLineBreakPaging())return 0;
  if(typeof pageStep!=='number'||pageStep<=0||typeof viewRect!=='function')return 0;
  const pr=viewRect();
  return Math.floor((rect.left-pr.left+viewOffset+1)/pageStep);
}
function highlightRectEnvelope(rects: readonly RectLike[]): RectLike{
  return ReaderPageHighlightRules.envelope(rects);
}
function nearestHighlightRect(rects: readonly RectLike[],evt: MouseEvent|null = null): RectLike|null{
  return ReaderPageHighlightRules.nearestRect(rects,evt&&typeof evt.clientX==='number'&&typeof evt.clientY==='number'?{x:evt.clientX,y:evt.clientY}:null);
}
function highlightLineGroups(rects: readonly RectLike[]): RectLike[]{
  // 同一行内的多个内联片段应看成一行，否则单行高亮会误判为多行。
  return ReaderPageHighlightRules.groupedEnvelopes(rects,function(r){return highlightPageKey(r)+':'+Math.round(r.top)+':'+Math.round(r.bottom);});
}
function highlightMenuPlacement(idx: number,fallbackEl: Element|null,evt: MouseEvent|null): HighlightPlacement|null{
  const rects=visibleHighlightLineRects(idx,fallbackEl);
  if(!rects.length){const fallback=anchorRectForElement(fallbackEl,evt);return {rect:fallback,above:false};}
  // 跨页优先较早一页；同页多行紧跟末行，单行则跟随指针所在文字片段。
  return ReaderPageHighlightRules.placement(rects,evt&&typeof evt.clientX==='number'&&typeof evt.clientY==='number'?{x:evt.clientX,y:evt.clientY}:null,highlightPageKey,function(r){return highlightPageKey(r)+':'+Math.round(r.top)+':'+Math.round(r.bottom);});
}
function readerViewportHeight(){
  // iframe 的 innerHeight 偶尔会滞后一帧；以 layout viewport 的较小值为准，
  // 避免把菜单误判为“下方还有空间”而塞到页末文字里。
  const inner=Number(window.innerHeight)||0;
  const client=Number(document.documentElement&&document.documentElement.clientHeight)||0;
  if(inner&&client)return Math.min(inner,client);
  return inner||client||800;
}
function placeHighlightMenuVertically(menu: ReaderMenuElement,rect: RectLike,preferAbove: boolean): {top:number;above:boolean;height:number}{
  const safe=6,gap=6,vh=readerViewportHeight();
  // 必须在菜单 display:block 后读取。横排、九宫格、多彩高亮的真实高度都不同，
  // 不能再用固定 34px 估算。
  const mh=Math.min(Math.max(Number(menu&&menu.offsetHeight)||34,1),Math.max(1,vh-safe*2));
  const aboveTop=rect.top-mh-gap,belowTop=rect.bottom+gap;
  const canAbove=aboveTop>=safe,canBelow=belowTop+mh<=vh-safe;
  let above=!!preferAbove,top;
  if(preferAbove){
    if(canAbove){above=true;top=aboveTop;}
    else if(canBelow){above=false;top=belowTop;}
  }else{
    if(canBelow){above=false;top=belowTop;}
    else if(canAbove){above=true;top=aboveTop;}
  }
  // 视口非常矮时两侧都不足：仍完整留在可视区，优先留在空间更多的一侧。
  if(top===undefined){
    const roomAbove=Math.max(0,rect.top-safe-gap),roomBelow=Math.max(0,vh-safe-rect.bottom-gap);
    above=roomAbove>=roomBelow;
    top=above?aboveTop:belowTop;
  }
  top=Math.max(safe,Math.min(vh-mh-safe,top));
  return {top:top,above:above,height:mh};
}
function repositionVisibleHighlightMenu(menu: ReaderMenuElement|null): void{
  if(!menu||menu.style.display!=='block'||!menu._anchorRect)return;
  const rect=menu._anchorRect,mw=menu.offsetWidth||200;
  const x=typeof menu._menuPointerX==='number'?menu._menuPointerX:rect.left+rect.width/2;
  const left=Math.max(6,Math.min(window.innerWidth-mw-6,x-mw/2));
  const vertical=placeHighlightMenuVertically(menu,rect,!!menu._menuPreferredAbove);
  menu.style.left=left+'px';menu.style.top=vertical.top+'px';
  menu._menuAbove=vertical.above;
}
function showHlMenu(idx: number,force = false,anchor: Element|null = null,evt: MouseEvent|null = null): void{
  if(selActive()&&!force)return;   // 还在选字（如刚高亮完）就不弹，避免和选区菜单同时出现
  hideSelMenu();                  // 任何时候只保留一个工具栏
  activeHi=idx;let el=anchor||markEl(idx)||virtualMarkEl(idx);
  if(!el){const hr=visibleHighlightRect(idx);if(hr){const stableRect=hr,synthetic=document.createElement('span');synthetic.getBoundingClientRect=function(){return stableRect;};el=synthetic;}}
  if(!el)return;
  if(!hlMenu)return;
  applyConfiguredMenu(hlMenu,hlMenuItems,hlMenu&&hlMenu._setBtn);
  hlMenu.style.display='block';
  const placement=highlightMenuPlacement(idx,el,evt);if(!placement)return;const rect=placement.rect;
  hlMenu._anchorRect=rect;
  hlMenu._menuPreferredAbove=placement.above;
  hlMenu._menuPointerX=evt&&typeof evt.clientX==='number'?evt.clientX:rect.left+rect.width/2;
  repositionVisibleHighlightMenu(hlMenu);
}
function setupHlUi(){
  const menu=document.createElement('div') as ReaderMenuElement;hlMenu=menu;menu.id='hl-menu';
  menu._onColorPick=function(color){if(activeHi>=0)parent.postMessage({setHighlightColor:{index:activeHi,color:color}},'*');};
  const mWeb=mkBtn(''),mDict=mkBtn(''),mTr=mkBtn(''),mCopy=mkBtn(''),mDel=mkBtn(''),mCorrect=mkBtn(''),mExcerpt=mkBtn(''),mCross=mkBtn(''),mSemantic=mkBtn(''),mAiReader=mkBtn(''),mNote=mkBtn(''),mSet=mkBtn('⚙');
  hlMenuItems=[
    {key:'web',button:mWeb},
    {key:'dict',button:mDict},
    {key:'translate',button:mTr},
    {key:'copy',button:mCopy},
    {key:'highlight',button:mDel,labelKey:'removeHighlight',icon:'remove'},
    {key:'correct',button:mCorrect},
    {key:'excerpt',button:mExcerpt},
    {key:'cross',button:mCross},
    {key:'semantic',button:mSemantic},
    {key:'aiReader',button:mAiReader},
    {key:'note',button:mNote}
  ];
  menu._setBtn=mSet;
  applyConfiguredMenu(menu,hlMenuItems,mSet);
  document.body.appendChild(menu);
  [mWeb,mDict,mTr,mCopy,mDel,mCorrect,mExcerpt,mCross,mSemantic,mAiReader,mNote,mSet].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  mWeb.addEventListener('click',function(e){e.stopPropagation();const h=HL[activeHi];if(h)parent.postMessage({webSearch:{term:highlightDisplayText(h),engine:readHlWebEngine()}},'*');hideHlMenu();});
  mDict.addEventListener('click',function(e){e.stopPropagation();const h=HL[activeHi];if(h)openDict(highlightDisplayText(h),h.context||'');hideHlMenu();});
  mTr.addEventListener('click',function(e){e.stopPropagation();const h=HL[activeHi],el=markEl(activeHi);if(h)openTranslate(highlightDisplayText(h),el?el.getBoundingClientRect():null);hideHlMenu();});
  mCopy.addEventListener('click',function(e){e.stopPropagation();const h=HL[activeHi];if(h)copyTextToClipboard(highlightDisplayText(h));hideHlMenu();});
  mDel.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({removeHighlight:activeHi},'*');hideHlMenu();});
  mCorrect.addEventListener('click',function(e){e.stopPropagation();const idx=activeHi;hideHlMenu();if(idx>=0)showHighlightTextEditor(idx);});
  mExcerpt.addEventListener('click',function(e){e.stopPropagation();const h=HL[activeHi];hideHlMenu();if(h)showExcerptPage(highlightDisplayText(h));});
  mCross.addEventListener('click',function(e){e.stopPropagation();const h=HL[activeHi];if(h)parent.postMessage({crossSearch:highlightDisplayText(h)},'*');hideHlMenu();});
  mSemantic.addEventListener('click',function(e){e.stopPropagation();const h=HL[activeHi];if(h)parent.postMessage({semanticSearch:highlightDisplayText(h)},'*');hideHlMenu();});
  mAiReader.addEventListener('click',function(e){e.stopPropagation();const h=HL[activeHi];hideHlMenu();if(h)parent.postMessage({aiReader:{text:highlightDisplayText(h),anchorStart:h.start,anchorEnd:h.end}},'*');});
  mNote.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({openAnnotations:activeHi},'*');hideHlMenu();});
  mSet.addEventListener('click',function(e){e.stopPropagation();showHlSettings(hlMenu);hideHlMenu();});
  menu.addEventListener('mouseenter',function(){if(hlHideTimer)clearTimeout(hlHideTimer);});
  menu.addEventListener('mouseleave',function(){if(hlSettingsPop&&hlSettingsPop.style.display==='block')return;hlHideTimer=setTimeout(hideHlMenu,400);});

  // 悬停高亮 → 出菜单；移开延时收起
  root.addEventListener('mouseover',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('mark.hl')??null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi')||'',10),false,m,e);}});
  root.addEventListener('mousemove',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('mark.hl')??null;if(m&&activeHi===parseInt(m.getAttribute('data-hi')||'',10))showHlMenu(activeHi,false,m,e);});
  root.addEventListener('mouseout',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('mark.hl')??null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
  if(hlOverlay){
    hlOverlay.addEventListener('mouseover',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('.hl-rect[data-hi]')??null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi')||'',10),false,m,e);}});
    hlOverlay.addEventListener('mousemove',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('.hl-rect[data-hi]')??null;if(m&&activeHi===parseInt(m.getAttribute('data-hi')||'',10))showHlMenu(activeHi,false,m,e);});
    hlOverlay.addEventListener('mouseout',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('.hl-rect[data-hi]')??null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
    hlOverlay.addEventListener('click',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('.hl-rect[data-hi]')??null;if(m){e.preventDefault();e.stopPropagation();showHlMenu(parseInt(m.getAttribute('data-hi')||'',10),true,m,e);}});
  }
  if(virtualPage){
    virtualPage.addEventListener('mouseover',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('.vp-hl[data-hi]')??null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi')||'',10),false,m,e);}});
    virtualPage.addEventListener('mousemove',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('.vp-hl[data-hi]')??null;if(m&&activeHi===parseInt(m.getAttribute('data-hi')||'',10))showHlMenu(activeHi,false,m,e);});
    virtualPage.addEventListener('mouseout',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('.vp-hl[data-hi]')??null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
    virtualPage.addEventListener('click',function(e){const target=e.target instanceof Element?e.target:null,m=target?.closest('.vp-hl[data-hi]')??null;if(m){e.preventDefault();e.stopPropagation();showHlMenu(parseInt(m.getAttribute('data-hi')||'',10),true,m,e);}});
  }
  document.addEventListener('mousedown',function(e){if(hlMenu&&e.target instanceof Node&&!hlMenu.contains(e.target))hideHlMenu();});
  document.addEventListener('wheel',function(){hideHlMenu();},{passive:true});
}
// 取选区所在"整段"的纯文本（作为批注上下文，存起来供大批注页展示）
function getSelContext(){
  const sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return '';
  const off=selOffsets();
  if(off){
    var txt=sourceTextAround(off.start,off.end,240,560).replace(/\s+/g,' ').trim();
    return txt.length>800?txt.slice(0,800)+'…':txt;
  }
  const node=sel.getRangeAt(0).startContainer;const el: Element|null=node instanceof Element?node:node.parentElement;
  // 优先取最近的段落元素 <p>，没有再退回其它块级元素
  const block=el?(el.closest('p')||el.closest('li,blockquote,td,div,section')):null;
  var txt=((block||el)?.textContent||'').replace(/\s+/g,' ').trim();
  return txt.length>800?txt.slice(0,800)+'…':txt; // 整段，过长才截断
}

// ---- 注释/脚注：点角标 → 就地弹出注释正文（而不是跳过去）----
var fnPop: HTMLDivElement|null=null,fnPopKey='';
function hideFn(){if(fnPop)fnPop.style.display='none';fnPopKey='';}
function setupFn(){
  const pop=document.createElement('div');fnPop=pop;pop.id='fn-pop';
  pop.innerHTML='<span class="fn-close">✕</span><div class="fn-body"></div>';
  document.body.appendChild(pop);
  requiredDescendant(pop,'.fn-close',HTMLElement).addEventListener('click',function(e){e.stopPropagation();hideFn();});
  pop.addEventListener('mousedown',function(e){e.stopPropagation();});
  // 非链接内容仍会由阅读页的 inFootnote 分支吞掉，不会触发翻页；但链接必须
  // 冒泡到该分支，才能复用既有的跨章/同章锚点跳转，并在跳转后收起注释卡片。
  pop.addEventListener('click',function(e){if(e.target instanceof Element&&e.target.closest('a'))e.preventDefault();});
  pop.addEventListener('wheel',function(e){e.stopPropagation();},{passive:true});
  document.addEventListener('mousedown',function(e){
    if(!fnPop||fnPop.style.display!=='block'||!(e.target instanceof Node)||fnPop.contains(e.target))return;
    const note=e.target instanceof Element?e.target.closest('a'):null;
    if(note&&isNoteLink(note))return; // 让 click 处理同一条“注”的开关
    hideFn();
  });
  document.addEventListener('wheel',hideFn,{passive:true});
}
// ---- 离线词典：选中文字/已高亮 → 就地弹释义（释义由外壳查后端再回传）----
var dictPop: HTMLDivElement|null=null,dictRect: DOMRect|null=null,dictContext='',dictSettingsStatus='';
const DICT_HN_SETTINGS_KEY='dictEnhancementSettingsV2';
const DICT_HN_CFG: DictConfig[]=[
  {key:'plain',labelKey:'meaningHint'}, {key:'sense',labelKey:'possibleSenses'},
  {key:'context',labelKey:'contextHint'}, {key:'hypernyms',labelKey:'hypernyms'},
  {key:'synonyms',labelKey:'synonyms'}, {key:'antonyms',labelKey:'antonyms'}
];
function dictHnSettings(): DictSettings{
  const defaults={plain:false,sense:false,context:false,hypernyms:false,synonyms:false,antonyms:false};
  try{
    const raw=localStorage.getItem(DICT_HN_SETTINGS_KEY);
    if(raw){
      const v=JSON.parse(raw)||{};
      return {
        plain:v.plain===true,
        sense:v.sense===true,
        context:v.context===true,
        hypernyms:v.hypernyms===true,
        synonyms:v.synonyms===true,
        antonyms:v.antonyms===true
      };
    }
  }catch(_){}
  return defaults;
}
function setDictHnSettings(v: DictSettings): void{try{localStorage.setItem(DICT_HN_SETTINGS_KEY,JSON.stringify(v));}catch(_){}}
function dictEnhancementAvailable(result: DictResult|null,key: DictEnhancementKey): boolean{
  const h=result&&result.hownet;
  if(!h)return false;
  const field: keyof HowNetResult=key==='context'?'example_note':key;
  const value=h[field];
  return Array.isArray(value)?value.length>0:typeof value==='string'?value.trim().length>0:value!=null;
}
function dictEnhancementUnavailableText(cfg: DictConfig): string{
  return readerPageText('dictionaryEnhancementUnavailable').replace('{option}',readerPageText(cfg.labelKey));
}
function hideDict(){
  if(!dictPop)return;
  dictPop.style.display='none';
  const pop=dictPop.querySelector('.dc-settings');
  if(pop)pop.classList.remove('show');
}
function ensureDictControls(){
  if(!dictPop)return;
  const old=dictPop.querySelectorAll('.dc-close');
  for(let i=0;i<old.length;i++){requiredArrayItem(old,i).remove();}
  let gear=dictPop.querySelector<DictGearButton>('.dc-gear');
  if(!gear){
    gear=document.createElement('button') as DictGearButton;
    gear.className='dc-gear';
    gear.type='button';
    gear.title=readerPageText('dictionarySettings');
    gear.textContent='⚙';
    dictPop.insertBefore(gear,dictPop.firstChild);
  }
  if(!gear._dictGearBound){
    gear._dictGearBound=true;
    gear.addEventListener('click',function(e){e.stopPropagation();toggleDictSettings();});
  }
}
function setupDict(){
  const pop=document.createElement('div');dictPop=pop;pop.id='dict-pop';
  pop.innerHTML='<button class="dc-gear" type="button" title="'+readerPageText('dictionarySettings')+'">⚙</button><div class="dc-settings"></div><div class="dc-head"></div><div class="dc-def"></div>';
  document.body.appendChild(pop);
  ensureDictControls();
  pop.addEventListener('mousedown',function(e){e.stopPropagation();});
  pop.addEventListener('click',function(e){e.stopPropagation();});
  document.addEventListener('mousedown',function(e){if(dictPop&&dictPop.style.display==='block'&&e.target instanceof Node&&!dictPop.contains(e.target))hideDict();});
  document.addEventListener('wheel',function(){hideDict();},{passive:true});
  window.addEventListener('resize',function(){
    const settings=dictPop?.querySelector<HTMLElement>('.dc-settings')??null;
    if(settings&&settings.classList.contains('show'))placeDictSettings(settings);
  });
}
function placeDictSettings(pop: HTMLElement): void{
  if(!dictPop||!pop)return;
  const gear=dictPop.querySelector<HTMLElement>('.dc-gear');
  const anchor=(gear||dictPop).getBoundingClientRect();
  const gap=8;
  const width=Math.min(220,Math.max(160,window.innerWidth-16));
  pop.style.width=width+'px';
  const left=Math.max(8,Math.min(anchor.right-width,window.innerWidth-width-8));
  pop.style.left=left+'px';
  pop.style.top=(anchor.bottom+gap)+'px';
  const height=pop.offsetHeight||0;
  let top=anchor.bottom+gap;
  if(top+height>window.innerHeight-8)top=anchor.top-height-gap;
  if(top<8)top=Math.max(8,window.innerHeight-height-8);
  pop.style.top=top+'px';
}
function toggleDictSettings(){
  if(!dictPop)return;
  const pop=dictPop.querySelector<HTMLElement>('.dc-settings');
  if(!pop)return;
  if(pop.classList.contains('show')){pop.classList.remove('show');return;}
  renderDictSettings(pop);
  pop.classList.add('show');
  placeDictSettings(pop);
}
function renderDictSettings(pop: HTMLElement): void{
  const st=dictHnSettings();
  pop.innerHTML='';
  if(dictSettingsStatus){
    const status=document.createElement('div');status.className='dc-settings-status';status.textContent=dictSettingsStatus;pop.appendChild(status);
  }
  DICT_HN_CFG.forEach(function(cfg){
    const row=document.createElement('label');row.className='dc-set-row';
    const name=document.createElement('span');name.textContent=readerPageText(cfg.labelKey);row.appendChild(name);
    const sw=document.createElement('span');sw.className='dc-switch';
    const input=document.createElement('input');input.type='checkbox';input.checked=st[cfg.key]!==false;
    const slider=document.createElement('span');slider.className='dc-slider';
    input.addEventListener('change',function(e){
      e.stopPropagation();
      if(input.checked&&!dictEnhancementAvailable(lastDict,cfg.key)){
        input.checked=false;
        st[cfg.key]=false;
        setDictHnSettings(st);
        dictSettingsStatus=dictEnhancementUnavailableText(cfg);
        renderDictSettings(pop);pop.classList.add('show');placeDictSettings(pop);
        return;
      }
      dictSettingsStatus='';
      st[cfg.key]=input.checked;
      setDictHnSettings(st);
      renderDict();
      const next=dictPop?.querySelector<HTMLElement>('.dc-settings')??null;
      if(next){renderDictSettings(next);next.classList.add('show');placeDictSettings(next);}
    });
    sw.appendChild(input);sw.appendChild(slider);row.appendChild(sw);pop.appendChild(row);
  });
}
function placeDict(){
  if(!dictPop)return;
  dictPop.style.display='block';
  const ph=dictPop.offsetHeight,r=dictRect;
  let top=(r?r.bottom:120)+10;
  if(top+ph>window.innerHeight-8)top=(r?r.top:120)-ph-10;
  if(top<8)top=8;
  dictPop.style.top=top+'px';
  const pop=dictPop.querySelector<HTMLElement>('.dc-settings');
  if(pop&&pop.classList.contains('show'))placeDictSettings(pop);
}
function openDict(term: string,context = ""): void{
  if(!dictPop)setupDict();
  if(!dictPop)return;
  ensureDictControls();
  // 新词结果返回前不得沿用上一个词的增强数据判定可用性。
  lastDict=null;dictSettingsStatus='';
  try{const s=window.getSelection();dictRect=(s&&s.rangeCount)?s.getRangeAt(0).getBoundingClientRect():null;}catch(_){dictRect=null;}
  dictContext=(context||'').replace(/\s+/g,' ').trim();
  if(!dictContext)dictContext=getSelContext();
  requiredDescendant(dictPop,'.dc-head',HTMLElement).textContent=readerPageText('lookingUp');
  requiredDescendant(dictPop,'.dc-def',HTMLElement).textContent='';requiredDescendant(dictPop,'.dc-def',HTMLElement).className='dc-def';
  placeDict();
  parent.postMessage({dict:term,dictContext:dictContext},'*');
}
function speakWord(w: string): void{
  try{
    if(!w)return;
    parent.postMessage({dictSpeak:w},'*');
  }catch(_){}
}
// 释义来源多选记忆（按语种分开）：中文词 中=中中/英=中英；英文词 中=英中/英=英英
var lastDict: DictResult|null=null;
function dictSel(lang: string): string[]|null{try{const v=localStorage.getItem('dictSel_'+lang);return v?v.split(','):null;}catch(_){return null;}}
function setDictSel(lang: string,a: string[]): void{try{localStorage.setItem('dictSel_'+lang,a.join(','));}catch(_){}}
function appendDictTextBlock(parent: HTMLElement,title: string,text: string): void{
  if(!text)return;
  const blk=document.createElement('div');blk.className='dc-hnblk';
  const t=document.createElement('span');t.className='dc-hnt';t.textContent=title;blk.appendChild(t);
  const body=document.createElement('span');body.textContent=text;blk.appendChild(body);
  parent.appendChild(blk);
}
function appendDictTags(parent: HTMLElement,title: string,items: string[]): void{
  if(!items||!items.length)return;
  const blk=document.createElement('div');blk.className='dc-hnblk';
  const t=document.createElement('span');t.className='dc-hnt';t.textContent=title;blk.appendChild(t);
  const tags=document.createElement('div');tags.className='dc-tags';
  items.forEach(function(x){const tag=document.createElement('span');tag.className='dc-tag';tag.textContent=x;tags.appendChild(tag);});
  blk.appendChild(tags);parent.appendChild(blk);
}
function appendHowNetBlocks(def: HTMLElement,r: DictResult): void{
  const h=r&&r.hownet;if(!h)return;
  const st=dictHnSettings(),box=document.createElement('div');box.className='dc-hn';
  if(st.plain!==false)appendDictTextBlock(box,readerPageText('meaningHint'),h.plain||'');
  if(st.sense!==false)appendDictTextBlock(box,readerPageText('possibleSenses'),h.sense||'');
  if(st.context!==false)appendDictTextBlock(box,readerPageText('contextHint'),h.example_note||'');
  if(st.hypernyms!==false)appendDictTags(box,readerPageText('hypernyms'),h.hypernyms||[]);
  if(st.synonyms!==false)appendDictTags(box,readerPageText('synonyms'),h.synonyms||[]);
  if(st.antonyms!==false)appendDictTags(box,readerPageText('antonyms'),h.antonyms||[]);
  if(box.childNodes.length)def.appendChild(box);
}
function renderDict(){
  if(!dictPop||!lastDict)return;
  ensureDictControls();
  const r=lastDict,head=requiredDescendant(dictPop,'.dc-head',HTMLElement),def=requiredDescendant(dictPop,'.dc-def',HTMLElement);
  head.innerHTML='';def.innerHTML='';
  const w=document.createElement('span');w.className='dc-word';w.textContent=r.word||'';head.appendChild(w);
  if(!r.found){def.textContent=readerPageText('notFoundDefinition');def.className='dc-def dc-miss';return;}
  if(r.phonetic){const ph=document.createElement('span');ph.className='dc-phon';ph.textContent=(r.lang==='en')?('['+r.phonetic+']'):r.phonetic;head.appendChild(ph);}
  if(r.lang==='en'){
    parent.postMessage({dictPrefetch:r.word},'*');
    const spk=document.createElement('span');spk.className='dc-spk';spk.textContent='🔊';spk.title=readerPageText('pronunciation');
    spk.addEventListener('click',function(e){e.stopPropagation();speakWord(r.word);});head.appendChild(spk);
  }
  if(r.sources&&r.sources.length){
    r.sources.forEach(function(src,idx){
      const det=document.createElement('details');det.className='dc-source';if(idx===0)det.open=true;
      const sum=document.createElement('summary');
      const label=src.source_name||readerPageText('externalDictionary');
      const sw=src.word&&src.word!==r.word?(' · '+src.word):'';
      const ph=src.phonetic?(' · '+src.phonetic):'';
      sum.textContent=label+sw+ph;
      const body=document.createElement('div');body.className='dc-source-body';
      if(src.def){const blk=document.createElement('div');blk.className='dc-defblk';const lb=document.createElement('span');lb.className='dc-lb';lb.textContent=readerPageText('chinese');blk.appendChild(lb);const tx=document.createElement('span');tx.textContent=src.def;blk.appendChild(tx);body.appendChild(blk);}
      if(src.def_en){const blk2=document.createElement('div');blk2.className='dc-defblk';const lb2=document.createElement('span');lb2.className='dc-lb';lb2.textContent=readerPageText('english');blk2.appendChild(lb2);const tx2=document.createElement('span');tx2.textContent=src.def_en;blk2.appendChild(tx2);body.appendChild(blk2);}
      if(!body.childNodes.length){body.textContent=readerPageText('noDefinition');}
      det.append(sum,body);def.appendChild(det);
    });
    appendHowNetBlocks(def,r);
    return;
  }
  if(r.source_name){
    const srcBadge=document.createElement('div');srcBadge.className='dc-src';srcBadge.textContent=r.source_name;def.appendChild(srcBadge);
  }
  const sources: Array<{k:string;label:string;text:string}>=[];
  if(r.def)sources.push({k:'c',label:readerPageText('chinese'),text:r.def});
  if(r.def_en)sources.push({k:'e',label:readerPageText('english'),text:r.def_en});
  if(!sources.length){def.textContent=readerPageText('noDefinition');def.className='dc-def dc-miss';return;}
  const avail=sources.map(function(s){return s.k;});
  let firstSource=requiredArrayItem(sources,0),sel=dictSel(r.lang)||[firstSource.k];
  sel=sel.filter(function(k){return avail.indexOf(k)>=0;});
  if(!sel.length)sel=[firstSource.k];
  if(sources.length>1){ // 两种释义都有 → 显示多选切换键（可同时选中）
    const tg=document.createElement('span');tg.className='dc-toggle';
    sources.forEach(function(s){
      const b=document.createElement('span');b.className='dt'+(sel.indexOf(s.k)>=0?' on':'');b.textContent=s.label;
      b.addEventListener('click',function(e){e.stopPropagation();
        const i=sel.indexOf(s.k);
        if(i>=0){if(sel.length>1)sel.splice(i,1);}else{sel.push(s.k);}
        setDictSel(r.lang,sel);renderDict();
      });
      tg.appendChild(b);
    });
    head.appendChild(tg);
  }
  const multi=sel.length>1;
  sources.forEach(function(s){
    if(sel.indexOf(s.k)<0)return;
    const blk=document.createElement('div');blk.className='dc-defblk';
    if(multi){const lb=document.createElement('span');lb.className='dc-lb';lb.textContent=s.label;blk.appendChild(lb);}
    const tx=document.createElement('span');tx.textContent=s.text;blk.appendChild(tx);
    def.appendChild(blk);
  });
  appendHowNetBlocks(def,r);
  def.className='dc-def';
  const pop=dictPop.querySelector<HTMLElement>('.dc-settings');
  if(pop&&pop.classList.contains('show'))placeDictSettings(pop);
}
function showDictResult(r: DictResult): void{
  if(!dictPop)setupDict();
  lastDict=r;dictSettingsStatus='';renderDict();
  if(r&&r.found&&r.lang==='en'&&r.autoSpeak)speakWord(r.word); // 按生词本设置决定是否自动读一次
  if(r&&r.found)parent.postMessage({vocabAdd:{word:r.word,lang:r.lang,def:r.def||'',def_en:r.def_en||'',phonetic:r.phonetic||'',example:dictContext||''}},'*'); // 记入生词本
  placeDict();
}
// 是否是"注释角标"链接：epub:type/role/class 含 note，或链接文字形如
// [23] / (3) / 23 / 注1。最后一种常见于中文书的跨章节注文。
function isNoteLink(a: Element): boolean{
  const cls=String(a&&a.className||'');
  if(a&&(a.getAttribute('data-rr-note-ref')==='1'||/\brr-note-ref\b/.test(cls)))return true;
  const ty=((a.getAttribute('epub:type')||'')+' '+(a.getAttribute('role')||'')+' '+cls).toLowerCase();
  if(/note|footnote|endnote|annoref/.test(ty))return true;
  const t=(a.textContent||'').trim();
  return /^[\[【（(]?\s*(?:(?:注|註)\s*)?\d{1,4}\s*[\]】）)]?$/.test(t);
}
function fnSelector(frag: string): string{return '[id="'+String(frag).replace(/"/g,'\\"')+'"]';}
function popFootnote(a: Element,html: string,key: string): void{
  if(!fnPop)setupFn();
  const pop=fnPop;if(!pop)return;
  fnPopKey=key||'';
  requiredDescendant(pop,'.fn-body',HTMLElement).innerHTML=html;
  pop.scrollTop=0;
  pop.style.display='block';
  const rect=a.getBoundingClientRect();
  const pw=pop.offsetWidth;
  const ph=pop.offsetHeight;
  const viewportWidth=Math.max(16,window.innerWidth||document.documentElement.clientWidth||16);
  let left=rect.left+rect.width/2-pw/2;
  left=Math.max(8,Math.min(left,Math.max(8,viewportWidth-pw-8)));
  let top=rect.bottom+10;
  if(top+ph>window.innerHeight-8)top=rect.top-ph-10; // 下方放不下 → 放上方
  if(top<8)top=8;
  if(top+ph>window.innerHeight-8)top=Math.max(8,window.innerHeight-ph-8);
  pop.style.left=left+'px';
  pop.style.top=top+'px';
  readerBugTrace('footnote','popup_shown',null,{note_popup_visible:pop.style.display==='block'});
}
// 取注释正文：id 常落在内联回链角标(<a>/<sup>)上，其内容只是"[n]"，正文是它的兄弟
// → 此时取它所在的块（p/li/aside…）的内容；id 本身就在块上则直接用。
function noteHtml(el: Element): string{
  let block: Element=el;
  if(el.nodeType===1&&/^(A|SUP|SPAN|B|I|EM|FONT|SMALL)$/.test(el.nodeName)){
    block=el.closest('p,li,div,dd,aside,section,td,blockquote')||el;
  }
  const h=(block.innerHTML||'').trim();
  return h||el.innerHTML||'';
}
const footnoteChapterBodyCache: Record<number,string>={},footnoteChapterBodyCacheKeys: number[]=[];
function noteHtmlFromBody(body: string,frag: string): string{
  const tmp=document.createElement('div');tmp.innerHTML=body||'';
  const el=tmp.querySelector(fnSelector(frag));
  return el?noteHtml(el):'';
}
function footnoteChapterBody(i: number): Promise<string>{
  i=Math.max(0,Math.min(CH-1,parseInt(String(i),10)||0));
  if(Object.prototype.hasOwnProperty.call(footnoteChapterBodyCache,i))return Promise.resolve(requiredRecordValue(footnoteChapterBodyCache,String(i)));
  return fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
    const body=d&&d.body||'';
    footnoteChapterBodyCache[i]=body;
    footnoteChapterBodyCacheKeys.push(i);
    if(footnoteChapterBodyCacheKeys.length>120){
      const old=footnoteChapterBodyCacheKeys.shift();
      if(old!==undefined)delete footnoteChapterBodyCache[old];
    }
    return body;
  });
}
function footnoteSearchOrder(ci: number,exactTarget?: boolean): number[]{
  const out: number[]=[],seen: Record<number,true>={};
  function add(i: number): void{
    i=parseInt(String(i),10);
    if(!isFinite(i)||i<0||i>=CH||seen[i])return;
    seen[i]=true;out.push(i);
  }
  if(exactTarget){add(ci);return out;}
  add(curCh);add(ci);
  for(let r=1;r<=16;r++){add(curCh+r);add(curCh-r);add(ci+r);add(ci-r);}
  for(let i=0;i<CH;i++)add(i);
  return out;
}
function findFootnoteHtmlAcrossChapters(order: number[],frag: string): Promise<string>{
  let idx=0;
  return new Promise(function(resolve,reject){
    function step(){
      if(idx>=order.length){resolve('');return;}
      const ch=requiredArrayItem(order,idx++);
      footnoteChapterBody(ch).then(function(body){
        const html=noteHtmlFromBody(body,frag);
        if(html)resolve(html);else step();
      }).catch(function(err){
        if(idx>=order.length)reject(err);else step();
      });
    }
    step();
  });
}
function showFootnote(a: Element,ci: number,frag: string,exactTarget?: boolean): void{
  const key=String(ci)+':'+String(frag);
  const traceBase={note_link_present:true,note_fragment_present:!!frag,note_target_chapter:ci};
  readerBugTrace('footnote','open_requested',null,traceBase);
  if(fnPop&&fnPop.style.display==='block'&&fnPopKey===key){hideFn();readerBugTrace('footnote','toggle_closed',null,{...traceBase,note_popup_visible:false});return;}
  const el=document.querySelector(fnSelector(frag));
  if(el){readerBugTrace('footnote','local_found',null,traceBase);popFootnote(a,noteHtml(el),key);return;}
  popFootnote(a,readerPageText('footnoteLoading'),key);
  const order=footnoteSearchOrder(ci,exactTarget);
  readerBugTrace('footnote','search_started',null,{...traceBase,note_search_chapters:order.length});
  findFootnoteHtmlAcrossChapters(order,frag).then(function(html){
    readerBugTrace('footnote',html?'search_found':'search_not_found',null,{...traceBase,note_search_chapters:order.length});
    if(fnPopKey===key)popFootnote(a,html||readerPageText('footnoteNotFound'),key);
  }).catch(function(){readerBugTrace('footnote','search_failed',null,{...traceBase,note_search_chapters:order.length});if(fnPopKey===key)popFootnote(a,readerPageText('footnoteFailed'),key);});
}
let sMarks: HTMLElement[]=[],sIdx=-1;
function clearSearch(){
  for(let i=0;i<sMarks.length;i++){const m=requiredArrayItem(sMarks,i);if(m.parentNode){m.parentNode.replaceChild(document.createTextNode(m.textContent||''),m);}}
  sMarks=[];sIdx=-1;
}
// 清除高亮后把视图重新钉回当前页：删 <mark> 会让浏览器把横向滚动跑掉，需重新定位
function clearMarksKeepPage(){
  clearSearch();
  if(!root)return;
  applyCols();
  if(pageInCh>pagesInCh-1)pageInCh=pagesInCh-1;
  setViewOffset();
  report();
}
function doSearch(term: string): void{
  clearSearch();
  term=(term||'').trim();
  if(!term){relayout();parent.postMessage({searchPos:0,searchCount:0},'*');return;}
  const low=term.toLowerCase(),len=term.length;
  if(!root)return;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(n: Node){
    if(!n.nodeValue)return NodeFilter.FILTER_REJECT;
    const p=n.parentNode?n.parentNode.nodeName:'';
    if(p==='SCRIPT'||p==='STYLE'||p==='MARK')return NodeFilter.FILTER_REJECT;
    return n.nodeValue.toLowerCase().indexOf(low)>=0?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
  }});
  let nodes: Text[]=[],nd: Node|null;while((nd=walker.nextNode()))if(nd instanceof Text)nodes.push(nd);
  for(let k=0;k<nodes.length;k++){
    var node=requiredArrayItem(nodes,k),text=node.nodeValue??'',lowt=text.toLowerCase(),idx,last=0,frag=document.createDocumentFragment();
    while((idx=lowt.indexOf(low,last))>=0){
      if(idx>last)frag.appendChild(document.createTextNode(text.slice(last,idx)));
      const mk=document.createElement('mark');mk.className='search-hit';mk.textContent=text.slice(idx,idx+len);
      frag.appendChild(mk);sMarks.push(mk);last=idx+len;
    }
    if(last<text.length)frag.appendChild(document.createTextNode(text.slice(last)));
    if(node.parentNode)node.parentNode.replaceChild(frag,node);
  }
  applyCols();
  if(sMarks.length){sIdx=0;focusMatch();}else{parent.postMessage({searchPos:0,searchCount:0},'*');}
}
function focusMatch(){
  for(let i=0;i<sMarks.length;i++)requiredArrayItem(sMarks,i).classList.toggle('cur',i===sIdx);
  if(sIdx>=0&&sIdx<sMarks.length)gotoPage(pageOf(requiredArrayItem(sMarks,sIdx)));
  parent.postMessage({searchPos:sIdx+1,searchCount:sMarks.length},'*');
}
function searchNav(d: number): void{if(!sMarks.length)return;sIdx=(sIdx+d+sMarks.length)%sMarks.length;focusMatch();}

// 后续的 mode-switch、runtime 与 transition 安装器仍以同一个全局对象为端口。
// 函数可以一次发布；可变状态必须保持 live binding，不能复制安装时快照。
const global=runtime;
const api={
  IS_MAC_WEBKIT,
  anchorRect,anchorTextOffset,anchorValid,applyPageCache,applyScrollPageMask,
  applyTranslationProfiles,buildScrollBreaks,captureAnchor,captureImageVisualAnchor,
  clearMarksKeepPage,clearScrollPreview,clearVirtualPage,clonePreviewElement,
  closeReaderPageGestureSurface,currentScrollPageClipBlank,doSearch,documentTextLineRects,
  filterTextLines,gotoGlobalFrac,gotoPage,highlightRange,imagePreviewGapPx,init,
  invalidateMeasure,invalidateScrollItemsCache,isDualPage,isScrollMode,lineHeightPx,mg,
  nextPage,notifyReaderEndIfReached,pageCountSig,pageLayout,pageOf,pagedBoxHeight,placeTranslate,prevPage,
  readerAnimationSettingOn,readerSideViewportDiag,refreshHighlights,
  refreshReaderPageLanguage,relayout,report,requestTranslate,reveal,
  scheduleImageVisualAnchorRestore,scheduleMeasure,scheduleReaderSideViewportRestore,
  searchNav,setMeasurePaused,setViewOffset,showChapter,showDictResult,
  showHighlightTextEditor,showHlMenu,showHlSettings,showTranslateResult,translateApiLabel,
  sourceRangeForOffsets,sourceTextAround,sourceTextRecords,stabilizeProgrammaticViewPaint,
  topAnchor,viewportHeight,visibleTopTextAnchor
};
Object.assign(global, api);

function liveProperty<T>(read:()=>T,write:(value:T)=>void): PropertyDescriptor{
  return {configurable:true,enumerable:true,get:read,set:write};
}
const liveProperties: PropertyDescriptorMap={
  S:liveProperty(()=>S,(value:typeof S)=>{S=value;}),
  CH:liveProperty(()=>CH,(value:number)=>{CH=value;}),
  VC:liveProperty(()=>VC,(value:typeof VC)=>{VC=value;}),
  HL:liveProperty(()=>HL,(value:HighlightRecord[])=>{HL=value;}),
  root:liveProperty(()=>root,(value:ReaderPageRootElement)=>{root=value;}),
  pager:liveProperty(()=>pager,(value:HTMLElement)=>{pager=value;}),
  scroller:liveProperty(()=>scroller,(value:HTMLElement)=>{scroller=value;}),
  scrollPreview:liveProperty(()=>scrollPreview,(value:ReaderPreviewElement|null)=>{scrollPreview=value;}),
  virtualPage:liveProperty(()=>virtualPage,(value:HTMLElement|null)=>{virtualPage=value;}),
  curCh:liveProperty(()=>curCh,(value:number)=>{curCh=value;}),
  pageInCh:liveProperty(()=>pageInCh,(value:number)=>{pageInCh=value;}),
  pagesInCh:liveProperty(()=>pagesInCh,(value:number)=>{pagesInCh=value;}),
  pageStep:liveProperty(()=>pageStep,(value:number)=>{pageStep=value;}),
  viewOffset:liveProperty(()=>viewOffset,(value:number)=>{viewOffset=value;}),
  dualStartColumn:liveProperty(()=>dualStartColumn,(value:number)=>{dualStartColumn=value;}),
  curTopAnchor:liveProperty(()=>curTopAnchor,(value:ReaderPageAnchor|null)=>{curTopAnchor=value;}),
  sourceTextCache:liveProperty(()=>sourceTextCache,(value:ReaderSourceRecord[]|null)=>{sourceTextCache=value;}),
  scrollBreakSig:liveProperty(()=>scrollBreakSig,(value:string)=>{scrollBreakSig=value;}),
  scrollPagedView:liveProperty(()=>scrollPagedView,(value:boolean)=>{scrollPagedView=value;}),
  sideAnchorVirtualOffset:liveProperty(()=>sideAnchorVirtualOffset,(value:number|null)=>{sideAnchorVirtualOffset=value;}),
  overlayOpen:liveProperty(()=>overlayOpen,(value:boolean)=>{overlayOpen=value;}),
  pageCountViewportWidth:liveProperty(()=>pageCountViewportWidth,(value:number)=>{pageCountViewportWidth=value;}),
  modeSwitchRecoveryOffset:liveProperty(()=>modeSwitchRecoveryOffset,(value:number|null)=>{modeSwitchRecoveryOffset=value;}),
  readerAnimationSettingsOverride:liveProperty(()=>readerAnimationSettingsOverride,(value:Record<string,boolean>|null)=>{readerAnimationSettingsOverride=value;}),
  hlMenu:liveProperty(()=>hlMenu,(value:ReaderMenuElement|null)=>{hlMenu=value;}),
  hlSettingsPop:liveProperty(()=>hlSettingsPop,(value:HTMLDivElement|null)=>{hlSettingsPop=value;}),
  selMenu:liveProperty(()=>selMenu,(value:ReaderMenuElement|null)=>{selMenu=value;}),
  excerptPage:liveProperty(()=>excerptPage,(value:HTMLDivElement|null)=>{excerptPage=value;}),
  trPop:liveProperty(()=>trPop,(value:HTMLDivElement|null)=>{trPop=value;}),
  trText:liveProperty(()=>trText,(value:string)=>{trText=value;}),
  trCredentialDirty:liveProperty(()=>trCredentialDirty,(value:boolean)=>{trCredentialDirty=value;}),
  trCredentialStatus:liveProperty(()=>trCredentialStatus,(value:Partial<Record<TranslationProvider,TranslationProfile>>)=>{trCredentialStatus=value;}),
  ttsOn:liveProperty(()=>ttsOn,(value:boolean)=>{ttsOn=value;}),
  ttsMap:liveProperty(()=>ttsMap,(value:typeof ttsMap)=>{ttsMap=value;}),
  ttsText:liveProperty(()=>ttsText,(value:string)=>{ttsText=value;}),
  ttsSents:liveProperty(()=>ttsSents,(value:typeof ttsSents)=>{ttsSents=value;}),
  ttsVoice:liveProperty(()=>ttsVoice,(value:typeof ttsVoice)=>{ttsVoice=value;}),
  ttsRate:liveProperty(()=>ttsRate,(value:number)=>{ttsRate=value;}),
  ttsSi:liveProperty(()=>ttsSi,(value:number)=>{ttsSi=value;}),
  ttsGen:liveProperty(()=>ttsGen,(value:number)=>{ttsGen=value;}),
  ttsAudioEl:liveProperty(()=>ttsAudioEl,(value:typeof ttsAudioEl)=>{ttsAudioEl=value;}),
  ttsCache:liveProperty(()=>ttsCache,(value:typeof ttsCache)=>{ttsCache=value;}),
  ttsWaiting:liveProperty(()=>ttsWaiting,(value:number)=>{ttsWaiting=value;}),
  ttsPlayedAny:liveProperty(()=>ttsPlayedAny,(value:boolean)=>{ttsPlayedAny=value;}),
  fastChapterLayout:liveProperty(()=>fastChapterLayout,(value:boolean)=>{fastChapterLayout=value;}),
  scrollCaptureTimer:liveProperty(()=>scrollCaptureTimer,(value:ReturnType<typeof setTimeout>|null)=>{scrollCaptureTimer=value;}),
  pagedImagePreview:liveProperty(()=>pagedImagePreview,(value:ReaderPreviewElement|null)=>{pagedImagePreview=value;}),
  chapterPending:liveProperty(()=>chapterPending,(value:number)=>{chapterPending=value;})
};
Object.defineProperties(global,liveProperties);
}
