// ---- 全书页数：增量测量、缓存与加载状态 ----
// 右上角的全书页数、进度滑块都依赖这个后台测量。
// 测量结果按章增量缓存，超大书即使中途退出也不会从头再来。
var measurer,chapterPages=[],measureDone=false,measureToken=0,measureTimer=null,pageSig='',measurePaused=false;
var fullBookMeasureEnabled=true;

function measureChapterPages(html){
  if(!measurer)return 1;
  var vw=window.innerWidth,vh=pagedBoxHeight(),pl=pageCountLayout();
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
      i++;if(i%4===0)publishPageCache(false);setTimeout(step,16);
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
