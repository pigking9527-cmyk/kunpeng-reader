// ---- 朗读：Web Speech API + 当前词高亮(CSS Highlight) + 自动翻页/跳章 ----
function ttsPickVoice(){
  var vs=(window.speechSynthesis&&speechSynthesis.getVoices())||[];
  var zh=null;for(var i=0;i<vs.length;i++){if(/zh|chinese|中文|普通话/i.test((vs[i].lang||'')+(vs[i].name||''))){zh=vs[i];break;}}
  ttsVoice=zh||vs[0]||null;return {count:vs.length,zh:!!zh};
}
function ttsBuildChapter(){
  var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
    var p=n.parentNode?n.parentNode.nodeName:'';if(p==='SCRIPT'||p==='STYLE')return NodeFilter.FILTER_REJECT;
    return n.nodeValue&&n.nodeValue.trim()?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;}});
  ttsMap=[];var node,base=0,t='';
  while(node=w.nextNode()){ttsMap.push({node:node,start:base,end:base+node.nodeValue.length});t+=node.nodeValue;base+=node.nodeValue.length;}
  ttsText=t;
  // 切句（中文标点/换行/过长断开），记录每句在全文的起始偏移
  ttsSents=[];var cur='',cb=0;
  for(var i=0;i<t.length;i++){var ch=t[i];cur+=ch;
    if('。！？!?…\n'.indexOf(ch)>=0||cur.length>=120){if(cur.trim())ttsSents.push({text:cur,base:cb});cb=i+1;cur='';}}
  if(cur.trim())ttsSents.push({text:cur,base:cb});
}
function ttsHighlight(gs,len){
  len=len||1;
  var seg=null;for(var i=0;i<ttsMap.length;i++){if(gs>=ttsMap[i].start&&gs<ttsMap[i].end){seg=ttsMap[i];break;}}
  if(!seg)return;var node=seg.node,o=gs-seg.start;
  try{var r=document.createRange();r.setStart(node,o);r.setEnd(node,Math.min(node.nodeValue.length,o+len));
    if(window.CSS&&CSS.highlights)CSS.highlights.set('tts',new Highlight(r));
    var rr=r.getBoundingClientRect(),pr=viewRect();
    var x=rr.left-pr.left+viewOffset,pg=Math.floor((x+1)/pageStep);
    if(pg>=0&&pg<pagesInCh&&pg!==pageInCh)gotoPage(pg);
  }catch(_){}
}
function ttsCurrentOffset(){
  var a=topAnchor();if(a&&a.range){var n=a.range.startContainer,o=a.range.startOffset;
    for(var i=0;i<ttsMap.length;i++){if(ttsMap[i].node===n)return ttsMap[i].start+o;}}
  return 0;
}
function ttsAdvance(edge){ // 本章读完 → 下一章
  if(curCh<CH-1){showChapter(curCh+1,'start').then(function(){if(ttsOn){ttsBuildChapter();if(edge){ttsCache={};ttsPlayIndex(0);}else ttsSpeakFrom(0);}});}else ttsStop();
}
function ttsSpeakFrom(i){ // 系统语音
  if(!ttsOn)return;
  if(i>=ttsSents.length){ttsAdvance(false);return;}
  ttsSi=i;var s=ttsSents[i],u=new SpeechSynthesisUtterance(s.text);
  if(ttsVoice)u.voice=ttsVoice;u.lang='zh-CN';u.rate=ttsRate;
  u.onboundary=function(e){if(e.charIndex!=null)ttsHighlight(s.base+e.charIndex);};
  u.onend=function(){if(ttsOn)ttsSpeakFrom(i+1);};
  speechSynthesis.speak(u);
}
// edge-tts：流水线——边读边预取后两句，句间几乎无缝
function ttsReq(i){
  if(i<0||i>=ttsSents.length)return;
  if(ttsCache[i]!==undefined)return; // null=请求中，对象=已到
  ttsCache[i]=null;
  var rate=Math.round(((S.ttsRate||1)-1)*100);
  parent.postMessage({ttsSynth:{seq:ttsGen,idx:i,text:ttsSents[i].text,voice:S.ttsVoice||'',rate:rate}},'*');
}
function ttsPlayIndex(i){
  if(!ttsOn)return;
  if(i>=ttsSents.length){ttsAdvance(true);return;}
  ttsSi=i;ttsReq(i);ttsReq(i+1);ttsReq(i+2); // 预取后两句
  var c=ttsCache[i];
  if(c&&c.err){ttsPlayIndex(i+1);return;} // 这句取音失败 → 跳过
  if(c)ttsRenderAudio(i,c);else ttsWaiting=i;
}
function ttsRenderAudio(i,a){
  if(!ttsOn)return;ttsWaiting=-1;ttsSi=i;ttsPlayedAny=true;
  var s=ttsSents[i],marks=[],cur=0;
  for(var k=0;k<a.marks.length;k++){var w=a.marks[k].word||'';var idx=w?s.text.indexOf(w,cur):-1;if(idx<0)idx=cur;marks.push({at:a.marks[k].at,off:s.base+idx,len:Math.max(1,w.length)});cur=idx+Math.max(1,w.length);}
  var au=new Audio('data:audio/mpeg;base64,'+a.audio);ttsAudioEl=au;var mi=0;
  au.ontimeupdate=function(){var ms=au.currentTime*1000,hl=-1;for(var k=mi;k<marks.length;k++){if(marks[k].at<=ms)hl=k;else break;}if(hl>=0){mi=hl+1;ttsHighlight(marks[hl].off,marks[hl].len);}};
  au.onended=function(){if(ttsOn)ttsPlayIndex(i+1);};
  au.onerror=function(){if(ttsOn)ttsPlayIndex(i+1);};
  au.play().catch(function(){if(ttsOn)ttsPlayIndex(i+1);});
  ttsReq(i+1);ttsReq(i+2);
}
function ttsIsEdge(){return (S.ttsSource||'edge')==='edge';}
function ttsBegin(){
  parent.postMessage({ttsState:1},'*');
  var off=ttsCurrentOffset(),si=0;
  for(var k=0;k<ttsSents.length;k++){if(ttsSents[k].base+ttsSents[k].text.length>off){si=k;break;}}
  if(ttsIsEdge()){ttsCache={};ttsWaiting=-1;ttsPlayedAny=false;ttsPlayIndex(si);}else ttsSpeakFrom(si);
}
function ttsStart(){
  ttsOn=true;ttsBuildChapter();
  if(ttsIsEdge()){ttsBegin();return;} // 在线音源不需要本地语音
  if(!window.speechSynthesis){parent.postMessage({ttsErr:1},'*');ttsOn=false;return;}
  var pv=ttsPickVoice();
  if(pv.count===0){speechSynthesis.onvoiceschanged=function(){if(ttsOn){var p2=ttsPickVoice();if(!p2.zh)parent.postMessage({ttsNoZh:1},'*');ttsBegin();speechSynthesis.onvoiceschanged=null;}};return;}
  if(!pv.zh)parent.postMessage({ttsNoZh:1},'*');
  ttsBegin();
}
function ttsStop(){
  ttsOn=false;ttsGen++;ttsCache={};ttsWaiting=-1;
  try{speechSynthesis.cancel();}catch(_){}
  if(ttsAudioEl){try{ttsAudioEl.pause();}catch(_){}ttsAudioEl=null;}
  if(window.CSS&&CSS.highlights)CSS.highlights.delete('tts');
  parent.postMessage({ttsState:0},'*');
}
window.addEventListener('message',function(e){
  if(!e.data)return;
  if(e.data.windowDragging!==undefined){setMeasurePaused(!!e.data.windowDragging);}
  if(e.data.settings){
    var prevFlow=S.flowMode,prevPageMode=S.pageMode;
    if(prevFlow==='scroll'){
      scrollPagedView=false;
      clearVirtualPage();clearScrollPreview();
      if(scroller){scroller.style.clipPath='none';scroller.style.webkitClipPath='none';}
    }
    var anchor=topAnchor();
    if(!anchorValid(anchor)&&anchorValid(curTopAnchor))anchor=curTopAnchor;
    if(anchorValid(anchor))curTopAnchor=anchor;
    var anchorOffset=anchorTextOffset(anchor);
    S=Object.assign(S,e.data.settings);
    var flowChanged=prevFlow!==S.flowMode;
    var pageModeChanged=prevPageMode!==S.pageMode;
    if(flowChanged&&isScrollMode())scrollPagedView=false;
    parent.postMessage({layoutBusy:1},'*');
    invalidateMeasure();
    relayout({anchor:anchor,anchorOffset:anchorOffset,exactScroll:flowChanged&&isScrollMode(),scrollOffset:Math.max(8,mg(S.marginTop)+8),modeSwitch:flowChanged||pageModeChanged});
    scheduleMeasure();
  }
  if(e.data.tts){if(e.data.tts==='start')ttsStart();else ttsStop();}
  if(e.data.ttsAudio){var a=e.data.ttsAudio;if(ttsOn&&a.seq===ttsGen){ttsCache[a.idx]=a;if(ttsWaiting===a.idx)ttsRenderAudio(a.idx,a);}}
  if(e.data.ttsAudioErr){var er=e.data.ttsAudioErr;if(ttsOn&&er.seq===ttsGen){ttsCache[er.idx]={err:1};if(ttsWaiting===er.idx){ttsWaiting=-1;if(!ttsPlayedAny){parent.postMessage({ttsErr:er.err||2},'*');ttsStop();}else ttsPlayIndex(er.idx+1);}}}
  if(e.data.overlayOpen!==undefined){overlayOpen=!!e.data.overlayOpen;}
  if(e.data.pageCache){applyPageCache(e.data.pageCache);}
  if(e.data.clearMarks){clearMarksKeepPage();}
  if(e.data.gotoChapter!==undefined){var cf=e.data.chFrac,fr=e.data.frag,sq=e.data.search;showChapter(e.data.gotoChapter,'start',fr).then(function(){if(cf!==undefined&&cf>0)gotoPage(Math.round(cf*(pagesInCh-1)));if(sq)doSearch(sq);});}
  if(e.data.gotoFrac!==undefined){gotoGlobalFrac(e.data.gotoFrac);}
  if(e.data.pageTurn){if(e.data.pageTurn>0)nextPage();else prevPage();}
  if(e.data.reveal){reveal();}
  if(e.data.search!==undefined){doSearch(e.data.search);}
  if(e.data.searchNav){searchNav(e.data.searchNav);}
  if(e.data.vchaps){VC=e.data.vchaps;report();}
  if(e.data.highlights){
    HL=e.data.highlights;refreshHighlights();
    if(isScrollMode()){scrollBreakSig='';invalidateScrollItemsCache();buildScrollBreaks(true);applyScrollPageMask();}
  }
  if(e.data.excerptSaved!==undefined){
    var es=excerptPage&&excerptPage.querySelector?excerptPage.querySelector('.ex-status'):null;
    if(es)es.textContent='已保存到：'+(e.data.excerptSaved||'下载目录');
  }
  if(e.data.excerptSaveError!==undefined){
    var ee=excerptPage&&excerptPage.querySelector?excerptPage.querySelector('.ex-status'):null;
    if(ee)ee.textContent=e.data.excerptSaveError||'保存图片失败';
  }
  if(e.data.editHighlightTextFor!==undefined){var ei=e.data.editHighlightTextFor;setTimeout(function(){if(window.getSelection)window.getSelection().removeAllRanges();showHighlightTextEditor(ei);},40);}
  if(e.data.showHlMenuFor!==undefined){var si=e.data.showHlMenuFor;setTimeout(function(){if(window.getSelection)window.getSelection().removeAllRanges();showHlMenu(si);},40);}
  if(e.data.dictResult!==undefined){showDictResult(e.data.dictResult);}
  if(e.data.translationCredentialStatus!==undefined){
    var cs=e.data.translationCredentialStatus,p=cs&&cs.provider;
    if(p){trCredentialStatus[p]=cs;if(trPop&&trPop.querySelector('.tr-api').value===p){var lbl=translateApiLabel(p),ok=!!cs.configured;trPop.querySelector('.tr-api-id').placeholder=lbl.id+(ok?'（已安全保存，留空沿用）':'');trPop.querySelector('.tr-api-key').placeholder=lbl.key+(ok?'（已安全保存，留空沿用）':'');if(ok&&trText&&trPop.style.display!=='none'&&!trCredentialDirty)requestTranslate();}}
  }
  if(e.data.translationCredentialSaved!==undefined){
    var saved=e.data.translationCredentialSaved,sp=saved&&saved.provider;
    if(sp){trCredentialStatus[sp]=saved;if(trPop&&trPop.querySelector('.tr-api').value===sp){if(saved.configured){trCredentialDirty=false;trPop.querySelector('.tr-api-id').value='';trPop.querySelector('.tr-api-key').value='';var sl=translateApiLabel(sp);trPop.querySelector('.tr-api-id').placeholder=sl.id+'（已安全保存，留空沿用）';trPop.querySelector('.tr-api-key').placeholder=sl.key+'（已安全保存，留空沿用）';if(trText&&trPop.style.display!=='none')requestTranslate();}else{var sd=trPop.querySelector('.tr-dst');sd.textContent=saved.error||'保存翻译凭据失败';sd.className='tr-text tr-dst tr-error';placeTranslate();}}}
  }
  if(e.data.translateResult!==undefined){showTranslateResult(e.data.translateResult);}
  if(e.data.gotoHighlight!==undefined){var hi=e.data.gotoHighlight,h=HL[hi];if(h){showChapter(h.chapter,'start').then(function(){var r=highlightRange(hi),rect=null;if(r){try{rect=r.getBoundingClientRect();}catch(_){rect=null;}}if(rect)gotoPage(pageOf({getBoundingClientRect:function(){return rect;}}));});}}
  if(e.data.resolveToc){
    // 在当前章里，找出当前页或之前最近的一个目录锚点
    var frags=e.data.resolveToc,bestFrag=frags.length?frags[0]:'',bestPage=-1;
    for(var i=0;i<frags.length;i++){
      var f=frags[i],pg;
      if(!f){pg=0;}else{var el=document.getElementById(f);if(!el){continue;}pg=pageOf(el);}
      if(pg<=pageInCh&&pg>=bestPage){bestPage=pg;bestFrag=f;}
    }
    parent.postMessage({tocResolved:{chapter:curCh,frag:bestFrag}},'*');
  }
});
var pagedImagePreview=null;
function clearPagedImagePreview(){
  if(!pagedImagePreview)return;
  pagedImagePreview.style.display='none';
  pagedImagePreview.innerHTML='';
}
function ensurePagedImagePreview(){
  if(pagedImagePreview&&pagedImagePreview.isConnected)return pagedImagePreview;
  if(!pager)return null;
  pagedImagePreview=document.getElementById('paged-image-preview');
  if(!pagedImagePreview){
    pagedImagePreview=document.createElement('div');
    pagedImagePreview.id='paged-image-preview';
    pagedImagePreview.style.cssText='position:absolute;display:none;overflow:hidden;pointer-events:none;z-index:2147483636;contain:paint;';
    pager.appendChild(pagedImagePreview);
  }
  return pagedImagePreview;
}
function refreshPagedImagePreview(){
  if(!root||!pager||isScrollMode()||isDualPage()){clearPagedImagePreview();return;}
  var pr=viewRect(),step=pageStep||window.innerWidth||1,current=pageInCh;
  // 大多数页面没有“下一页顶端图片”；先做轻量检查，避免每次翻页都扫描整章字符。
  var hasPreviewCandidate=false,previewImgs=root.querySelectorAll('img');
  for(var pi=0;pi<previewImgs.length;pi++){
    var candidate=previewImgs[pi],candidateRect=null;
    try{candidateRect=candidate.getBoundingClientRect();}catch(_){candidateRect=null;}
    if(!candidateRect||candidateRect.width<20||candidateRect.height<48)continue;
    var candidateLeft=candidateRect.left-pr.left+viewOffset;
    if(Math.floor((candidateLeft+1)/step)!==current+1)continue;
    if(candidateRect.top-pr.top>mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5))continue;
    hasPreviewCandidate=true;
    break;
  }
  if(!hasPreviewCandidate){clearPagedImagePreview();return;}
  var lines=filterTextLines(documentTextLineRects()),last=mg(S.marginTop);
  for(var i=0;i<lines.length;i++){
    var line=lines[i],logicalLeft=line.left+viewOffset;
    if(Math.floor((logicalLeft+1)/step)===current)last=Math.max(last,line.bottom);
  }
  var pageBottom=Math.min(pr.height||viewportHeight(),pagedBoxHeight())-mg(S.marginBottom);
  var free=Math.floor(pageBottom-last-6);
  if(free<32){clearPagedImagePreview();return;}
  var imgs=root.querySelectorAll('img');
  for(var j=0;j<imgs.length;j++){
    var img=imgs[j],r=null;
    try{r=img.getBoundingClientRect();}catch(_){r=null;}
    if(!r||r.width<20||r.height<48)continue;
    var logicalLeft=r.left-pr.left+viewOffset;
    if(Math.floor((logicalLeft+1)/step)!==current+1)continue;
    if(r.top-pr.top>mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5))continue;
    // 当前页可容纳多少就显示多少；下一页仍保留从顶部开始的完整原图。
    var crop=Math.min(free,Math.floor(r.height));
    if(crop<32||crop>=r.height-2)continue;
    var box=ensurePagedImagePreview();
    if(!box)return;
    var clone=clonePreviewElement(img);
    if(!clone){clearPagedImagePreview();return;}
    var left=((logicalLeft%step)+step)%step;
    box.innerHTML='';
    box.style.left=Math.round(left)+'px';
    box.style.top=Math.round(last+4)+'px';
    box.style.width=Math.round(r.width)+'px';
    box.style.height=Math.round(crop)+'px';
    box.style.display='block';
    clone.style.setProperty('width',Math.round(r.width)+'px','important');
    clone.style.setProperty('height',Math.round(r.height)+'px','important');
    clone.style.setProperty('max-width','none','important');
    clone.style.setProperty('max-height','none','important');
    box.appendChild(clone);
    return;
  }
  clearPagedImagePreview();
}
var pagedImagePreviewFrame=0,pagedImagePreviewGeneration=0;
function schedulePagedImagePreview(){
  var generation=++pagedImagePreviewGeneration;
  if(pagedImagePreviewFrame){cancelAnimationFrame(pagedImagePreviewFrame);pagedImagePreviewFrame=0;}
  if(!root||!pager||isScrollMode()||isDualPage()){clearPagedImagePreview();return;}
  // 让页面位移和翻页动画先提交到屏幕，预览测量放到下一帧执行。
  clearPagedImagePreview();
  pagedImagePreviewFrame=requestAnimationFrame(function(){
    pagedImagePreviewFrame=0;
    if(generation!==pagedImagePreviewGeneration)return;
    refreshPagedImagePreview();
  });
}
var baseSetViewOffset=setViewOffset;
setViewOffset=function(){baseSetViewOffset();schedulePagedImagePreview();};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
