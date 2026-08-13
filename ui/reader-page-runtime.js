// Reading text retains its own selection-based dictionary and annotation
// actions, but Chromium must not begin a native image/link/text drag.
document.addEventListener('dragstart',function(event){event.preventDefault();},true);
// ---- 朗读：按正文语言自动选微软/系统声音，并高亮当前词、自动翻页/跳章 ----
var TTS_AUTO_VOICES={"zh-CN":"zh-CN-XiaoxiaoNeural","zh-TW":"zh-TW-HsiaoChenNeural","en":"en-US-JennyNeural",ja:"ja-JP-NanamiNeural",ko:"ko-KR-SunHiNeural",fr:"fr-FR-DeniseNeural",de:"de-DE-KatjaNeural",es:"es-ES-ElviraNeural",ru:"ru-RU-SvetlanaNeural","pt-BR":"pt-BR-FranciscaNeural"};
function ttsUiLanguage(){var l=String(S.uiLanguage||document.documentElement.lang||'zh-CN');return TTS_AUTO_VOICES[l]?l:(l.indexOf('zh-TW')===0?'zh-TW':(l.indexOf('pt')===0?'pt-BR':(l.indexOf('zh')===0?'zh-CN':(TTS_AUTO_VOICES[l.slice(0,2)]?l.slice(0,2):'en'))));}
function ttsLatinLanguage(text){var t=(' '+String(text||'').toLowerCase().replace(/[^a-zà-ÿßœ]+/g,' ')+' ');var scores={en:0,fr:0,de:0,es:0,'pt-BR':0};
  [['fr',/\b(le|la|les|des|une|est|avec|pour|dans|que|qui|bonjour|merci|vous|nous)\b/g],['de',/\b(der|die|das|und|ist|nicht|mit|eine|für|auf|den|hallo|ich|sie|wir)\b/g],['es',/\b(el|los|las|del|que|con|para|por|una|está|hola|gracias|como|usted)\b/g],['pt-BR',/\b(os|as|que|com|para|por|uma|não|dos|das|olá|obrigado|você)\b/g],['en',/\b(the|and|that|with|for|from|this|have|are|was|you|hello|thanks)\b/g]].forEach(function(rule){scores[rule[0]]=(t.match(rule[1])||[]).length;});
  if(/[äöüß]/.test(t))scores.de+=3;if(/[ñ¿¡]/.test(t))scores.es+=3;if(/[ãõ]/.test(t))scores['pt-BR']+=3;if(/[àâçèéêëîïôûùüÿœ]/.test(t))scores.fr+=2;
  var best='en',score=0;Object.keys(scores).forEach(function(key){if(scores[key]>score){best=key;score=scores[key];}});return score?best:'en';}
