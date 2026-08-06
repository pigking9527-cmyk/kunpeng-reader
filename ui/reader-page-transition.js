// ---- 阅读页运行诊断、翻页动画与视口公共辅助 ----
function pageDebugSettingOn(k){try{var s=JSON.parse(localStorage.getItem('debugSettingsV1')||'{}');return s[k]!==false;}catch(_){return true;}}
function userNav(){parent.postMessage({userNav:1},'*');} // 用户主动翻页（键盘/滚轮）通知外壳关闭浮层
function reportReaderPaintPerf(name,started,detail){
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    var elapsed=Math.max(0,performance.now()-started);
    parent.postMessage({readerPerf:name+' elapsed_ms='+elapsed.toFixed(1)+(detail?' '+detail:'')},'*');
  });});
}
var turnFxTimer=null,turnFxSheet=null,chapterTurnPending=false;
function reducedMotion(){return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);}
function turnFxName(){
  if(typeof readerAnimationSettingOn==='function'&&!readerAnimationSettingOn('pageTurn'))return 'off';
  var fx=S.pageTurnEffect||'horizontal';
  return /^(off|horizontal)$/.test(fx)?fx:'horizontal';
}
function turnFxSpeed(){
  var n=parseFloat(S.pageTurnSpeed);
  if(!isFinite(n))n=1;
  return Math.max(0.5,Math.min(2,n));
}
function turnFxDuration(base){
  return Math.max(80,Math.round(base/turnFxSpeed()));
}
function ensureTurnFxSheet(){
  if(turnFxSheet&&turnFxSheet.isConnected)return turnFxSheet;
  if(!pager)return null;
  turnFxSheet=document.getElementById('turn-fx-sheet');
  if(!turnFxSheet){turnFxSheet=document.createElement('div');turnFxSheet.id='turn-fx-sheet';pager.appendChild(turnFxSheet);}
  return turnFxSheet;
}
function turnFxBg(){
  if(S.theme==='dark')return '#1c1c1e';
  if(S.theme==='sepia')return '#f4ecd8';
  return '#fff';
}
function captureTurnFxPage(role){
  var sheet=ensureTurnFxSheet();
  if(!sheet||!root||!pager)return false;
  sheet.style.setProperty('--turn-fx-bg',turnFxBg());
  var page=document.createElement('div');
  page.className='turn-fx-page '+(role||'turn-fx-outgoing');
  if(isScrollMode()){
    var sp=scrollPort();
    var viewH=Math.max(1,(sp&&sp.clientHeight)||window.innerHeight||1);
    var blank=currentScrollPageClipBlank();
    page.style.bottom='auto';
    page.style.height=Math.max(1,viewH-blank)+'px';
  }
  var clone=root.cloneNode(true);
  clone.removeAttribute('id');
  clone.classList.remove('turn-fx-moving');
  clone.style.transform=root.style.transform||'';
  clone.style.width=root.style.width||root.scrollWidth+'px';
  clone.style.height=root.style.height||root.scrollHeight+'px';
  if(isScrollMode()){
    clone.style.top='-'+((scrollPort()&&scrollPort().scrollTop)||0)+'px';
  }
  page.appendChild(clone);
  sheet.appendChild(page);
  return true;
}
function clearTurnFx(){
  if(turnFxTimer){clearTimeout(turnFxTimer);turnFxTimer=null;}
  if(turnFxSheet)turnFxSheet.innerHTML='';
  if(pager)pager.classList.remove('turn-fx','turn-fx-next','turn-fx-prev','turn-fx-horizontal');
}
function beginTurnFx(dir,move){
  var fx=turnFxName();
  if(!dir||!pager||!root||fx==='off'||reducedMotion()){clearTurnFx();move();return;}
  clearTurnFx();
  // 动画层同时保留切换前、后的两个页面。先前只画旧页，而动画层背景又是不透明的：
  // 旧页滑出后，新页虽已切换却被背景盖住，用户看到的就是一段空白。
  captureTurnFxPage('turn-fx-outgoing');
  move();
  captureTurnFxPage('turn-fx-incoming');
  var ms=turnFxDuration(360);
  var sheet=ensureTurnFxSheet();
  if(sheet)sheet.style.setProperty('--turn-fx-duration',ms+'ms');
  pager.classList.add('turn-fx','turn-fx-'+fx,dir>0?'turn-fx-next':'turn-fx-prev');
  root.offsetWidth;
  turnFxTimer=setTimeout(clearTurnFx,ms+40);
}
function beginChapterTurnFx(dir,chapter,where){
  // 跨章要异步读取和排版。加载未完成时再次点翻页过去会并发请求同一章，
  // 在磁盘繁忙时把一次等待放大成多次排队；保留第一次意图即可。
  if(chapterTurnPending)return Promise.resolve();
  chapterTurnPending=true;
  function done(){chapterTurnPending=false;}
  var fx=turnFxName();
  if(!dir||!pager||!root||fx==='off'||reducedMotion())return showChapter(chapter,where).then(function(){notifyReaderEndIfReached(dir);}).finally(done);
  clearTurnFx();
  // showChapter 会异步 fetch + 两帧排版。不能像同章翻页那样立即复制“新页”，
  // 否则复制到的仍是旧章节，并会在动画结束时闪回旧内容。
  captureTurnFxPage('turn-fx-outgoing');
  pager.classList.add('turn-fx');
  return showChapter(chapter,where).then(function(){
    notifyReaderEndIfReached(dir);
    if(curCh!==chapter){clearTurnFx();return;}
    captureTurnFxPage('turn-fx-incoming');
    var ms=turnFxDuration(360),sheet=ensureTurnFxSheet();
    if(sheet)sheet.style.setProperty('--turn-fx-duration',ms+'ms');
    pager.classList.add('turn-fx-'+fx,dir>0?'turn-fx-next':'turn-fx-prev');
    root.offsetWidth;
    turnFxTimer=setTimeout(clearTurnFx,ms+40);
  }).finally(done);
}
var scrollCaptureTimer=null;
// WKWebView 对逐字 Range.getClientRects() 的成本远高于 Chromium；普通中文章节
// 达到 16KB 就使用已有的批量几何路径，避免首章和每次翻页卡住。Windows 保持
// 原来的 120KB 阈值，不改变 WebView2 已验证的精确排版行为。
var FAST_CHAPTER_LAYOUT_CHARS=(IS_MAC_WEBKIT?16:120)*1024,fastChapterLayout=false;
function largeChapterFastLayout(html){return (html||'').length>=FAST_CHAPTER_LAYOUT_CHARS;}
function scrollPort(){return scroller||pager;}
function viewRect(){var sp=scrollPort();return ((isScrollMode()&&sp)?sp:pager).getBoundingClientRect();}
function scrollGlyphSafePx(){return Math.max(4,Math.min(8,Math.ceil(lineHeightPx()*0.16)));}
function scrollBottomSafePx(){return Math.max(4,Math.min(10,Math.ceil(lineHeightPx()*0.14)));}
function scrollStartEpsilonPx(){return Math.max(16,Math.ceil(lineHeightPx()*0.65));}
function perfLog(name,detail){}
var modeSwitchDiagSeq=0,modeSwitchDiagUntil=0,modeSwitchDiagExpected=null;
function modeSwitchDiagLayerVisible(layer){
  if(!layer||!layer.isConnected||layer.style.display==='none')return false;
  var r=null;try{r=layer.getBoundingClientRect();}catch(_){r=null;}
  return !!(r&&r.width>1&&r.height>1&&r.bottom>0&&r.top<viewportHeight());
}
function modeSwitchDiagSnippet(offset){
  if(offset==null||!isFinite(offset))return '';
  try{return sourceTextAround(Math.max(0,offset),Math.max(0,offset)+1,12,32).replace(/\s+/g,' ').slice(0,48);}catch(_){return '';}
}
function modeSwitchDiagRect(anchor){
  var r=anchorRect(anchor);
  return r?{left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom)}:null;
}
function modeSwitchDiagLog(seq,phase,expectedOffset,extra){
  if(!seq)return;
  var sampled=null,sampledOffset=null;
  try{sampled=topAnchor();sampledOffset=anchorTextOffset(sampled);}catch(_){}
  var expectedRange=null;
  if(expectedOffset!=null)try{expectedRange=sourceAnchorRangeForOffset(expectedOffset);}catch(_){}
  var sp=scrollPort(),payload={
    seq:seq,phase:phase,ts:Math.round(performance.now()),chapter:curCh,
    flow:S.flowMode,pageMode:S.pageMode,page:pageInCh+1,pages:pagesInCh,
    scrollTop:sp?Math.round(sp.scrollTop||0):null,viewOffset:Math.round(viewOffset||0),
    scrollPaged:!!scrollPagedView,expectedOffset:expectedOffset,
    sampledOffset:sampledOffset,storedOffset:(function(){try{return anchorTextOffset(curTopAnchor);}catch(_){return null;}})(),
    expectedRect:expectedRange?modeSwitchDiagRect({range:expectedRange}):null,
    sampledRect:sampled?modeSwitchDiagRect(sampled):null,
    expectedText:modeSwitchDiagSnippet(expectedOffset),sampledText:modeSwitchDiagSnippet(sampledOffset),
    virtualVisible:modeSwitchDiagLayerVisible(virtualPage),
    scrollPreviewVisible:modeSwitchDiagLayerVisible(scrollPreview),
    pagedPreviewVisible:typeof pagedImagePreview!=='undefined'&&modeSwitchDiagLayerVisible(pagedImagePreview),
    rootTransform:root?String(root.style.transform||''):''
  };
  if(extra)for(var k in extra)payload[k]=extra[k];
  parent.postMessage({readerPerf:'mode_diag '+JSON.stringify(payload)},'*');
}
function modeSwitchDiagBegin(prevFlow,nextFlow,prevPageMode,nextPageMode,expectedOffset,storedBefore){
  var seq=++modeSwitchDiagSeq;
  modeSwitchDiagUntil=Date.now()+1500;modeSwitchDiagExpected=expectedOffset;
  modeSwitchDiagLog(seq,'before',expectedOffset,{transition:prevFlow+'/'+prevPageMode+'->'+nextFlow+'/'+nextPageMode,storedBefore:storedBefore});
  return seq;
}
function modeSwitchDiagSchedule(seq,expectedOffset){
  requestAnimationFrame(function(){
    modeSwitchDiagLog(seq,'raf1',expectedOffset);
    requestAnimationFrame(function(){modeSwitchDiagLog(seq,'raf2',expectedOffset);});
  });
  setTimeout(function(){modeSwitchDiagLog(seq,'t80',expectedOffset);},80);
  setTimeout(function(){modeSwitchDiagLog(seq,'t250',expectedOffset);},250);
  setTimeout(function(){modeSwitchDiagLog(seq,'t800',expectedOffset);},800);
}
function modeSwitchDiagEvent(phase){
  if(Date.now()>modeSwitchDiagUntil||!modeSwitchDiagSeq)return;
  modeSwitchDiagLog(modeSwitchDiagSeq,phase,modeSwitchDiagExpected);
}
