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
    var x=rr.left-pr.left+viewOffset,pg;
    if(isDualPage()){
      var pl=pageLayout(),physical=Math.max(0,Math.floor((x-pl.l+1)/pl.colPitch));
      pg=Math.max(0,Math.floor(Math.max(0,physical-dualStartColumn)/2));
    }else pg=Math.floor((x+1)/pageStep);
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
  if(e.data.animationSettings){
    readerAnimationSettingsOverride=Object.assign({},e.data.animationSettings);
    document.documentElement.classList.toggle('anim-highlight-settings-off',!readerAnimationSettingOn('highlightSettings'));
    if(!readerAnimationSettingOn('highlightSettings')&&typeof hlSettingsPop!=='undefined'&&hlSettingsPop)hlSettingsPop.classList.remove('hs-opening');
  }
  if(e.data.windowDragging!==undefined){setMeasurePaused(!!e.data.windowDragging);}
  if(e.data.pageCountTaskControl!==undefined){
    var pageTaskControl=String(e.data.pageCountTaskControl||'');
    if(pageTaskControl==='pause'||pageTaskControl==='cancel')setMeasurePaused(true);
  }
  if(e.data.pageCountViewportWidth!==undefined){
    var nextPageCountWidth=Math.max(1,Math.round(Number(e.data.pageCountViewportWidth)||window.innerWidth||1));
    var oldPageCountSig=pageCountSig();
    pageCountViewportWidth=nextPageCountWidth;
    if(oldPageCountSig!==pageCountSig()){
      invalidateMeasure();
      parent.postMessage({layoutBusy:1},'*');
      scheduleMeasure(60);
    }
  }
  // 智读侧栏是一项独立的阅读区宽度变更事务：先保存不可变的源文本偏移，
  // 父页面改宽度后再发 commit，最终由正文页等待实际宽度稳定后恢复。
  if(e.data.preserveAnchor){
    var sideAnchor=null;
    var sideViewportOffset=8;
    // 若上一轮侧栏开关正在展示锚定临时页，真实 root 位于它下方的完整页首；
    // 此时必须继续使用临时页的起点，不能重新采样被遮住的 root。
    var sideOffset=sideAnchorVirtualOffset!=null?sideAnchorVirtualOffset:null;
    if(sideOffset==null){
      // 固定坐标取 caret 在多栏重排、段首留白或图片旁排版时可能落到下一行。
      // 优先取当前视口里实际最靠上的正文行，保证开关智读前后的第一行一致。
      sideAnchor=visibleTopTextAnchor()||topAnchor();
      if(!anchorValid(sideAnchor)&&anchorValid(curTopAnchor))sideAnchor=curTopAnchor;
      sideOffset=anchorTextOffset(sideAnchor);
      if(anchorValid(sideAnchor)){
        var sideRect=anchorRect(sideAnchor),sideView=viewRect();
        if(sideRect&&sideView)sideViewportOffset=Math.max(0,Math.round(sideRect.top-sideView.top));
      }
    }
    if(sideOffset!=null&&typeof sourceRangeForOffsets==='function'){
      var stableSideRange=sourceRangeForOffsets(sideOffset,sideOffset+1);
      if(stableSideRange)curTopAnchor={range:stableSideRange};
      window.__readerSideViewportTxn={
        id:e.data.aiReaderSideRequestId||0,offset:sideOffset,chapter:curCh,
        viewportOffset:sideViewportOffset,preparedWidth:Math.round(window.innerWidth||0),
        preparedAt:Date.now(),committed:false,finished:false
      };
      if(typeof readerSideViewportDiag==='function')readerSideViewportDiag(window.__readerSideViewportTxn,'prepared');
    }else if(anchorValid(sideAnchor))curTopAnchor=sideAnchor;
    parent.postMessage({readerAnchorReady:1,aiReaderSideRequestId:e.data.aiReaderSideRequestId||0},'*');
  }
  if(e.data.aiReaderSideCommit!==undefined){
    var sideTxn=window.__readerSideViewportTxn;
    if(sideTxn&&sideTxn.id===(e.data.aiReaderSideCommit||0)&&!sideTxn.finished){
      sideTxn.committed=true;
      sideTxn.expectedWidth=Math.round(Number(e.data.aiReaderSideExpectedWidth)||0);
      sideTxn.committedAt=Date.now();
      if(typeof readerSideViewportDiag==='function')readerSideViewportDiag(sideTxn,'committed');
      if(typeof scheduleReaderSideViewportRestore==='function')scheduleReaderSideViewportRestore(sideTxn);
    }
  }
  if(e.data.settings){
    var prevFlow=S.flowMode,prevPageMode=S.pageMode,prevFontFamily=S.fontFamily;
    var nextFlow=e.data.settings.flowMode||prevFlow,nextPageMode=e.data.settings.pageMode||prevPageMode;
    var incomingModeChange=prevFlow!==nextFlow||prevPageMode!==nextPageMode;
    var prevPageCountSig=pageCountSig();
    // 模式切换会清空滚动模式的虚拟页和图片预览层。必须在动这些层之前
    // 记录当前左上角的字符位置；否则 topAnchor() 读到的是清理后的底层正文，
    // 切回整页时就会落到相邻页。只有纯图片页没有字符锚点时，才让图片
    // 预览锚点接管恢复，避免页面下方一张可见图片覆盖正常正文锚点。
    var storedOffsetBefore=anchorTextOffset(curTopAnchor);
    // 用户翻页、滚动停止和跳转后都会由 captureAnchor() 记录当前首行。
    // 多栏正文和滚动分页遮罩仍会给被裁掉的文字返回 getClientRects()，
    // 所以模式切换时重新扫描“可见文字”反而可能得到另一页。诊断日志中
    // storedOffsetBefore=1292 正是截图首行，而几何扫描误报成了 896。
    // 因此已记录的导航锚点是模式互切的唯一首选；只有尚未记录锚点时，
    // 才用即时几何采样和普通 topAnchor() 兜底。
    var anchor=null;
    if(incomingModeChange&&storedOffsetBefore!=null&&anchorValid(curTopAnchor)){
      anchor=curTopAnchor;
    }else if(incomingModeChange&&typeof visibleTopTextAnchor==='function'){
      anchor=visibleTopTextAnchor();
    }
    if(!anchorValid(anchor))anchor=topAnchor();
    // 失败验证只用于本次切换后的诊断，绝不能在下一次切换时覆盖用户
    // 已经翻到的新位置。旧逻辑会把一次失败的 offset 长期粘住：
    // 用户在第二页切换双页，仍被强制拉回上一次失败所在的章首附近。
    modeSwitchRecoveryOffset=null;
    if(!anchorValid(anchor)&&anchorValid(curTopAnchor))anchor=curTopAnchor;
    if(anchorValid(anchor))curTopAnchor=anchor;
    var anchorOffset=anchorTextOffset(anchor);
    var imageAnchor=anchorOffset==null?captureImageVisualAnchor():null;
    // 章节题图是否应与标题一起保留，必须在旧布局仍然可见时判断。
    // 若等到双页重排之后再检查，较宽的新 spread 可能重新露出章首题图，
    // 从而误判当前第二页仍在章首并跳过首行强制对齐。
    var preserveLeadMedia=incomingModeChange&&anchorOffset!=null&&typeof hasVisibleLeadMediaBeforeAnchor==='function'
      ?hasVisibleLeadMediaBeforeAnchor(anchorOffset):false;
    var modeDiagSeq=incomingModeChange?modeSwitchDiagBegin(prevFlow,nextFlow,prevPageMode,nextPageMode,anchorOffset,storedOffsetBefore):0;
    if(prevFlow==='scroll'){
      scrollPagedView=false;
      clearVirtualPage();clearScrollPreview();
      if(scroller){scroller.style.clipPath='none';scroller.style.webkitClipPath='none';}
    }
    S=Object.assign(S,e.data.settings);
    var flowChanged=prevFlow!==S.flowMode;
    var pageModeChanged=prevPageMode!==S.pageMode;
    if(flowChanged||pageModeChanged)cancelPagedImagePreview();
    if(flowChanged&&isScrollMode())scrollPagedView=!!imageAnchor;
    parent.postMessage({layoutBusy:1},'*');
    // 单页/双页共用同一套总页数；字体、边距、窗口或滚动模式改变才作废缓存。
    if(prevPageCountSig!==pageCountSig())invalidateMeasure();
    // 滚动容器已经按阅读边距内缩；恢复锚点时使用容器内偏移，避免重复叠加 marginTop。
    var layoutResult=relayout({anchor:anchor,anchorOffset:anchorOffset,exactScroll:flowChanged&&isScrollMode()&&!imageAnchor,scrollOffset:8,modeSwitch:incomingModeChange,alignDualAnchor:incomingModeChange&&isDualPage(),forceAnchorColumn:incomingModeChange&&!isScrollMode(),preserveLeadMedia:preserveLeadMedia});
    if(incomingModeChange){
      modeSwitchRecoveryOffset=layoutResult&&layoutResult.modeSwitchVerified===false?anchorOffset:null;
    }
    if(prevFontFamily!==S.fontFamily&&document.fonts&&document.fonts.ready){
      var selectedFont=S.fontFamily,fontAnchorOffset=anchorOffset;
      document.fonts.ready.then(function(){
        if(S.fontFamily!==selectedFont)return;
        relayout({anchorOffset:fontAnchorOffset,modeSwitch:true,alignDualAnchor:isDualPage()});
        invalidateMeasure();scheduleMeasure();
      }).catch(function(){});
    }
    if(modeDiagSeq){modeSwitchDiagLog(modeDiagSeq,'after_relayout',anchorOffset);modeSwitchDiagSchedule(modeDiagSeq,anchorOffset);}
    if(flowChanged||pageModeChanged)scheduleImageVisualAnchorRestore(imageAnchor);
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
  if(e.data.translationProfiles!==undefined){applyTranslationProfiles(e.data.translationProfiles);}
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
  pagedImagePreview._rrPreviewSource=null;
  pagedImagePreview.style.display='none';
  pagedImagePreview.innerHTML='';
}
function cancelPagedImagePreview(){
  pagedImagePreviewGeneration++;
  if(pagedImagePreviewFrame){cancelAnimationFrame(pagedImagePreviewFrame);pagedImagePreviewFrame=0;}
  clearPagedImagePreview();
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
function pagedImageSourcePage(rect,rootRect,step){
  if(!rect||!rootRect)return -1;
  return Math.max(0,Math.floor((rect.left-rootRect.left+1)/Math.max(1,step||1)));
}
function pagedTextLineBottomOnPage(line,rootRect,step,page){
  if(!line)return -1;
  var fragments=line.fragments||[];
  if(fragments.length){
    var bottom=-1;
    for(var i=0;i<fragments.length;i++){
      var fragment=fragments[i];
      if(!fragment||pagedImageSourcePage(fragment,rootRect,step)!==page)continue;
      bottom=Math.max(bottom,Number(fragment.bottom)||Number(line.bottom)||-1);
    }
    return bottom;
  }
  return pagedImageSourcePage(line,rootRect,step)===page?(Number(line.bottom)||-1):-1;
}
function refreshPagedImagePreview(){
  if(!root||!pager||isScrollMode()||isDualPage()){clearPagedImagePreview();return;}
  var pr=viewRect(),rr=root.getBoundingClientRect(),step=pageStep||window.innerWidth||1,current=pageInCh;
  var imgs=root.querySelectorAll('img'),candidate=null,candidateRect=null,sourcePage=-1;
  for(var i=0;i<imgs.length;i++){
    var img=imgs[i],r=null;
    if(img.closest&&img.closest('sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap'))continue;
    try{r=img.getBoundingClientRect();}catch(_){r=null;}
    if(!r||r.width<20||r.height<48)continue;
    var page=pagedImageSourcePage(r,rr,step);
    if(page!==current+1)continue;
    if(r.top-pr.top>mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5))continue;
    candidate=img;candidateRect=r;sourcePage=page;break;
  }
  if(!candidate){clearPagedImagePreview();return;}
  var lines=filterTextLines(documentTextLineRects()),last=mg(S.marginTop);
  for(var j=0;j<lines.length;j++){
    var line=lines[j];
    // 相同纵坐标的文字会被 documentTextLineRects 合并为一条逻辑行，且可能
    // 同时包含多个分栏的片段。使用整行 left 判断所属页会漏掉当前栏末尾正文，
    // 让图片预览提前覆盖文字。必须逐片段判断所属栏并取当前栏真实底部。
    var lineBottom=pagedTextLineBottomOnPage(line,rr,step,current);
    if(lineBottom>=0)last=Math.max(last,lineBottom);
  }
  var pageBottom=Math.min(pr.height||viewportHeight(),pagedBoxHeight())-mg(S.marginBottom);
  var free=Math.floor(pageBottom-last-6);
  if(free<32){clearPagedImagePreview();return;}
  var crop=Math.min(free,Math.floor(candidateRect.height));
  if(crop<32||crop>=candidateRect.height-2){clearPagedImagePreview();return;}
  var box=ensurePagedImagePreview();
  if(!box)return;
  var clone=clonePreviewElement(candidate);
  if(!clone){clearPagedImagePreview();return;}
  var logicalLeft=candidateRect.left-rr.left;
  var left=logicalLeft-sourcePage*step;
  box.innerHTML='';
  box.style.left=Math.max(0,Math.round(left))+'px';
  box.style.top=(Math.round(last)+imagePreviewGapPx())+'px';
  box.style.width=Math.round(candidateRect.width)+'px';
  box.style.height=Math.round(crop)+'px';
  box.style.display='block';
  box._rrPreviewSource=candidate;
  clone.style.setProperty('width',Math.round(candidateRect.width)+'px','important');
  clone.style.setProperty('height',Math.round(candidateRect.height)+'px','important');
  clone.style.setProperty('max-width','none','important');
  clone.style.setProperty('max-height','none','important');
  box.appendChild(clone);
}
var pagedImagePreviewFrame=0,pagedImagePreviewGeneration=0;
function schedulePagedImagePreview(){
  var generation=++pagedImagePreviewGeneration;
  if(pagedImagePreviewFrame){cancelAnimationFrame(pagedImagePreviewFrame);pagedImagePreviewFrame=0;}
  clearPagedImagePreview();
  if(!root||!pager||isScrollMode()||isDualPage())return;
  pagedImagePreviewFrame=requestAnimationFrame(function(){
    pagedImagePreviewFrame=0;
    if(generation!==pagedImagePreviewGeneration)return;
    refreshPagedImagePreview();
  });
}
var baseSetViewOffset=setViewOffset;
setViewOffset=function(){baseSetViewOffset();schedulePagedImagePreview();};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
