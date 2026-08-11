// ---- 全书页数：增量测量、缓存与加载状态 ----
// 右上角的全书页数、进度滑块都依赖这个后台测量。
// 测量结果按章增量缓存，超大书即使中途退出也不会从头再来。
var measurer,chapterPages=[],measureDone=false,measureToken=0,measureTimer=null,pageSig='',measurePaused=false;
var fullBookMeasureEnabled=true;

function fastTextRangeNeedsChunks(rects){
  var limit=Math.max(24,lineHeightPx()*2.4),seen=0;
  for(var i=0;i<(rects?rects.length:0);i++){
    var r=rects[i];
    if(!r||r.width<1||r.height<3)continue;
    seen++;
    if(r.height>limit)return true;
  }
  return seen===0;
}
function appendFastRangeRects(out,node,rects,pr,scrollTop){
  for(var i=0;i<(rects?rects.length:0);i++){
    var r=rects[i];
    if(!r||r.width<1||r.height<3)continue;
    out.push({top:r.top-pr.top+scrollTop,bottom:r.bottom-pr.top+scrollTop,height:r.height,left:r.left-pr.left,right:r.right-pr.left,fragments:[],flowNodes:[node]});
  }
}
function appendFastTextRangeLines(out,node,range,start,end,pr,scrollTop){
  var rects=[];
  try{range.setStart(node,start);range.setEnd(node,end);rects=range.getClientRects();}catch(_){return;}
  if(!fastTextRangeNeedsChunks(rects)){appendFastRangeRects(out,node,rects,pr,scrollTop);return;}
  // 极少数电子书会把每个 192 字片段也合成一个高矩形；仅对该小片段退回逐字
  // 测量，确保页面可读，而不会把整章都变成逐字扫描。
  for(var i=start;i<end;i++){
    try{range.setStart(node,i);range.setEnd(node,i+1);rects=range.getClientRects();}catch(_){continue;}
    appendFastRangeRects(out,node,rects,pr,scrollTop);
  }
}
function imagePreviewGapPx(){return 4;}
function primaryCharacterRect(rects){
  if(!rects||!rects.length)return null;
  var best=null,bestScore=-1;
  for(var i=0;i<rects.length;i++){
    var r=rects[i];
    if(!r||r.height<3)continue;
    var score=Math.max(0,r.width)*r.height;
    // 行尾换行字符在 WKWebView 中可能同时返回“上一行零宽占位矩形”和
    // “下一行真实字形矩形”。每个字符只能采用面积最大的那个矩形。
    if(score>bestScore){best=r;bestScore=score;}
  }
  return best;
}
// 大章节的全章分页只测量文本节点的整行矩形，避免 WKWebView 逐字扫描卡顿。
// 真正显示某一页时，只对与该页相交的文本节点做逐字测量，既保留快速打开，
// 又能构造不含下一页首行的完整文字图层。
function exactTextLineItemsForBand(bandTop,bandBottom){
  if(!root||!pager)return [];
  var pr=viewRect(),sp=scrollPort(),scrollTop=sp?sp.scrollTop||0:0;
  var linesByKey={},keys=[],styleCache=new WeakMap();
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node,range=document.createRange(),docPos=0;
  var extra=Math.max(4,lineHeightPx()*0.25);
  while((node=walker.nextNode())){
    var text=node.nodeValue||'';
    var parent=node.parentElement;
    if(!parent||generatedTextNode(node)||closestInlineNoteElement(node))continue;
    var nodeStart=docPos;docPos+=text.length;
    if(!text.trim())continue;
    var pcs=window.getComputedStyle(parent);
    if(pcs.display==='none'||pcs.visibility==='hidden')continue;
    var nodeVisible=false;
    try{
      range.selectNodeContents(node);
      var nodeRects=range.getClientRects();
      for(var nri=0;nri<nodeRects.length;nri++){
        var nr=nodeRects[nri],nt=nr.top-pr.top+scrollTop,nb=nr.bottom-pr.top+scrollTop;
        if(nb>=bandTop-extra&&nt<=bandBottom+extra){nodeVisible=true;break;}
      }
    }catch(_){nodeVisible=false;}
    if(!nodeVisible)continue;
    var style=computedLineStyleForNode(node,styleCache);
    for(var i=0;i<text.length;i++){
      var ch=text.charAt(i);
      if(ch==='\r'||ch==='\n'||ch==='\t')continue;
      try{range.setStart(node,i);range.setEnd(node,i+1);}catch(e){continue;}
      var rects=range.getClientRects();
      if(!rects||!rects.length)continue;
      var r=primaryCharacterRect(rects);
      if(!r)continue;
      var top=r.top-pr.top+scrollTop,bottom=r.bottom-pr.top+scrollTop;
      if(bottom<bandTop-extra||top>bandBottom+extra||r.width<0.1&&!ch.trim())continue;
      appendMeasuredCharLine(linesByKey,keys,node,ch,r,pr,scrollTop,style,nodeStart+i);
    }
  }
  var noteEls=root.querySelectorAll('.rr-note-ref,a,sup,sub,span'),seenNotes=new WeakSet();
  for(var ne=0;ne<noteEls.length;ne++){
    var noteEl=closestInlineNoteElement(noteEls[ne]);
    if(!noteEl||seenNotes.has(noteEl))continue;
    seenNotes.add(noteEl);
    var ncs=window.getComputedStyle(noteEl);
    if(ncs.display==='none'||ncs.visibility==='hidden')continue;
    var nrect=null;try{nrect=noteEl.getBoundingClientRect();}catch(_){nrect=null;}
    if(!nrect||nrect.width<1||nrect.height<3)continue;
    var ntop=nrect.top-pr.top+scrollTop,nbottom=nrect.bottom-pr.top+scrollTop;
    if(nbottom<bandTop-extra||ntop>bandBottom+extra)continue;
    appendMeasuredInlineLine(linesByKey,keys,noteEl,nrect,pr,scrollTop);
  }
  var out=keys.map(function(k){return linesByKey[k];}).sort(function(a,b){return a.top-b.top||a.left-b.left;});
  for(var j=0;j<out.length;j++)out[j].fragments.sort(function(a,b){return a.top-b.top||a.left-b.left;});
  return filterTextLines(out).map(function(line,idx){
    return {top:line.top,bottom:line.bottom,height:line.height,type:'line',index:idx,left:line.left,right:line.right,fragments:line.fragments||[],flowNodes:line.flowNodes||[]};
  });
}