function ttsLanguageForText(text){var t=String(text||'');if(/[\uac00-\ud7af]/.test(t))return 'ko';if(/[\u3040-\u30ff]/.test(t))return 'ja';if(/[\u0400-\u052f]/.test(t))return 'ru';if(/[\u3400-\u9fff]/.test(t)){if(/[體臺萬與為國書讀這個們後裡發現]/.test(t)||ttsUiLanguage()==='zh-TW')return 'zh-TW';return 'zh-CN';}if(/[A-Za-zÀ-ÿ]/.test(t))return ttsLatinLanguage(t);return ttsUiLanguage();}
function ttsVoiceForText(text){return TTS_AUTO_VOICES[ttsLanguageForText(text)]||TTS_AUTO_VOICES['en'];}
function ttsPickVoice(text){var lang=ttsLanguageForText(text),vs=(window.speechSynthesis&&speechSynthesis.getVoices())||[],wanted=lang==='en'?'en-us':lang.toLowerCase(),found=null;for(var i=0;i<vs.length;i++){if(String(vs[i].lang||'').toLowerCase().indexOf(wanted)===0){found=vs[i];break;}}ttsVoice=found||vs[0]||null;return {count:vs.length,matched:!!found,language:lang};}
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
  var pv=ttsPickVoice(s.text);if(ttsVoice)u.voice=ttsVoice;u.lang=pv.language==='en'?'en-US':pv.language;u.rate=ttsRate;
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
  parent.postMessage({ttsSynth:{seq:ttsGen,idx:i,text:ttsSents[i].text,voice:ttsVoiceForText(ttsSents[i].text),rate:rate}},'*');
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
  var pv=ttsPickVoice(ttsSents[0]&&ttsSents[0].text);
  if(pv.count===0){speechSynthesis.onvoiceschanged=function(){if(ttsOn){var p2=ttsPickVoice(ttsSents[0]&&ttsSents[0].text);if(!p2.matched)parent.postMessage({ttsNoSystemVoice:p2.language},'*');ttsBegin();speechSynthesis.onvoiceschanged=null;}};return;}
  if(!pv.matched)parent.postMessage({ttsNoSystemVoice:pv.language},'*');
  ttsBegin();
}
function ttsStop(){
  ttsOn=false;ttsGen++;ttsCache={};ttsWaiting=-1;
  try{speechSynthesis.cancel();}catch(_){}
  if(ttsAudioEl){try{ttsAudioEl.pause();}catch(_){}ttsAudioEl=null;}
  if(window.CSS&&CSS.highlights)CSS.highlights.delete('tts');
  parent.postMessage({ttsState:0},'*');
}
// 阅读模式开关先保存“目标模式”，不立即改变 iframe 的布局。第一条阅读输入
// 会把同一份设置送回此处，重排完成后由 annotations 按目标模式重放该输入。
// 后续同一手势的事件在重排期间不会再入队，避免触控板惯性被延后回放。
var pendingReaderModeSettings=null,pendingReaderModeReplay=null,pendingReaderModeApplying=false;
function queuePendingReaderModeInput(replay){
  if(!pendingReaderModeSettings)return false;
  if(pendingReaderModeApplying)return true;
  pendingReaderModeApplying=true;
  pendingReaderModeReplay=replay;
  var next=pendingReaderModeSettings;
  pendingReaderModeSettings=null;
  window.postMessage({settings:next,applyQueuedReaderModeChange:1},'*');
  return true;
}
window.addEventListener('message',function(e){
  if(!e.data)return;
  // Bounded settings-only bridge for the original reader preferences panel. It never carries
  // selected text, highlights, chapter HTML or a document URL. The imperative
  // page validates and applies the values before re-rendering its own menu.
  if(e.data.readerHighlightMenuSettings){
    var highlightMenuRequest=e.data.readerHighlightMenuSettings;
    var highlightMenuRequestId=Math.max(0,parseInt(highlightMenuRequest.requestId,10)||0);
    if(highlightMenuRequestId&&typeof window.ReaderHighlightMenuSettings==='object'){
      var highlightMenuOp=String(highlightMenuRequest.operation||'');
      var highlightMenuSettings=highlightMenuOp==='get'
        ?window.ReaderHighlightMenuSettings.get()
        :highlightMenuOp==='update'
          ?window.ReaderHighlightMenuSettings.update(highlightMenuRequest.settings)
          :highlightMenuOp==='activate'
            ?window.ReaderHighlightMenuSettings.activate()
          :null;
      if(highlightMenuSettings)parent.postMessage({readerHighlightMenuSettings:{requestId:highlightMenuRequestId,settings:highlightMenuSettings}},'*');
    }
    return;
  }
  if(e.data.showHighlightMenuSettings){
    if(typeof showHlSettings==='function')showHlSettings(selMenu||hlMenu);
    return;
  }
  if(e.data.readerGestureAction==='back'){
    var readerGestureSurfaceClosed=typeof closeReaderPageGestureSurface==='function'&&closeReaderPageGestureSurface();
    parent.postMessage({readerGestureSurfaceClosed:!!readerGestureSurfaceClosed},'*');
    return;
  }
  if(e.data.positionSnapshotRequest!==undefined){
    var snapshotId=Math.max(0,parseInt(e.data.positionSnapshotRequest,10)||0),snapshotStarted=Date.now();
    (function waitForStablePosition(){
      if(chapterTurnPending&&Date.now()-snapshotStarted<2400){setTimeout(waitForStablePosition,16);return;}
      requestAnimationFrame(function(){requestAnimationFrame(function(){
        captureAnchor();report(false,false,snapshotId);
      });});
    })();
  }  if(e.data.animationSettings){
    readerAnimationSettingsOverride=Object.assign({},e.data.animationSettings);
    document.documentElement.classList.toggle('animations-all-off',readerAnimationSettingsOverride.allAnimations===false);
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
    var requestedFlow=e.data.settings.flowMode||S.flowMode;
    var requestedPageMode=e.data.settings.pageMode||S.pageMode;
    // 只延后“整屏/滚动”的流式模式切换。单双页必须立刻重排，不能被
    // 上一次滚动模式切换的等待状态吞掉。
    var shouldDeferFlowModeChange=!!e.data.deferModeChange&&requestedFlow!==S.flowMode;
    if(shouldDeferFlowModeChange){
      // 整屏单页和滚动单页的 pageMode 同为 single；是否需要切换必须以
      // flowMode 为准，不能因 pageMode 相同而丢掉这次切换。
      pendingReaderModeSettings=Object.assign({},e.data.settings);
      return;
    }
    pendingReaderModeSettings=null;
    var prevFlow=S.flowMode,prevPageMode=S.pageMode,prevFontFamily=S.fontFamily,prevTextConversion=S.textConversion,prevImagePagination=S.imagePagination;
    var imagePaginationChanged=e.data.settings.imagePagination!==undefined&&prevImagePagination!==e.data.settings.imagePagination;
    var imagePaginationOnly=imagePaginationChanged&&Object.keys(e.data.settings).every(function(key){return key==='imagePagination'||e.data.settings[key]===S[key];});
    var dualPageGapOnly=e.data.settings.dualPageGap!==undefined&&Object.keys(e.data.settings).every(function(key){return key==='dualPageGap'||e.data.settings[key]===S[key];});
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
    var previousUiLanguage=S.uiLanguage;
    S=Object.assign(S,e.data.settings);
    if(previousUiLanguage!==S.uiLanguage&&typeof refreshReaderPageLanguage==='function')refreshReaderPageLanguage();
    var textConversionChanged=prevTextConversion!==S.textConversion;
    // 转换始终从原始章节 HTML 重新取一份显示文本，不修改图书文件、索引或同步内容。
    // 保留当前章内页号作为近似位置；字符宽度变化后再用旧的精确文本锚点反而会失效。
    if(textConversionChanged){
      showChapter(curCh,pageInCh);
      return;
    }
    if(imagePaginationOnly){
      // 当前页可能正在显示连续模式裁掉的下半图；此时立即恢复原图会把
      // 图注和正文推到另一栏。保留当前视觉状态，新选择在下一次翻页的
      // setViewOffset() 中自然生效，设置本身绝不重排本章文字。
      pagedImageTraceSignature='';
      tracePagedImageLayout('setting_deferred',{image_source_page:pageInCh,image_candidate_page:-1,image_probed:false});
      return;
    }
    // 单页和滚动阅读根本不会使用中缝。保存该偏好时无需让正在阅读的
    // iframe 重排；真正的双页预览 iframe 仍会即时应用这个值。
    if(dualPageGapOnly&&!isDualPage())return;
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
    if(pendingReaderModeReplay){
      var replay=pendingReaderModeReplay;
      pendingReaderModeReplay=null;
      requestAnimationFrame(function(){
        pendingReaderModeApplying=false;
        if(typeof window.replayPendingReaderModeInput==='function')window.replayPendingReaderModeInput(replay);
      });
    }else{
      pendingReaderModeApplying=false;
    }
  }
  if(e.data.tts){if(e.data.tts==='start')ttsStart();else ttsStop();}
  if(e.data.ttsAudio){var a=e.data.ttsAudio;if(ttsOn&&a.seq===ttsGen){ttsCache[a.idx]=a;if(ttsWaiting===a.idx)ttsRenderAudio(a.idx,a);}}
  if(e.data.ttsAudioErr){var er=e.data.ttsAudioErr;if(ttsOn&&er.seq===ttsGen){ttsCache[er.idx]={err:1};if(ttsWaiting===er.idx){ttsWaiting=-1;if(!ttsPlayedAny){parent.postMessage({ttsErr:er.err||2},'*');ttsStop();}else ttsPlayIndex(er.idx+1);}}}
  if(e.data.overlayOpen!==undefined){overlayOpen=!!e.data.overlayOpen;}
  if(e.data.pageCache){applyPageCache(e.data.pageCache);}
  if(e.data.clearMarks){clearMarksKeepPage();}
  if(e.data.gotoChapter!==undefined){var cf=e.data.chFrac,fr=e.data.frag,sq=e.data.search;showChapter(e.data.gotoChapter,'start',fr).then(function(){if(cf!==undefined&&cf>0)gotoPage(Math.round(cf*(pagesInCh-1)));if(sq)doSearch(sq);});}
  if(e.data.gotoFrac!==undefined){gotoGlobalFrac(e.data.gotoFrac);}
  if(e.data.pageTurn){markPageTurnInput('shell');if(e.data.pageTurn>0)nextPage();else prevPage();}
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
// Do not let the iframe's own default storage overwrite a preference saved by
// the reader shell.  The shell starts synchronization only after this handler
// and the visual settings API both exist.
function announceHighlightMenuPreferencesReady(){
  if(typeof window.ReaderHighlightMenuSettings==='object')parent.postMessage({readerHighlightMenuPreferencesReady:true},'*');
  else setTimeout(announceHighlightMenuPreferencesReady,0);
}
if(document.readyState==='complete')setTimeout(announceHighlightMenuPreferencesReady,0);
else window.addEventListener('load',announceHighlightMenuPreferencesReady,{once:true});

var pagedImagePreview=null,pagedImageTraceSignature='';
function tracePagedImageLayout(outcome,detail){
  if(typeof readerBugTrace!=='function')return;
  var data=detail&&typeof detail==='object'?detail:{};
  data.image_mode=S&&S.imagePagination||'unknown';
  var signature=[outcome,pageInCh,data.image_mode,data.image_source_page,data.image_candidate_page,data.image_top,data.image_height,data.image_free_height,data.image_preview_height,data.image_next_count,data.image_skipped_text].join('|');
  // 同一页可能因字体、图片解码或面板动画多次重排；只留发生变化的一条。
  if(signature===pagedImageTraceSignature)return;
  pagedImageTraceSignature=signature;
  readerBugTrace('image_pagination',outcome,null,data);
}
function restorePagedImagePreviewSource(){
  if(!pagedImagePreview)return;
  var source=pagedImagePreview._rrCroppedSource;
  if(source){
    if(pagedImagePreview._rrSourceStyle==null)source.removeAttribute('style');
    else source.setAttribute('style',pagedImagePreview._rrSourceStyle);
    source.__kpPagedPreviewHeight=0;
    source.__kpPagedPreviewFromPage=-1;
    source.__kpPagedOriginalHeight=0;
  }
  pagedImagePreview._rrCroppedSource=null;
  pagedImagePreview._rrSourceStyle=null;
}
function clearPagedImagePreview(){
  if(!pagedImagePreview)return;
  restorePagedImagePreviewSource();
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
  pagedImagePreview=document.getElementById('paged-image-preview');
  if(!pagedImagePreview){
    pagedImagePreview=document.createElement('div');
    pagedImagePreview.id='paged-image-preview';
    pagedImagePreview.style.cssText='position:fixed;display:none;overflow:hidden;pointer-events:none;z-index:2147483646;contain:paint;';
    document.body.appendChild(pagedImagePreview);
  }else if(pagedImagePreview.parentNode!==document.body){
    // #pager 带 perspective，正文又带 transform；放在其中会进入另一个合成层，
    // WebView2 可能把预览压在正文后面。顶层固定层不受该 stacking context 影响。
    document.body.appendChild(pagedImagePreview);
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
function pagedImageFreeHeight(lines,rootRect,step,page,pr){
  var last=mg(S.marginTop);
  for(var i=0;i<lines.length;i++){
    var bottom=pagedTextLineBottomOnPage(lines[i],rootRect,step,page);
    if(bottom>=0)last=Math.max(last,bottom);
  }
  var pageBottom=Math.min(pr.height||viewportHeight(),pagedBoxHeight())-mg(S.marginBottom);
  return {last:last,free:Math.floor(pageBottom-last-6)};
}
function visiblePagedTextBottom(pr){
  var last=mg(S.marginTop);
  if(!root||!pr)return last;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    var range=null,rects=null;
    try{range=document.createRange();range.selectNodeContents(node);rects=range.getClientRects();}catch(_){rects=null;}
    if(!rects)continue;
    for(var i=0;i<rects.length;i++){
      var r=rects[i];
      if(!r||r.right<=pr.left+2||r.left>=pr.right-2||r.bottom<=pr.top||r.top>=pr.bottom)continue;
      last=Math.max(last,Math.round(r.bottom-pr.top));
    }
  }
  return last;
}
function hasPagedTextBeforeMedia(lines,rootRect,step,page,mediaTop){
  // 图不一定正好贴在下一栏页顶：较高图片在 Chromium 的多栏布局中可能
  // 因 figure 的外边距落在页顶数行之后。只要它前面没有正文，就仍然是
  // 当前页的下一个阅读内容；若有正文则不能提前显示图片，以免打乱顺序。
  for(var i=0;i<lines.length;i++){
    var line=lines[i],fragments=line&&line.fragments||[];
    if(!fragments.length)fragments=[line];
    for(var j=0;j<fragments.length;j++){
      var fragment=fragments[j];
      if(!fragment||pagedImageSourcePage(fragment,rootRect,step)!==page)continue;
      if((Number(fragment.bottom)||-1)<=mediaTop+2)return true;
    }
  }
  return false;
}
function hasVisiblePagedTextBeforeMedia(pr,mediaTop){
  if(!root||!pr)return false;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    var range=null,rects=null;
    try{range=document.createRange();range.selectNodeContents(node);rects=range.getClientRects();}catch(_){rects=null;}
    if(!rects)continue;
    for(var i=0;i<rects.length;i++){
      var r=rects[i];
      if(!r||r.right<=pr.left+2||r.left>=pr.right-2||r.bottom<=pr.top||r.top>=pr.bottom)continue;
      if(r.bottom<=mediaTop+2)return true;
    }
  }
  return false;
}
function lastVisiblePagedTextNode(pr){
  if(!root||!pr)return null;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node,last=null;
  while((node=walker.nextNode())){
    if(!(node.nodeValue||'').trim())continue;
    var range=null,rects=null;
    try{range=document.createRange();range.selectNodeContents(node);rects=range.getClientRects();}catch(_){rects=null;}
    if(!rects)continue;
    for(var i=0;i<rects.length;i++){
      var r=rects[i];
      if(r&&r.right>pr.left+2&&r.left<pr.right-2&&r.bottom>pr.top&&r.top<pr.bottom){last=node;break;}
    }
  }
  return last;
}
function hasPagedTextBetween(start,end){
  if(!start||!end)return true;
  try{
    var range=document.createRange();
    range.setStartAfter(start);range.setEndBefore(end);
    return !!(range.toString()||'').trim();
  }catch(_){return true;}
}
function immediatePagedImageAfterVisibleText(pr){
  var last=lastVisiblePagedTextNode(pr);
  if(!last||!root)return null;
  var imgs=root.querySelectorAll('img');
  for(var i=0;i<imgs.length;i++){
    var img=imgs[i];
    if(img.closest&&img.closest('sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap'))continue;
    if(!(last.compareDocumentPosition(img)&Node.DOCUMENT_POSITION_FOLLOWING))continue;
    // 这条路径只允许“当前可见正文之后立刻就是图片”。EPUB 的 p/div
    // 经常让内联 img 的多栏 rect 丢失，但 DOM 顺序仍是可靠的；若中间
    // 有任何正文则绝不能借此提前预览，否则会再次出现图片压在文字前。
    if(hasPagedTextBetween(last,img))return null;
    return img;
  }
  return null;
}
function pageBeforePagedImage(img,rootRect,step){
  if(!root||!img)return -1;
  try{
    var range=document.createRange();
    range.selectNodeContents(root);range.setEndBefore(img);
    var rects=range.getClientRects(),bestPage=-1;
    for(var i=0;i<rects.length;i++){
      var r=rects[i];
      if(!r||r.width<2||r.height<2)continue;
      bestPage=Math.max(bestPage,pagedImageSourcePage(r,rootRect,step));
    }
    return bestPage;
  }catch(_){return -1;}
}
function nextPagedImageByPrecedingContent(imgs,rootRect,step,current){
  for(var i=0;i<imgs.length;i++){
    var img=imgs[i];
    if(img.closest&&img.closest('sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap'))continue;
    // 某些 EPUB 将图片作为 p 的内联子节点，图片自身在屏外时没有可靠
    // 的列坐标；但“图片前的所有文档流”最后落在哪一页是稳定的。
    if(pageBeforePagedImage(img,rootRect,step)===current)return img;
  }
  return null;
}
function showPagedImageSlice(box,source,rect,left,top,height,offset,viewport){
  var clone=clonePreviewElement(source);
  if(!clone)return false;
  box.innerHTML='';
  box.style.left=Math.max(0,Math.round((viewport&&viewport.left||0)+left))+'px';
  box.style.top=Math.max(0,Math.round((viewport&&viewport.top||0)+top))+'px';
  box.style.width=Math.round(rect.width)+'px';
  box.style.height=Math.max(1,Math.round(height))+'px';
  box.style.display='block';
  clone.style.setProperty('width',Math.round(rect.width)+'px','important');
  clone.style.setProperty('height',Math.round(rect.height)+'px','important');
  clone.style.setProperty('max-width','none','important');
  clone.style.setProperty('max-height','none','important');
  clone.style.transform='translateY(-'+Math.max(0,Math.round(offset||0))+'px)';
  box.appendChild(clone);
  return true;
}
function cropPagedImageSource(box,source,height){
  if(!box||!source||!source.style)return;
  box._rrCroppedSource=source;
  box._rrSourceStyle=source.getAttribute('style');
  // 让真实图片盒只保留未显示的下半段，随后 figcaption 和正文自然紧跟。
  // 只做遮罩克隆会保留原图完整高度，正是截图里图片和说明文字之间的空洞来源。
  source.style.setProperty('height',Math.max(1,Math.round(height))+'px','important');
  source.style.setProperty('max-height','none','important');
  source.style.setProperty('object-fit','cover','important');
  source.style.setProperty('object-position','center bottom','important');
  source.style.setProperty('break-before','column','important');
  source.style.setProperty('-webkit-column-break-before','always','important');
}
function continuousPagedImageSourceState(){
  if(!root||S.imagePagination!=='continuous')return null;
  var imgs=root.querySelectorAll('img');
  for(var i=0;i<imgs.length;i++){
    var img=imgs[i],consumed=Math.floor(img.__kpPagedPreviewHeight||0);
    if(img.__kpPagedPreviewFromPage===pageInCh-1&&consumed>=32)return {source:img,consumed:consumed};
  }
  return null;
}
function probeNextPagedImage(pr,current,step){
  if(!root)return null;
  var previousTransform=root.style.transform;
  var found=null;
  try{
    // Chromium 对屏外多栏中的 replaced element 会返回不可靠的 rect。同步切到
    // 下一页测量后立刻恢复，不让用户看到过渡帧，得到的才是可用于预览的真尺寸。
    root.style.transform='translateX(-'+Math.max(0,(current+1)*step)+'px)';
    void root.offsetWidth;
    var imgs=root.querySelectorAll('img');
    for(var i=0;i<imgs.length;i++){
      var img=imgs[i],r=null;
      if(img.closest&&img.closest('sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap'))continue;
      try{r=img.getBoundingClientRect();}catch(_){r=null;}
      if(!r||r.width<20||r.height<48)continue;
      if(r.right<=pr.left+2||r.left>=pr.right-2)continue;
      var nearPageTop=r.top-pr.top<=mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5);
      if(!nearPageTop&&hasVisiblePagedTextBeforeMedia(pr,r.top))continue;
      found={source:img,rect:{left:r.left,top:r.top,width:r.width,height:r.height}};
      break;
    }
  }finally{
    root.style.transform=previousTransform;
    void root.offsetWidth;
  }
  return found;
}
function probePagedImageElement(pr,current,step,img){
  if(!root||!img)return null;
  var previousTransform=root.style.transform;
  try{
    root.style.transform='translateX(-'+Math.max(0,(current+1)*step)+'px)';
    void root.offsetWidth;
    var r=img.getBoundingClientRect();
    if(!r||r.width<20||r.height<48)return null;
    return {source:img,rect:{left:r.left,top:r.top,width:r.width,height:r.height}};
  }catch(_){return null;
  }finally{
    root.style.transform=previousTransform;
    void root.offsetWidth;
  }
}
function refreshPagedImagePreview(){
  if(!root||!pager||isScrollMode()||isDualPage()){clearPagedImagePreview();return;}
  var pr=viewRect(),rr=root.getBoundingClientRect(),step=pageStep||window.innerWidth||1,current=pageInCh;
  // “下一页完整显示”不能创建任何视觉预览：原图已经由多栏正文负责
  // 移到下一页。此前这里也生成克隆图，结果在原图前再叠出一截同图，
  // 特别是带插图 EPUB 会出现重复、交错，并把一次翻页拆成数次。
  if(S.imagePagination!=='continuous'){clearPagedImagePreview();return;}
  var imgs=root.querySelectorAll('img'),candidate=null,candidateRect=null,sourcePage=-1,nextImageCount=0,futureImageCount=0,skippedForText=0,firstNextImage=null,firstFutureImage=null;
  var lines=filterTextLines(documentTextLineRects());
  for(var i=0;i<imgs.length;i++){
    var img=imgs[i],r=null;
    if(img.closest&&img.closest('sup,sub,a.duokan-footnote,.rr-note-ref,.rr-note-wrap'))continue;
    try{r=img.getBoundingClientRect();}catch(_){r=null;}
    if(!r||r.width<20||r.height<48)continue;
    var page=pagedImageSourcePage(r,rr,step);
    var inFutureColumn=r.left>=pr.right-2;
    var inCurrentView=r.right>pr.left+2&&r.left<pr.right-2;
    if(inFutureColumn){
      futureImageCount++;
      if(!firstFutureImage)firstFutureImage={page:page,top:Math.round(r.top-pr.top),width:Math.round(r.width),height:Math.round(r.height)};
    }
    // EPUB 的 figure 在 Chromium 中可能为子图报告错误的逻辑列号；直接按
    // 图片是否已经位于当前视口右侧来判断下一页，避免遗漏页底预览。
    if(inFutureColumn&&page===current+1){
      nextImageCount++;
      if(!firstNextImage)firstNextImage={page:page,top:Math.round(r.top-pr.top),width:Math.round(r.width),height:Math.round(r.height)};
      var nearPageTop=r.top-pr.top<=mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5);
      var mediaIsNextContent=!hasPagedTextBeforeMedia(lines,rr,step,current+1,r.top);
      if(nearPageTop||mediaIsNextContent){
        candidate=img;candidateRect=r;sourcePage=current+1;break;
      }
      skippedForText++;
    }
    // 当前页页顶的图片只有在上一页确实生成过预览时，才是连续模式需要
    // 裁去已读上段的“来源图”。章节徽标等普通页顶图片不能抢占候选，
    // 否则扫描会在它们这里提前结束，后面的跨页正文图永远不会被探测。
    if(inCurrentView&&S.imagePagination==='continuous'&&img.__kpPagedPreviewFromPage===current-1&&Math.floor(img.__kpPagedPreviewHeight||0)>=32){
      candidate=img;candidateRect=r;sourcePage=current;break;
    }
  }
  if(!candidate){
    var probed=probeNextPagedImage(pr,current,step);
    if(probed){candidate=probed.source;candidateRect=probed.rect;sourcePage=current+1;}
  }
  if(!candidate){
    var precedingContentImage=nextPagedImageByPrecedingContent(imgs,rr,step,current);
    var precedingContentProbe=probePagedImageElement(pr,current,step,precedingContentImage);
    if(precedingContentProbe){candidate=precedingContentProbe.source;candidateRect=precedingContentProbe.rect;sourcePage=current+1;}
  }
  if(!candidate){
    var immediate=immediatePagedImageAfterVisibleText(pr);
    var immediateProbe=probePagedImageElement(pr,current,step,immediate);
    if(immediateProbe){candidate=immediateProbe.source;candidateRect=immediateProbe.rect;sourcePage=current+1;}
  }
  if(!candidate){
    // 即使右侧尚未找到图片也要落一条记录：这能区分“没有执行重算”与
    // “执行了但 Chromium 给出的图片列号/位置不在预期页”。
    var traceImage=firstNextImage||firstFutureImage;
    tracePagedImageLayout('no_candidate',{image_source_page:current,image_candidate_page:traceImage?traceImage.page:-1,image_top:traceImage?traceImage.top:-1,image_width:traceImage?traceImage.width:0,image_height:traceImage?traceImage.height:0,image_next_count:nextImageCount,image_future_count:futureImageCount,image_skipped_text:skippedForText,image_near_top:!!(traceImage&&traceImage.top<=mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5)),image_text_before:skippedForText>0,image_probed:true});
    clearPagedImagePreview();return;
  }
  var slicePage=sourcePage===current?current-1:current;
  var space=pagedImageFreeHeight(lines,rr,step,slicePage,pr);
  if(sourcePage!==current){
    // 预览层必须贴在“用户现在看到的最后一行”后面；跨列行缓存只用于
    // 连续模式恢复旧页时的兜底，不能再用来决定当前页的绘制坐标。
    space.last=visiblePagedTextBottom(pr);
    space.free=Math.floor(Math.min(pr.height||viewportHeight(),pagedBoxHeight())-mg(S.marginBottom)-space.last-6);
  }
  var free=space.free;
  var pageBottom=Math.min(pr.height||viewportHeight(),pagedBoxHeight())-mg(S.marginBottom);
  var maxCrop=Math.max(32,Math.floor(candidateRect.height*0.45));
  var crop=Math.min(Math.max(0,free),maxCrop);
  var previewTop=Math.round(space.last)+imagePreviewGapPx();
  if(crop<32){
    // 图片刚解码时文本行几何偶有旧值；贴到页底比留下整块空白更符合连续阅读。
    crop=Math.min(maxCrop,Math.max(32,Math.floor((pr.height||viewportHeight())*0.36)));
    previewTop=Math.max(mg(S.marginTop),pageBottom-crop);
  }
  if(crop>=candidateRect.height-2){
    tracePagedImageLayout('fits_full',{image_source_page:sourcePage,image_candidate_page:sourcePage,image_top:Math.round(candidateRect.top-pr.top),image_width:Math.round(candidateRect.width),image_height:Math.round(candidateRect.height),image_free_height:Math.round(free),image_preview_height:Math.round(crop),image_next_count:nextImageCount,image_future_count:futureImageCount,image_skipped_text:skippedForText,image_near_top:candidateRect.top-pr.top<=mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5),image_text_before:false,image_probed:!nextImageCount});
    clearPagedImagePreview();return;
  }
  var box=ensurePagedImagePreview();
  if(!box)return;
  var logicalLeft=candidateRect.left-rr.left;
  var pageLeft=((candidateRect.left-pr.left)%step+step)%step;
  box._rrPreviewSource=candidate;
  if(sourcePage===current){
    // “下一页完整显示”保留原图；只有连续模式才裁掉前页已经预览的上段。
    if(S.imagePagination!=='continuous'){clearPagedImagePreview();return;}
    var consumed=candidate.__kpPagedPreviewFromPage===current-1?Math.max(0,Math.floor(candidate.__kpPagedPreviewHeight||0)):0;
    // 没有上一页预览就绝不能裁真实图片。此前这里以 crop 作为默认值，
    // 导致直接打开/漏检候选时，正常图片也只剩下半截。
    if(consumed<32){
      tracePagedImageLayout('source_without_preview',{image_source_page:sourcePage,image_candidate_page:sourcePage,image_top:Math.round(candidateRect.top-pr.top),image_width:Math.round(candidateRect.width),image_height:Math.round(candidateRect.height),image_free_height:Math.round(free),image_preview_height:0,image_next_count:nextImageCount,image_future_count:futureImageCount,image_skipped_text:skippedForText,image_near_top:candidateRect.top-pr.top<=mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5),image_text_before:false,image_probed:false});
      clearPagedImagePreview();return;
    }
    // refresh 可能因字体加载、窗口动画或首帧稳定器在同一页被调用多次。
    // 始终用首次裁切前的原始高度计算，避免每次刷新再减一次 consumed。
    var originalHeight=Math.max(Math.floor(candidate.__kpPagedOriginalHeight||0),Math.floor(candidateRect.height));
    candidate.__kpPagedOriginalHeight=originalHeight;
    var remaining=originalHeight-consumed;
    cropPagedImageSource(box,candidate,remaining);
    // 改写图片高度会让 WebKit 重新计算后续多栏位置。真实图片保留在当前栏，
    // 但它后面的正文可能被推到旧栏坐标；再提交一次当前页 transform 后重新
    // 取几何，效果与用户轻微滑动触发的稳定重绘相同。
    void root.offsetWidth;
    root.style.transform='translateX(-'+viewOffset+'px)';
    // 保留到离开本页时由 clearPagedImagePreview() 复原；不能在这里清理，
    // 否则刚裁掉的上半段会在同一帧被还原，图注仍被原始整图高度推开。
    box.innerHTML='';
    box.style.display='none';
    tracePagedImageLayout('continuous_source',{image_source_page:sourcePage,image_candidate_page:sourcePage,image_top:Math.round(candidateRect.top-pr.top),image_width:Math.round(candidateRect.width),image_height:Math.round(candidateRect.height),image_free_height:Math.round(free),image_preview_height:Math.round(consumed),image_next_count:nextImageCount,image_future_count:futureImageCount,image_skipped_text:skippedForText,image_near_top:candidateRect.top-pr.top<=mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5),image_text_before:false,image_probed:false});
  }else if(!showPagedImageSlice(box,candidate,candidateRect,pageLeft,previewTop,crop,0,pr)){
    tracePagedImageLayout('preview_failed',{image_source_page:sourcePage,image_candidate_page:sourcePage,image_top:Math.round(candidateRect.top-pr.top),image_width:Math.round(candidateRect.width),image_height:Math.round(candidateRect.height),image_free_height:Math.round(free),image_preview_height:Math.round(crop),image_next_count:nextImageCount,image_future_count:futureImageCount,image_skipped_text:skippedForText,image_near_top:candidateRect.top-pr.top<=mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5),image_text_before:false,image_probed:!nextImageCount});
    clearPagedImagePreview();
  }else{
    candidate.__kpPagedPreviewHeight=crop;
    candidate.__kpPagedPreviewFromPage=current;
    tracePagedImageLayout('preview',{image_source_page:sourcePage,image_candidate_page:sourcePage,image_top:Math.round(candidateRect.top-pr.top),image_width:Math.round(candidateRect.width),image_height:Math.round(candidateRect.height),image_free_height:Math.round(free),image_preview_height:Math.round(crop),image_next_count:nextImageCount,image_future_count:futureImageCount,image_skipped_text:skippedForText,image_near_top:candidateRect.top-pr.top<=mg(S.marginTop)+Math.max(32,lineHeightPx()*1.5),image_text_before:false,image_probed:!nextImageCount});
  }
}
var pagedImagePreviewFrame=0,pagedImagePreviewGeneration=0;
function hasPendingContinuousPagedImageSource(){
  return !!continuousPagedImageSourceState();
}
function schedulePagedImagePreview(){
  var generation=++pagedImagePreviewGeneration;
  if(pagedImagePreviewFrame){cancelAnimationFrame(pagedImagePreviewFrame);pagedImagePreviewFrame=0;}
  clearPagedImagePreview();
  if(!root||!pager||isScrollMode()||isDualPage()||S.imagePagination!=='continuous'){
    tracePagedImageLayout('schedule_skipped',{image_source_page:pageInCh,image_candidate_page:-1,image_probed:false});
    return;
  }
  tracePagedImageLayout('scheduled',{image_source_page:pageInCh,image_candidate_page:-1,image_probed:false});
  pagedImagePreviewFrame=requestAnimationFrame(function(){requestAnimationFrame(function(){
    pagedImagePreviewFrame=0;
    if(generation!==pagedImagePreviewGeneration)return;
    refreshPagedImagePreview();
  });});
}
var baseSetViewOffset=setViewOffset;
setViewOffset=function(){
  baseSetViewOffset();
  // 连续模式翻到图片来源页时，上一页已经留下了精确的预览高度。
  // 必须在本次翻页脚本结束、浏览器绘制新页之前同步裁剪；若仍走双 rAF，
  // 用户会先看到完整图片，再在约一帧后跳成剩余下段。
  if(hasPendingContinuousPagedImageSource()){
    if(pagedImagePreviewFrame){cancelAnimationFrame(pagedImagePreviewFrame);pagedImagePreviewFrame=0;}
    refreshPagedImagePreview();
    if(typeof stabilizeProgrammaticViewPaint==='function')stabilizeProgrammaticViewPaint();
    return;
  }
  schedulePagedImagePreview();
};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
