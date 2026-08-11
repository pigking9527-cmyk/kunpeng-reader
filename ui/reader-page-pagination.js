// ---- 分页几何：单页/双页判定、版式签名与页数换算 ----
// 此文件与 reader-page-layout.js 在编译期拼成同一个 <script>；
// 保留原有全局函数名，让阅读页其余模块无需改变调用方式。
function isScrollMode(){return S.flowMode==='scroll';}
function isDualPage(){return !isScrollMode()&&S.pageMode==='dual'&&window.innerWidth>=900;}
function isLinePagedMode(){return false;}
function usesLineBreakPaging(){return isScrollMode();}
function columnsPerView(){return isDualPage()?2:1;}
function columnPitch(){return window.innerWidth/columnsPerView();}
function fastDualPagedPageCount(el){
  if(!el)return 1;
  var base=el.getBoundingClientRect().left,pl=pageLayout(),right=0;
  // 大章节不逐字扫描整章；只读取末尾可见正文块的行矩形。scrollWidth 会把
  // rr-end 的强制空栏算进去，双页模式因此可能凭空多出一整个 spread。
  var blocks=el.querySelectorAll('p,li,blockquote,h1,h2,h3,h4,h5,h6,pre,figure,img,svg,canvas,table');
  for(var i=blocks.length-1;i>=0&&right<1;i--){
    var block=blocks[i];
    if(block.closest&&block.closest('.rr-end,.rr-dual-continuation'))continue;
    var range=document.createRange(),rects=[];
    try{range.selectNodeContents(block);rects=range.getClientRects();}catch(_){rects=block.getClientRects();}
    for(var j=0;j<rects.length;j++)if(rects[j].width>0&&rects[j].height>0)right=Math.max(right,rects[j].right-base);
  }
  var physical=right>0?Math.max(1,Math.ceil((right+1)/pl.colPitch)):1;
  var bias=typeof dualStartColumn==='number'?dualStartColumn:0;
  return Math.max(1,Math.ceil(Math.max(1,physical-bias)/2));
}
function fastPagedPageCount(el){
  if(!el)return 1;
  if(isDualPage())return fastDualPagedPageCount(el);
  var hasEnd=!!el.querySelector('.rr-end');
  return columnCountFromWidth(el.scrollWidth||0,hasEnd);
}
// 全书页数按没有打开智读侧栏时的阅读窗口宽度统计。智读只临时压缩正文，
// 不应产生另一套页数缓存；真正调整窗口时由父页面更新此宽度。
var pageCountViewportWidth=Math.max(1,Math.round(window.innerWidth||1));
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
  return {top:top,bottom:bottom,left:pl.l,right:pl.r,height:usable};
}
function pagedBoxHeight(){
  return viewportHeight();
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
function dualPageGapPx(){var v=Math.round(Number(S.dualPageGap));return isFinite(v)?Math.max(0,Math.min(120,v)):40;}
function pageLayout(){
  var vw=window.innerWidth,l=mg(S.marginLeft),r=mg(S.marginRight);
  if(isDualPage()){
    var gap=dualPageGapPx();
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
    var bias=typeof dualStartColumn==='number'?dualStartColumn:0;
    return Math.max(1,Math.ceil(Math.max(1,physical-bias)/2));
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
    var parent=node.parentElement;
    if(parent&&parent.closest&&parent.closest('.rr-end,.rr-dual-continuation'))continue;
    var range=document.createRange();
    try{range.selectNodeContents(node);}catch(e){continue;}
    var rects=range.getClientRects();
    for(var i=0;i<rects.length;i++)addRect(rects[i]);
  }
  // 文本节点上面的 Range 已经给出了真实字形的最右边界。不能再读取 p/li/h*
  // 的盒子：在多栏排版中，段后的 margin 可能单独被推入下一栏，盒子虽存在
  // 却没有任何文字，若把它计入便会在章节末尾虚构一整张空白 spread。
  // 这里仅补充无文本也应占页的真实媒体。
  var els=el.querySelectorAll('img,svg,canvas,video,object,embed,iframe');
  for(var j=0;j<els.length;j++){
    if(els[j].closest&&els[j].closest('.rr-end,.rr-dual-continuation'))continue;
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
  var bias=typeof dualStartColumn==='number'?dualStartColumn:0;
  return isDualPage()?Math.max(1,Math.ceil(Math.max(1,physical-bias)/2)):physical;
}
// 浏览器的 column flow 偶尔会在正文之后留下只含段距或强制换栏标记的列。
// 几何宽度会把这些列算进去，但用户实际看到的是整张空白页。按真实文字行和
// 非文本媒体逐页复核末尾，可作为所有页数估算路径的最终兜底。
function pagedViewHasVisibleContent(el,index){
  if(!el||isScrollMode())return true;
  var base=el.getBoundingClientRect().left,pl=pageLayout();
  var start=isDualPage()?index*2+(typeof dualStartColumn==='number'?dualStartColumn:0):index;
  var width=isDualPage()?pl.colPitch:pl.pageStep;
  var count=isDualPage()?2:1;
  function inView(r){
    if(!r||r.width<1||r.height<3)return false;
    var column=Math.floor((r.left-base+1)/width);
    return column>=start&&column<start+count;
  }
  var walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    var parent=node.parentElement;
    if(parent&&parent.closest&&parent.closest('.rr-end,.rr-dual-continuation'))continue;
    var range=document.createRange();
    try{range.selectNodeContents(node);}catch(_){continue;}
    var rects=range.getClientRects();
    for(var i=0;i<rects.length;i++)if(inView(rects[i]))return true;
  }
  var media=el.querySelectorAll('img,svg,canvas,video,object,embed,iframe');
  for(var j=0;j<media.length;j++){
    if(media[j].closest&&media[j].closest('.rr-end,.rr-dual-continuation'))continue;
    var mediaRects=media[j].getClientRects();
    for(var k=0;k<mediaRects.length;k++)if(inView(mediaRects[k]))return true;
  }
  return false;
}
function trimTrailingBlankPagedViews(el,count){
  var pages=Math.max(1,Math.floor(Number(count)||1));
  while(pages>1&&!pagedViewHasVisibleContent(el,pages-1))pages--;
  return pages;
}
function pageCountLayout(){
  var vw=pageCountWidth(),l=mg(S.marginLeft),r=mg(S.marginRight);
  var maxTotal=Math.max(0,vw-160);
  if(l+r>maxTotal&&l+r>0){
    var s=maxTotal/(l+r);l=Math.floor(l*s);r=Math.floor(r*s);
  }
  return {width:vw,colW:Math.max(100,vw-l-r),gap:l+r,pageStep:vw};
}
function pageCountFromMeasuredContent(el){
  var extent=contentRectExtent(el),pl=pageCountLayout();
  if(extent<2)return 1;
  return Math.max(1,Math.ceil((extent+1)/pl.pageStep));
}

// 单页/双页切换使用字符锚点，而不是把旧页码按二换算。若锚点在标准
// spread 的右栏，则把该物理栏作为新双页的左栏，避免视口向前跳一整页。
function anchorPage(a){
  if(!anchorValid(a))return pageInCh;
  var r=null;
  if(a.range){var rs=a.range.getClientRects();r=rs&&rs.length?rs[0]:a.range.getBoundingClientRect();}
  else if(a.el)r=a.el.getBoundingClientRect();
  if(!r)return pageInCh;
  var pr=viewRect();
  if(usesLineBreakPaging()){
    var y=r.top-pr.top+(scrollPort()?scrollPort().scrollTop:0);
    buildScrollBreaks();
    return pageIndexForScrollTop(y);
  }
  var x=r.left-pr.left+viewOffset;
  if(isDualPage()){
    var pl=pageLayout(),physical=Math.max(0,Math.floor((x-pl.l+1)/pl.colPitch));
    return Math.max(0,Math.min(pagesInCh-1,Math.floor(Math.max(0,physical-dualStartColumn)/2)));
  }
  return Math.max(0,Math.min(pagesInCh-1,Math.floor((x+1)/pageStep)));
}
function alignDualAnchorToLeftPage(a){
  if(!isDualPage()||!anchorValid(a))return false;
  var r=anchorRect(a),pr=viewRect(),pl=pageLayout();
  if(!r)return false;
  var x=r.left-pr.left+viewOffset-pl.l;
  var physical=Math.max(0,Math.floor((x+1)/pl.colPitch));
  dualStartColumn=physical%2;
  pagesInCh=fastChapterLayout?fastPagedPageCount(root):pagedPageCountFromContent(root);
  if(!fastChapterLayout)pagesInCh=trimTrailingBlankPagedViews(root,pagesInCh);
  pageInCh=Math.max(0,Math.min(pagesInCh-1,Math.floor((physical-dualStartColumn)/2)));
  return true;
}
