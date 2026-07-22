// ---- 分页几何：单页/双页判定、版式签名与页数换算 ----
// 此文件与 reader-page-layout.js 在编译期拼成同一个 <script>；
// 保留原有全局函数名，让阅读页其余模块无需改变调用方式。
function isScrollMode(){return S.flowMode==='scroll';}
function isDualPage(){return !isScrollMode()&&S.pageMode==='dual'&&window.innerWidth>=900;}
function isLinePagedMode(){return false;}
function usesLineBreakPaging(){return isScrollMode();}
function columnsPerView(){return isDualPage()?2:1;}
function columnPitch(){return window.innerWidth/columnsPerView();}
// 版式签名：窗口尺寸+字体/字号/行距/段距/字间距/页边距必须一致。
function layoutSig(){return [window.innerWidth,viewportHeight(),S.styleMode,S.fontSize,S.noteFontSize,S.lineHeight,S.paraSpacing,S.letterSpacing,S.fontFamily,S.marginTop,S.marginBottom,S.marginLeft,S.marginRight,S.pageMode,S.flowMode].join('|');}
// 书籍总页数以单页版式为基准：双页只改变一次展示几页，不能把总页数除以二。
// 因此页数缓存不包含 pageMode；滚动模式的页高口径不同，仍独立缓存。
function pageCountSig(){return [window.innerWidth,viewportHeight(),S.styleMode,S.fontSize,S.noteFontSize,S.lineHeight,S.paraSpacing,S.letterSpacing,S.fontFamily,S.marginTop,S.marginBottom,S.marginLeft,S.marginRight,S.flowMode].join('|');}

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
function pageCountLayout(){
  var vw=window.innerWidth,l=mg(S.marginLeft),r=mg(S.marginRight);
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
