
var S={fontFamily:"",styleMode:"local",fontSize:18,noteFontSize:14,lineHeight:1.7,paraSpacing:0.6,letterSpacing:0,marginTop:18,marginBottom:24,marginLeft:28,marginRight:28,pageMode:"single",flowMode:"paged",pageTurnEffect:"off",pageTurnSpeed:1};
var root,pager,scroller,pageMask,virtualPage,scrollPreview,curCh=0,pageInCh=0,pagesInCh=1,pageStep=1,viewOffset=0,headSeen={},chapChars=0,scrollBreaks=[0],scrollPages=[],scrollBreakSig='',scrollItemsSig='',scrollItemsCache=[],scrollProgrammaticUntil=0,scrollProgrammaticTarget=null,scrollActiveSlice=null,scrollPagedView=true;
var downX=null,downY=null,didDrag=false;
var overlayOpen=false; // 外壳里搜索框/设置面板是否打开（打开时正文点击只用于关闭它）
var ttsOn=false,ttsMap=[],ttsText='',ttsSents=[],ttsVoice=null,ttsRate=1,ttsSi=0,ttsGen=0,ttsAudioEl=null,ttsCache={},ttsWaiting=-1,ttsPlayedAny=false; // 朗读状态
function pageDebugSettingOn(k){try{var s=JSON.parse(localStorage.getItem('debugSettingsV1')||'{}');return s[k]!==false;}catch(_){return true;}}
function userNav(){parent.postMessage({userNav:1},'*');} // 用户主动翻页（键盘/滚轮）通知外壳关闭浮层
var turnFxTimer=null,turnFxSheet=null;
function reducedMotion(){return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);}
function turnFxName(){
  var fx=S.pageTurnEffect||'off';
  return /^(off|google-paper|curl)$/.test(fx)?fx:'off';
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
function captureTurnFxPage(){
  var sheet=ensureTurnFxSheet();
  if(!sheet||!root||!pager)return false;
  sheet.innerHTML='';
  sheet.style.setProperty('--turn-fx-bg',turnFxBg());
  var page=document.createElement('div');
  page.className='turn-fx-page';
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
  var fold=document.createElement('div');
  fold.className='turn-fx-fold';
  sheet.appendChild(fold);
  return true;
}
function clearTurnFx(){
  if(turnFxTimer){clearTimeout(turnFxTimer);turnFxTimer=null;}
  if(turnFxSheet)turnFxSheet.innerHTML='';
  if(pager)pager.classList.remove('turn-fx','turn-fx-next','turn-fx-prev','turn-fx-google-paper','turn-fx-curl');
}
function beginTurnFx(dir,move){
  var fx=turnFxName();
  if(!dir||!pager||!root||fx==='off'||reducedMotion()){clearTurnFx();move();return;}
  clearTurnFx();
  captureTurnFxPage();
  var ms=turnFxDuration(fx==='curl'?620:430);
  var sheet=ensureTurnFxSheet();
  if(sheet)sheet.style.setProperty('--turn-fx-duration',ms+'ms');
  pager.classList.add('turn-fx','turn-fx-'+fx,dir>0?'turn-fx-next':'turn-fx-prev');
  root.offsetWidth;
  move();
  turnFxTimer=setTimeout(clearTurnFx,ms+40);
}
var measurer,chapterPages=[],measureDone=false,measureToken=0,measureTimer=null,pageSig='',measurePaused=false,scrollCaptureTimer=null;
var fullBookMeasureEnabled=false;
var FAST_CHAPTER_LAYOUT_CHARS=120*1024,fastChapterLayout=false;
function largeChapterFastLayout(html){return (html||'').length>=FAST_CHAPTER_LAYOUT_CHARS;}
function scrollPort(){return scroller||pager;}
function viewRect(){var sp=scrollPort();return ((isScrollMode()&&sp)?sp:pager).getBoundingClientRect();}
function scrollGlyphSafePx(){return Math.max(4,Math.min(8,Math.ceil(lineHeightPx()*0.16)));}
function scrollBottomSafePx(){return Math.max(4,Math.min(10,Math.ceil(lineHeightPx()*0.14)));}
function scrollStartEpsilonPx(){return Math.max(16,Math.ceil(lineHeightPx()*0.65));}
function perfLog(name,detail){}
// 版式签名：窗口尺寸+字体/字号/行距/段距/字间距/页边距 都一致才能复用缓存的页数
function isScrollMode(){return S.flowMode==='scroll';}
function isDualPage(){return !isScrollMode()&&S.pageMode==='dual'&&window.innerWidth>=900;}
function isLinePagedMode(){return false;}
function usesLineBreakPaging(){return isScrollMode();}
function columnsPerView(){return isDualPage()?2:1;}
function columnPitch(){return window.innerWidth/columnsPerView();}
function layoutSig(){return [window.innerWidth,viewportHeight(),S.styleMode,S.fontSize,S.noteFontSize,S.lineHeight,S.paraSpacing,S.letterSpacing,S.fontFamily,S.marginTop,S.marginBottom,S.marginLeft,S.marginRight,S.pageMode,S.flowMode].join('|');}
var CH=window.__CH__||0, ID=window.__ID__||0;
var VC=null; // 虚拟章节列表 [{ch:spine序号, frag:锚点}]（按目录顺序），用于在大文件内细分逻辑章节
// 算出“当前在第几个逻辑章节（0 基）”：取目录顺序中位置 <= 当前阅读位置的最后一条
function computeLogical(){
  if(!VC||!VC.length)return {lc:curCh,lt:CH};
  var idx=0;
  for(var k=0;k<VC.length;k++){
    var v=VC[k];
    if(v.ch<curCh){idx=k;}
    else if(v.ch===curCh){
      var pg=0;if(v.frag){var el=document.getElementById(v.frag);if(el)pg=pageOf(el);}
      if(pg<=pageInCh){idx=k;}else{break;}
    }else{break;}
  }
  return {lc:idx,lt:VC.length};
}
function applyStyle(){
  var st=document.getElementById('user-style');
  if(!st){st=document.createElement('style');st.id='user-style';document.head.appendChild(st);}
  var hm=hMargins(),scroll=isScrollMode();
  // 滚动模式的边距属于可视 PageBox；整页/双页模式的边距仍属于分页内容盒。
  var padT=scroll?0:mg(S.marginTop),padB=scroll?0:mg(S.marginBottom);
  var padL=scroll?0:(isDualPage()?0:hm.l);
  var padR=scroll?0:(isDualPage()?0:hm.r);
  var useLocalStyle=S.styleMode!=='book';
  var c='.rr{margin:0 !important;padding:'+padT+'px '+padR+'px '+padB+'px '+padL+'px;';
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
    c+='.rr div{margin-top:0 !important;margin-bottom:0 !important;padding-top:0 !important;padding-bottom:0 !important;}';
  }
  c+='.rr hr.rr-note-sep{display:none !important;}';
  c+='.rr *{break-before:auto !important;break-after:auto !important;break-inside:auto !important;page-break-before:auto !important;page-break-after:auto !important;page-break-inside:auto !important;-webkit-column-break-before:auto !important;-webkit-column-break-after:auto !important;-webkit-column-break-inside:auto !important;}';
  if(mg(S.marginTop)===0)c+='.rr>:first-child,.rr body>:first-child{margin-top:0 !important;padding-top:0 !important;}';
  if(mg(S.marginBottom)===0)c+='.rr>:last-child,.rr body>:last-child{margin-bottom:0 !important;padding-bottom:0 !important;}';
  if(mg(S.marginLeft)===0)c+='.rr,.rr>*,.rr body{margin-left:0 !important;padding-left:0 !important;}';
  if(mg(S.marginRight)===0)c+='.rr,.rr>*,.rr body{margin-right:0 !important;padding-right:0 !important;}';
  // 本地样式覆盖书籍 CSS（包括类名和内联字号），避免某些 EPUB 把正文压得过小。
  if(useLocalStyle&&S.fontSize){
    c+='.rr *{font-size:inherit !important;}';
    c+='.rr h1{font-size:1.7em !important;} .rr h2{font-size:1.4em !important;} .rr h3{font-size:1.2em !important;} .rr h4{font-size:1.1em !important;}';
    c+='.rr sup,.rr sub{font-size:.75em !important;}'; // 上下标（注释角标）仍保持小一号
  }
  var bg='#fff',fg='#222';
  if(S.theme==='dark'){bg='#1c1c1e';fg='#d2d2d2';}
  else if(S.theme==='sepia'){bg='#f4ecd8';fg='#5b4636';}
  c+='html,body{background:'+bg+' !important;}#page-mask{background:'+bg+' !important;}#virtual-page{--reader-bg:'+bg+';}';
  c+='#fn-pop{font-size:'+noteFontSizePx()+'px !important;}';
  if(S.theme&&S.theme!=='light'){c+='.rr,.rr *{color:'+fg+' !important;}';}
  c+='.rr .rr-note-wrap{font-size:inherit !important;line-height:1 !important;vertical-align:baseline !important;text-decoration:none !important;}';
  c+='.rr .rr-note-ref,#virtual-page .rr-note-ref{display:inline-flex !important;align-items:center !important;justify-content:center !important;width:14px !important;height:14px !important;box-sizing:border-box !important;border-radius:50% !important;background:#eef7ef !important;border:1px solid #6f8f7d !important;color:#5f7f6d !important;font-size:9px !important;font-family:system-ui,"Microsoft YaHei",sans-serif !important;font-weight:700 !important;line-height:1 !important;text-decoration:none !important;vertical-align:middle !important;overflow:hidden !important;padding:0 !important;margin:0 .08em !important;}';
  c+='#virtual-page .rr-note-ref{margin:0 !important;}';
  c+='.rr .rr-note-ref::before,.rr .rr-note-ref::after,#virtual-page .rr-note-ref::before,#virtual-page .rr-note-ref::after{content:none !important;}';
  c+='.rr .rr-note-badge,#virtual-page .rr-note-badge{display:inline-flex !important;align-items:center !important;justify-content:center !important;width:100% !important;height:100% !important;box-sizing:border-box !important;color:#5f7f6d !important;background:transparent !important;border:0 !important;border-radius:50% !important;font:700 9px/1 system-ui,"Microsoft YaHei",sans-serif !important;text-decoration:none !important;letter-spacing:0 !important;}';
  // 强制横排：有些书自带 -epub-writing-mode:vertical-rl（竖排），覆盖成横排左→右
  c+='html,body,.rr,.rr *{writing-mode:horizontal-tb !important;-webkit-writing-mode:horizontal-tb !important;-epub-writing-mode:horizontal-tb !important;text-orientation:mixed !important;}.rr{direction:ltr !important;orphans:1 !important;widows:1 !important;-webkit-line-box-contain:block glyphs replaced !important;}.rr p,.rr div,.rr li,.rr blockquote{orphans:1 !important;widows:1 !important;}';
  c+='html,body,#pager,#scroller,.rr{overflow-anchor:none;}';
  c+='body.scroll-mode #pager{overflow:hidden !important;}body.scroll-mode #scroller{overflow-y:auto !important;overflow-x:hidden !important;}';
  c+='body.scroll-mode .rr{height:auto !important;min-height:100% !important;column-count:auto !important;column-width:auto !important;column-gap:normal !important;}';
  c+='body.scroll-mode .rr-end{display:block !important;height:var(--scroll-tail-space,100vh) !important;width:100% !important;margin:0 !important;padding:0 !important;border:0 !important;font-size:0 !important;line-height:0 !important;break-before:auto !important;-webkit-column-break-before:auto !important;}';
  c+='body.line-paged-mode #pager,body.line-paged-mode #scroller{overflow:hidden !important;}';
  c+='body.line-paged-mode .rr{height:auto !important;min-height:100vh !important;padding-top:0 !important;padding-bottom:0 !important;column-count:auto !important;column-width:auto !important;column-gap:normal !important;}';
  c+='body.line-paged-mode .rr-end{display:none !important;}';
  st.textContent=c;
}
function scrollBottomBuffer(){
  if(!usesLineBreakPaging())return 0;
  return mg(S.marginBottom)+Math.ceil(lineHeightPx()*0.9);
}
function scrollBottomMaskPx(){
  return 0;
}
function scrollSafeBottomGapPx(){
  if(!usesLineBreakPaging())return 0;
  var raw=window.innerHeight||1;
  var lh=Math.max(12,Math.ceil((parseFloat(S.fontSize)||18)*(parseFloat(S.lineHeight)||1.7)));
  var topPad=Math.max(2,mg(S.marginTop));
  var minGap=mg(S.marginBottom)+2;
  var maxVisible=Math.max(1,raw-minGap);
  var usable=Math.max(0,maxVisible-topPad);
  var wholeLines=Math.max(1,Math.floor((usable-1)/lh));
  var visible=Math.max(1,Math.min(maxVisible,topPad+wholeLines*lh));
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
  var h=document.documentElement.clientHeight||window.innerHeight||(pager&&pager.clientHeight)||1;
  return Math.max(1,Math.floor(h));
}
function scrollPageBox(){
  var raw=viewportHeight();
  var top=mg(S.marginTop),bottom=mg(S.marginBottom),pl=pageLayout();
  var usable=Math.max(1,raw-top-bottom);
  var lh=lineHeightPx();
  var whole=Math.max(1,Math.floor((usable-1)/lh));
  var h=Math.max(1,Math.min(usable,whole*lh));
  bottom=Math.max(0,raw-top-h);
  return {top:top,bottom:bottom,left:pl.l,right:pl.r,height:h};
}
function pagedBoxHeight(){
  var raw=viewportHeight();
  var top=mg(S.marginTop),bottom=mg(S.marginBottom);
  var usable=Math.max(1,raw-top-bottom);
  var lh=lineHeightPx();
  var whole=Math.max(1,Math.floor((usable-1)/lh));
  var h=top+whole*lh+bottom;
  return Math.max(1,Math.min(raw,Math.floor(h)));
}
function scrollVisualHeight(){
  var sp=scrollPort();var raw=sp?(sp.clientHeight||scrollPageBox().height||window.innerHeight||1):(window.innerHeight||1);
  return Math.max(1,Math.floor(raw));
}
function lineBreakPagerHeight(){
  return Math.max(1,(window.innerHeight||1)-lineBreakViewportTopGapPx()-lineBreakViewportBottomGapPx());
}
function lineBreakVisibleHeight(){
  return lineBreakPagerHeight();
}
// 页边距夹到非负且有上限：负内边距会破坏分栏排版（正文溢出/整体变形）
function mg(v){v=parseInt(v,10);if(isNaN(v)||v<0)return 0;return v>240?240:v;}
function pageLayout(){
  var vw=window.innerWidth,l=mg(S.marginLeft),r=mg(S.marginRight);
  if(isDualPage()){
    var gap=Math.max(32,Math.min(56,Math.round(vw*0.024)));
    var maxOuter=Math.max(0,vw-gap-320);
    if(l+r>maxOuter&&l+r>0){
      var s=maxOuter/(l+r);
      l=Math.floor(l*s);r=Math.floor(r*s);
    }
    var colW=Math.max(120,Math.floor((vw-l-r-gap)/2));
    var colPitch=colW+gap;
    return {l:l,r:r,gap:gap,colW:colW,colPitch:colPitch,pageStep:colPitch*2};
  }
  var maxTotal=Math.max(0,vw-160);
  if(l+r>maxTotal&&l+r>0){
    var ss=maxTotal/(l+r);
    l=Math.floor(l*ss);r=Math.floor(r*ss);
  }
  var singleW=Math.max(100,vw-l-r);
  return {l:l,r:r,gap:l+r,colW:singleW,colPitch:vw,pageStep:vw};
}
function hMargins(){
  return pageLayout();
}
function columnCountFromWidth(w,hasEnd){
  if(usesLineBreakPaging()){
    var h=measurer&&measurer.innerHTML?measurer.scrollHeight:(root?root.scrollHeight:0);
    var step=lineBreakVisibleHeight();
    return Math.max(1,Math.ceil(h/step));
  }
  var pl=pageLayout();
  if(isDualPage()){
    // w 是横向多列条带的 scrollWidth。双页模式下 UI 翻动的是 spread，
    // 每个 spread 包含两个物理栏，所以页数 = 物理栏数 / 2 向上取整。
    var physical=Math.max(1,Math.round((w-pl.l+pl.gap)/pl.colPitch));
    if(hasEnd)physical=Math.max(1,physical-1);
    return Math.max(1,Math.ceil(physical/2));
  }
  var count=Math.max(1,Math.round(w/pl.pageStep));
  if(hasEnd)count=Math.max(1,count-1);
  return count;
}
function contentRectExtent(el){
  if(!el)return 0;
  var base=el.getBoundingClientRect().left,maxRight=0;
  function addRect(r){
    if(!r||r.width<1||r.height<1)return;
    maxRight=Math.max(maxRight,r.right-base);
  }
  var walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    var range=document.createRange();
    try{range.selectNodeContents(node);}catch(e){continue;}
    var rects=range.getClientRects();
    for(var i=0;i<rects.length;i++)addRect(rects[i]);
  }
  var els=el.querySelectorAll('img,svg,canvas,table,pre,blockquote,h1,h2,h3,h4,h5,h6,p,li');
  for(var j=0;j<els.length;j++){
    if(els[j].classList&&els[j].classList.contains('rr-end'))continue;
    var rs=els[j].getClientRects();
    for(var k=0;k<rs.length;k++)addRect(rs[k]);
  }
  return Math.max(0,maxRight);
}
function physicalPageCountFromContent(el){
  var pl=pageLayout(),extent=contentRectExtent(el);
  if(extent<2)return 1;
  if(isDualPage())return Math.max(1,Math.ceil((extent+1)/pl.colPitch));
  return Math.max(1,Math.ceil((extent+1)/pl.pageStep));
}
function pagedPageCountFromContent(el){
  var physical=physicalPageCountFromContent(el);
  return isDualPage()?Math.max(1,Math.ceil(physical/2)):physical;
}
function fastPagedPageCount(el){
  if(!el)return 1;
  var hasEnd=!!el.querySelector('.rr-end');
  return columnCountFromWidth(el.scrollWidth||0,hasEnd);
}
function firstColumnLineRectsForHeight(){
  if(!root)return [];
  var rr=root.getBoundingClientRect(),pl=pageLayout();
  var left=rr.left-2,right=rr.left+pl.colW+2;
  var out=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    var range=document.createRange();
    try{range.selectNodeContents(node);}catch(e){continue;}
    var rects=range.getClientRects();
    for(var i=0;i<rects.length;i++){
      var r=rects[i];
      if(r.width<1||r.height<3)continue;
      if(r.right<left||r.left>right)continue;
      out.push({top:r.top,bottom:r.bottom,height:r.height});
    }
  }
  out.sort(function(a,b){return a.top-b.top||a.bottom-b.bottom;});
  var merged=[];
  for(var j=0;j<out.length;j++){
    var last=merged[merged.length-1];
    if(last&&Math.abs(last.top-out[j].top)<2){
      last.bottom=Math.max(last.bottom,out[j].bottom);
      last.height=Math.max(last.height,out[j].height);
    }else merged.push(out[j]);
  }
  return merged;
}
function calibratePagedBoxHeight(baseH){
  if(!root||isScrollMode())return baseH;
  var raw=viewportHeight();
  var h=Math.max(1,Math.min(raw,Math.floor(baseH||raw)));
  var minH=Math.max(1,mg(S.marginTop)+lineHeightPx()+mg(S.marginBottom));
  for(var pass=0;pass<4;pass++){
    root.style.height=h+'px';
    var rr=root.getBoundingClientRect();
    var bottom=rr.top+h-2;
    var lines=firstColumnLineRectsForHeight();
    if(!lines.length)break;
    var bad=-1;
    for(var i=0;i<lines.length;i++){
      if(lines[i].bottom>bottom){bad=i;break;}
    }
    if(bad<0)break;
    if(bad===0){h=Math.max(minH,Math.floor(h-lineHeightPx()));break;}
    var next=Math.floor(lines[bad-1].bottom-rr.top+mg(S.marginBottom)+2);
    next=Math.max(minH,Math.min(h-1,next));
    if(next>=h-1)next=Math.max(minH,Math.floor(h-lineHeightPx()));
    if(Math.abs(next-h)<1)break;
    h=next;
  }
  return Math.max(1,Math.min(raw,Math.floor(h)));
}
function applyCols(){
  var vw=window.innerWidth, vh=viewportHeight(), pageH=pagedBoxHeight(), pl=pageLayout();
  var fastLargeChapter=fastChapterLayout&&!isScrollMode();
  document.body.classList.toggle('scroll-mode',isScrollMode());
  document.body.classList.toggle('line-paged-mode',false);
  if(pageMask&&!isScrollMode())pageMask.style.height='0px';
  if(!isScrollMode()){
    // 切回分页后滚动容器虽被隐藏，scrollTop 仍会保留。若不清空，下一次
    // 切回滚动模式会把旧的纵向偏移和新的锚点恢复叠加，表现为每切一次跳一页。
    var inactiveScrollPort=scrollPort();
    if(inactiveScrollPort)inactiveScrollPort.scrollTop=0;
    scrollProgrammaticTarget=null;
    scrollActiveSlice=null;
    clearVirtualPage();clearScrollPreview();
  }
  if(!isScrollMode()&&scroller){scroller.style.clipPath='none';scroller.style.webkitClipPath='none';}
  if(isLinePagedMode()){
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
    root.style.transform='none';
    buildScrollBreaks();
    return;
  }
  if(isScrollMode()){
    var sb=scrollPageBox();
    pager.style.top=sb.top+'px';
    pager.style.bottom=sb.bottom+'px';
    pager.style.left=sb.left+'px';
    pager.style.right=sb.right+'px';
    pager.style.height='auto';
    if(scroller){scroller.style.top='0';scroller.style.bottom='0';scroller.style.left='0';scroller.style.right='0';}
    root.style.position='relative';
    root.style.left='0';
    root.style.top='0';
    root.style.width='100%';
    root.style.height='auto';
    root.style.minHeight=Math.max(1,(scrollPort()&&scrollPort().clientHeight)||sb.height)+'px';
    root.style.setProperty('--scroll-tail-space',Math.max(1,Math.ceil((scrollPort()&&scrollPort().clientHeight)||sb.height||vh))+'px');
    root.style.columnWidth='auto';
    root.style.columnCount='auto';
    root.style.columnGap='normal';
    root.style.transform='none';
    buildScrollBreaks();
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
  root.style.position='absolute';
  root.style.top='0';
  if(isDualPage()){
    // 真实双页：正文是一个横向多列条带，当前 spread 只露出两栏。
    // root 从左外边距开始；第三栏起点在右外边距之外，因此不会进入窗口。
    root.style.left=pl.l+'px';
    root.style.width=pl.colW+'px';
    root.style.columnWidth=pl.colW+'px';
    root.style.columnCount='auto';
    root.style.columnGap=pl.gap+'px';
  }else{
    root.style.left='0';
    root.style.width=vw+'px';
    root.style.columnWidth=pl.colW+'px';
    root.style.columnCount='auto';
    root.style.columnGap=pl.gap+'px';
  }
  // 大章节首屏避免遍历全部文本节点；小章节继续执行精确行边界校准。
  if(!fastLargeChapter)pageH=calibratePagedBoxHeight(pageH);
  root.style.height=pageH+'px';
  // 末尾有一个强制分栏的占位空栏（rr-end），让滚动条能到达真正的最后一页；页数要减掉它
  pageStep=pl.pageStep;
  pagesInCh=fastLargeChapter?fastPagedPageCount(root):pagedPageCountFromContent(root);
}
function setViewOffset(){
  if(isLinePagedMode()){
    viewOffset=0;
    scrollActiveSlice=null;
    if(pager){
pager.style.top=linePagedViewportTopGapPx()+'px';
pager.style.bottom=linePagedViewportBottomGapPx()+'px';
      buildScrollBreaks();
      var lpTop=scrollBreaks[Math.max(0,Math.min(pageInCh,scrollBreaks.length-1))]||0;
      scrollProgrammaticUntil=Date.now()+180;
      scrollProgrammaticTarget=Math.max(0,Math.min(scrollMaxTop(),lpTop));
      scrollPort().scrollTop=scrollProgrammaticTarget;
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
      var sb=scrollPageBox();
      pager.style.top=sb.top+'px';
      pager.style.bottom=sb.bottom+'px';
      pager.style.left=sb.left+'px';
      pager.style.right=sb.right+'px';
      if(scroller){scroller.style.top='0';scroller.style.bottom='0';scroller.style.left='0';scroller.style.right='0';}
      buildScrollBreaks();
      var top=scrollBreaks[Math.max(0,Math.min(pageInCh,scrollBreaks.length-1))]||0;
      scrollProgrammaticUntil=Date.now()+180;
      scrollProgrammaticTarget=Math.max(0,Math.min(scrollMaxTop(),top));
      scrollPort().scrollTop=scrollProgrammaticTarget;
      applyScrollPageMask();
    }
    if(root)root.style.transform='none';
    refreshHighlights();
    return;
  }
  viewOffset=pageInCh*pageStep;
  if(pager)pager.scrollLeft=0;
  if(root)root.style.transform='translateX(-'+viewOffset+'px)';
  refreshHighlights();
}
function scrollMaxTop(){
  if(!pager)return 0;
  var h=Math.max(root?root.scrollHeight:0,(scrollPort()&&scrollPort().scrollHeight)||0);
  return Math.max(0,h-((scrollPort()&&scrollPort().clientHeight)||window.innerHeight||1));
}
function scrollContentEndTop(){
  if(!pager)return 0;
  var safeH=Math.max(1,scrollVisualHeight());
  var h=Math.max(root?root.scrollHeight:0,(scrollPort()&&scrollPort().scrollHeight)||0);
  return Math.max(0,Math.min(scrollMaxTop(),h-safeH));
}
function atScrollEnd(){
  var sp=scrollPort();return !!(sp&&sp.scrollTop>=scrollContentEndTop()-2);
}
function atScrollStart(){
  var sp=scrollPort();return !!(sp&&sp.scrollTop<=2);
}
function lineHeightPx(){
  var cs=root?getComputedStyle(root):null;
  var lh=cs?parseFloat(cs.lineHeight):0;
  if(!lh||isNaN(lh)){
    var fs=cs?parseFloat(cs.fontSize):0;
    lh=fs?fs*1.5:28;
  }
  return Math.max(12,lh);
}
function visibleTextLineRects(extraTop,extraBottom){
  if(!root||!pager)return [];
  extraTop=extraTop||0;
  extraBottom=extraBottom||0;
  var pr=viewRect();
  var out=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    var text=node.nodeValue||'';
    if(!text.trim())continue;
    var range=document.createRange();
    try{range.selectNodeContents(node);}catch(e){continue;}
    var rects=range.getClientRects();
    for(var i=0;i<rects.length;i++){
      var r=rects[i];
      if(r.width<1||r.height<3)continue;
      if(r.bottom<pr.top-extraTop-2||r.top>pr.bottom+extraBottom+2)continue;
      out.push({top:r.top,bottom:r.bottom,height:r.height});
    }
  }
  out.sort(function(a,b){return a.top-b.top||a.bottom-b.bottom;});
  var merged=[];
  for(var j=0;j<out.length;j++){
    var last=merged[merged.length-1];
    if(last&&Math.abs(last.top-out[j].top)<2){
      last.bottom=Math.max(last.bottom,out[j].bottom);
      last.height=Math.max(last.height,out[j].height);
    }else merged.push(out[j]);
  }
  return merged;
}
function hasClippedTextAtBottom(){
  if(!pager)return false;
  var pr=viewRect();
  var safeBottom=pr.bottom-scrollBottomMaskPx();
  var lines=visibleTextLineRects();
  for(var i=0;i<lines.length;i++){
    if(lines[i].bottom>safeBottom-2&&lines[i].top<safeBottom-2)return true;
  }
  return false;
}
function transparentCssColor(v){
  return !v||v==='transparent'||/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(v);
}
function computedLineStyleForNode(node,cache){
  var el=node&&node.parentElement;
  if(!el)return {};
  if(cache&&cache.has(el))return cache.get(el);
  var cs=window.getComputedStyle(el);
  var style={
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
function computedLineStyleForElement(el,cache){
  if(!el)return {};
  if(cache&&cache.has(el))return cache.get(el);
  var cs=window.getComputedStyle(el);
  var style={
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
function sameLineKey(a,b){
  return Math.abs(a-b)<2;
}
function closestInlineNoteElement(node){
  var el=node&&node.nodeType===1?node:(node&&node.parentElement);
  if(!el||!root)return null;
  try{
    var hit=el.closest('a,sup,sub,span');
    while(hit&&root.contains(hit)){
      var tag=(hit.tagName||'').toLowerCase();
      if(tag==='a'&&isNoteLink(hit))return hit;
      var noteA=hit.querySelector&&hit.querySelector('a[data-rr-note-ref="1"],a.rr-note-ref');
      if(noteA)return noteA;
      if((tag==='sup'||tag==='sub')&&(hit.querySelector&&hit.querySelector('a')&&isNoteLink(hit.querySelector('a'))))return hit.querySelector('a');
      var meta=((hit.id||'')+' '+(hit.className||'')+' '+(hit.getAttribute&&hit.getAttribute('epub:type')||'')+' '+(hit.getAttribute&&hit.getAttribute('role')||'')).toLowerCase();
      if(/noteref|annoref|footnote|endnote/.test(meta))return hit;
      hit=hit.parentElement?hit.parentElement.closest('a,sup,sub,span'):null;
    }
  }catch(_){}
  return null;
}
function appendMeasuredCharLine(linesByKey,keys,node,ch,r,pr,scrollTop,style,docIndex){
  if(!ch)return;
  var top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop,left=r.left-pr.left,right=r.right-pr.left;
  if(!isFinite(top)||!isFinite(bottom)||bottom-top<3)return;
  var key=null;
  for(var i=0;i<keys.length;i++){if(sameLineKey(keys[i],top)){key=keys[i];break;}}
  if(key==null){key=top;keys.push(key);linesByKey[key]={top:top,bottom:bottom,height:bottom-top,left:left,right:right,fragments:[]};}
  var line=linesByKey[key];
  line.top=Math.min(line.top,top);line.bottom=Math.max(line.bottom,bottom);line.height=Math.max(line.height,bottom-top);line.left=Math.min(line.left,left);line.right=Math.max(line.right,right);
  var frags=line.fragments,last=frags[frags.length-1];
  if(last&&last.node===node&&Math.abs(last.top-top)<2&&Math.abs(last.right-left)<3){
    last.text+=ch;last.right=Math.max(last.right,right);last.width=Math.max(1,last.right-last.left);last.bottom=Math.max(last.bottom,bottom);last.height=Math.max(last.height,bottom-last.top);last.end=Math.max(last.end,docIndex+1);
  }else{
    frags.push({node:node,text:ch,left:left,right:right,top:top,bottom:bottom,width:Math.max(1,right-left),height:bottom-top,style:style,start:docIndex,end:docIndex+1});
  }
}
function appendMeasuredInlineLine(linesByKey,keys,el,r,pr,scrollTop,kind,style,text){
  if(!el||!r||r.width<1||r.height<3)return;
  var top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop,left=r.left-pr.left,right=r.right-pr.left;
  var key=null,bestOverlap=0,center=(top+bottom)/2,created=false;
  for(var i=0;i<keys.length;i++){
    var cand=linesByKey[keys[i]],over=Math.min(bottom,cand.bottom)-Math.max(top,cand.top);
    if(over>bestOverlap&&over>Math.min(bottom-top,cand.height)*0.18){bestOverlap=over;key=keys[i];}
    else if(key==null&&center>=cand.top-Math.max(2,cand.height*.35)&&center<=cand.bottom+Math.max(2,cand.height*.35)){key=keys[i];}
  }
  if(key==null){key=top;keys.push(key);linesByKey[key]={top:top,bottom:bottom,height:bottom-top,left:left,right:right,fragments:[]};created=true;}
  var line=linesByKey[key],frags=line.fragments;
  if(created){
    line.top=Math.min(line.top,top);line.bottom=Math.max(line.bottom,bottom);line.height=Math.max(line.height,bottom-top);
  }
  line.left=Math.min(line.left,left);line.right=Math.max(line.right,right);
  frags.push({kind:kind||'inline',el:el,text:text||'',left:left,right:right,top:top,bottom:bottom,width:Math.max(1,right-left),height:bottom-top,style:style||null});
}
function fastDocumentTextLineRects(){
  if(!root||!pager)return [];
  var pr=viewRect(),sp=scrollPort(),scrollTop=sp?sp.scrollTop||0:0;
  var out=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node,range=document.createRange();
  while((node=walker.nextNode())){
    var text=node.nodeValue||'',parent=node.parentElement;
    if(!text.trim()||!parent||generatedTextNode(node)||closestInlineNoteElement(node))continue;
    var pcs=window.getComputedStyle(parent);
    if(pcs.display==='none'||pcs.visibility==='hidden')continue;
    try{range.selectNodeContents(node);}catch(_){continue;}
    var rects=range.getClientRects();
    for(var i=0;i<rects.length;i++){
      var r=rects[i];
      if(r.width<1||r.height<3)continue;
      out.push({top:r.top-pr.top+scrollTop,bottom:r.bottom-pr.top+scrollTop,height:r.height,left:r.left-pr.left,right:r.right-pr.left,fragments:[]});
    }
  }
  out.sort(function(a,b){return a.top-b.top||a.left-b.left;});
  var merged=[];
  for(var j=0;j<out.length;j++){
    var last=merged[merged.length-1],cur=out[j];
    if(last&&Math.abs(last.top-cur.top)<2){
      last.top=Math.min(last.top,cur.top);last.bottom=Math.max(last.bottom,cur.bottom);last.height=Math.max(last.height,cur.height);last.left=Math.min(last.left,cur.left);last.right=Math.max(last.right,cur.right);
    }else merged.push(cur);
  }
  return merged;
}
function documentTextLineRects(){
  if(!root||!pager)return [];
  if(fastChapterLayout)return fastDocumentTextLineRects();
  var pr=viewRect(),sp=scrollPort(),scrollTop=sp?sp.scrollTop||0:0;
  var linesByKey={},keys=[],styleCache=new WeakMap();
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node,range=document.createRange(),docPos=0;
  while((node=walker.nextNode())){
    var text=node.nodeValue||'';
    var parent=node.parentElement;
    if(!parent)continue;
    if(generatedTextNode(node))continue;
    if(closestInlineNoteElement(node))continue;
    var nodeStart=docPos;docPos+=text.length;
    if(!text.trim())continue;
    var pcs=window.getComputedStyle(parent);
    if(pcs.display==='none'||pcs.visibility==='hidden')continue;
    var style=computedLineStyleForNode(node,styleCache);
    for(var i=0;i<text.length;i++){
      var ch=text.charAt(i);
      if(ch==='\r'||ch==='\n'||ch==='\t')continue;
      try{range.setStart(node,i);range.setEnd(node,i+1);}catch(e){continue;}
      var rects=range.getClientRects();
      if(!rects||!rects.length)continue;
      for(var ri=0;ri<rects.length;ri++){
        var r=rects[ri];
        if(r.height<3)continue;
        if(r.width<0.1&&!ch.trim())continue;
        appendMeasuredCharLine(linesByKey,keys,node,ch,r,pr,scrollTop,style,nodeStart+i);
      }
    }
  }
  var noteEls=root.querySelectorAll('.rr-note-ref,a,sup,sub,span'),seenNotes=new WeakSet();
  for(var ne=0;ne<noteEls.length;ne++){
    var nel=noteEls[ne];
    var noteEl=closestInlineNoteElement(nel);
    if(!noteEl||seenNotes.has(noteEl))continue;
    seenNotes.add(noteEl);
    var ncs=window.getComputedStyle(noteEl);
    if(ncs.display==='none'||ncs.visibility==='hidden')continue;
    var nr=null;
    try{nr=noteEl.getBoundingClientRect();}catch(_){nr=null;}
    if(!nr||nr.width<1||nr.height<3)continue;
    appendMeasuredInlineLine(linesByKey,keys,noteEl,nr,pr,scrollTop);
  }
  var numEls=root.querySelectorAll('.rr-note-num');
  for(var nn=0;nn<numEls.length;nn++){
    var numEl=numEls[nn];
    var nns=window.getComputedStyle(numEl);
    if(nns.display==='none'||nns.visibility==='hidden')continue;
    var nr2=null;
    try{nr2=numEl.getBoundingClientRect();}catch(_){nr2=null;}
    if(!nr2||nr2.width<1||nr2.height<3)continue;
    appendMeasuredInlineLine(linesByKey,keys,numEl,nr2,pr,scrollTop,'note-number',computedLineStyleForElement(numEl,styleCache),(numEl.textContent||'').trim());
  }
  var out=keys.map(function(k){return linesByKey[k];}).sort(function(a,b){return a.top-b.top||a.left-b.left;});
  for(var j=0;j<out.length;j++){
    out[j].fragments.sort(function(a,b){return a.top-b.top||a.left-b.left;});
  }
  return out;
}
function documentFlowItems(){
  if(!root||!pager)return [];
  var items=filterTextLines(documentTextLineRects()).map(function(x){
    return {top:x.top,bottom:x.bottom,height:x.height,type:'line',atomic:false};
  });
  var pr=viewRect(),sp=scrollPort(),scrollTop=sp?sp.scrollTop||0:0;
  var blockSel='figure,img,svg,canvas,table,video,pre,blockquote';
  var els=root.querySelectorAll(blockSel);
  for(var i=0;i<els.length;i++){
    var el=els[i];
    if(el.classList&&el.classList.contains('rr-end'))continue;
    var parentBlock=el.parentElement?el.parentElement.closest(blockSel):null;
    if(parentBlock&&parentBlock!==el&&root.contains(parentBlock))continue;
    var r=null;
    try{r=el.getBoundingClientRect();}catch(e){r=null;}
    if(!r||r.width<2||r.height<4)continue;
    var top=r.top-pr.top+scrollTop;
    var bottom=r.bottom-pr.top+scrollTop;
    var tag=(el.tagName||'').toLowerCase();
    items.push({top:top,bottom:bottom,height:bottom-top,type:'block',atomic:true,tag:tag,preview:isPreviewableBlock({type:'block',tag:tag}),el:el,left:r.left-pr.left,width:r.width});
  }
  items.sort(function(a,b){return a.top-b.top||a.bottom-b.bottom||(a.type==='block'?-1:1);});
  var clean=[];
  for(var j=0;j<items.length;j++){
    var it=items[j];
    if(it.height<3)continue;
    var last=clean[clean.length-1];
    if(last&&it.type===last.type&&Math.abs(it.top-last.top)<2&&Math.abs(it.bottom-last.bottom)<2)continue;
    clean.push(it);
  }
  return clean;
}
function nextFlowItemAfter(items,y){
  for(var i=0;i<items.length;i++)if(items[i].top>y+2)return items[i];
  return null;
}
function firstAtomicBlockCrossing(items,top,bottom,usableH){
  for(var i=0;i<items.length;i++){
    var it=items[i];
    if(it.type!=='block'||!it.atomic)continue;
    if(it.height>usableH)continue;
    if(it.top>=top-2&&it.top<bottom-2&&it.bottom>bottom)return it;
  }
  return null;
}
function scrollPageItems(){
  if(!root||!pager)return [];
  var sp=scrollPort();
  var cacheSig=[curCh,layoutSig(),root.scrollHeight||0,sp?sp.clientWidth:0,sp?sp.clientHeight:0,root.querySelectorAll('figure,img,svg,canvas,table,video').length].join('|');
  if(cacheSig&&cacheSig===scrollItemsSig)return scrollItemsCache;
  var lines=filterTextLines(documentTextLineRects()).map(function(x,idx){
    return {top:x.top,bottom:x.bottom,height:x.height,type:'line',index:idx,left:x.left,right:x.right,fragments:x.fragments||[]};
  });
  var items=lines.slice();
  var pr=viewRect(),scrollTop=sp?sp.scrollTop||0:0;
  var els=root.querySelectorAll('figure,img,svg,canvas,table,video');
  function overlapsText(top,bottom){
    for(var i=0;i<lines.length;i++){
      var ln=lines[i];
      if(ln.bottom<top+2)continue;
      if(ln.top>bottom-2)break;
      var overlap=Math.min(bottom,ln.bottom)-Math.max(top,ln.top);
      if(overlap>Math.min(ln.height,bottom-top)*0.35)return true;
    }
    return false;
  }
  for(var i=0;i<els.length;i++){
    var el=els[i];
    if(el.classList&&el.classList.contains('rr-end'))continue;
    var parentBlock=el.parentElement?el.parentElement.closest('figure,img,svg,canvas,table,video'):null;
    if(parentBlock&&parentBlock!==el&&root.contains(parentBlock))continue;
    var r=null;
    try{r=el.getBoundingClientRect();}catch(e){r=null;}
    if(!r||r.width<2||r.height<4)continue;
    var top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop;
    if(overlapsText(top,bottom))continue;
    var tag=(el.tagName||'').toLowerCase();
    var src=previewSourceElement(el),sr=null;
    try{if(src)sr=src.getBoundingClientRect();}catch(_){sr=null;}
    var renderLeft=sr&&sr.width>2?sr.left-pr.left:r.left-pr.left;
    var renderTopOffset=sr&&sr.height>2?Math.max(0,sr.top-r.top):0;
    var renderWidth=sr&&sr.width>2?sr.width:r.width;
    var renderHeight=sr&&sr.height>2?sr.height:r.height;
    items.push({top:top,bottom:bottom,height:bottom-top,type:'block',atomic:true,tag:tag,preview:isPreviewableBlock({type:'block',tag:tag}),el:el,left:r.left-pr.left,width:r.width,renderLeft:renderLeft,renderTopOffset:renderTopOffset,renderWidth:renderWidth,renderHeight:renderHeight});
  }
  items.sort(function(a,b){return a.top-b.top||a.bottom-b.bottom||(a.type==='block'?-1:1);});
  var clean=[];
  for(var j=0;j<items.length;j++){
    var it=items[j];
    if(it.height<3)continue;
    var last=clean[clean.length-1];
    if(last&&Math.abs(it.top-last.top)<2&&Math.abs(it.bottom-last.bottom)<2)continue;
    clean.push(it);
  }
  scrollItemsSig=cacheSig;
  scrollItemsCache=clean;
  return clean;
}
function isPreviewableBlock(it){
  if(!it||it.type!=='block')return false;
  return /^(figure|img|svg|canvas|video)$/.test(it.tag||'');
}
function pageBottomForSlice(pageTop,viewH,endItem,nextItem,bottomGuard){
  var fullBottom=pageTop+viewH;
  if(nextItem&&nextItem.type==='block'&&nextItem.atomic&&!isPreviewableBlock(nextItem)&&nextItem.top<fullBottom-1&&nextItem.bottom>fullBottom+0.5){
    return Math.max(pageTop,Math.min(fullBottom,Math.round(nextItem.top)));
  }
  return fullBottom;
}
function firstUnfinishedScrollItemIndex(items,startIdx,bottom){
  if(!items||!items.length)return -1;
  startIdx=Math.max(0,Math.min(items.length-1,startIdx||0));
  for(var i=startIdx;i<items.length;i++){
    if(items[i].bottom>bottom+0.5)return i;
  }
  return items.length;
}
function scrollLineTopAtOrBefore(lines,target,maxTop){
  target=Math.max(0,Math.min(maxTop,target||0));
  var best=0;
  for(var i=0;i<lines.length;i++){
    var top=Math.max(0,Math.min(maxTop,Math.round(lines[i].top||0)));
    if(top<=target+1)best=top;else break;
  }
  return best;
}
function readableScrollEndTop(lines){
  if(!pager)return 0;
  var safeH=scrollVisualHeight();
  var topPad=lineBreakTopPadPx();
  var last=lines&&lines.length?lines[lines.length-1]:null;
  var byLine=last?Math.max(0,last.bottom-safeH+topPad+Math.max(2,lineHeightPx()*0.12)):scrollContentEndTop();
  return Math.max(0,Math.min(scrollMaxTop(),byLine));
}
function readableNavMaxTop(lines,maxTop){
  maxTop=Math.max(0,maxTop||0);
  if(!lines||!lines.length)return maxTop;
  var last=lines[lines.length-1];
  return scrollLineTopAtOrBefore(lines,last?Math.round(last.top||0):0,maxTop);
}
function scrollPageTopForStartItem(items,startIdx,navMaxTop,topPad){
  if(!items||!items.length||startIdx<=0)return 0;
  var it=items[Math.max(0,Math.min(items.length-1,startIdx))];
  return Math.max(0,Math.min(navMaxTop,Math.round((it?it.top:0)-(topPad||0))));
}
function scrollAlignedPageStart(items,startIdx,navMaxTop,topPad){
  startIdx=Math.max(0,Math.min((items&&items.length?items.length:1)-1,startIdx||0));
  var pageTop=scrollPageTopForStartItem(items,startIdx,navMaxTop,topPad);
  var guard=0;
  while(startIdx>0&&items[startIdx-1].bottom>pageTop+1&&guard++<1000){
    startIdx--;
    pageTop=scrollPageTopForStartItem(items,startIdx,navMaxTop,topPad);
  }
  return {startIdx:startIdx,pageTop:pageTop};
}
function nearestScrollBreakIndex(top){
  if(!scrollBreaks.length)return 0;
  var best=0,bestD=Infinity;
  for(var i=0;i<scrollBreaks.length;i++){
    var d=Math.abs(scrollBreaks[i]-top);
    if(d<bestD){best=i;bestD=d;}
  }
  return best;
}
function pageIndexForScrollTop(top){
  if(!scrollBreaks.length)return 0;
  var idx=0;
  for(var i=0;i<scrollBreaks.length;i++){
    if(scrollBreaks[i]<=top+2)idx=i;else break;
  }
  return Math.max(0,Math.min(scrollBreaks.length-1,idx));
}
function snapScrollTopToBreak(target){
  buildScrollBreaks(false);
  if(!scrollBreaks.length)return {top:0,index:0};
  target=Math.max(0,Math.min(scrollMaxTop(),Math.round(target||0)));
  var idx=pageIndexForScrollTop(target);
  var top=Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[idx]||0));
  return {top:top,index:idx};
}
function currentScrollPageIndexForNav(top){
  buildScrollBreaks(false);
  if(!scrollBreaks.length)return 0;
  top=Math.max(0,Math.min(scrollMaxTop(),Math.round(top||0)));
  var eps=Math.max(3,Math.ceil(lineHeightPx()*0.20));
  var idx=pageIndexForScrollTop(top);
  if(idx<scrollBreaks.length-1&&Math.abs((scrollBreaks[idx+1]||0)-top)<=eps)return idx+1;
  if(Math.abs((scrollBreaks[idx]||0)-top)<=eps)return idx;
  return idx;
}
function scrollBreakForNav(top,dir){
  if(!scrollBreaks.length)buildScrollBreaks(false);
  if(!scrollBreaks.length)return null;
  var idx=currentScrollPageIndexForNav(top);
  var eps=Math.max(3,Math.ceil(lineHeightPx()*0.20));
  if(dir>0){
    for(var i=idx+1;i<scrollBreaks.length;i++){
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
function scrollSliceFromCanonicalBreak(nav){
  if(!nav)return null;
  buildScrollBreaks(false);
  if(!scrollBreaks.length)return null;
  var idx=Math.max(0,Math.min(scrollBreaks.length-1,nav.index||0));
  var top=Math.max(0,Math.min(scrollMaxTop(),Math.round(nav.top==null?(scrollBreaks[idx]||0):nav.top)));
  var page=scrollPages&&scrollPages[idx]?scrollPages[idx]:null;
  if(!page){
    var viewH=Math.max(1,(scrollPort()&&scrollPort().clientHeight)||window.innerHeight||1);
    return {top:top,bottom:top+viewH,nextTop:top,startIndex:0,endIndex:0,nextIndex:0,end:idx>=scrollBreaks.length-1,index:idx};
  }
  return {
    top:top,
    bottom:page.bottom,
    nextTop:page.nextTop,
    startIndex:page.startIndex,
    endIndex:page.endIndex,
    nextIndex:page.nextIndex,
    previewIndex:page.previewIndex,
    previewItem:page.previewItem,
    virtualLayout:page.virtualLayout,
    virtualBottom:page.virtualBottom,
    end:page.end,
    index:idx
  };
}
function canonicalScrollSliceForNav(top,dir){
  return scrollSliceFromCanonicalBreak(scrollBreakForNav(top,dir));
}
function computeScrollPageSlice(cur,items){
  var sp=scrollPort();
  if(!sp||!root)return null;
  var viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  var safe=scrollGlyphSafePx(),bottomGuard=scrollBottomSafePx();
  var usableH=Math.max(1,viewH-safe-bottomGuard);
  items=items||documentFlowItems();
  if(!items.length)return null;
  var maxTop=scrollMaxTop();
  cur=Math.max(0,Math.min(maxTop,Math.round(cur||0)));
  var top=cur+safe,hardBottom=cur+viewH-bottomGuard;
  var sliceBottom=cur+viewH;
  var nextTop=maxTop;
  var crossing=firstAtomicBlockCrossing(items,top,hardBottom,usableH);
  if(crossing&&crossing.top>top+Math.max(6,lineHeightPx()*0.35)){
    sliceBottom=Math.max(top,crossing.top-safe);
    nextTop=crossing.top-safe;
    return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:Math.max(0,Math.min(maxTop,Math.round(nextTop)))};
  }
  var last=null;
  for(var i=0;i<items.length;i++){
    var it=items[i];
    if(it.bottom<=top+2)continue;
    if(it.bottom<=hardBottom){last=it;continue;}
    if(it.top>=hardBottom)break;
  }
  if(last){
    sliceBottom=Math.max(top,Math.min(cur+viewH,last.bottom+Math.min(safe,bottomGuard)));
    var afterLast=nextFlowItemAfter(items,last.bottom);
    if(!afterLast){
      return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:maxTop,end:true};
    }
    nextTop=afterLast.top-safe;
    if(nextTop<=cur+Math.max(4,lineHeightPx()*0.25)){
      var later=nextFlowItemAfter(items,top+lineHeightPx());
      nextTop=later?later.top-safe:Math.min(maxTop,cur+usableH);
    }
    return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:Math.max(0,Math.min(maxTop,Math.round(nextTop)))};
  }
  var next=nextFlowItemAfter(items,top);
  if(next){
    nextTop=next.top-safe;
    sliceBottom=Math.max(cur,Math.min(cur+viewH,next.top-safe));
  }else{
    return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:maxTop,end:true};
  }
  return {top:cur,bottom:Math.max(cur,Math.min(cur+viewH,Math.round(sliceBottom))),nextTop:Math.max(0,Math.min(maxTop,Math.round(nextTop)))};
}
function scrollNextTopFromDocument(cur,dir){
  if(dir>0){var s=computeScrollPageSlice(cur);return s?s.nextTop:null;}
  var sp=scrollPort();
  if(!sp||!root)return null;
  var viewH=Math.max(1,sp.clientHeight||window.innerHeight||1),safe=scrollGlyphSafePx();
  var items=documentFlowItems(),maxTop=scrollMaxTop();
  if(!items.length)return null;
  cur=Math.max(0,Math.min(maxTop,cur||0));
  if(cur<=scrollStartEpsilonPx())return 0;
  var target=cur-viewH+safe,prev=null;
  for(var j=0;j<items.length;j++){if(items[j].top<=target+1)prev=items[j];else break;}
  if(prev)return Math.max(0,Math.min(maxTop,Math.round(prev.top-safe)));
  return 0;
}
function clearScrollPreview(){
  if(!scrollPreview)return;
  scrollPreview._rrPreviewSource=null;
  scrollPreview.style.display='none';
  scrollPreview.style.height='0px';
  scrollPreview.innerHTML='';
}
function activeScrollSliceAtTop(top){
  top=Math.round(top||0);
  if(scrollActiveSlice&&Math.abs(Math.round(scrollActiveSlice.top||0)-top)<=3)return scrollActiveSlice;
  if(scrollPages&&scrollPages.length){
    var idx=pageIndexForScrollTop(top);
    var page=scrollPages[Math.max(0,Math.min(scrollPages.length-1,idx))];
    if(page&&Math.abs(Math.round(page.top||0)-top)<=3)return page;
  }
  return null;
}
function stripCloneIds(el){
  if(!el)return;
  try{if(el.removeAttribute)el.removeAttribute('id');}catch(_){}
  var all=[];
  try{all=el.querySelectorAll?el.querySelectorAll('[id]'):[];}catch(_){all=[];}
  for(var i=0;i<all.length;i++){try{all[i].removeAttribute('id');}catch(_){}}
}
function previewSourceElement(el){
  if(!el)return null;
  var tag=(el.tagName||'').toLowerCase();
  if(tag==='figure'){
    var inner=el.querySelector&&el.querySelector('img,svg,canvas,video');
    return inner||el;
  }
  return el;
}
function clonePreviewElement(el){
  el=previewSourceElement(el);
  if(!el)return null;
  var tag=(el.tagName||'').toLowerCase(),clone=null;
  if(tag==='canvas'){
    try{clone=document.createElement('img');clone.src=el.toDataURL('image/png');}
    catch(_){clone=el.cloneNode(true);}
  }else clone=el.cloneNode(true);
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
function imagePreviewGapPx(){return 4;}
var imageVisualAnchorFrame=0;
function visiblePreviewLayerForSource(source){
  var layers=[];
  if(typeof pagedImagePreview!=='undefined'&&pagedImagePreview)layers.push(pagedImagePreview);
  if(scrollPreview)layers.push(scrollPreview);
  for(var i=0;i<layers.length;i++){
    var layer=layers[i];
    if(layer._rrPreviewSource!==source||layer.style.display==='none')continue;
    var r=null;try{r=layer.getBoundingClientRect();}catch(_){r=null;}
    if(r&&r.width>1&&r.height>1&&r.bottom>0&&r.top<viewportHeight())return {layer:layer,rect:r};
  }
  return null;
}
function captureImageVisualAnchor(){
  var layers=[];
  if(typeof pagedImagePreview!=='undefined'&&pagedImagePreview)layers.push(pagedImagePreview);
  if(scrollPreview)layers.push(scrollPreview);
  for(var i=0;i<layers.length;i++){
    var layer=layers[i],source=layer&&layer._rrPreviewSource;
    if(!source||layer.style.display==='none')continue;
    var r=null;try{r=layer.getBoundingClientRect();}catch(_){r=null;}
    if(r&&r.width>1&&r.height>1&&r.bottom>0&&r.top<viewportHeight())return {source:source,top:r.top};
  }
  return null;
}
function restoreImageVisualAnchor(anchor){
  if(!anchor||!anchor.source)return false;
  var match=visiblePreviewLayerForSource(anchor.source);
  if(!match)return false;
  var delta=anchor.top-match.rect.top;
  if(Math.abs(delta)<0.5)return true;
  var top=parseFloat(match.layer.style.top);
  if(!isFinite(top))return false;
  match.layer.style.top=Math.round(top+delta)+'px';
  return true;
}
function scheduleImageVisualAnchorRestore(anchor){
  if(imageVisualAnchorFrame){cancelAnimationFrame(imageVisualAnchorFrame);imageVisualAnchorFrame=0;}
  if(!anchor)return;
  var attempts=3;
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
}
function invalidateScrollItemsCache(){
  scrollItemsSig='';
  scrollItemsCache=[];
}
function ensureVirtualPage(){
  if(virtualPage&&virtualPage.isConnected)return virtualPage;
  if(!pager)return null;
  virtualPage=document.getElementById('virtual-page');
  if(!virtualPage){virtualPage=document.createElement('div');virtualPage.id='virtual-page';pager.appendChild(virtualPage);}
  return virtualPage;
}
function virtualItemHeight(it){
  if(!it)return 0;
  var lh=lineHeightPx();
  if(it.type==='line')return Math.max(8,Math.ceil(it.height||lh));
  return Math.max(8,Math.ceil(it.height||lh));
}
function virtualGapBetween(prev,it){
  if(!prev||!it)return 0;
  var gap=Math.max(0,(it.top||0)-(prev.bottom||0));
  var lh=lineHeightPx();
  if(prev.type==='line'&&it.type==='line')return Math.min(gap,Math.max(0,lh*0.08));
  return Math.min(gap,Math.max(2,lh*0.32));
}
function buildVirtualPageFromIndex(items,startIdx,viewH,navMaxTop){
  startIdx=Math.max(0,Math.min(items.length-1,startIdx||0));
  var lh=lineHeightPx(),bottomGuard=Math.max(2,Math.ceil(lh*0.08));
  var pageTop=Math.max(0,Math.min(navMaxTop,Math.round((items[startIdx]&&items[startIdx].top)||0)));
  var y=0,endIdx=startIdx-1,layout=[],previewIndex=-1,guard=0;
  for(var i=startIdx;i<items.length&&guard++<1000;i++){
    var it=items[i],h=virtualItemHeight(it);
    var y0=Math.max(0,Math.round((it.top||0)-pageTop));
    if(y0>=viewH-bottomGuard+0.5)break;
    var fits=y0+h<=viewH-bottomGuard+0.5;
    if(!fits){
      if(it.type==='block'&&isPreviewableBlock(it)){
        previewIndex=i;
      }
      break;
    }
    layout.push({index:i,type:it.type,top:y0,height:h,sourceTop:Math.max(0,Math.round((it.top||0)-Math.max(1,(h-(it.height||h))/2))),item:it});
    y=y0+h;
    endIdx=i;
  }
  if(!layout.length){
    var first=items[startIdx],firstH=Math.min(viewH-bottomGuard,virtualItemHeight(first));
    layout.push({index:startIdx,type:first.type,top:0,height:firstH,sourceTop:Math.max(0,Math.round(first.top||0)),item:first});
    endIdx=startIdx;
    y=firstH;
  }
  var nextIdx=endIdx+1;
  if(previewIndex>=0)nextIdx=previewIndex;
  var isEnd=nextIdx>=items.length;
  var nextTop=isEnd?navMaxTop:Math.max(0,Math.min(navMaxTop,Math.round((items[nextIdx]&&items[nextIdx].top)||0)));
  return {top:pageTop,bottom:pageTop+viewH,nextTop:nextTop,startIndex:startIdx,endIndex:endIdx,nextIndex:nextIdx,previewIndex:previewIndex,previewItem:previewIndex>=0?items[previewIndex]:null,virtualLayout:layout,virtualBottom:y,end:isEnd};
}
function applyVirtualFragmentStyle(el,style){
  if(!style)return;
  for(var k in style){
    if(Object.prototype.hasOwnProperty.call(style,k)&&style[k])el.style[k]=style[k];
  }
}
function cssContentText(v){
  if(!v||v==='none'||v==='normal')return '';
  if((v.charAt(0)==='"'&&v.charAt(v.length-1)==='"')||(v.charAt(0)==="'"&&v.charAt(v.length-1)==="'"))return v.slice(1,-1);
  return '';
}
function noteLinkInfo(el){
  if(!el)return null;
  var a=(el.tagName&&el.tagName.toLowerCase()==='a')?el:(el.querySelector&&el.querySelector('a'));
  var href=a?a.getAttribute('href'):(el.getAttribute&&el.getAttribute('href'));
  var frag=href&&href.indexOf('#')>=0?decodeURIComponent(href.split('#').pop()):'';
  return frag?{anchor:a||el,href:href,frag:frag}:null;
}
function bindVirtualNoteClick(el,info){
  if(!el||!info)return;
  el.style.cursor='pointer';
  el.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    if(pageDebugSettingOn('reader_footnotes'))showFootnote(el,curCh,info.frag);
  });
}
function inlineCloneHasVisibleContent(el){
  if(!el)return false;
  if((el.textContent||'').replace(/\s+/g,'').length>0)return true;
  if(el.querySelector&&el.querySelector('img,svg,canvas,video'))return true;
  var nodes=[el],kids=el.querySelectorAll?el.querySelectorAll('*'):[];
  for(var i=0;i<kids.length;i++)nodes.push(kids[i]);
  for(var j=0;j<nodes.length;j++){
    try{
      var cs=window.getComputedStyle(nodes[j]);
      if(cs.backgroundImage&&cs.backgroundImage!=='none')return true;
      var before=cssContentText(window.getComputedStyle(nodes[j],'::before').content);
      var after=cssContentText(window.getComputedStyle(nodes[j],'::after').content);
      if(before||after)return true;
    }catch(_){}
  }
  return false;
}
function noteFontSizePx(){
  var n=parseFloat(S.noteFontSize);
  if(!isFinite(n))n=14;
  return Math.max(10,Math.min(22,n));
}
function noteBadgeSizePx(){
  return 14;
}
function inlineNoteAnchor(a){
  if(!a||!a.tagName||a.tagName.toLowerCase()!=='a')return false;
  var href=a.getAttribute('href')||'',id=a.getAttribute('id')||'';
  var cls=String(a.className||'');
  var meta=((a.getAttribute('epub:type')||'')+' '+(a.getAttribute('role')||'')+' '+cls).toLowerCase();
  if(a.getAttribute('data-rr-note-ref')==='1'||/\brr-note-ref\b/.test(cls))return true;
  if(/noteref|annoref/.test(meta))return true;
  if(/^noteBack[_-]?\d*$/i.test(id))return true;
  var frag=href&&href.indexOf('#')>=0?href.split('#').pop():'';
  if(!frag)return false;
  if(/back/i.test(frag))return false;
  return /^(note|footnote|endnote|fn|n)[_\-]?\d{1,5}$/i.test(decodeURIComponent(frag));
}
function ensureNoteBadgeForAnchor(a){
  if(!a||!inlineNoteAnchor(a))return null;
  if(a.getAttribute('data-rr-note-ref')!=='1'){
    var raw=(a.textContent||'').trim();
    if(raw)a.setAttribute('data-rr-note-text',raw);
    a.setAttribute('data-rr-note-ref','1');
    a.classList.add('rr-note-ref');
    a.setAttribute('aria-label',raw?('注释 '+raw):'注释');
    while(a.firstChild)a.removeChild(a.firstChild);
  }else{
    a.classList.add('rr-note-ref');
  }
  var badge=null;
  for(var i=0;i<a.children.length;i++){
    if(a.children[i].classList&&a.children[i].classList.contains('rr-note-badge')){badge=a.children[i];break;}
  }
  if(!badge){
    badge=document.createElement('span');
    badge.className='rr-note-badge';
    badge.setAttribute('data-generated','1');
    a.appendChild(badge);
  }
  badge.textContent='注';
  var p=a.parentElement;
  while(p&&p!==root&&/^(SUP|SUB|SPAN|SMALL|FONT|B|I|EM|STRONG)$/.test(p.nodeName)){
    p.classList.add('rr-note-wrap');
    if(p.parentElement&&p.parentElement.children&&p.parentElement.children.length===1)p=p.parentElement;
    else break;
  }
  return a;
}
function normalizeInlineNoteRefs(){
  if(!root)return;
  var anchors=root.querySelectorAll('a[href*="#"],a[id^="noteBack"],a[epub\\:type*="noteref"],a[role~="doc-noteref"],a[data-rr-note-ref="1"]');
  for(var i=0;i<anchors.length;i++)ensureNoteBadgeForAnchor(anchors[i]);
  sourceTextCache=null;
}
function styleSyntheticNoteBadge(badge,el){
  if(!badge)return;
  var cs=null;
  try{cs=el?window.getComputedStyle(el):null;}catch(_){}
  var size=Math.round(noteBadgeSizePx());
  badge.textContent='注';
  badge.style.display='inline-flex';
  badge.style.alignItems='center';
  badge.style.justifyContent='center';
  badge.style.width=size+'px';
  badge.style.height=size+'px';
  badge.style.boxSizing='border-box';
  badge.style.borderRadius='50%';
  badge.style.background='#eef7ef';
  badge.style.border='1px solid #6f8f7d';
  badge.style.color='#5f7f6d';
  badge.style.fontFamily=cs&&cs.fontFamily?cs.fontFamily:"system-ui,'Microsoft YaHei',sans-serif";
  badge.style.fontSize=Math.max(9,Math.round(size*0.62))+'px';
  badge.style.fontWeight='700';
  badge.style.lineHeight='1';
  badge.style.verticalAlign='middle';
  badge.style.textDecoration='none';
  badge.style.overflow='hidden';
  badge.style.pointerEvents='auto';
}
function makeSyntheticNoteBadge(el){
  var badge=document.createElement('span');
  styleSyntheticNoteBadge(badge,el);
  badge.setAttribute('data-vnote-badge','1');
  return badge;
}
function copyInlineComputedStyle(src,dst){
  if(!src||!dst)return;
  var props=['display','width','height','minWidth','minHeight','maxWidth','maxHeight','color','backgroundColor','backgroundImage','backgroundSize','backgroundRepeat','backgroundPosition','backgroundClip','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderRadius','boxShadow','fontFamily','fontSize','fontWeight','fontStyle','fontVariant','lineHeight','letterSpacing','wordSpacing','textDecoration','textAlign','verticalAlign','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft'];
  var cs=window.getComputedStyle(src);
  for(var i=0;i<props.length;i++){try{dst.style[props[i]]=cs[props[i]];}catch(_){}}
}
function cloneInlineNoteFragment(el){
  if(!el)return null;
  var info=noteLinkInfo(el);
  var src=el.classList&&el.classList.contains('rr-note-ref')?el:(el.querySelector&&el.querySelector('.rr-note-ref'));
  var clone=src?src.cloneNode(true):makeSyntheticNoteBadge(el);
  clone.removeAttribute('id');
  if(src){
    copyInlineComputedStyle(src,clone);
    var srcBadge=src.querySelector&&src.querySelector('.rr-note-badge');
    var cloneBadge=clone.querySelector&&clone.querySelector('.rr-note-badge');
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
  var badge=clone.querySelector&&clone.querySelector('.rr-note-badge');
  if(badge){
    badge.style.width='100%';
    badge.style.height='100%';
    badge.style.margin='0';
  }
  bindVirtualNoteClick(clone,info);
  return clone;
}
function renderVirtualLine(entry){
  var it=entry&&entry.item;
  if(!it||!it.fragments||!it.fragments.length)return null;
  var line=document.createElement('div');
  line.className='vp-line';
  line.style.top=Math.round(entry.top)+'px';
  line.style.height=Math.max(1,Math.ceil(entry.height))+'px';
  for(var i=0;i<it.fragments.length;i++){
    var f=it.fragments[i];
    if(!f)continue;
    var span=document.createElement('span');
    span.className=f.kind==='inline'?'vp-inline':'vp-frag';
    if(f.kind==='note-number')span.classList.add('vp-note-num');
    span.style.left=Math.round(f.left||0)+'px';
    span.style.top=Math.round((f.top||it.top||0)-(it.top||0))+'px';
    span.style.height=Math.max(1,Math.ceil(f.height||it.height||entry.height))+'px';
    if(f.width)span.style.width=Math.max(1,Math.ceil(f.width))+'px';
    if(f.kind==='note-number'){
      if(!f.text)continue;
      span.textContent=f.text;
      span.style.left=Math.max(6,Math.round(f.left||0))+'px';
      span.style.width=Math.max(1,Math.ceil(f.width||0)+2)+'px';
      span.style.minWidth=span.style.width;
      applyVirtualFragmentStyle(span,f.style);
    }else if(f.kind==='inline'){
      var clone=cloneInlineNoteFragment(f.el);
      if(!clone)continue;
      var noteW=Math.max(1,Math.ceil(f.width||noteBadgeSizePx()));
      var noteH=Math.max(1,Math.ceil(f.height||noteBadgeSizePx()));
      span.style.left=Math.round(f.left||0)+'px';
      span.style.top=Math.round((f.top||it.top||0)-(it.top||0))+'px';
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
      var hi=highlightIndexForRange(f.start,f.end);
      if(hi>=0){span.classList.add('vp-hl');span.setAttribute('data-hi',String(hi));}
      if(f.width)span.style.minWidth=Math.max(1,Math.ceil(f.width))+'px';
      applyVirtualFragmentStyle(span,f.style);
    }
    line.appendChild(span);
  }
  return line.childNodes.length?line:null;
}
function sizeVirtualPreviewClone(clone,it){
  if(!clone||!it)return;
  var w=Math.max(1,Math.round(it.renderWidth||it.width||0));
  var h=Math.max(1,Math.round(it.renderHeight||it.height||0));
  clone.style.width=w+'px';
  clone.style.height=h+'px';
  clone.style.maxWidth='none';
  clone.style.maxHeight='none';
  clone.style.objectFit='fill';
}
function renderVirtualBlockSlice(page,entry){
  var it=entry.item,box=document.createElement('div');
  box.className='vp-block';
  box.style.top=Math.round(entry.top+(it.renderTopOffset||0))+'px';
  box.style.height=Math.max(1,Math.ceil(Math.min(entry.height,entry.height-(it.renderTopOffset||0)+(it.renderHeight||entry.height))))+'px';
  box.style.left=Math.max(0,Math.round(it.renderLeft!=null?it.renderLeft:(it.left||0)))+'px';
  box.style.width=Math.max(1,Math.round(it.renderWidth||it.width||1))+'px';
  var clone=clonePreviewElement(it.el);
  if(!clone&&it.el){clone=it.el.cloneNode(true);stripCloneIds(clone);}
  if(clone){sizeVirtualPreviewClone(clone,it);box.appendChild(clone);}
  return box;
}
function renderVirtualPreview(page,viewH){
  var it=page&&page.previewItem?page.previewItem:null;
  if(!it||!isPreviewableBlock(it)||!it.el)return null;
  var y=Math.max(0,Math.round(page.virtualBottom||0)+imagePreviewGapPx());
  var h=Math.floor(viewH-y);
  if(h<Math.max(24,Math.ceil(lineHeightPx()*0.75)))return null;
  var box=document.createElement('div');
  box.className='vp-block vp-preview';
  box.style.top=y+'px';
  box.style.height=h+'px';
  box.style.left=Math.max(0,Math.round(it.renderLeft!=null?it.renderLeft:(it.left||0)))+'px';
  box.style.width=Math.max(1,Math.round(it.renderWidth||it.width||1))+'px';
  var clone=clonePreviewElement(it.el);
  if(!clone)return null;
  sizeVirtualPreviewClone(clone,it);
  box.appendChild(clone);
  return box;
}
function renderVirtualScrollPage(){
  if(!isScrollMode()||!scrollPagedView||!pager||!root){clearVirtualPage();return;}
  var sp=scrollPort();
  if(!sp){clearVirtualPage();return;}
  var layer=ensureVirtualPage();
  if(!layer)return;
  var top=Math.round(sp.scrollTop||0),viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  var page=activeScrollSliceAtTop(top);
  if(!page){clearVirtualPage();return;}
  var layout=page.virtualLayout||[];
  layer.innerHTML='';
  for(var i=0;i<layout.length;i++){
    var entry=layout[i],node=entry.type==='block'?renderVirtualBlockSlice(page,entry):renderVirtualLine(entry);
    if(node)layer.appendChild(node);
  }
  var preview=renderVirtualPreview(page,viewH);
  if(preview)layer.appendChild(preview);
  layer.style.display='block';
}
function scrollImagePreviewEligible(next,slice,nextIdx,pageBottom){
  if(!next||!slice)return false;
  if(next.top>=pageBottom-2)return true;
  return next.bottom>pageBottom+0.5&&(slice.previewItem===next||slice.previewIndex===nextIdx);
}
function applyScrollImagePreview(){
  if(!isScrollMode()||!scrollPagedView||!pager||!root){clearScrollPreview();return;}
  var sp=scrollPort();
  if(!sp){clearScrollPreview();return;}
  if(!scrollPreview){
    scrollPreview=document.getElementById('scroll-preview');
    if(!scrollPreview&&pager){scrollPreview=document.createElement('div');scrollPreview.id='scroll-preview';pager.appendChild(scrollPreview);}
  }
  if(!scrollPreview)return;
  var top=Math.round(sp.scrollTop||0);
  var viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  var pageBottom=top+viewH;
  var slice=activeScrollSliceAtTop(top);
  if(!slice){clearScrollPreview();return;}
  var items=scrollPageItems();
  if(!items.length){clearScrollPreview();return;}
  var nextIdx=typeof slice.nextIndex==='number'?slice.nextIndex:-1;
  if(nextIdx<0||nextIdx>=items.length){clearScrollPreview();return;}
  var next=items[nextIdx];
  if(!next||!isPreviewableBlock(next)||!next.el){clearScrollPreview();return;}
  // 大图虽然已经从正文流进入视口，但整张放不下时，仍应使用与单页模式一致的裁剪预览。
  if(!scrollImagePreviewEligible(next,slice,nextIdx,pageBottom)){clearScrollPreview();return;}
  var contentBottom=top;
  var start=Math.max(0,Math.min(items.length-1,slice.startIndex||0));
  var end=Math.max(start,Math.min(items.length-1,slice.endIndex==null?nextIdx-1:slice.endIndex));
  for(var i=start;i<=end;i++){
    var it=items[i];
    if(!it||it.top<top-2||it.bottom>pageBottom+0.5)continue;
    contentBottom=Math.max(contentBottom,it.bottom);
  }
  if(contentBottom<=top+1){
    for(var j=0;j<items.length;j++){
      var it2=items[j];
      if(!it2||it2.top<top-2||it2.bottom>pageBottom+0.5)continue;
      contentBottom=Math.max(contentBottom,it2.bottom);
    }
  }
  var gapTop=Math.max(0,Math.round(contentBottom-top)+imagePreviewGapPx());
  var gapH=Math.floor(viewH-gapTop);
  if(gapH<Math.max(24,Math.ceil(lineHeightPx()*0.75))){clearScrollPreview();return;}
  var clone=clonePreviewElement(next.el);
  if(!clone){clearScrollPreview();return;}
  sizeVirtualPreviewClone(clone,next);
  var src=previewSourceElement(next.el),r=null,pr=viewRect();
  try{r=src.getBoundingClientRect();}catch(_){r=null;}
  scrollPreview.innerHTML='';
  scrollPreview.style.display='block';
  scrollPreview.style.top=gapTop+'px';
  scrollPreview.style.height=gapH+'px';
  scrollPreview.style.bottom='auto';
  scrollPreview._rrPreviewSource=src||previewSourceElement(next.el);
  var inner=document.createElement('div');
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
function applyScrollPageMask(){
  if(typeof clearPagedImagePreview==='function')clearPagedImagePreview();
  if(pageMask){
    pageMask.style.height='0px';
    pageMask.style.display='none';
  }
  clearVirtualPage();
  clearScrollPreview();
  var blank=currentScrollPageClipBlank();
  if(scroller){
    if(blank>1){
      scroller.style.clipPath='inset(0px 0px '+blank+'px 0px)';
      scroller.style.webkitClipPath='inset(0px 0px '+blank+'px 0px)';
    }else{
      scroller.style.clipPath='none';
      scroller.style.webkitClipPath='none';
    }
  }
  refreshHighlights();
  applyScrollImagePreview();
}
function currentScrollPageClipBlank(){
  if(!isScrollMode()||!scrollPagedView||!pager||!root)return 0;
  var sp=scrollPort();
  if(!sp)return 0;
  var viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  var top=Math.round(sp.scrollTop||0);
  var pr=viewRect();
  var maskBlank=0;
  var pageBottom=top+viewH;
  var docLines=filterTextLines(documentTextLineRects());
  for(var i=0;i<docLines.length;i++){
    var ln=docLines[i];
    if(ln.top>=pageBottom-1)break;
    if(ln.bottom>pageBottom+0.5){
      maskBlank=Math.max(maskBlank,Math.ceil(pageBottom-ln.top+1));
      break;
    }
  }
  if(maskBlank<=1){
    var lines=visibleTextLineRects(0,Math.ceil(lineHeightPx()*0.4));
    for(var j=lines.length-1;j>=0;j--){
      var vl=lines[j];
      if(vl.top>=pr.bottom-1)continue;
      if(vl.bottom>pr.bottom+0.5){
        maskBlank=Math.max(maskBlank,Math.ceil(pr.bottom-vl.top+1));
        break;
      }
      break;
    }
  }
  var slice=activeScrollSliceAtTop(top);
  var blank=0;
  blank=Math.max(blank,maskBlank);
  if(slice){
    // 分页器会为底部留出少量安全区，避免把一行字切在页边。原始滚动内容
    // 仍会把这行完整绘制在视口内；若不按虚拟页的最后一项裁切，它既出现在
    // 当前页底部，也会作为下一页首行出现。
    var items=scrollPageItems();
    var nextIdx=typeof slice.nextIndex==='number'?slice.nextIndex:-1;
    var next=nextIdx>=0&&nextIdx<items.length?items[nextIdx]:null;
    var virtualBottom=Math.max(0,Math.min(viewH,Math.ceil(slice.virtualBottom||0)));
    var nextTop=next?Math.round((next.top||0)-top):viewH;
    if(next&&next.type==='line'&&virtualBottom>0&&virtualBottom<viewH-1&&nextTop>=virtualBottom-1&&nextTop<viewH-1){
      blank=Math.max(blank,Math.ceil(viewH-virtualBottom));
    }
    var bottom=Math.max(top,Math.min(top+viewH,Math.round(slice.bottom==null?top+viewH:slice.bottom)));
    if(bottom<top+viewH-1){
      if(next&&next.type==='block'&&next.atomic&&!isPreviewableBlock(next)){
        blank=Math.max(blank,Math.ceil(top+viewH-bottom));
      }
    }
  }
  return blank<=1?0:Math.max(0,Math.min(viewH-1,blank));
}
function buildScrollBreaks(syncIndex){
  var sp=scrollPort();
  if(!isScrollMode()||!pager||!root||!sp){scrollBreaks=[0];scrollPages=[{top:0,bottom:0,nextTop:0,startIndex:0,endIndex:0,end:true}];return;}
  var oldTop=sp.scrollTop||0;
  var viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  var contentH=Math.max(root.scrollHeight||0,sp.scrollHeight||0,viewH);
  var maxTop=Math.max(0,contentH-viewH);
  var items=scrollPageItems();
  var navMaxTop=items.length?readableNavMaxTop(items,maxTop):Math.max(0,maxTop);
  var sig=[curCh,layoutSig(),contentH,viewH,navMaxTop,items.length,root.querySelectorAll('img,svg,canvas,table,figure,video').length].join('|');
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
  var guard=0,startIdx=0,lastTop=-999999;
  while(startIdx<items.length&&guard++<3000){
    var page=buildVirtualPageFromIndex(items,startIdx,viewH,navMaxTop);
    var pageTop=page.top,nextIdx=page.nextIndex,isEnd=page.end;
    if(!scrollBreaks.length||Math.abs(pageTop-lastTop)>2){
      scrollBreaks.push(pageTop);scrollPages.push(page);lastTop=pageTop;
    }else{
      var prev=scrollPages[scrollPages.length-1];
      prev.bottom=Math.max(prev.bottom,page.bottom);
      prev.endIndex=Math.max(prev.endIndex,page.endIndex);
      prev.nextIndex=page.nextIndex;
      prev.nextTop=page.nextTop;
      prev.previewIndex=page.previewIndex;
      prev.previewItem=page.previewItem;
      prev.virtualLayout=page.virtualLayout;
      prev.virtualBottom=page.virtualBottom;
      prev.end=page.end;
    }
    if(isEnd)break;
    if(nextIdx<=startIdx)break;
    startIdx=nextIdx;
  }
  if(!scrollBreaks.length){scrollBreaks=[0];scrollPages=[{top:0,bottom:viewH,nextTop:maxTop,startIndex:0,endIndex:items.length-1,end:true}];}
  scrollBreakSig=sig;
  pagesInCh=scrollBreaks.length;
  if(syncIndex)pageInCh=pageIndexForScrollTop(oldTop);
  applyScrollPageMask();
}
function buildLinePagedBreaks(lines,topPad,viewH,maxTop){
  if(!lines||!lines.length)return [0];
  var lh=lineHeightPx();
  var breaks=[0],curTop=0;
  var minAdvance=Math.max(2,lh*0.35);
  var guard=0;
  while(guard++<2000){
    var bottom=curTop+viewH-2;
    var nextIdx=null;
    for(var i=0;i<lines.length;i++){
      if(lines[i].bottom>bottom){
        nextIdx=i;
        break;
      }
    }
    if(nextIdx==null)break;
    var next=scrollTopForLineIndex(lines,nextIdx,topPad);
    if(next<=curTop+minAdvance){
      next=null;
      var minTop=curTop+Math.max(lh*3,viewH*0.55);
      for(var j=nextIdx+1;j<lines.length;j++){
        var t=scrollTopForLineIndex(lines,j,topPad);
        if(t>=minTop){next=t;break;}
      }
      if(next==null)break;
    }
    next=Math.max(0,Math.min(maxTop,next));
    if(next<=curTop+minAdvance)break;
    if(breaks.length&&Math.abs(next-breaks[breaks.length-1])<=2)break;
    breaks.push(Math.round(next));
    curTop=next;
    if(curTop>=maxTop-2)break;
  }
  return breaks.length?breaks:[0];
}
function trimScrollBottomToWholeLine(){
  return 0;
}
function canLeaveScrollChapter(dir){
  if(!pager)return false;
  buildScrollBreaks(false);
  if(!scrollBreaks.length)return true;
  var cur=scrollPort().scrollTop||0;
  var eps=Math.max(3,lineHeightPx()*0.25);
  var idx=pageIndexForScrollTop(cur);
  if(dir>0){
    return idx>=scrollBreaks.length-1&&cur>=(scrollBreaks[idx]||0)-eps;
  }
  if(dir<0){
    return idx<=0&&cur<=(scrollBreaks[0]||0)+eps;
  }
  return false;
}
function snapScrollToReadableLine(dir){
  if(!isScrollMode()||!pager||!root)return;
  var maxTop=scrollMaxTop();
  if(scrollPort().scrollTop<=1||scrollPort().scrollTop>=maxTop-1)return;
  var pr=viewRect();
  var lines=visibleTextLineRects();
  if(!lines.length)return;
  var topLine=null;
  for(var i=0;i<lines.length;i++){if(lines[i].bottom>pr.top+2){topLine=lines[i];break;}}
  if(!topLine)return;
  var tolerance=2;
  var lh=lineHeightPx();
  if(topLine.top<pr.top-tolerance){
    var delta=(dir<0)?topLine.top-pr.top:topLine.bottom-pr.top+Math.max(1,lh*0.08);
    scrollPort().scrollTop=Math.max(0,Math.min(maxTop,scrollPort().scrollTop+delta));
    applyScrollPageMask();
  }else if(topLine.top>pr.top+lh*0.85){
    scrollPort().scrollTop=Math.max(0,Math.min(maxTop,scrollPort().scrollTop+(topLine.top-pr.top)));
    applyScrollPageMask();
  }
}
function syncScrollPageFromTop(){
  if(!usesLineBreakPaging()||!pager)return;
  var sp=scrollPort();
  if(!sp)return;
  var top=Math.round(sp.scrollTop||0);
  if(Date.now()<scrollProgrammaticUntil||(scrollProgrammaticTarget!=null&&Math.abs(top-scrollProgrammaticTarget)<=2)){
    if(scrollPagedView)applyScrollPageMask();
    return;
  }
  if(scrollPagedView){
    buildScrollBreaks(false);
    var idx=pageIndexForScrollTop(top);
    var breakTop=Math.round(scrollBreaks[idx]||0);
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
  var old=pageInCh;
  buildScrollBreaks(true);
  pageInCh=pageIndexForScrollTop(top);
  if(old!==pageInCh)report();
  if(scrollCaptureTimer)clearTimeout(scrollCaptureTimer);
  scrollCaptureTimer=setTimeout(function(){captureAnchor();report();},160);
}
function scrollTopForLine(line,topPad){
  return Math.max(0,Math.min(scrollMaxTop(),Math.round((line?line.top:0)-topPad)));
}
function scrollTopForLineIndex(lines,idx,topPad){
  if(!lines||!lines.length)return 0;
  idx=Math.max(0,Math.min(lines.length-1,idx||0));
  return scrollTopForLine(lines[idx],topPad);
}
function scrollTopForItemIndex(items,idx,topPad){
  if(!items||!items.length)return 0;
  idx=Math.max(0,Math.min(items.length-1,idx||0));
  return Math.max(0,Math.min(scrollMaxTop(),Math.round((items[idx]?items[idx].top:0)-topPad)));
}
function scrollLineIndexAtTop(lines,cur,topPad){
  if(!lines||!lines.length)return 0;
  var y=(cur||0)+topPad+1;
  for(var i=0;i<lines.length;i++){
    if(lines[i].bottom>y)return i;
  }
  return Math.max(0,lines.length-1);
}
function scrollItemIndexAtTop(items,cur,topPad){
  if(!items||!items.length)return 0;
  var y=(cur||0)+topPad+1;
  for(var i=0;i<items.length;i++){
    if(items[i].bottom>y)return i;
  }
  return Math.max(0,items.length-1);
}
function scrollSnapTopForTarget(lines,target,topPad){
  target=Math.max(0,Math.min(scrollMaxTop(),target||0));
  if(!lines||!lines.length)return target;
  var lh=lineHeightPx();
  var idx=scrollLineIndexAtTop(lines,target,topPad);
  var snapped=scrollTopForLineIndex(lines,idx,topPad);
  if(snapped<target-lh*0.75){
    for(var i=idx+1;i<lines.length;i++){
      var t=scrollTopForLineIndex(lines,i,topPad);
      if(t>=target-lh*0.2){snapped=t;break;}
    }
  }
  return Math.max(0,Math.min(scrollMaxTop(),snapped));
}
function scrollVisibleLineCount(lines,cur,topPad){
  if(!lines||!lines.length||!pager)return 1;
  var top=(cur||0)+topPad+1;
  var bottom=(cur||0)+scrollVisualHeight()-2;
  var n=0;
  for(var i=0;i<lines.length;i++){
    if(lines[i].bottom<=top)continue;
    if(lines[i].top>=bottom)break;
    n++;
  }
  return Math.max(3,n);
}
function scrollNextLineIndex(lines,cur,topPad,topIdx){
  if(!lines||!lines.length||!pager)return null;
  topIdx=Math.max(0,Math.min(lines.length-1,topIdx==null?scrollLineIndexAtTop(lines,cur,topPad):topIdx));
  var viewH=scrollVisualHeight();
  var lh=lineHeightPx();
  var bottom=(cur||0)+viewH-2;
  var targetIdx=null;
  for(var i=topIdx;i<lines.length;i++){
    if(lines[i].bottom>bottom){
      targetIdx=i;
      break;
    }
  }
  if(targetIdx==null)return null;
  if(targetIdx<=topIdx){
    var n=scrollVisibleLineCount(lines,cur,topPad);
    targetIdx=Math.min(lines.length-1,topIdx+Math.max(1,n-1));
  }
  var targetTop=scrollTopForLineIndex(lines,targetIdx,topPad);
  if(targetIdx<=topIdx+1||targetTop<=(cur||0)+Math.max(lh*3,viewH*0.28)){
    var minTop=(cur||0)+Math.max(lh*4,viewH*0.62);
    var fallback=null;
    for(var k=Math.max(topIdx+1,targetIdx+1);k<lines.length;k++){
      if(scrollTopForLineIndex(lines,k,topPad)>=minTop){fallback=k;break;}
    }
    if(fallback==null)return null;
    targetIdx=fallback;
  }
  return targetIdx;
}
function updateScrollPageAfterProgrammatic(){
  buildScrollBreaks(true);
  scrollProgrammaticTarget=pager?Math.round(scrollPort().scrollTop||0):scrollProgrammaticTarget;
  pageInCh=pageIndexForScrollTop(pager?scrollPort().scrollTop||0:0);
  report();
  captureAnchor();
  scheduleNoteNumberDisplayRefresh();
}
function firstLineAfter(lines,y){
  for(var i=0;i<lines.length;i++){
    if(lines[i].bottom>y)return lines[i];
  }
  return null;
}
function firstLineStartingAtOrAfter(lines,y){
  for(var i=0;i<lines.length;i++){
    if(lines[i].top>=y-1)return lines[i];
  }
  return null;
}
function liveNextScrollTop(){
  if(!pager)return null;
  buildScrollBreaks(false);
  var cur=scrollPort().scrollTop||0;
  var eps=Math.max(2,lineHeightPx()*0.20);
  var idx=pageIndexForScrollTop(cur);
  for(var i=Math.max(0,idx+1);i<scrollBreaks.length;i++){
    if((scrollBreaks[i]||0)>cur+eps)return Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[i]||0));
  }
  return null;
}
function livePrevScrollTop(){
  if(!pager)return null;
  buildScrollBreaks(true);
  var cur=scrollPort().scrollTop||0;
  var eps=Math.max(2,lineHeightPx()*0.20);
  var idx=pageIndexForScrollTop(cur);
  if(idx>0)return Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[idx-1]||0));
  for(var i=scrollBreaks.length-1;i>=0;i--){
    if((scrollBreaks[i]||0)<cur-eps)return Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[i]||0));
  }
  return null;
}
function report(){
  var useScrollPagesForReport=false;
  if(isScrollMode()&&pager){
    buildScrollBreaks(true);
    pageInCh=pageIndexForScrollTop(scrollPort().scrollTop||0);
    useScrollPagesForReport=true;
    var chFrac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
  }else{
    var chFrac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
  }
  var progressPagesInCh=useScrollPagesForReport?Math.max(1,pagesInCh||1):((measureDone&&chapterPages[curCh])?chapterPages[curCh]:pagesInCh);
  var progressPage=Math.round(chFrac*Math.max(0,progressPagesInCh-1));
  var gP=0,gT=0;
  if(measureDone){
    for(var i=0;i<CH;i++)gT+=(useScrollPagesForReport&&i===curCh)?progressPagesInCh:(chapterPages[i]||1);
    for(var j=0;j<curCh;j++)gP+=chapterPages[j]||1;
    gP+=progressPage+1;
  }
  // 进度优先按“整书页位置”算（章节大小不均时仍平滑）；未测量完再退回按章节估算
  // 用 0 基：首页(gP=1)=0%、末页(gP=gT)=100%
  var prog;
  if(measureDone&&gT>0)prog=gT>1?((gP-1)/(gT-1))*100:0;
  else prog=CH>0?((curCh+chFrac)/CH)*100:0;
  var L=computeLogical();
  var pageChars=pagesInCh>0?Math.round(chapChars/pagesInCh):chapChars; // 当前页约略字数（按本章字数/页数均摊）
  parent.postMessage({chapter:curCh,chFrac:chFrac,page:pageInCh+1,total:pagesInCh,totalCh:CH,progress:prog,gPage:gP,gTotal:gT,logicalCh:L.lc,logicalTotal:L.lt,pageChars:pageChars},'*');
  // 注意：不在这里记录锚点。report() 也会被 relayout() 调到；若每次都重取锚点，
  // 拖动字号滑块时会把“重排后已偏移的顶部”当成新锚点，逐步累积漂移→整页跑掉。
  // 锚点只在用户“导航”（翻页/跳章/跳搜索命中）时更新，见 captureAnchor()。
}
// 记录当前页顶部锚点（精确到字符）。仅在用户主动导航后调用，供之后的重排锁定位置。
function captureAnchor(){
  var anchor=topAnchor();
  if(anchorValid(anchor))curTopAnchor=anchor;
  return curTopAnchor;
}
function measureChapterPages(html){
  if(!measurer)return 1;
  var vw=window.innerWidth,vh=pagedBoxHeight(),pl=pageLayout();
  if(isScrollMode()){
    measurer.style.minHeight='';
    measurer.style.height='auto';
    measurer.style.width=pl.colW+'px';
    measurer.style.columnWidth='auto';
    measurer.style.columnCount='auto';
    measurer.style.columnGap='normal';
    measurer.innerHTML=html;
    var contentH=Math.max(measurer.scrollHeight||0,Math.ceil(measurer.getBoundingClientRect().height||0));
    var pageH=Math.max(1,scrollPageBox().height||scrollVisualHeight()||viewportHeight());
    var step=Math.max(1,pageH-Math.max(2,Math.ceil(lineHeightPx()*0.08)));
    return Math.max(1,Math.ceil(contentH/step));
  }
  if(isDualPage()){
    measurer.style.minHeight='';
    measurer.style.height=vh+'px';
    measurer.style.width=pl.colW+'px';
    measurer.style.columnWidth=pl.colW+'px';
    measurer.style.columnCount='auto';
    measurer.style.columnGap=pl.gap+'px';
  }else{
    measurer.style.minHeight='';
    measurer.style.height=vh+'px';
    measurer.style.width=vw+'px';
    measurer.style.columnWidth=pl.colW+'px';
    measurer.style.columnCount='auto';
    measurer.style.columnGap=pl.gap+'px';
  }
  measurer.innerHTML=html;
  return physicalPageCountFromContent(measurer);
}
function measureAll(){
  if(!fullBookMeasureEnabled)return;
  if(measurePaused){perfLog('measure.skip','paused-before-start');scheduleMeasure(900);return;}
  if(measureDone&&pageSig===layoutSig())return; // 版式没变、已有页数 → 不重算
  var tok=++measureToken;measureDone=false;chapterPages=new Array(CH).fill(0);
  var i=0,tAll=performance.now();
  perfLog('measure.start','chapters='+CH);
  function step(){
    if(tok!==measureToken)return;
    if(measurePaused){perfLog('measure.pause','chapter='+i);scheduleMeasure(900);return;}
    if(i>=CH){if(measurer)measurer.innerHTML='';measureDone=true;pageSig=layoutSig();report();
      perfLog('measure.end','chapters='+CH+' dt='+(performance.now()-tAll).toFixed(1)+'ms');
      parent.postMessage({measured:{sig:pageSig,pages:chapterPages.slice()}},'*');return;} // 测完落盘缓存
    var tStep=performance.now(),idx=i;
    fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
      if(tok!==measureToken)return;if(measurePaused){perfLog('measure.pause','chapter='+idx+' after-fetch');scheduleMeasure(900);return;}chapterPages[i]=measureChapterPages(d.body||'');
      var dt=performance.now()-tStep;if(dt>40)perfLog('measure.chapter','chapter='+idx+' dt='+dt.toFixed(1)+'ms html='+(d.body||'').length);
      i++;setTimeout(step,16);
    }).catch(function(){if(tok!==measureToken)return;if(measurePaused){perfLog('measure.pause','chapter='+idx+' after-error');scheduleMeasure(900);return;}chapterPages[i]=1;i++;setTimeout(step,16);});
  }
  step();
}
// 外壳送来缓存的页数：版式签名一致就直接采用，跳过测量
function applyPageCache(pc){
  if(!pc||!pc.pages||pc.pages.length!==CH)return;
  if(pc.sig!==layoutSig())return; // 版式变了，缓存作废，照常测量
  measureToken++; // 作废可能在跑的测量
  chapterPages=pc.pages.slice();measureDone=true;pageSig=pc.sig;
  if(measureTimer){clearTimeout(measureTimer);measureTimer=null;}
  report();
}
function invalidateMeasure(){measureToken++;measureDone=false;pageSig='';chapterPages=new Array(CH).fill(0);}
function scheduleMeasure(delay){if(!fullBookMeasureEnabled)return;if(measureTimer)clearTimeout(measureTimer);measureTimer=setTimeout(measureAll,delay||1200);}
function setMeasurePaused(paused){
  measurePaused=!!paused;
  perfLog('measure.paused',measurePaused?1:0);
  if(measurePaused){
    measureToken++;
    if(measureTimer){clearTimeout(measureTimer);measureTimer=null;}
    if(measurer)measurer.innerHTML='';
  }else if(!measureDone){
    scheduleMeasure(1200);
  }
}
// 滚动条按“全书页位置”精确定位：已测量完→映射到具体章+页（同章直接翻页，平滑；跨章才加载）；
// 未测量完→退回按章节粗跳。这样点滑块附近不再原地跳，拖动也能平滑跟随。
function gotoGlobalFrac(frac){
  frac=Math.max(0,Math.min(1,frac));
  if(measureDone){
    var gt=0,i;for(i=0;i<CH;i++)gt+=chapterPages[i]||1;if(gt<1)gt=1;
    var gp=Math.round(frac*(gt-1)),acc=0,tc=CH-1,tp=0;
    for(i=0;i<CH;i++){var cp=chapterPages[i]||1;if(gp<acc+cp){tc=i;tp=gp-acc;break;}acc+=cp;}
    if(tc===curCh)gotoPage(tp);else showChapter(tc,tp);
  }else{
    showChapter(Math.min(CH-1,Math.floor(frac*CH)),'start');
  }
}
function gotoPage(p,dir){
  var next=Math.max(0,Math.min(pagesInCh-1,p));
  if(usesLineBreakPaging())scrollPagedView=true;
  beginTurnFx(dir,function(){
    pageInCh=next;
    setViewOffset();
    if(usesLineBreakPaging()){
      syncScrollPageFromTop();
    }
    report();captureAnchor();scheduleNoteNumberDisplayRefresh();
  });
}
function filterTextLines(lines){
  if(!lines||!lines.length)return [];
  var heights=lines.map(function(x){return x.height||0;}).filter(function(x){return x>2;}).sort(function(a,b){return a-b;});
  var median=heights[Math.floor(heights.length/2)]||lineHeightPx();
  var maxLineHeight=median*1.9;
  return lines.filter(function(x){return x.height<=maxLineHeight;}).sort(function(a,b){return a.top-b.top||a.bottom-b.bottom;});
}
function filteredVisibleLines(){
  return filterTextLines(visibleTextLineRects());
}
function filteredDocumentLines(){
  return filterTextLines(documentTextLineRects());
}
function firstDocumentLineAfter(y){
  var lines=filteredDocumentLines();
  for(var i=0;i<lines.length;i++){
    if(lines[i].top>=y-1)return lines[i];
  }
  return null;
}
function scrollTargetFromVisibleLines(dir){
  var sp=scrollPort();
  if(!pager||!root||!sp)return null;
  var cur=sp.scrollTop||0;
  return scrollNextTopFromDocument(cur,dir);
}
function scrollSliceFromStartIndex(items,startIdx){
  var sp=scrollPort();
  if(!sp||!items||!items.length)return null;
  startIdx=Math.max(0,Math.min(items.length-1,startIdx||0));
  var viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  var maxTop=scrollMaxTop();
  var navMaxTop=items.length?readableNavMaxTop(items,maxTop):maxTop;
  var bottomGuard=Math.max(2,Math.ceil(lineHeightPx()*0.08));
  var aligned=scrollAlignedPageStart(items,startIdx,navMaxTop,0);
  startIdx=aligned.startIdx;
  var pageTop=aligned.pageTop;
  var hardBottom=pageTop+viewH-bottomGuard;
  var endIdx=startIdx-1;
  for(var i=startIdx;i<items.length;i++){
    if(items[i].bottom<=hardBottom+0.5){endIdx=i;continue;}
    break;
  }
  if(endIdx<startIdx)endIdx=startIdx;
  var rawNextIdx=endIdx+1;
  var pageBottom=pageBottomForSlice(pageTop,viewH,items[endIdx],items[rawNextIdx],bottomGuard);
  var nextIdx=firstUnfinishedScrollItemIndex(items,startIdx,pageBottom);
  if(nextIdx<=startIdx)nextIdx=Math.max(rawNextIdx,startIdx+1);
  return {top:pageTop,bottom:pageBottom,index:pageIndexForScrollTop(pageTop),startIndex:startIdx,endIndex:endIdx,nextIndex:nextIdx,end:nextIdx>=items.length};
}
function firstVisibleScrollItemIndex(items,top){
  if(!items||!items.length)return -1;
  var eps=Math.max(2,Math.ceil(lineHeightPx()*0.12));
  for(var i=0;i<items.length;i++)if(items[i].bottom>top+eps)return i;
  return items.length-1;
}
function scrollPrevSliceFromVisibleTop(items,top){
  var sp=scrollPort();
  if(!sp||!items||!items.length)return null;
  var firstIdx=firstVisibleScrollItemIndex(items,top);
  if(firstIdx<=0)return null;
  var endIdx=firstIdx-1;
  var viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  var maxTop=scrollMaxTop();
  var navMaxTop=items.length?readableNavMaxTop(items,maxTop):maxTop;
  var bottomGuard=Math.max(2,Math.ceil(lineHeightPx()*0.08));
  var desiredBottom=items[endIdx].bottom+bottomGuard;
  var minTop=desiredBottom-viewH;
  var startIdx=endIdx;
  while(startIdx>0&&items[startIdx-1].top>=minTop-0.5)startIdx--;
  var aligned=scrollAlignedPageStart(items,startIdx,navMaxTop,0);
  startIdx=aligned.startIdx;
  var pageTop=aligned.pageTop;
  var pageBottom=pageBottomForSlice(pageTop,viewH,items[endIdx],items[firstIdx],bottomGuard);
  return {top:pageTop,bottom:pageBottom,index:pageIndexForScrollTop(pageTop),startIndex:startIdx,endIndex:endIdx,nextIndex:firstIdx,end:false};
}
function scrollNextSliceFromVisiblePage(items,top){
  var sp=scrollPort();
  if(!sp||!items||!items.length)return null;
  var firstIdx=firstVisibleScrollItemIndex(items,top);
  if(firstIdx<0)return null;
  var viewH=Math.max(1,sp.clientHeight||window.innerHeight||1);
  var bottomGuard=Math.max(2,Math.ceil(lineHeightPx()*0.08));
  var hardBottom=top+viewH-bottomGuard;
  var endIdx=firstIdx-1;
  for(var i=firstIdx;i<items.length;i++){
    if(items[i].bottom<=hardBottom+0.5){endIdx=i;continue;}
    break;
  }
  if(endIdx<firstIdx)return scrollSliceFromStartIndex(items,firstIdx);
  var rawNextIdx=endIdx+1;
  var pageBottom=pageBottomForSlice(top,viewH,items[endIdx],items[rawNextIdx],bottomGuard);
  var nextIdx=firstUnfinishedScrollItemIndex(items,firstIdx,pageBottom);
  if(nextIdx<=firstIdx)nextIdx=Math.max(rawNextIdx,firstIdx+1);
  if(nextIdx>=items.length)return null;
  return scrollSliceFromStartIndex(items,nextIdx);
}
function scrollSliceForNav(top,dir){
  var items=scrollPageItems();
  if(!items.length)return scrollBreakForNav(top,dir);
  var target=dir<0?scrollPrevSliceFromVisibleTop(items,top):scrollNextSliceFromVisiblePage(items,top);
  return target||scrollBreakForNav(top,dir);
}
function scrollPageBy(dir){
  if(!isScrollMode()||!pager)return false;
  var sp=scrollPort();
  if(!sp)return false;
  var wasPaged=scrollPagedView;
  buildScrollBreaks(false);
  var cur=sp.scrollTop||0;
  var aligned=false;
  if(wasPaged&&scrollBreaks.length){
    var idx=pageIndexForScrollTop(cur);
    var breakTop=Math.round(scrollBreaks[idx]||0);
    aligned=Math.abs(breakTop-Math.round(cur))<=Math.max(3,Math.ceil(lineHeightPx()*0.20));
  }
  var target=(wasPaged&&aligned)?canonicalScrollSliceForNav(cur,dir):scrollSliceForNav(cur,dir);
  scrollPagedView=true;
  if(!target){
    if(dir>0&&curCh<CH-1){beginTurnFx(dir,function(){showChapter(curCh+1,'start');});return true;}
    if(dir<0&&curCh>0){beginTurnFx(dir,function(){showChapter(curCh-1,'end');});return true;}
    return true;
  }
  var next=Math.max(0,Math.min(scrollMaxTop(),Math.round(target.top||0)));
  if(Math.abs(next-cur)<2){
    if(dir>0&&curCh<CH-1&&canLeaveScrollChapter(1)){
      beginTurnFx(dir,function(){showChapter(curCh+1,'start');});
      return true;
    }
    if(dir<0&&curCh>0&&canLeaveScrollChapter(-1)){
      beginTurnFx(dir,function(){showChapter(curCh-1,'end');});
      return true;
    }
    pageInCh=Math.max(0,Math.min(pagesInCh-1,target.index||0));
    scrollActiveSlice=target;
    scrollProgrammaticTarget=next;
    applyScrollPageMask();
    report();captureAnchor();
    return true;
  }
  beginTurnFx(dir,function(){
    pageInCh=Math.max(0,Math.min(pagesInCh-1,target.index||0));
    scrollActiveSlice=target;
    scrollProgrammaticUntil=Date.now()+180;
    scrollProgrammaticTarget=next;
    sp.scrollTop=next;
    updateScrollPageAfterProgrammatic();
  });
  return true;
}
function pageOf(el){
  var r=el.getBoundingClientRect(),pr=viewRect();
  if(usesLineBreakPaging()){
    var y=r.top-pr.top+(scrollPort()?scrollPort().scrollTop:0);
    buildScrollBreaks();
    return pageIndexForScrollTop(y);
  }
  var x=r.left-pr.left+viewOffset;return Math.floor((x+1)/pageStep);
}
function invalidateScrollBreaksSoon(){
  if(!isScrollMode())return;
  scrollBreakSig='';
  invalidateScrollItemsCache();
  setTimeout(function(){
    if(!isScrollMode()||!root||!scrollPort())return;
    buildScrollBreaks(true);
    pageInCh=pageIndexForScrollTop(scrollPort().scrollTop||0);
    report();
  },80);
}
function refreshLayoutAfterMedia(){
  invalidateScrollBreaksSoon();
  setTimeout(schedulePagedImagePreview,0);
}
function watchFlowMedia(){
  if(!root)return;
  var imgs=root.querySelectorAll('img,svg,canvas,video');
  for(var i=0;i<imgs.length;i++){
    var el=imgs[i];
    if(el.__kpFlowWatch)continue;
    el.__kpFlowWatch=1;
    el.addEventListener('load',refreshLayoutAfterMedia,{once:false});
    el.addEventListener('error',refreshLayoutAfterMedia,{once:false});
  }
}
function markNoteSeparators(){
  if(!root)return;
  if(!root.querySelector('hr'))return;
  var els=Array.prototype.slice.call(root.querySelectorAll('*'));
  var noteMark=/^(?:[\[\(（]?\d+[\]\)）\.．、\s]|[①②③④⑤⑥⑦⑧⑨⑩])/;
  for(var i=0;i<els.length;i++){
    var hr=els[i];
    if((hr.tagName||'').toLowerCase()!=='hr')continue;
    var next=null;
    for(var j=i+1;j<els.length;j++){
      if(hr.contains(els[j]))continue;
      var txt=(els[j].textContent||'').replace(/\s+/g,' ').trim();
      if(txt){next=els[j];break;}
    }
    if(!next)continue;
    var meta=((hr.id||'')+' '+(hr.className||'')+' '+(hr.getAttribute('epub:type')||'')+' '+(next.id||'')+' '+(next.className||'')+' '+(next.getAttribute('epub:type')||'')).toLowerCase();
    var nextText=(next.textContent||'').replace(/\s+/g,' ').trim();
    if(/footnote|endnote|note|annotation|fn|注|註/.test(meta)||noteMark.test(nextText)){
      hr.classList.add('rr-note-sep');
    }
  }
}
function isExistingNoteNumberText(text){
  return /^(?:\s*(?:\d{1,3}[\.\、．)]|[\(（]\d{1,3}[\)）]|[①②③④⑤⑥⑦⑧⑨⑩]))/.test(text||'');
}
function noteEntryText(el){
  return (el&&el.textContent||'').replace(/\s+/g,' ').trim();
}
function isNoteEntryElement(el){
  if(!el||el.nodeType!==1)return false;
  if(el.classList&&(el.classList.contains('rr-end')||el.classList.contains('rr-note-num')))return false;
  var tag=(el.tagName||'').toLowerCase();
  if(tag==='script'||tag==='style'||tag==='hr')return false;
  if(!noteEntryText(el))return false;
  return /^(p|li|dd|dt|a|div|blockquote|aside|section)$/i.test(tag);
}
function directNoteEntries(container){
  var out=[];
  if(!container||!container.children)return out;
  for(var i=0;i<container.children.length;i++){
    var child=container.children[i];
    if(isNoteEntryElement(child))out.push(child);
  }
  return out;
}
function isNoteListElement(el){
  if(!el||el.nodeType!==1)return false;
  var tag=(el.tagName||'').toLowerCase();
  return tag==='ol'||tag==='ul';
}
function directListNoteItems(list){
  var out=[];
  if(!list||!list.children)return out;
  for(var i=0;i<list.children.length;i++){
    var child=list.children[i];
    if((child.tagName||'').toLowerCase()==='li'&&noteEntryText(child))out.push(child);
  }
  return out;
}
function addNoteNumber(el,num){
  if(!el||el.nodeType!==1||el.getAttribute('data-rr-note-numbered'))return false;
  var txt=noteEntryText(el);
  if(!txt)return false;
  el.setAttribute('data-rr-note-numbered','1');
  if(isExistingNoteNumberText(txt))return true;
  var span=document.createElement('span');
  span.className='rr-note-num';
  span.textContent=num+'.';
  el.insertBefore(span,el.firstChild);
  return true;
}
function wrapNoteListItemBody(li){
  if(!li)return;
  for(var i=0;i<li.children.length;i++){
    if(li.children[i].classList&&li.children[i].classList.contains('rr-note-body'))return;
  }
  var body=document.createElement('div');
  body.className='rr-note-body';
  while(li.firstChild)body.appendChild(li.firstChild);
  li.appendChild(body);
}
function numberBrSeparatedNotes(el,num){
  if(!el||!el.childNodes||el.getAttribute('data-rr-note-br-numbered'))return num;
  var brs=el.querySelectorAll?el.querySelectorAll('br').length:0;
  if(brs<1)return num;
  var segs=[],start=null,txt='';
  function closeSeg(){
    var t=(txt||'').replace(/\s+/g,' ').trim();
    if(start&&t)segs.push({node:start,text:t});
    start=null;txt='';
  }
  for(var i=0;i<el.childNodes.length;i++){
    var nd=el.childNodes[i];
    if(nd.nodeType===1&&(nd.tagName||'').toLowerCase()==='br'){closeSeg();continue;}
    var t=nd.textContent||'';
    if(!t.replace(/\s+/g,''))continue;
    if(!start)start=nd;
    txt+=t;
  }
  closeSeg();
  if(segs.length<2)return num;
  el.setAttribute('data-rr-note-br-numbered','1');
  for(var j=0;j<segs.length;j++){
    if(!isExistingNoteNumberText(segs[j].text)){
      var span=document.createElement('span');
      span.className='rr-note-num';
      span.textContent=num+'.';
      el.insertBefore(span,segs[j].node);
    }
    num++;
  }
  return num;
}
function numberListNotes(list,num){
  if(!isNoteListElement(list)||list.getAttribute('data-rr-note-list-numbered'))return num;
  var items=directListNoteItems(list);
  if(!items.length)return num;
  list.setAttribute('data-rr-note-list-numbered','1');
  list.classList.add('rr-note-list');
  list.style.listStyleType='none';
  list.style.listStylePosition='inside';
  list.style.marginLeft='0';
  list.style.paddingLeft='0';
  for(var i=0;i<items.length;i++){
    wrapNoteListItemBody(items[i]);
    items[i].style.listStyleType='none';
    items[i].style.marginLeft='0';
    items[i].style.paddingLeft='0';
    if(addNoteNumber(items[i],num))num++;
  }
  return num;
}
var noteNumbersReady=false,noteNumberDisplayRefreshPending=false;
function numberEndNotes(){
  if(!root)return;
  var seps=Array.prototype.slice.call(root.querySelectorAll('hr.rr-note-sep'));
  for(var si=0;si<seps.length;si++){
    var n=1,el=seps[si].nextElementSibling;
    while(el&&!(el.classList&&el.classList.contains('rr-end'))){
      var next=el.nextElementSibling;
      if(isNoteListElement(el)){
        n=numberListNotes(el,n);
      }else if(isNoteEntryElement(el)){
        var entries=directNoteEntries(el).filter(function(child){
          return noteEntryText(child).length>0;
        });
        if(entries.length>1){
          for(var i=0;i<entries.length;i++){if(addNoteNumber(entries[i],n))n++;}
        }else{
          var target=entries.length===1?entries[0]:el;
          var nextN=numberBrSeparatedNotes(target,n);
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
function showChapter(i,where,frag){
  i=Math.max(0,Math.min(CH-1,i));
  return fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
    var body=d.body||'';fastChapterLayout=largeChapterFastLayout(body);
    curCh=i;pageInCh=0;scrollBreakSig='';invalidateScrollItemsCache();sourceTextCache=null;scrollBreaks=[0];scrollActiveSlice=null;scrollProgrammaticUntil=Date.now()+180;scrollProgrammaticTarget=0;if(scrollPort())scrollPort().scrollTop=0;if(d.head)injectHead(d.head,headSeen);root.innerHTML=body+'<div class="rr-end"></div>';normalizeInlineNoteRefs();noteNumbersReady=false;ensureNoteNumbers();watchFlowMedia();chapChars=(fastChapterLayout?(root.textContent||''):sourceTextAround(0,Number.MAX_SAFE_INTEGER,0,0)).replace(/\s/g,'').length;applyStyle();applyCols();clearHighlights();
    return new Promise(function(resolve){
      requestAnimationFrame(function(){requestAnimationFrame(function(){
        if(fastChapterLayout){
          if(!isScrollMode())pagesInCh=fastPagedPageCount(root);
        }else{
          scrollBreakSig='';invalidateScrollItemsCache();applyCols();
        }
        pageInCh=0;
        if(where==='end')pageInCh=pagesInCh-1;else if(typeof where==='number')pageInCh=Math.max(0,Math.min(pagesInCh-1,where));
        if(frag){var el=document.getElementById(frag);if(el)pageInCh=pageOf(el);}
        setViewOffset();refreshHighlights();report();captureAnchor();scheduleNoteNumberDisplayRefresh();resolve();
      });});
    });
  }).catch(function(){});
}
var curTopAnchor=null; // 实时记录的当前页顶部锚点（精确到字符）
// 视口左上角对应的"字符级"锚点。长段落跨多列时，元素级锚点的 left 是段首所在列，
// 会让重排后跳回段首（如金庸全集的超长段落）；用 caret 定位到具体字符即可避免。
function anchorNodeInReader(n){return !!(n&&root&&root.contains(n)&&!generatedTextNode(n));}
function caretRangeInReader(x,y){
  var oldVirtual=null,rng=null;
  if(virtualPage){oldVirtual=virtualPage.style.pointerEvents;virtualPage.style.pointerEvents='none';}
  try{
    if(document.caretRangeFromPoint){rng=document.caretRangeFromPoint(x,y);}
    else if(document.caretPositionFromPoint){var cp=document.caretPositionFromPoint(x,y);if(cp){rng=document.createRange();rng.setStart(cp.offsetNode,cp.offset);rng.collapse(true);}}
  }catch(_){}finally{
    if(virtualPage)virtualPage.style.pointerEvents=oldVirtual;
  }
  return anchorNodeInReader(rng&&rng.startContainer)?rng:null;
}
function topAnchor(){
  var hm=hMargins();
  var x=Math.max(2,hm.l+8), y=Math.max(2,mg(S.marginTop)+8);
  if(isScrollMode()&&pager){
    var pr=viewRect();
    // viewRect() 已经是扣除阅读边距后的滚动容器，不能再次加 marginLeft/marginTop。
    x=Math.max(2,pr.left+8);
    y=Math.max(2,pr.top+8);
  }
  var rng=caretRangeInReader(x,y);
  if(rng){
    try{var n=rng.startContainer,o=rng.startOffset;if(n.nodeType===3&&o<n.nodeValue.length)rng.setEnd(n,o+1);if(anchorNodeInReader(n))return {range:rng};}catch(e){}
  }
  var el=document.elementFromPoint(x,y);
  while(el&&el!==root&&el.nodeType===1){ if(anchorNodeInReader(el)&&(el.textContent||'').trim()) return {el:el}; el=el.parentNode; }
  var media=topVisibleOriginalMedia();
  if(media)return {el:media,media:true};
  return null;
}
function topVisibleOriginalMedia(){
  if(!root||!pager)return null;
  var pr=viewRect(),topBand=pr.top+Math.max(48,lineHeightPx()*2.2);
  var media=root.querySelectorAll('img,svg,canvas,video');
  var best=null,bestTop=Number.POSITIVE_INFINITY;
  for(var i=0;i<media.length;i++){
    var el=media[i];
    if(el.closest&&el.closest('sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap'))continue;
    var r=null;try{r=el.getBoundingClientRect();}catch(_){r=null;}
    if(!r||r.width<80||r.height<80||r.bottom<=pr.top+8||r.top>=pr.bottom-8||r.top>topBand)continue;
    if(r.top<bestTop){best=el;bestTop=r.top;}
  }
  return best;
}
function anchorValid(a){
  if(!a)return false;
  if(a.range){return anchorNodeInReader(a.range.startContainer);}
  if(a.el){return anchorNodeInReader(a.el);}
  return false;
}
function anchorTextOffset(a){
  if(!anchorValid(a))return null;
  if(a.media)return null;
  if(a.range)return sourceBoundaryOffset(a.range.startContainer,a.range.startOffset);
  var node=a.el;
  if(!node)return null;
  var range=document.createRange();
  try{range.selectNodeContents(node);range.collapse(true);}catch(_){return null;}
  return sourceBoundaryOffset(range.startContainer,range.startOffset);
}
function anchorPage(a){
  if(!anchorValid(a))return pageInCh;
  var r=null;
  if(a.range){var rs=a.range.getClientRects();r=rs&&rs.length?rs[0]:a.range.getBoundingClientRect();}
  else if(a.el){ r=a.el.getBoundingClientRect(); }
  if(!r)return pageInCh;
  var pr=viewRect();
  if(usesLineBreakPaging()){
    var y=r.top-pr.top+(scrollPort()?scrollPort().scrollTop:0);
    buildScrollBreaks();
    return pageIndexForScrollTop(y);
  }
  var x=r.left-pr.left+viewOffset;
  return Math.max(0,Math.min(pagesInCh-1,Math.floor((x+1)/pageStep)));
}
function anchorRect(a){
  if(!anchorValid(a))return null;
  var r=null;
  try{
    if(a.range){
      r=a.range.getBoundingClientRect();
      if(r&&!r.width&&!r.height&&!r.left&&!r.top){var rs=a.range.getClientRects();if(rs&&rs.length)r=rs[0];}
    }else if(a.el){
      r=a.el.getBoundingClientRect();
    }
  }catch(_){r=null;}
  return r;
}
function restoreScrollAnchorToBreak(anchor){
  if(!anchor||!isScrollMode()||!pager)return false;
  var sp=scrollPort();
  if(!sp)return false;
  var r=anchorRect(anchor);
  if(!r)return false;
  buildScrollBreaks(false);
  var pr=viewRect();
  var y=r.top-pr.top+(sp.scrollTop||0);
  var idx=pageIndexForScrollTop(y);
  idx=Math.max(0,Math.min(scrollBreaks.length-1,idx));
  var top=Math.max(0,Math.min(scrollMaxTop(),scrollBreaks[idx]||0));
  pageInCh=idx;
  scrollActiveSlice=scrollPages[idx]||null;
  scrollProgrammaticUntil=Date.now()+180;
  scrollProgrammaticTarget=top;
  sp.scrollTop=top;
  applyScrollPageMask();
  return true;
}
function restoreScrollAnchorExact(anchor,offset){
  if(!anchor||!isScrollMode()||!pager)return false;
  var sp=scrollPort();
  if(!sp)return false;
  var r=anchorRect(anchor);
  if(!r)return false;
  buildScrollBreaks(false);
  var pr=viewRect();
  var y=r.top-pr.top+(sp.scrollTop||0);
  var top=Math.max(0,Math.min(scrollMaxTop(),Math.round(y-(offset==null?8:offset))));
  pageInCh=pageIndexForScrollTop(top);
  scrollActiveSlice=null;
  scrollProgrammaticUntil=Date.now()+180;
  scrollProgrammaticTarget=top;
  sp.scrollTop=top;
  applyScrollPageMask();
  return true;
}
function relayout(opts){
  if(!root)return;
  // 用"重排前"就记好的锚点（resize 时浏览器已先重排，临时再取就晚了）
  opts=opts||{};
  var anchor=anchorValid(opts.anchor)?opts.anchor:(anchorValid(curTopAnchor)?curTopAnchor:topAnchor());
  var anchorOffset=opts.anchorOffset;
  if(isScrollMode()){scrollActiveSlice=null;scrollBreakSig='';invalidateScrollItemsCache();}
  applyStyle();applyCols();
  if(anchorOffset!=null){
    var restoredRange=sourceRangeForOffsets(anchorOffset,anchorOffset+1);
    if(restoredRange)anchor={range:restoredRange};
  }
  var restoredScroll=opts.exactScroll?restoreScrollAnchorExact(anchor,opts.scrollOffset):restoreScrollAnchorToBreak(anchor);
  if(!restoredScroll){
    if(anchor){ pageInCh=anchorPage(anchor); }
    else if(pageInCh>pagesInCh-1){ pageInCh=pagesInCh-1; }
    setViewOffset();
  }
  report();
  // 切换分页/滚动时只能沿用切换前的字符锚点；若此处重新取页顶，
  // 整页/滚动两套坐标的取整误差会在每次切换后累积成跳页。
  if(!opts.modeSwitch)captureAnchor();
  scheduleNoteNumberDisplayRefresh();
}
function nextPage(){
  if(usesLineBreakPaging()&&scrollPageBy(1))return;
  if(pageInCh<pagesInCh-1)gotoPage(pageInCh+1,1);else if(curCh<CH-1)beginTurnFx(1,function(){showChapter(curCh+1,'start');});
}
function prevPage(){
  if(usesLineBreakPaging()&&scrollPageBy(-1))return;
  if(pageInCh>0)gotoPage(pageInCh-1,-1);else if(curCh>0)beginTurnFx(-1,function(){showChapter(curCh-1,'end');});
}
function wheelDeltaPx(e){
  var d=Math.abs(e.deltaY)>=Math.abs(e.deltaX)?e.deltaY:e.deltaX;
  if(e.deltaMode===1)d*=lineHeightPx();
  else if(e.deltaMode===2)d*=(pager?pager.clientHeight:window.innerHeight);
  return d;
}
function reveal(){document.body.classList.add('ready');}