function measureChapterPages(html){
  if(!measurer)return 1;
  var vw=pageCountWidth(),vh=pagedBoxHeight(),pl=pageCountLayout();
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
  measurer.style.minHeight='';
  measurer.style.height=vh+'px';
  measurer.style.width=vw+'px';
  measurer.style.columnWidth=pl.colW+'px';
  measurer.style.columnCount='auto';
  measurer.style.columnGap=pl.gap+'px';
  measurer.innerHTML=html;
  return pageCountFromMeasuredContent(measurer);
}
function publishPageCache(complete){
  if(!pageSig||chapterPages.length!==CH)return;
  parent.postMessage({pageCache:{sig:pageSig,pages:chapterPages.slice(),complete:!!complete}},'*');
}
function measureAll(){
  if(!fullBookMeasureEnabled)return;
  if(measurePaused){perfLog('measure.skip','paused-before-start');scheduleMeasure(900);return;}
  if(measureDone&&pageSig===pageCountSig())return; // 版式没变、已有页数 → 不重算
  var sig=pageCountSig();
  // 版式相同的未完成缓存保留已经测过的章节；只有版式变化时才整本失效。
  if(pageSig!==sig||chapterPages.length!==CH)chapterPages=new Array(CH).fill(0);
  pageSig=sig;measureDone=false;
  var tok=++measureToken;
  var i=0,tAll=performance.now();
  perfLog('measure.start','chapters='+CH);
  function step(){
    if(tok!==measureToken)return;
    while(i<CH&&chapterPages[i]>0)i++;
    if(measurePaused){perfLog('measure.pause','chapter='+i);scheduleMeasure(900);return;}
    if(i>=CH){if(measurer)measurer.innerHTML='';measureDone=true;report();
      perfLog('measure.end','chapters='+CH+' dt='+(performance.now()-tAll).toFixed(1)+'ms');
      publishPageCache(true);return;}
    var tStep=performance.now(),idx=i;
    fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
      if(tok!==measureToken)return;if(measurePaused){perfLog('measure.pause','chapter='+idx+' after-fetch');scheduleMeasure(900);return;}chapterPages[i]=measureChapterPages(d.body||'');
      var dt=performance.now()-tStep;if(dt>40)perfLog('measure.chapter','chapter='+idx+' dt='+dt.toFixed(1)+'ms html='+(d.body||'').length);
      i++;if(i%4===0)publishPageCache(false);
      // 本地章节读取通常很快，不必每章固定等待一帧；每 8 章或遇到重章时
      // 主动让出一次界面线程，兼顾统计速度与阅读交互响应。
      setTimeout(step,dt>30?16:(i%8===0?8:0));
    }).catch(function(){if(tok!==measureToken)return;if(measurePaused){perfLog('measure.pause','chapter='+idx+' after-error');scheduleMeasure(900);return;}chapterPages[i]=1;i++;if(i%4===0)publishPageCache(false);setTimeout(step,16);});
  }
  step();
}
// 外壳送来缓存的页数：完整缓存直接采用；未完成缓存从第一个空章继续。
function applyPageCache(pc){
  if(!pc||!pc.pages||pc.pages.length!==CH)return;
  if(pc.sig!==pageCountSig())return; // 版式变了，缓存作废，照常测量
  measureToken++; // 作废可能在跑的测量
  chapterPages=pc.pages.map(function(p){p=Number(p)||0;return p>0?Math.floor(p):0;});
  measureDone=!!pc.complete||chapterPages.every(function(p){return p>0;});pageSig=pc.sig;
  if(measureTimer){clearTimeout(measureTimer);measureTimer=null;}
  report();
  // 回填的完整缓存同样要通知外壳：统一任务中心才能把“统计总页数”
  // 立即标为完成，而不是留下一个没有实际工作的 running 任务。
  if(typeof parent!=='undefined'&&parent.postMessage)publishPageCache(measureDone);
  if(!measureDone)scheduleMeasure(60);
}
function invalidateMeasure(){measureToken++;measureDone=false;pageSig='';chapterPages=new Array(CH).fill(0);}
function scheduleMeasure(delay){if(!fullBookMeasureEnabled)return;if(measureTimer)clearTimeout(measureTimer);measureTimer=setTimeout(measureAll,delay||1200);}
function setMeasurePaused(paused){
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
