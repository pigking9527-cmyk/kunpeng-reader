// ---- 高亮/批注 ----
var HL=[]; // 全书高亮 [{chapter,start,end,text,note}]，数组下标即后端 index
var hlOverlay=null,sourceTextCache=null,highlightRenderTimer=null;
function generatedTextNode(node){
  var el=node&&node.nodeType===3?node.parentElement:(node&&node.nodeType===1?node:null);
  return !!(el&&el.closest&&el.closest('.rr-note-num,#hl-overlay,#virtual-page,#scroll-preview,#turn-fx-sheet,#page-mask'));
}
function sourceTextRecords(){
  if(sourceTextCache)return sourceTextCache;
  var out=[],pos=0;
  if(!root)return out;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    var text=node.nodeValue||'';
    if(generatedTextNode(node))continue;
    if(closestInlineNoteElement(node))continue;
    out.push({node:node,start:pos,end:pos+text.length});
    pos+=text.length;
  }
  sourceTextCache=out;
  return out;
}
function sourceTextAround(s,e,pre,post){
  var recs=sourceTextRecords(),a=Math.max(0,(s||0)-(pre||0)),b=Math.max(a,(e||0)+(post||0)),parts=[];
  for(var i=0;i<recs.length;i++){
    var r=recs[i];
    if(r.end<=a)continue;
    if(r.start>=b)break;
    var from=Math.max(0,a-r.start),to=Math.min((r.node.nodeValue||'').length,b-r.start);
    if(from<to)parts.push((r.node.nodeValue||'').slice(from,to));
  }
  return parts.join('');
}
function compareBoundaryToNodeOffset(container,offset,node,nodeOffset){
  var a=document.createRange(),b=document.createRange();
  a.setStart(container,offset);a.collapse(true);
  b.setStart(node,nodeOffset);b.collapse(true);
  return a.compareBoundaryPoints(Range.START_TO_START,b);
}
function sourceBoundaryOffset(container,offset){
  if(!root||!container)return null;
  if(container.nodeType===3&&generatedTextNode(container))return null;
  var recs=sourceTextRecords();
  for(var i=0;i<recs.length;i++){
    var r=recs[i],len=(r.node.nodeValue||'').length;
    if(container===r.node)return r.start+Math.max(0,Math.min(len,offset||0));
    var beforeStart=false,afterEnd=false;
    try{
      beforeStart=compareBoundaryToNodeOffset(container,offset,r.node,0)<=0;
      afterEnd=compareBoundaryToNodeOffset(container,offset,r.node,len)>=0;
    }catch(_){continue;}
    if(beforeStart)return r.start;
    if(afterEnd)continue;
    var lo=0,hi=len;
    while(lo<hi){
      var mid=Math.floor((lo+hi)/2);
      var cmp=compareBoundaryToNodeOffset(container,offset,r.node,mid);
      if(cmp<=0)hi=mid;else lo=mid+1;
    }
    return r.start+lo;
  }
  return recs.length?recs[recs.length-1].end:0;
}
function sourceRangeForOffsets(s,e){
  var recs=sourceTextRecords();
  s=Math.max(0,parseInt(s,10)||0);e=Math.max(s,parseInt(e,10)||0);
  if(!recs.length||e<=s)return null;
  var start=null,end=null;
  for(var i=0;i<recs.length;i++){
    var r=recs[i],len=(r.node.nodeValue||'').length;
    if(!start&&s<=r.end)start={node:r.node,offset:Math.max(0,Math.min(len,s-r.start))};
    if(e<=r.end){end={node:r.node,offset:Math.max(0,Math.min(len,e-r.start))};break;}
  }
  if(!start||!end)return null;
  var range=document.createRange();
  try{range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset);}catch(_){return null;}
  return range;
}
function ensureHighlightOverlay(){
  if(!hlOverlay){
    hlOverlay=document.getElementById('hl-overlay');
    if(!hlOverlay){hlOverlay=document.createElement('div');hlOverlay.id='hl-overlay';document.body.appendChild(hlOverlay);}
  }
  return hlOverlay;
}
function clearHighlightOverlay(){
  if(window.CSS&&CSS.highlights)try{CSS.highlights.delete('reader-hl');}catch(_){}
  if(hlOverlay)hlOverlay.innerHTML='';
}
function clearLegacyHighlightMarks(){
  if(!root)return;
  var ms=root.querySelectorAll('mark.hl');
  for(var i=0;i<ms.length;i++){
    var m=ms[i];
    if(m.parentNode)m.parentNode.replaceChild(document.createTextNode(m.getAttribute('data-orig')||m.textContent),m);
  }
  if(ms.length){root.normalize();sourceTextCache=null;}
}
function clearHighlights(){
  clearLegacyHighlightMarks();
  clearHighlightOverlay();
}
function highlightDisplayText(h){
  var t=h&&typeof h.corrected_text==='string'?h.corrected_text:'';
  return t?t:((h&&h.text)||'');
}
function highlightIndexForRange(s,e){
  if(s==null||e==null)return -1;
  for(var i=0;i<HL.length;i++){
    var h=HL[i];
    if(!h||h.chapter!==curCh)continue;
    var hs=parseInt(h.start,10),he=parseInt(h.end,10);
    if(!isFinite(hs)||!isFinite(he))continue;
    if(s<he&&e>hs)return i;
  }
  return -1;
}
function highlightRange(idx){
  var h=HL[idx];
  if(!h||h.chapter!==curCh)return null;
  return sourceRangeForOffsets(h.start,h.end);
}
function visibleHighlightRect(idx){
  var range=highlightRange(idx);
  if(!range)return null;
  var rects=[];try{rects=[].slice.call(range.getClientRects()).filter(function(r){return r&&r.width>0&&r.height>0;});}catch(_){rects=[];}
  if(!rects.length)return null;
  var vw=window.innerWidth||1,vh=window.innerHeight||1;
  for(var i=0;i<rects.length;i++){
    var r=rects[i];
    if(r.right>=0&&r.left<=vw&&r.bottom>=0&&r.top<=vh)return r;
  }
  return rects[0];
}
function applyHighlights(){
  clearHighlights();
  if(!root)return;
  var overlay=ensureHighlightOverlay();
  if(virtualPage&&virtualPage.style.display==='block'){overlay.innerHTML='';return;}
  var ranges=[];
  for(var i=0;i<HL.length;i++){
    var h=HL[i];if(!h||h.chapter!==curCh)continue;
    var range=sourceRangeForOffsets(h.start,h.end);if(!range)continue;
    ranges.push(range);
    var rects=[];try{rects=[].slice.call(range.getClientRects());}catch(_){rects=[];}
    for(var j=0;j<rects.length;j++){
      var r=rects[j];
      if(!r||r.width<1||r.height<3)continue;
      if(r.right<0||r.left>(window.innerWidth||0)||r.bottom<0||r.top>(window.innerHeight||0))continue;
      var d=document.createElement('span');
      d.className='hl-rect'+(h.note?' has-note':'');
      d.setAttribute('data-hi',String(i));
      if(h.note)d.title=h.note;
      d.style.left=Math.round(r.left)+'px';
      d.style.top=Math.round(r.top)+'px';
      d.style.width=Math.max(1,Math.ceil(r.width))+'px';
      d.style.height=Math.max(1,Math.ceil(r.height))+'px';
      overlay.appendChild(d);
    }
  }
  if(window.CSS&&CSS.highlights&&ranges.length){
    try{CSS.highlights.set('reader-hl',new Highlight(...ranges));}catch(_){}
  }
}
function scheduleHighlightRender(){
  if(highlightRenderTimer)cancelAnimationFrame(highlightRenderTimer);
  highlightRenderTimer=requestAnimationFrame(function(){highlightRenderTimer=null;applyHighlights();});
}
function refreshHighlights(){scheduleHighlightRender();}
function virtualSelectionActive(){
  var sel=window.getSelection?window.getSelection():null;
  if(!sel||!sel.rangeCount||!virtualPage||virtualPage.style.display!=='block')return false;
  var r=sel.getRangeAt(0),n=r.commonAncestorContainer;
  return !!(n&&virtualPage.contains(n.nodeType===1?n:n.parentNode));
}
function virtualBoundaryOffset(container,offset,isEnd){
  var el=container&&container.nodeType===1?container:container&&container.parentElement;
  var frag=el&&el.closest?el.closest('.vp-frag'):null;
  if(!frag)return null;
  var s=parseInt(frag.getAttribute('data-vstart')||'',10),e=parseInt(frag.getAttribute('data-vend')||'',10);
  if(!isFinite(s)||!isFinite(e))return null;
  if(container&&container.nodeType===3)return Math.max(s,Math.min(e,s+(offset||0)));
  return isEnd?e:s;
}
function virtualSelectionOffsets(){
  var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return null;
  var r=sel.getRangeAt(0),t=sel.toString();if(!t||!t.length)return null;
  if(!virtualSelectionActive())return null;
  var start=virtualBoundaryOffset(r.startContainer,r.startOffset,false);
  var end=virtualBoundaryOffset(r.endContainer,r.endOffset,true);
  if(start==null||end==null){
    var spans=virtualPage.querySelectorAll('.vp-frag[data-vstart][data-vend]');
    for(var i=0;i<spans.length;i++){
      var hit=false;try{hit=r.intersectsNode(spans[i]);}catch(_){hit=false;}
      if(!hit)continue;
      var s=parseInt(spans[i].getAttribute('data-vstart')||'',10),e=parseInt(spans[i].getAttribute('data-vend')||'',10);
      if(!isFinite(s)||!isFinite(e))continue;
      if(start==null||s<start)start=s;
      if(end==null||e>end)end=e;
    }
  }
  if(start==null||end==null||end<=start)return null;
  return {start:start,end:end,text:t};
}
function selOffsets(){
  var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return null;
  var vo=virtualSelectionOffsets();if(vo)return vo;
  var r=sel.getRangeAt(0);var t=r.toString();if(!t||!t.length)return null;
  var start=sourceBoundaryOffset(r.startContainer,r.startOffset);
  var end=sourceBoundaryOffset(r.endContainer,r.endOffset);
  if(start==null||end==null)return null;
  if(end<start){var tmp=start;start=end;end=tmp;}
  return {start:start,end:end,text:t};
}
function injectHead(htmlStr,seen){
  var tmp=document.createElement('div');tmp.innerHTML=htmlStr;
  var nodes=tmp.querySelectorAll('link,style');
  for(var i=0;i<nodes.length;i++){var key=nodes[i].outerHTML;if(seen[key])continue;seen[key]=1;document.head.appendChild(nodes[i]);}
}
function loadInit(){
  var p=new URLSearchParams(location.search);
  try{S=Object.assign(S,JSON.parse(decodeURIComponent(p.get('s')||'{}')));}catch(e){}
  var rc=parseInt(p.get('rc')||'0',10)||0, rf=parseFloat(p.get('rf')||'0')||0;
  showChapter(rc,'start').then(function(){
    var resumePage=Math.round(rf*(pagesInCh-1));
    if(resumePage>0)gotoPage(resumePage);
    else if(isScrollMode()&&scrollPort()){pageInCh=0;scrollPort().scrollTop=0;scrollProgrammaticTarget=0;report();}
    reveal();parent.postMessage({ready:1},'*');
    scheduleMeasure(500);
  });
}
function init(){
  pager=document.getElementById('pager');scroller=document.getElementById('scroller')||pager;root=document.getElementById('reader-root');measurer=document.getElementById('measurer');
  pageMask=document.getElementById('page-mask');
  if(!pageMask&&pager){pageMask=document.createElement('div');pageMask.id='page-mask';pager.appendChild(pageMask);}
  virtualPage=document.getElementById('virtual-page');
  if(!virtualPage&&pager){virtualPage=document.createElement('div');virtualPage.id='virtual-page';pager.appendChild(virtualPage);}
  hlOverlay=ensureHighlightOverlay();
  scrollPreview=document.getElementById('scroll-preview');
  if(!scrollPreview&&pager){scrollPreview=document.createElement('div');scrollPreview.id='scroll-preview';pager.appendChild(scrollPreview);}
  scrollPort().addEventListener('scroll',syncScrollPageFromTop,{passive:true});
  loadInit();
  setTimeout(function(){reveal();parent.postMessage({ready:1},'*');},8000); // 兜底
  // 记录是否发生了拖动（用于区分“单击翻页”与“拖动选字”）
  document.addEventListener('mousedown',function(e){downX=e.clientX;downY=e.clientY;didDrag=false;if(e.detail>1)e.preventDefault();}); // e.detail>1：双击/三击 → 阻止浏览器选词/选段（连点翻页常被当双击而误选）
  document.addEventListener('mousemove',function(e){if(downX!==null&&(Math.abs(e.clientX-downX)>4||Math.abs(e.clientY-downY)>4))didDrag=true;});
  var macFastTap=null;
  var isMacWebKit=IS_MAC_WEBKIT;
  function tapHasSelection(){
    var sel=window.getSelection?window.getSelection():null;
    return !!(sel&&!sel.isCollapsed&&sel.toString().trim());
  }
  function handleReaderTap(e){
    parent.postMessage({uiClick:1},'*');
    var x=e.clientX;
    if(overlayOpen){
      // 关闭浮层的同一次中间点击也切换工具栏，不要求用户再点一次。
      if(x>=window.innerWidth*0.4&&x<=window.innerWidth*0.6)parent.postMessage({centerTap:1},'*');
      return;
    }
    // 点到已高亮的文字 → 出高亮菜单，不翻页
    var hm=e.target.closest?e.target.closest('.hl-rect[data-hi],mark.hl'):null;
    if(hm){e.stopPropagation();showHlMenu(parseInt(hm.getAttribute('data-hi'),10),true,hm,e);return;}
    if(e.target.closest&&e.target.closest('#fn-pop'))return; // 注释弹窗内点击：不翻页
    var a=e.target.closest?e.target.closest('a'):null;
    if(a){var href=a.getAttribute('href')||'';
      if(href.charAt(0)==='#'){e.preventDefault();
        var m=/^#c(\d+)(?:~(.+))?$/.exec(href);
        var frag=m?m[2]:href.slice(1), ciT=m?parseInt(m[1],10):curCh;
        if(pageDebugSettingOn('reader_footnotes')&&isNoteLink(a)&&frag){showFootnote(a,ciT,frag);return;} // 注释角标 → 弹注释正文
        if(m){var ci=ciT,fr=frag;if(ci===curCh){if(fr){var el=document.getElementById(fr);if(el)gotoPage(pageOf(el));}}else showChapter(ci,'start',fr);}
        else{var el2=document.getElementById(href.slice(1));if(el2)gotoPage(pageOf(el2));}
      }
      return;
    }
    hideFn(); // 点别处 → 收起注释弹窗
    // 拖动选字（或存在选中文字）时不翻页，让 web 搜索菜单稳定停在高亮处
    if(didDrag||tapHasSelection()){return;}
    var tapStarted=performance.now();
    if(x>window.innerWidth*0.6){nextPage();reportReaderPaintPerf('tap_next',tapStarted,'chapter='+curCh);}
    else if(x<window.innerWidth*0.4){prevPage();reportReaderPaintPerf('tap_prev',tapStarted,'chapter='+curCh);}
    else parent.postMessage({centerTap:1},'*');
  }
  // macOS 的 WKWebView 在部分点击序列中较晚派发 click。只对正文空白/文字区
  // 使用更早的 pointerup 翻页，并吞掉紧随其后的 click，避免 Windows 行为变化。
  if(isMacWebKit)document.addEventListener('pointerup',function(e){
    if(e.button!==0||e.isPrimary===false||didDrag||tapHasSelection())return;
    if(e.target.closest&&e.target.closest('a,button,input,select,textarea,#fn-pop,.hl-rect[data-hi],mark.hl'))return;
    macFastTap={at:Date.now(),x:e.clientX,y:e.clientY,target:e.target};
    handleReaderTap(e);
  });
  document.addEventListener('click',function(e){
    if(macFastTap&&Date.now()-macFastTap.at<700&&macFastTap.target===e.target&&Math.abs(macFastTap.x-e.clientX)<5&&Math.abs(macFastTap.y-e.clientY)<5){
      macFastTap=null;e.preventDefault();e.stopPropagation();return;
    }
    macFastTap=null;
    handleReaderTap(e);
  });
  document.addEventListener('keydown',function(e){if(((e.ctrlKey||e.metaKey)&&(e.key==='f'||e.key==='F'))||e.key==='F3')e.preventDefault();},true); // 禁用浏览器自带查找
  document.addEventListener('keydown',function(e){
    if(e.key==='PageDown'||e.key==='ArrowRight'||e.key==='ArrowDown'||(e.key===' '&&!e.shiftKey)){e.preventDefault();userNav();nextPage();}
    else if(e.key==='PageUp'||e.key==='ArrowLeft'||e.key==='ArrowUp'||(e.key===' '&&e.shiftKey)){e.preventDefault();userNav();prevPage();}
  });
  var wheelLock=false,scrollChapterLock=false;
  document.addEventListener('wheel',function(e){
    if(isScrollMode()){
      userNav();
      scrollProgrammaticTarget=null;
      if(scrollPagedView){
        var sp0=scrollPort(),top0=sp0?Math.round(sp0.scrollTop||0):0;
        var slice0=activeScrollSliceAtTop(top0);
        var d0=wheelDeltaPx(e);
        if(Math.abs(d0)<4)d0=0;
        var stableTop=top0;
        if(slice0&&sp0){
          stableTop=Math.max(0,Math.min(scrollMaxTop(),Math.round(slice0.top||top0)));
        }
        var targetTop=sp0?Math.max(0,Math.min(scrollMaxTop(),stableTop+d0)):stableTop;
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
      var d=wheelDeltaPx(e);
      if(d>0&&curCh<CH-1&&canLeaveScrollChapter(1)){
        e.preventDefault();scrollChapterLock=true;showChapter(curCh+1,'start').finally(function(){setTimeout(function(){scrollChapterLock=false;},180);});
      }else if(d<0&&curCh>0&&canLeaveScrollChapter(-1)){
        e.preventDefault();scrollChapterLock=true;showChapter(curCh-1,'end').finally(function(){setTimeout(function(){scrollChapterLock=false;},180);});
      }
      return;
    }
    e.preventDefault();if(wheelLock)return;if(Math.abs(e.deltaY)<4&&Math.abs(e.deltaX)<4)return;userNav();if(e.deltaY>0||e.deltaX>0)nextPage();else prevPage();wheelLock=true;setTimeout(function(){wheelLock=false;},220);
  },{passive:false});
  window.addEventListener('resize',function(){parent.postMessage({layoutBusy:1},'*');invalidateMeasure();relayout();scheduleMeasure();});
  setupSelMenu();
  setupHlUi();
  setupFn();
  setupDict();
  document.addEventListener('contextmenu',function(e){e.preventDefault();}); // 禁用浏览器右键菜单
}
// 选中文字后弹出“web搜索”菜单 → 通知父窗口用浏览器搜索
var selMenu=null,hlSettingsPop=null,selMenuItems=[],hlMenuItems=[];
var HL_MENU_CFG_KEY='highlightMenuActionsV1';
var HL_MENU_CFG_VERSION_KEY='highlightMenuActionsVersionV1';
var HL_MENU_MODE_KEY='highlightMenuDisplayModeV1';
var HL_MENU_SIZE_KEY='highlightMenuSizeV1';
var HL_MENU_ACTIONS=[
  {key:'web',label:'web搜索',icon:'🔍'},
  {key:'dict',label:'词典',icon:'📖'},
  {key:'translate',label:'翻译',icon:'译'},
  {key:'copy',label:'复制',icon:'📋'},
  {key:'highlight',label:'高亮',icon:'🖍'},
  {key:'correct',label:'改错',icon:'✎'},
  {key:'excerpt',label:'书摘',icon:'▣'},
  {key:'cross',label:'跨书搜索',icon:'📚'},
  {key:'semantic',label:'相似语义',icon:'≈'},
  {key:'note',label:'批注',icon:'📝'},
  {key:'bookmark',label:'书签',icon:'🔖'}
];
function defaultHlMenuConfig(){return HL_MENU_ACTIONS.map(function(a){return {key:a.key,show:true};});}
function hlActionLabel(key){for(var i=0;i<HL_MENU_ACTIONS.length;i++){if(HL_MENU_ACTIONS[i].key===key)return HL_MENU_ACTIONS[i].label;}return key;}
function hlActionIcon(key){for(var i=0;i<HL_MENU_ACTIONS.length;i++){if(HL_MENU_ACTIONS[i].key===key)return HL_MENU_ACTIONS[i].icon||'';}return '';}
function readHlMenuMode(){var m='';try{m=localStorage.getItem(HL_MENU_MODE_KEY)||'';}catch(_){}return (m==='text'||m==='icon'||m==='both')?m:'both';}
function saveHlMenuMode(mode){localStorage.setItem(HL_MENU_MODE_KEY,mode);}
function readHlMenuSize(){var s='';try{s=localStorage.getItem(HL_MENU_SIZE_KEY)||'';}catch(_){}return (s==='medium'||s==='large'||s==='small')?s:'small';}
function saveHlMenuSize(size){localStorage.setItem(HL_MENU_SIZE_KEY,size);}
function updateMenuSizeClass(container){
  if(!container)return;
  var size=readHlMenuSize();
  container.classList.remove('hm-size-small','hm-size-medium','hm-size-large');
  container.classList.add('hm-size-'+size);
}
function updateActionButton(it){
  if(!it||!it.button)return;
  var mode=readHlMenuMode(),label=it.label||hlActionLabel(it.key),icon=it.icon||hlActionIcon(it.key);
  it.button.title=label;it.button.setAttribute('aria-label',label);
  if(mode==='icon')it.button.textContent=icon||label;
  else if(mode==='text')it.button.textContent=label;
  else it.button.textContent=(icon?icon+' ':'')+label;
}
function refreshConfiguredMenus(){
  applyConfiguredMenu(selMenu,selMenuItems,selMenu&&selMenu._setBtn);
  applyConfiguredMenu(hlMenu,hlMenuItems,hlMenu&&hlMenu._setBtn);
}
function readHlMenuConfig(){
  var raw=null;try{raw=JSON.parse(localStorage.getItem(HL_MENU_CFG_KEY)||'null');}catch(_){}
  var known={};HL_MENU_ACTIONS.forEach(function(a){known[a.key]=true;});
  var out=[],seen={},changed=false;
  if(Array.isArray(raw)){
    raw.forEach(function(x){
      var key=String((x&&x.key)||'');
      if(!known[key]||seen[key])return;
      seen[key]=true;out.push({key:key,show:x.show!==false});
    });
  }
  function insertMissingAction(a){
    var canonicalIndex=HL_MENU_ACTIONS.findIndex(function(x){return x.key===a.key;});
    var insertAt=out.length;
    for(var i=canonicalIndex-1;i>=0;i--){
      var prevKey=HL_MENU_ACTIONS[i].key;
      var prevPos=out.findIndex(function(x){return x.key===prevKey;});
      if(prevPos>=0){insertAt=prevPos+1;break;}
    }
    if(insertAt===out.length){
      for(var j=canonicalIndex+1;j<HL_MENU_ACTIONS.length;j++){
        var nextKey=HL_MENU_ACTIONS[j].key;
        var nextPos=out.findIndex(function(x){return x.key===nextKey;});
        if(nextPos>=0){insertAt=nextPos;break;}
      }
    }
    out.splice(insertAt,0,{key:a.key,show:true});
    seen[a.key]=true;
    changed=true;
  }
  HL_MENU_ACTIONS.forEach(function(a){if(!seen[a.key])insertMissingAction(a);});
  try{
    var ver=localStorage.getItem(HL_MENU_CFG_VERSION_KEY)||'';
    if(ver!=='2'){changed=true;localStorage.setItem(HL_MENU_CFG_VERSION_KEY,'2');}
    if(changed)saveHlMenuConfig(out);
  }catch(_){}
  return out;
}
function saveHlMenuConfig(cfg){localStorage.setItem(HL_MENU_CFG_KEY,JSON.stringify(cfg));}
function applyConfiguredMenu(container,items,setBtn){
  if(!container)return;
  updateMenuSizeClass(container);
  var cfg=readHlMenuConfig(),map={};
  items.forEach(function(it){map[it.key]=it;});
  items.forEach(function(it){if(it.button&&it.button.parentNode===container)container.removeChild(it.button);});
  if(setBtn&&setBtn.parentNode===container)container.removeChild(setBtn);
  cfg.forEach(function(c){var it=map[c.key];if(it&&c.show!==false){updateActionButton(it);container.appendChild(it.button);}});
  if(setBtn)container.appendChild(setBtn);
}
function renderHlSettings(){
  if(!hlSettingsPop)return;
  var cfg=readHlMenuConfig();
  hlSettingsPop.innerHTML='<div class="hs-mode"><span class="hs-mode-label">显示</span><span class="hs-mode-buttons hs-display-buttons"><button type="button" data-mode="both">图文</button><button type="button" data-mode="text">文字</button><button type="button" data-mode="icon">图标</button></span></div><div class="hs-mode"><span class="hs-mode-label">大小</span><span class="hs-mode-buttons hs-size-buttons"><button type="button" data-size="small">小</button><button type="button" data-size="medium">中</button><button type="button" data-size="large">大</button></span></div><div class="hs-list"></div>';
  var mode=readHlMenuMode();
  [].slice.call(hlSettingsPop.querySelectorAll('.hs-display-buttons button')).forEach(function(b){
    b.className=b.dataset.mode===mode?'on':'';
    b.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();saveHlMenuMode(b.dataset.mode);
      renderHlSettings();refreshConfiguredMenus();
    });
  });
  var size=readHlMenuSize();
  [].slice.call(hlSettingsPop.querySelectorAll('.hs-size-buttons button')).forEach(function(b){
    b.className=b.dataset.size===size?'on':'';
    b.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();saveHlMenuSize(b.dataset.size);
      renderHlSettings();refreshConfiguredMenus();
    });
  });
  var list=hlSettingsPop.querySelector('.hs-list'),dragState=null;
  function saveCurrentOrder(){
    var old=readHlMenuConfig(),show={};old.forEach(function(x){show[x.key]=x.show!==false;});
    var next=[].slice.call(list.querySelectorAll('.hs-row')).map(function(r){return {key:r.dataset.key,show:show[r.dataset.key]!==false};});
    saveHlMenuConfig(next);refreshConfiguredMenus();
  }
  function animateRowsAroundInsert(beforeNode){
      if(!dragState)return;
      var ph=dragState.placeholder;
      if((beforeNode&&beforeNode===ph)||ph.nextSibling===beforeNode)return;
      if(!beforeNode&&ph===list.lastElementChild)return;
      var beforePos=new Map();
      [].slice.call(list.children).forEach(function(r){if(r!==dragState.row)beforePos.set(r,r.getBoundingClientRect().top);});
      list.insertBefore(ph,beforeNode||null);
      [].slice.call(list.children).forEach(function(r){
        if(r===dragState.row)return;
        var first=beforePos.get(r);if(first===undefined)return;
        var last=r.getBoundingClientRect().top,dy=first-last;
        if(!dy)return;
        r.style.transition='none';r.style.transform='translateY('+dy+'px)';
        r.getBoundingClientRect();
        requestAnimationFrame(function(){r.style.transition='transform .18s cubic-bezier(.2,.8,.2,1),background .16s ease,border-color .16s ease,box-shadow .16s ease';r.style.transform='';});
      });
  }
  function moveDraggedRow(clientY){
    if(!dragState)return;
    var row=dragState.row;
    row.style.top=(clientY-dragState.offsetY)+'px';
    var rows=[].slice.call(list.querySelectorAll('.hs-row')).filter(function(r){return r!==row;});
    for(var i=0;i<rows.length;i++){
      var box=rows[i].getBoundingClientRect();
      if(clientY<box.top+box.height/2){animateRowsAroundInsert(rows[i]);return;}
    }
    animateRowsAroundInsert(null);
  }
  cfg.forEach(function(c){
    var row=document.createElement('div');row.className='hs-row';row.dataset.key=c.key;
    var name=document.createElement('span');name.className='hs-name';name.textContent=hlActionLabel(c.key);
    var sw=document.createElement('label');sw.className='hs-switch';
    var input=document.createElement('input');input.type='checkbox';input.checked=c.show!==false;
    var slider=document.createElement('span');slider.className='hs-slider';sw.append(input,slider);
    var grip=document.createElement('button');grip.type='button';grip.className='hs-grip';grip.title='拖动排序';
    row.append(name,sw,grip);list.appendChild(row);
    input.addEventListener('change',function(){
      var next=readHlMenuConfig();next.forEach(function(x){if(x.key===c.key)x.show=input.checked;});
      saveHlMenuConfig(next);refreshConfiguredMenus();
    });
    grip.addEventListener('pointerdown',function(e){
      e.preventDefault();e.stopPropagation();
      var box=row.getBoundingClientRect();
      var ph=document.createElement('div');ph.className='hs-placeholder';
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
    function finishDrag(e){
      if(!dragState)return;
      if(e){e.preventDefault();e.stopPropagation();try{grip.releasePointerCapture(e.pointerId);}catch(_){}}
      var st=dragState;dragState=null;
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
function hideHlSettings(){if(hlSettingsPop)hlSettingsPop.style.display='none';}
var hlTextPop=null,excerptPage=null,excerptText='',correctDraft=null;
function hideHlTextPop(){if(hlTextPop)hlTextPop.style.display='none';}
function ensureHighlightTextPop(){
  if(!hlTextPop){
    hlTextPop=document.createElement('div');hlTextPop.id='hl-text-pop';
    hlTextPop.innerHTML='<button class="ht-close" type="button">×</button><div class="ht-title">改错</div><div class="ht-original"></div><textarea></textarea><div class="ht-row"><button class="act cancel" type="button">取消</button><button class="act save" type="button">保存</button></div>';
    document.body.appendChild(hlTextPop);
    ['mousedown','mouseup','click','wheel'].forEach(function(t){hlTextPop.addEventListener(t,function(e){e.stopPropagation();});});
    hlTextPop.querySelector('.ht-close').addEventListener('click',hideHlTextPop);
    hlTextPop.querySelector('.cancel').addEventListener('click',hideHlTextPop);
    hlTextPop.querySelector('.save').addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      var text=hlTextPop.querySelector('textarea').value;
      if(correctDraft){
        var d=Object.assign({},correctDraft,{correctedText:text});
        parent.postMessage({addHighlightCorrectDraft:d},'*');
        correctDraft=null;
      }else if(activeHi>=0)parent.postMessage({setHighlightText:{index:activeHi,text:text}},'*');
      hideHlTextPop();
    });
    document.addEventListener('mousedown',function(e){if(hlTextPop&&hlTextPop.style.display==='block'&&!hlTextPop.contains(e.target))hideHlTextPop();},true);
  }
}
function placeHighlightTextPop(rect){
  var r=rect||{left:window.innerWidth/2,top:window.innerHeight/2,bottom:window.innerHeight/2,width:0};
  hlTextPop.style.display='block';
  var w=hlTextPop.offsetWidth||520,hp=hlTextPop.offsetHeight||260;
  var left=r.left+(r.width||0)/2-w/2;left=Math.max(8,Math.min(window.innerWidth-w-8,left));
  var top=r.bottom+10;if(top+hp>window.innerHeight-8)top=r.top-hp-10;if(top<8)top=8;
  hlTextPop.style.left=left+'px';hlTextPop.style.top=top+'px';
  setTimeout(function(){try{hlTextPop.querySelector('textarea').focus();hlTextPop.querySelector('textarea').select();}catch(_){}},0);
}
function showHighlightTextEditor(idx){
  var h=HL[idx];if(!h)return;
  ensureHighlightTextPop();
  correctDraft=null;
  activeHi=idx;
  hlTextPop.querySelector('.ht-original').textContent='原文：'+(h.text||'');
  hlTextPop.querySelector('textarea').value=highlightDisplayText(h);
  var el=markEl(idx),r=el?el.getBoundingClientRect():{left:window.innerWidth/2,top:window.innerHeight/2,bottom:window.innerHeight/2,width:0};
  placeHighlightTextPop(r);
}
function showCorrectionDraft(o,rect){
  if(!o)return;
  ensureHighlightTextPop();
  correctDraft=o;
  activeHi=-1;
  hlTextPop.querySelector('.ht-original').textContent='原文：'+(o.text||'');
  hlTextPop.querySelector('textarea').value=o.text||'';
  placeHighlightTextPop(rect);
}
function hideExcerptPage(){if(excerptPage)excerptPage.style.display='none';}
function showExcerptPage(text){
  var t=(text||'').trim();if(!t)return;
  excerptText=t;
  if(!excerptPage){
    excerptPage=document.createElement('div');excerptPage.id='excerpt-page';
    excerptPage.innerHTML='<div class="ex-card"><div class="ex-head"><div class="ex-title">书摘</div><button class="ex-close" type="button">×</button></div><div class="ex-body"><div class="ex-quote"></div></div><div class="ex-foot"><span class="ex-status"></span><button class="ex-download" type="button">下载图片</button></div></div>';
    document.body.appendChild(excerptPage);
    excerptPage.querySelector('.ex-close').addEventListener('click',hideExcerptPage);
    excerptPage.querySelector('.ex-download').addEventListener('click',downloadExcerptImage);
    excerptPage.addEventListener('mousedown',function(e){if(e.target===excerptPage)hideExcerptPage();e.stopPropagation();});
    excerptPage.addEventListener('wheel',function(e){e.stopPropagation();},{passive:true});
  }
  excerptPage.querySelector('.ex-quote').textContent=t;
  var st=excerptPage.querySelector('.ex-status');if(st)st.textContent='';
  excerptPage.style.display='block';
}
function canvasWrappedLines(ctx,text,maxW){
  var out=[],paras=String(text||'').split(/\n/);
  paras.forEach(function(p,pi){
    var line='';
    for(var i=0;i<p.length;i++){
      var next=line+p[i];
      if(line&&ctx.measureText(next).width>maxW){out.push(line);line=p[i];}
      else line=next;
    }
    out.push(line);
    if(pi<paras.length-1)out.push('');
  });
  return out;
}
function downloadExcerptImage(){
  var text=excerptText||'';if(!text.trim())return;
  var st=excerptPage&&excerptPage.querySelector?excerptPage.querySelector('.ex-status'):null;
  if(st)st.textContent='正在生成图片...';
  var scale=Math.max(2,Math.min(3,window.devicePixelRatio||2));
  var cssW=900,pad=72,font=34,lineH=62;
  var canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  ctx.font=font+'px "Microsoft YaHei", system-ui, sans-serif';
  var lines=canvasWrappedLines(ctx,text,cssW-pad*2);
  var cssH=Math.max(520,pad*2+lines.length*lineH+90);
  canvas.width=Math.round(cssW*scale);canvas.height=Math.round(cssH*scale);
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.fillStyle='#fbf7ed';ctx.fillRect(0,0,cssW,cssH);
  var g=ctx.createLinearGradient(0,0,cssW,cssH);g.addColorStop(0,'rgba(255,255,255,.55)');g.addColorStop(1,'rgba(210,185,135,.2)');ctx.fillStyle=g;ctx.fillRect(0,0,cssW,cssH);
  ctx.fillStyle='#2b2419';ctx.font=font+'px "Microsoft YaHei", system-ui, sans-serif';ctx.textBaseline='top';
  for(var i=0;i<lines.length;i++)ctx.fillText(lines[i],pad,pad+i*lineH);
  ctx.fillStyle='rgba(75,58,37,.54)';ctx.font='22px "Microsoft YaHei", system-ui, sans-serif';ctx.fillText('书摘',pad,cssH-pad+18);
  var dataUrl=canvas.toDataURL('image/png');
  try{
    if(parent&&parent!==window){
      parent.postMessage({downloadImage:{name:'书摘.png',dataUrl:dataUrl}},'*');
      return;
    }
  }catch(_){}
  var a=document.createElement('a');a.download='书摘.png';a.href=dataUrl;document.body.appendChild(a);a.click();a.remove();
  if(st)st.textContent='已开始下载';
}
function copyTextToClipboard(text){
  var t=(text||'').trim();if(!t)return;
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).catch(function(){fallbackCopyText(t);});return;}
  fallbackCopyText(t);
}
function fallbackCopyText(t){
  try{
    var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.left='-9999px';ta.style.top='0';
    document.body.appendChild(ta);ta.focus();ta.select();document.execCommand('copy');ta.remove();
  }catch(_){}
}
function showHlSettings(anchor){
  if(!hlSettingsPop){
    hlSettingsPop=document.createElement('div');hlSettingsPop.id='hl-settings-pop';
    document.body.appendChild(hlSettingsPop);
    ['mousedown','mouseup','click','wheel'].forEach(function(t){hlSettingsPop.addEventListener(t,function(e){e.stopPropagation();});});
    document.addEventListener('mousedown',function(e){if(!hlSettingsPop||hlSettingsPop.style.display==='none')return;if(hlSettingsPop.contains(e.target))return;hideHlSettings();},true);
  }
  renderHlSettings();
  var r=(anchor&&anchor._anchorRect)||((anchor&&anchor.getBoundingClientRect)?anchor.getBoundingClientRect():{left:window.innerWidth/2,top:window.innerHeight/2,right:window.innerWidth/2,bottom:window.innerHeight/2,width:0});
  var w=340,h=Math.min(420,window.innerHeight-18),left=r.left+(r.width||0)/2-w/2;
  left=Math.max(8,Math.min(window.innerWidth-w-8,left));
  var top=r.top-h-10;if(top<8)top=r.bottom+10;
  if(top+h>window.innerHeight-8)top=Math.max(8,window.innerHeight-h-8);
  hlSettingsPop.style.left=left+'px';hlSettingsPop.style.top=top+'px';hlSettingsPop.style.display='block';
}
// ---- 翻译面板：UI 先就位；实际 API 需用户配置后才发送文本到外部服务 ----
var trPop=null,trRect=null,trText='',trCredentialDirty=false,trCredentialStatus={};
function hideTranslate(){if(trPop)trPop.style.display='none';}
function setupTranslate(){
  trPop=document.createElement('div');trPop.id='tr-pop';
  trPop.innerHTML='<div class="tr-row"><div><div class="tr-title">原文</div><div class="tr-text tr-src"></div></div><select class="tr-select tr-source"><option value="auto">自动检测</option><option value="zh-CN">中文</option><option value="en">英文</option><option value="ja">日文</option><option value="ko">韩文</option></select></div><div class="tr-sep"></div><div class="tr-row"><div><div class="tr-title">译文</div><div class="tr-text tr-dst tr-muted">加载中...</div></div><select class="tr-select tr-target"><option value="system">系统语言</option><option value="zh-CN">中文</option><option value="en">英文</option><option value="ja">日文</option><option value="ko">韩文</option></select></div><div class="tr-provider"><select class="tr-select tr-api"><option value="baidu">百度</option><option value="tencent">腾讯</option><option value="deepl">DeepL</option><option value="google">Google</option></select></div><div class="tr-api-fields"><input class="tr-input tr-api-id"><input class="tr-input tr-api-key" type="password"></div>';
  document.body.appendChild(trPop);
  try{
    trPop.querySelector('.tr-api').value=localStorage.getItem('translateProvider')||'baidu';
    trPop.querySelector('.tr-source').value=localStorage.getItem('translateSourceLang')||'auto';
    trPop.querySelector('.tr-target').value=localStorage.getItem('translateTargetLang')||'system';
  }catch(_){}
  trPop.addEventListener('mousedown',function(e){e.stopPropagation();});
  trPop.addEventListener('click',function(e){e.stopPropagation();});
  ['.tr-source','.tr-target'].forEach(function(sel){trPop.querySelector(sel).addEventListener('change',function(){saveTranslatePrefs();requestTranslate();});});
  trPop.querySelector('.tr-api').addEventListener('change',function(){try{localStorage.setItem('translateProvider',trPop.querySelector('.tr-api').value);}catch(_){} updateTranslateApiFields();requestTranslate();});
  ['.tr-api-id','.tr-api-key'].forEach(function(sel){trPop.querySelector(sel).addEventListener('input',function(){trCredentialDirty=true;});trPop.querySelector(sel).addEventListener('change',function(){requestTranslate();});});
  document.addEventListener('mousedown',function(e){if(trPop&&trPop.style.display==='block'&&!trPop.contains(e.target))hideTranslate();});
  document.addEventListener('wheel',function(){hideTranslate();},{passive:true});
  migrateLegacyTranslateCredentials();updateTranslateApiFields();
}
function translateApiStorageKey(provider,field){
  if(provider==='baidu')return field==='id'?'translateBaiduAppId':'translateBaiduKey';
  return 'translate_'+provider+'_'+field;
}
function translateApiLabel(provider){
  if(provider==='baidu')return {id:'百度 AppID',key:'百度密钥'};
  if(provider==='tencent')return {id:'腾讯 SecretId',key:'腾讯 SecretKey'};
  if(provider==='deepl')return {id:'DeepL API Key',key:'DeepL 预留密钥（可空）'};
  if(provider==='google')return {id:'Google API Key',key:'Google 预留密钥（可空）'};
  return {id:'AppID / API Key',key:'密钥'};
}
function saveTranslatePrefs(){
  try{
    var provider=trPop.querySelector('.tr-api').value;
    localStorage.setItem('translateProvider',provider);
    localStorage.setItem('translateSourceLang',trPop.querySelector('.tr-source').value);
    localStorage.setItem('translateTargetLang',trPop.querySelector('.tr-target').value);
  }catch(_){}
}
function migrateLegacyTranslateCredentials(){
  ['baidu','tencent','deepl','google'].forEach(function(provider){
    try{
      var idKey=translateApiStorageKey(provider,'id'),secretKey=translateApiStorageKey(provider,'key');
      var apiId=(localStorage.getItem(idKey)||'').trim(),apiKey=(localStorage.getItem(secretKey)||'').trim();
      localStorage.removeItem(idKey);localStorage.removeItem(secretKey);
      if(apiId&&((provider!=='baidu'&&provider!=='tencent')||apiKey)){
        parent.postMessage({saveTranslationCredential:{provider:provider,apiId:apiId,apiKey:apiKey}},'*');
      }
    }catch(_){}
  });
}
function updateTranslateApiFields(){
  if(!trPop)return;
  var provider=trPop.querySelector('.tr-api').value;
  var label=translateApiLabel(provider);
  var idInput=trPop.querySelector('.tr-api-id'),keyInput=trPop.querySelector('.tr-api-key');
  var configured=trCredentialStatus[provider]&&trCredentialStatus[provider].configured;
  idInput.placeholder=label.id+(configured?'（已安全保存，留空沿用）':'');
  keyInput.placeholder=label.key+(configured?'（已安全保存，留空沿用）':'');
  idInput.value='';keyInput.value='';trCredentialDirty=false;
  parent.postMessage({getTranslationCredentialStatus:provider},'*');
}
function placeTranslate(){
  trPop.style.display='block';
  var ph=trPop.offsetHeight,r=trRect||{left:window.innerWidth/2,right:window.innerWidth/2,top:120,bottom:120,width:0};
  var pw=trPop.offsetWidth||520;
  var left=r.left+(r.width||0)/2-pw/2;left=Math.max(8,Math.min(window.innerWidth-pw-8,left));
  var top=r.bottom+10;if(top+ph>window.innerHeight-8)top=r.top-ph-10;
  if(top<8)top=8;
  trPop.style.left=left+'px';trPop.style.top=top+'px';
}
function openTranslate(text,rect){
  var t=(text||'').trim();if(!t)return;
  if(!trPop)setupTranslate();
  trText=t;trRect=rect||null;
  trPop.querySelector('.tr-src').textContent=t;
  trPop.querySelector('.tr-dst').textContent='加载中...';
  trPop.querySelector('.tr-dst').className='tr-text tr-dst tr-muted';
  placeTranslate();requestTranslate();
}
function requestTranslate(){
  if(!trPop||trPop.style.display==='none')return;
  var api=trPop.querySelector('.tr-api').value;
  var dst=trPop.querySelector('.tr-dst');
  saveTranslatePrefs();
  var apiId=trPop.querySelector('.tr-api-id').value.trim(),apiKey=trPop.querySelector('.tr-api-key').value.trim();
  if(trCredentialDirty){
    if(!apiId||(api==='baidu'||api==='tencent')&&!apiKey){
      var dirtyLabel=translateApiLabel(api);
      dst.textContent=(api==='deepl'||api==='google')?'请填写'+dirtyLabel.id+'。':'请填写'+dirtyLabel.id+' 和 '+dirtyLabel.key+'。';
      dst.className='tr-text tr-dst tr-error';placeTranslate();return;
    }
    dst.textContent='正在安全保存凭据...';dst.className='tr-text tr-dst tr-muted';placeTranslate();
    parent.postMessage({saveTranslationCredential:{provider:api,apiId:apiId,apiKey:apiKey}},'*');return;
  }
  var status=trCredentialStatus[api];
  if(!status){dst.textContent='正在检查凭据配置...';dst.className='tr-text tr-dst tr-muted';parent.postMessage({getTranslationCredentialStatus:api},'*');placeTranslate();return;}
  if(!status.configured){
    var label=translateApiLabel(api);
    dst.textContent=(api==='deepl'||api==='google')?'请先填写'+label.id+'。':'请先填写'+label.id+' 和 '+label.key+'。';
    dst.className='tr-text tr-dst tr-error';
    placeTranslate();return;
  }
  dst.textContent='加载中...';dst.className='tr-text tr-dst tr-muted';placeTranslate();
  parent.postMessage({translateText:{text:trText,source:trPop.querySelector('.tr-source').value,target:trPop.querySelector('.tr-target').value,provider:api,credentialConfigId:status.config_id||('translate:'+api)}},'*');
}
function showTranslateResult(r){
  if(!trPop)return;
  var dst=trPop.querySelector('.tr-dst');
  if(r&&r.ok){dst.textContent=r.translated||'';dst.className='tr-text tr-dst';}
  else{dst.textContent=(r&&r.error)||'翻译失败';dst.className='tr-text tr-dst tr-error';}
  placeTranslate();
}
function setupSelMenu(){
  selMenu=document.createElement('div');selMenu.id='sel-menu';
  var btn=document.createElement('button');btn.type='button';btn.textContent='🔍 web搜索';
  var btnDict=document.createElement('button');btnDict.type='button';btnDict.textContent='📖 词典';
  var btnTr=document.createElement('button');btnTr.type='button';btnTr.textContent='译 翻译';
  var btnCopy=document.createElement('button');btnCopy.type='button';btnCopy.textContent='复制';
  var btnHL=document.createElement('button');btnHL.type='button';btnHL.textContent='🖍 高亮';
  var btnCorrect=document.createElement('button');btnCorrect.type='button';btnCorrect.textContent='✎ 改错';
  var btnExcerpt=document.createElement('button');btnExcerpt.type='button';btnExcerpt.textContent='▣ 书摘';
  var btnCross=document.createElement('button');btnCross.type='button';btnCross.textContent='跨书搜索';
  var btnSemantic=document.createElement('button');btnSemantic.type='button';btnSemantic.textContent='≈ 相似语义';
  var btnNote=document.createElement('button');btnNote.type='button';btnNote.textContent='📝 批注';
  var btnBm=document.createElement('button');btnBm.type='button';btnBm.textContent='🔖 书签';
  var btnSet=document.createElement('button');btnSet.type='button';btnSet.textContent='⚙';
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
    {key:'note',button:btnNote},
    {key:'bookmark',button:btnBm}
  ];
  selMenu._setBtn=btnSet;
  applyConfiguredMenu(selMenu,selMenuItems,btnSet);
  document.body.appendChild(selMenu);
  [btn,btnDict,btnTr,btnCopy,btnHL,btnCorrect,btnExcerpt,btnCross,btnSemantic,btnNote,btnBm,btnSet].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  btnDict.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    if(t)openDict(t,getSelContext());
    hideSelMenu();
  });
  btnTr.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    var r=null;try{var s=window.getSelection();r=(s&&s.rangeCount)?s.getRangeAt(0).getBoundingClientRect():null;}catch(_){}
    if(t)openTranslate(t,r);
    hideSelMenu();
  });
  btnBm.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    var frac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
    parent.postMessage({addBookmark:{chapter:curCh,frac:frac,label:t.slice(0,40)}},'*');
    hideSelMenu();
  });
  btn.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    if(t)parent.postMessage({webSearch:t},'*');
    hideSelMenu();
  });
  btnHL.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();parent.postMessage({addHighlight:o},'*');}
    if(window.getSelection)window.getSelection().removeAllRanges();
    hideSelMenu();
  });
  btnCorrect.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var r=null;try{var s=window.getSelection();r=(s&&s.rangeCount)?s.getRangeAt(0).getBoundingClientRect():null;}catch(_){}
    var o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();showCorrectionDraft(o,r);}
    if(window.getSelection)window.getSelection().removeAllRanges();
    hideSelMenu();
  });
  btnExcerpt.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    hideSelMenu();
    if(t)showExcerptPage(t);
  });
  btnCross.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    if(t)parent.postMessage({crossSearch:t},'*');
    hideSelMenu();
  });
  btnSemantic.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    if(t)parent.postMessage({semanticSearch:t},'*');
    hideSelMenu();
  });
  btnNote.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();parent.postMessage({addHighlightNote:o},'*');}
    if(window.getSelection)window.getSelection().removeAllRanges();
    hideSelMenu();
  });
  btnCopy.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    copyTextToClipboard(t);
    hideSelMenu();
  });
  btnSet.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();showHlSettings(selMenu);});
  function showSelMenuAtSelection(){
    var sel=window.getSelection?window.getSelection():null;
    var t=sel?sel.toString().trim():'';
    if(!t){hideSelMenu();return;}
    var hi=selectedHighlightIndex();
    if(hi>=0){hideSelMenu();showHlMenu(hi,true);return;}
    hideHlMenu(); // 出选区菜单时，先收起"已高亮"菜单，保证同时只有一个
    var rect;try{rect=sel.getRangeAt(0).getBoundingClientRect();}catch(_){hideSelMenu();return;}
    if(!rect||(!rect.width&&!rect.height)){hideSelMenu();return;}
    selMenu._anchorRect=rect;
    applyConfiguredMenu(selMenu,selMenuItems,selMenu._setBtn);
    selMenu.style.display='block';
    var mw=selMenu.offsetWidth||100,mh=selMenu.offsetHeight||34;
    var left=rect.left+rect.width/2-mw/2;left=Math.max(6,Math.min(window.innerWidth-mw-6,left));
    var top=rect.top-mh-8;if(top<6)top=rect.bottom+8;
    selMenu.style.left=left+'px';selMenu.style.top=top+'px';
  }
  document.addEventListener('mouseup',function(e){
    if(selMenu&&selMenu.contains(e.target))return; // 在选区菜单上松开（如点"高亮"按钮）：保留选区，别清
    if((dictPop&&dictPop.contains(e.target))||(fnPop&&fnPop.contains(e.target)))return; // 在词典/注释弹窗内选字：正常选中、不弹高亮菜单
    setTimeout(function(){
      // 非拖动（单击/双击/连点翻页）：清掉任何选区并收菜单，避免单击误选/误高亮文本
      if(!didDrag){if(window.getSelection)window.getSelection().removeAllRanges();hideSelMenu();return;}
      showSelMenuAtSelection(); // 只有按住拖动选择才弹菜单
    },0);
  });
  document.addEventListener('mousedown',function(e){if(selMenu&&!selMenu.contains(e.target))hideSelMenu();});
  document.addEventListener('wheel',hideSelMenu,{passive:true});
  document.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.shiftKey&&(e.key==='s'||e.key==='S'))return; // 截图快捷键：保留菜单，方便截到高亮工具栏
    hideSelMenu();
  });
}
// ---- 点击/悬停"已高亮文字" → 一个菜单（web搜索 / 取消高亮 / 批注）；批注用父窗口的大批注页 ----
var hlMenu=null,activeHi=-1,hlHideTimer=null;
function mkBtn(txt){var b=document.createElement('button');b.type='button';b.textContent=txt;return b;}
function hideHlMenu(){if(hlMenu)hlMenu.style.display='none';}
function markEl(idx){return (hlOverlay&&hlOverlay.querySelector('.hl-rect[data-hi="'+idx+'"]'))||(root?root.querySelector('mark.hl[data-hi="'+idx+'"]'):null);}
function virtualMarkEl(idx){return virtualPage?virtualPage.querySelector('.vp-hl[data-hi="'+idx+'"]'):null;}
function selActive(){var s=window.getSelection?window.getSelection():null;return !!(s&&!s.isCollapsed&&s.toString().trim());}
function anchorRectForElement(el,evt){
  if(!el||!el.getBoundingClientRect)return {left:window.innerWidth/2,top:window.innerHeight/2,right:window.innerWidth/2,bottom:window.innerHeight/2,width:0,height:0};
  var rects=[];try{rects=[].slice.call(el.getClientRects()).filter(function(r){return r&&r.width>0&&r.height>0;});}catch(_){rects=[];}
  if(!rects.length)return el.getBoundingClientRect();
  if(evt&&typeof evt.clientX==='number'&&typeof evt.clientY==='number'){
    var x=evt.clientX,y=evt.clientY,best=rects[0],bestD=Infinity;
    for(var i=0;i<rects.length;i++){
      var r=rects[i];
      if(x>=r.left-3&&x<=r.right+3&&y>=r.top-5&&y<=r.bottom+5)return r;
      var cx=Math.max(r.left,Math.min(r.right,x)),cy=Math.max(r.top,Math.min(r.bottom,y));
      var dx=x-cx,dy=y-cy,d=dx*dx+dy*dy;
      if(d<bestD){bestD=d;best=r;}
    }
    return best;
  }
  return rects[0];
}
function selectedHighlightIndex(){
  var o=selOffsets();
  return o?highlightIndexForRange(o.start,o.end):-1;
}
function showHlMenu(idx,force,anchor,evt){
  if(selActive()&&!force)return;   // 还在选字（如刚高亮完）就不弹，避免和选区菜单同时出现
  hideSelMenu();                  // 任何时候只保留一个工具栏
  activeHi=idx;var el=anchor||markEl(idx)||virtualMarkEl(idx);
  if(!el){var hr=visibleHighlightRect(idx);if(hr)el={getBoundingClientRect:function(){return hr;},getClientRects:function(){return [hr];}};}
  if(!el)return;
  applyConfiguredMenu(hlMenu,hlMenuItems,hlMenu&&hlMenu._setBtn);
  hlMenu.style.display='block';
  var rect=anchorRectForElement(el,evt);
  hlMenu._anchorRect=rect;
  var mw=hlMenu.offsetWidth||200,mh=hlMenu.offsetHeight||34;
  var left=rect.left+rect.width/2-mw/2;left=Math.max(6,Math.min(window.innerWidth-mw-6,left));
  var gap=4,top=rect.top-mh-gap;if(top<6)top=rect.bottom+gap;
  hlMenu.style.left=left+'px';hlMenu.style.top=top+'px';
}
function setupHlUi(){
  hlMenu=document.createElement('div');hlMenu.id='hl-menu';
  var mWeb=mkBtn('🔍 web搜索'),mDict=mkBtn('📖 词典'),mTr=mkBtn('译 翻译'),mCopy=mkBtn('复制'),mDel=mkBtn('🗑 取消高亮'),mCorrect=mkBtn('✎ 改错'),mExcerpt=mkBtn('▣ 书摘'),mCross=mkBtn('跨书搜索'),mSemantic=mkBtn('≈ 相似语义'),mNote=mkBtn('📝 批注'),mSet=mkBtn('⚙');
  hlMenuItems=[
    {key:'web',button:mWeb},
    {key:'dict',button:mDict},
    {key:'translate',button:mTr},
    {key:'copy',button:mCopy},
    {key:'highlight',button:mDel,label:'取消高亮',icon:'🗑'},
    {key:'correct',button:mCorrect},
    {key:'excerpt',button:mExcerpt},
    {key:'cross',button:mCross},
    {key:'semantic',button:mSemantic},
    {key:'note',button:mNote}
  ];
  hlMenu._setBtn=mSet;
  applyConfiguredMenu(hlMenu,hlMenuItems,mSet);
  document.body.appendChild(hlMenu);
  [mWeb,mDict,mTr,mCopy,mDel,mCorrect,mExcerpt,mCross,mSemantic,mNote,mSet].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  mWeb.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)parent.postMessage({webSearch:highlightDisplayText(h)},'*');hideHlMenu();});
  mDict.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)openDict(highlightDisplayText(h),h.context||'');hideHlMenu();});
  mTr.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi],el=markEl(activeHi);if(h)openTranslate(highlightDisplayText(h),el?el.getBoundingClientRect():null);hideHlMenu();});
  mCopy.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)copyTextToClipboard(highlightDisplayText(h));hideHlMenu();});
  mDel.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({removeHighlight:activeHi},'*');hideHlMenu();});
  mCorrect.addEventListener('click',function(e){e.stopPropagation();var idx=activeHi;hideHlMenu();if(idx>=0)showHighlightTextEditor(idx);});
  mExcerpt.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];hideHlMenu();if(h)showExcerptPage(highlightDisplayText(h));});
  mCross.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)parent.postMessage({crossSearch:highlightDisplayText(h)},'*');hideHlMenu();});
  mSemantic.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)parent.postMessage({semanticSearch:highlightDisplayText(h)},'*');hideHlMenu();});
  mNote.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({openAnnotations:activeHi},'*');hideHlMenu();});
  mSet.addEventListener('click',function(e){e.stopPropagation();showHlSettings(hlMenu);});
  hlMenu.addEventListener('mouseenter',function(){if(hlHideTimer)clearTimeout(hlHideTimer);});
  hlMenu.addEventListener('mouseleave',function(){if(hlSettingsPop&&hlSettingsPop.style.display==='block')return;hlHideTimer=setTimeout(hideHlMenu,400);});

  // 悬停高亮 → 出菜单；移开延时收起
  root.addEventListener('mouseover',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi'),10),false,m,e);}});
  root.addEventListener('mouseout',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
  if(hlOverlay){
    hlOverlay.addEventListener('mouseover',function(e){var m=e.target.closest?e.target.closest('.hl-rect[data-hi]'):null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi'),10),false,m,e);}});
    hlOverlay.addEventListener('mouseout',function(e){var m=e.target.closest?e.target.closest('.hl-rect[data-hi]'):null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
    hlOverlay.addEventListener('click',function(e){var m=e.target.closest?e.target.closest('.hl-rect[data-hi]'):null;if(m){e.preventDefault();e.stopPropagation();showHlMenu(parseInt(m.getAttribute('data-hi'),10),true,m,e);}});
  }
  if(virtualPage){
    virtualPage.addEventListener('mouseover',function(e){var m=e.target.closest?e.target.closest('.vp-hl[data-hi]'):null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi'),10),false,m,e);}});
    virtualPage.addEventListener('mouseout',function(e){var m=e.target.closest?e.target.closest('.vp-hl[data-hi]'):null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
    virtualPage.addEventListener('click',function(e){var m=e.target.closest?e.target.closest('.vp-hl[data-hi]'):null;if(m){e.preventDefault();e.stopPropagation();showHlMenu(parseInt(m.getAttribute('data-hi'),10),true,m,e);}});
  }
  document.addEventListener('mousedown',function(e){if(hlMenu&&!hlMenu.contains(e.target))hideHlMenu();});
  document.addEventListener('wheel',function(){hideHlMenu();},{passive:true});
}
// 取选区所在"整段"的纯文本（作为批注上下文，存起来供大批注页展示）
function getSelContext(){
  var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return '';
  var off=selOffsets();
  if(off){
    var txt=sourceTextAround(off.start,off.end,240,560).replace(/\s+/g,' ').trim();
    return txt.length>800?txt.slice(0,800)+'…':txt;
  }
  var node=sel.getRangeAt(0).startContainer;var el=node.nodeType===1?node:node.parentNode;
  // 优先取最近的段落元素 <p>，没有再退回其它块级元素
  var block=el&&el.closest?(el.closest('p')||el.closest('li,blockquote,td,div,section')):el;
  var txt=((block||el).textContent||'').replace(/\s+/g,' ').trim();
  return txt.length>800?txt.slice(0,800)+'…':txt; // 整段，过长才截断
}

// ---- 注释/脚注：点角标 → 就地弹出注释正文（而不是跳过去）----
var fnPop=null,fnPopKey='';
function hideFn(){if(fnPop)fnPop.style.display='none';fnPopKey='';}
function setupFn(){
  fnPop=document.createElement('div');fnPop.id='fn-pop';
  fnPop.innerHTML='<span class="fn-close">✕</span><div class="fn-body"></div>';
  document.body.appendChild(fnPop);
  fnPop.querySelector('.fn-close').addEventListener('click',function(e){e.stopPropagation();hideFn();});
  fnPop.addEventListener('mousedown',function(e){e.stopPropagation();});
  fnPop.addEventListener('click',function(e){e.stopPropagation();if(e.target.closest&&e.target.closest('a'))e.preventDefault();}); // 弹窗内点击不翻页/不跳锚
  fnPop.addEventListener('wheel',function(e){e.stopPropagation();},{passive:true});
  document.addEventListener('mousedown',function(e){
    if(!fnPop||fnPop.style.display!=='block'||fnPop.contains(e.target))return;
    var note=e.target.closest&&e.target.closest('a');
    if(note&&isNoteLink(note))return; // 让 click 处理同一条“注”的开关
    hideFn();
  });
  document.addEventListener('wheel',hideFn,{passive:true});
}
// ---- 离线词典：选中文字/已高亮 → 就地弹释义（释义由外壳查后端再回传）----
var dictPop=null,dictRect=null,dictContext='';
var DICT_HN_CFG=[
  {key:'synonyms',label:'近义'},
  {key:'antonyms',label:'反义'}
];
function dictHnSettings(){
  var defaults={synonyms:true,antonyms:true};
  try{
    var raw=localStorage.getItem('dictHownetSettings');
    if(raw){
      var v=JSON.parse(raw)||{};
      return {synonyms:v.synonyms!==false,antonyms:v.antonyms!==false};
    }
  }catch(_){}
  return defaults;
}
function setDictHnSettings(v){try{localStorage.setItem('dictHownetSettings',JSON.stringify(v));}catch(_){}}
function hideDict(){
  if(!dictPop)return;
  dictPop.style.display='none';
  var pop=dictPop.querySelector('.dc-settings');
  if(pop)pop.classList.remove('show');
}
function ensureDictControls(){
  if(!dictPop)return;
  var old=dictPop.querySelectorAll('.dc-close');
  for(var i=0;i<old.length;i++){old[i].remove();}
  var gear=dictPop.querySelector('.dc-gear');
  if(!gear){
    gear=document.createElement('button');
    gear.className='dc-gear';
    gear.type='button';
    gear.title='词典增强设置';
    gear.textContent='⚙';
    dictPop.insertBefore(gear,dictPop.firstChild);
  }
  if(!gear._dictGearBound){
    gear._dictGearBound=1;
    gear.addEventListener('click',function(e){e.stopPropagation();toggleDictSettings();});
  }
}
function setupDict(){
  dictPop=document.createElement('div');dictPop.id='dict-pop';
  dictPop.innerHTML='<button class="dc-gear" type="button" title="词典增强设置">⚙</button><div class="dc-settings"></div><div class="dc-head"></div><div class="dc-def"></div>';
  document.body.appendChild(dictPop);
  ensureDictControls();
  dictPop.addEventListener('mousedown',function(e){e.stopPropagation();});
  dictPop.addEventListener('click',function(e){e.stopPropagation();});
  document.addEventListener('mousedown',function(e){if(dictPop&&dictPop.style.display==='block'&&!dictPop.contains(e.target))hideDict();});
  document.addEventListener('wheel',function(){hideDict();},{passive:true});
  window.addEventListener('resize',function(){
    var pop=dictPop&&dictPop.querySelector?dictPop.querySelector('.dc-settings'):null;
    if(pop&&pop.classList.contains('show'))placeDictSettings(pop);
  });
}
function placeDictSettings(pop){
  if(!dictPop||!pop)return;
  var gear=dictPop.querySelector('.dc-gear');
  var anchor=(gear||dictPop).getBoundingClientRect();
  var gap=8;
  var width=Math.min(220,Math.max(160,window.innerWidth-16));
  pop.style.width=width+'px';
  var left=Math.max(8,Math.min(anchor.right-width,window.innerWidth-width-8));
  pop.style.left=left+'px';
  pop.style.top=(anchor.bottom+gap)+'px';
  var height=pop.offsetHeight||0;
  var top=anchor.bottom+gap;
  if(top+height>window.innerHeight-8)top=anchor.top-height-gap;
  if(top<8)top=Math.max(8,window.innerHeight-height-8);
  pop.style.top=top+'px';
}
function toggleDictSettings(){
  if(!dictPop)return;
  var pop=dictPop.querySelector('.dc-settings');
  if(!pop)return;
  if(pop.classList.contains('show')){pop.classList.remove('show');return;}
  renderDictSettings(pop);
  pop.classList.add('show');
  placeDictSettings(pop);
}
function renderDictSettings(pop){
  var st=dictHnSettings();
  pop.innerHTML='';
  DICT_HN_CFG.forEach(function(cfg){
    var row=document.createElement('label');row.className='dc-set-row';
    var name=document.createElement('span');name.textContent=cfg.label;row.appendChild(name);
    var sw=document.createElement('span');sw.className='dc-switch';
    var input=document.createElement('input');input.type='checkbox';input.checked=st[cfg.key]!==false;
    var slider=document.createElement('span');slider.className='dc-slider';
    input.addEventListener('change',function(e){
      e.stopPropagation();
      st[cfg.key]=input.checked;
      setDictHnSettings(st);
      renderDict();
      var next=dictPop&&dictPop.querySelector?dictPop.querySelector('.dc-settings'):null;
      if(next){renderDictSettings(next);next.classList.add('show');placeDictSettings(next);}
    });
    sw.appendChild(input);sw.appendChild(slider);row.appendChild(sw);pop.appendChild(row);
  });
}
function placeDict(){
  dictPop.style.display='block';
  var ph=dictPop.offsetHeight,r=dictRect;
  var top=(r?r.bottom:120)+10;
  if(top+ph>window.innerHeight-8)top=(r?r.top:120)-ph-10;
  if(top<8)top=8;
  dictPop.style.top=top+'px';
  var pop=dictPop.querySelector('.dc-settings');
  if(pop&&pop.classList.contains('show'))placeDictSettings(pop);
}
function openDict(term,context){
  if(!dictPop)setupDict();
  ensureDictControls();
  try{var s=window.getSelection();dictRect=(s&&s.rangeCount)?s.getRangeAt(0).getBoundingClientRect():null;}catch(_){dictRect=null;}
  dictContext=(context||'').replace(/\s+/g,' ').trim();
  if(!dictContext)dictContext=getSelContext();
  dictPop.querySelector('.dc-head').textContent='查词中…';
  dictPop.querySelector('.dc-def').textContent='';dictPop.querySelector('.dc-def').className='dc-def';
  placeDict();
  parent.postMessage({dict:term,dictContext:dictContext},'*');
}
function speakWord(w){
  try{
    if(!w)return;
    parent.postMessage({dictSpeak:w},'*');
  }catch(_){}
}
// 释义来源多选记忆（按语种分开）：中文词 中=中中/英=中英；英文词 中=英中/英=英英
var lastDict=null;
function dictSel(lang){try{var v=localStorage.getItem('dictSel_'+lang);return v?v.split(','):null;}catch(_){return null;}}
function setDictSel(lang,a){try{localStorage.setItem('dictSel_'+lang,a.join(','));}catch(_){}}
function appendDictTextBlock(parent,title,text){
  if(!text)return;
  var blk=document.createElement('div');blk.className='dc-hnblk';
  var t=document.createElement('span');t.className='dc-hnt';t.textContent=title;blk.appendChild(t);
  var body=document.createElement('span');body.textContent=text;blk.appendChild(body);
  parent.appendChild(blk);
}
function appendDictTags(parent,title,items){
  if(!items||!items.length)return;
  var blk=document.createElement('div');blk.className='dc-hnblk';
  var t=document.createElement('span');t.className='dc-hnt';t.textContent=title;blk.appendChild(t);
  var tags=document.createElement('div');tags.className='dc-tags';
  items.forEach(function(x){var tag=document.createElement('span');tag.className='dc-tag';tag.textContent=x;tags.appendChild(tag);});
  blk.appendChild(tags);parent.appendChild(blk);
}
function appendHowNetBlocks(def,r){
  var h=r&&r.hownet;if(!h)return;
  var st=dictHnSettings(),box=document.createElement('div');box.className='dc-hn';
  if(st.synonyms!==false)appendDictTags(box,'近义',h.synonyms);
  if(st.antonyms!==false)appendDictTags(box,'反义',h.antonyms);
  if(box.childNodes.length)def.appendChild(box);
}
function renderDict(){
  if(!dictPop||!lastDict)return;
  ensureDictControls();
  var r=lastDict,head=dictPop.querySelector('.dc-head'),def=dictPop.querySelector('.dc-def');
  head.innerHTML='';def.innerHTML='';
  var w=document.createElement('span');w.className='dc-word';w.textContent=r.word||'';head.appendChild(w);
  if(!r.found){def.textContent='（未找到该词的释义）';def.className='dc-def dc-miss';return;}
  if(r.phonetic){var ph=document.createElement('span');ph.className='dc-phon';ph.textContent=(r.lang==='en')?('['+r.phonetic+']'):r.phonetic;head.appendChild(ph);}
  if(r.lang==='en'){
    parent.postMessage({dictPrefetch:r.word},'*');
    var spk=document.createElement('span');spk.className='dc-spk';spk.textContent='🔊';spk.title='发音';
    spk.addEventListener('click',function(e){e.stopPropagation();speakWord(r.word);});head.appendChild(spk);
  }
  if(r.sources&&r.sources.length){
    r.sources.forEach(function(src,idx){
      var det=document.createElement('details');det.className='dc-source';if(idx===0)det.open=true;
      var sum=document.createElement('summary');
      var label=src.source_name||'外置词典';
      var sw=src.word&&src.word!==r.word?(' · '+src.word):'';
      var ph=src.phonetic?(' · '+src.phonetic):'';
      sum.textContent=label+sw+ph;
      var body=document.createElement('div');body.className='dc-source-body';
      if(src.def){var blk=document.createElement('div');blk.className='dc-defblk';var lb=document.createElement('span');lb.className='dc-lb';lb.textContent=(src.lang==='en')?'中':'中';blk.appendChild(lb);var tx=document.createElement('span');tx.textContent=src.def;blk.appendChild(tx);body.appendChild(blk);}
      if(src.def_en){var blk2=document.createElement('div');blk2.className='dc-defblk';var lb2=document.createElement('span');lb2.className='dc-lb';lb2.textContent='英';blk2.appendChild(lb2);var tx2=document.createElement('span');tx2.textContent=src.def_en;blk2.appendChild(tx2);body.appendChild(blk2);}
      if(!body.childNodes.length){body.textContent='（无释义）';}
      det.append(sum,body);def.appendChild(det);
    });
    appendHowNetBlocks(def,r);
    return;
  }
  if(r.source_name){
    var srcBadge=document.createElement('div');srcBadge.className='dc-src';srcBadge.textContent=r.source_name;def.appendChild(srcBadge);
  }
  var sources=[];
  if(r.def)sources.push({k:'c',label:'中',text:r.def});
  if(r.def_en)sources.push({k:'e',label:'英',text:r.def_en});
  if(!sources.length){def.textContent='（无释义）';def.className='dc-def dc-miss';return;}
  var avail=sources.map(function(s){return s.k;});
  var sel=dictSel(r.lang)||[sources[0].k];
  sel=sel.filter(function(k){return avail.indexOf(k)>=0;});
  if(!sel.length)sel=[sources[0].k];
  if(sources.length>1){ // 两种释义都有 → 显示多选切换键（可同时选中）
    var tg=document.createElement('span');tg.className='dc-toggle';
    sources.forEach(function(s){
      var b=document.createElement('span');b.className='dt'+(sel.indexOf(s.k)>=0?' on':'');b.textContent=s.label;
      b.addEventListener('click',function(e){e.stopPropagation();
        var i=sel.indexOf(s.k);
        if(i>=0){if(sel.length>1)sel.splice(i,1);}else{sel.push(s.k);}
        setDictSel(r.lang,sel);renderDict();
      });
      tg.appendChild(b);
    });
    head.appendChild(tg);
  }
  var multi=sel.length>1;
  sources.forEach(function(s){
    if(sel.indexOf(s.k)<0)return;
    var blk=document.createElement('div');blk.className='dc-defblk';
    if(multi){var lb=document.createElement('span');lb.className='dc-lb';lb.textContent=s.label;blk.appendChild(lb);}
    var tx=document.createElement('span');tx.textContent=s.text;blk.appendChild(tx);
    def.appendChild(blk);
  });
  appendHowNetBlocks(def,r);
  def.className='dc-def';
  var pop=dictPop.querySelector('.dc-settings');
  if(pop&&pop.classList.contains('show'))placeDictSettings(pop);
}
function showDictResult(r){
  if(!dictPop)setupDict();
  lastDict=r;renderDict();
  if(r&&r.found&&r.lang==='en'&&r.autoSpeak)speakWord(r.word); // 按生词本设置决定是否自动读一次
  if(r&&r.found)parent.postMessage({vocabAdd:{word:r.word,lang:r.lang,def:r.def||'',def_en:r.def_en||'',phonetic:r.phonetic||'',example:dictContext||''}},'*'); // 记入生词本
  placeDict();
}
// 是否是"注释角标"链接：epub:type/role/class 含 note，或链接文字形如 [23] / (3) / 23
function isNoteLink(a){
  var cls=String(a&&a.className||'');
  if(a&&(a.getAttribute('data-rr-note-ref')==='1'||/\brr-note-ref\b/.test(cls)))return true;
  var ty=((a.getAttribute('epub:type')||'')+' '+(a.getAttribute('role')||'')+' '+cls).toLowerCase();
  if(/note|footnote|endnote|annoref/.test(ty))return true;
  var t=(a.textContent||'').trim();
  return /^[\[【（(]?\s*\d{1,4}\s*[\]】）)]?$/.test(t);
}
function fnSelector(frag){return '[id="'+String(frag).replace(/"/g,'\\"')+'"]';}
function popFootnote(a,html,key){
  if(!fnPop)setupFn();
  try{parent.postMessage({uiClick:1},'*');}catch(_){}
  fnPopKey=key||'';
  fnPop.querySelector('.fn-body').innerHTML=html;
  fnPop.scrollTop=0;
  fnPop.style.display='block';
  var rect=a.getBoundingClientRect();
  var pw=fnPop.offsetWidth;
  var ph=fnPop.offsetHeight;
  var left=rect.left+rect.width/2-pw/2;
  left=Math.max(8,Math.min(left,window.innerWidth-pw-8));
  var top=rect.bottom+10;
  if(top+ph>window.innerHeight-8)top=rect.top-ph-10; // 下方放不下 → 放上方
  if(top<8)top=8;
  if(top+ph>window.innerHeight-8)top=Math.max(8,window.innerHeight-ph-8);
  fnPop.style.left=left+'px';
  fnPop.style.top=top+'px';
}
// 取注释正文：id 常落在内联回链角标(<a>/<sup>)上，其内容只是"[n]"，正文是它的兄弟
// → 此时取它所在的块（p/li/aside…）的内容；id 本身就在块上则直接用。
function noteHtml(el){
  var block=el;
  if(el.nodeType===1&&/^(A|SUP|SPAN|B|I|EM|FONT|SMALL)$/.test(el.nodeName)){
    block=(el.closest&&el.closest('p,li,div,dd,aside,section,td,blockquote'))||el.parentNode||el;
  }
  var h=(block.innerHTML||'').trim();
  return h||el.innerHTML||'';
}
var footnoteChapterBodyCache={},footnoteChapterBodyCacheKeys=[];
function noteHtmlFromBody(body,frag){
  var tmp=document.createElement('div');tmp.innerHTML=body||'';
  var el=tmp.querySelector(fnSelector(frag));
  return el?noteHtml(el):'';
}
function footnoteChapterBody(i){
  i=Math.max(0,Math.min(CH-1,parseInt(i,10)||0));
  if(Object.prototype.hasOwnProperty.call(footnoteChapterBodyCache,i))return Promise.resolve(footnoteChapterBodyCache[i]);
  return fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
    var body=d&&d.body||'';
    footnoteChapterBodyCache[i]=body;
    footnoteChapterBodyCacheKeys.push(i);
    if(footnoteChapterBodyCacheKeys.length>120){
      var old=footnoteChapterBodyCacheKeys.shift();
      delete footnoteChapterBodyCache[old];
    }
    return body;
  });
}
function footnoteSearchOrder(ci){
  var out=[],seen={};
  function add(i){
    i=parseInt(i,10);
    if(!isFinite(i)||i<0||i>=CH||seen[i])return;
    seen[i]=1;out.push(i);
  }
  add(curCh);add(ci);
  for(var r=1;r<=16;r++){add(curCh+r);add(curCh-r);add(ci+r);add(ci-r);}
  for(var i=0;i<CH;i++)add(i);
  return out;
}
function findFootnoteHtmlAcrossChapters(order,frag){
  var idx=0;
  return new Promise(function(resolve,reject){
    function step(){
      if(idx>=order.length){resolve('');return;}
      var ch=order[idx++];
      footnoteChapterBody(ch).then(function(body){
        var html=noteHtmlFromBody(body,frag);
        if(html)resolve(html);else step();
      }).catch(function(err){
        if(idx>=order.length)reject(err);else step();
      });
    }
    step();
  });
}
function showFootnote(a,ci,frag){
  var key=String(ci)+':'+String(frag);
  if(fnPop&&fnPop.style.display==='block'&&fnPopKey===key){hideFn();return;}
  var el=document.querySelector(fnSelector(frag));
  if(el){popFootnote(a,noteHtml(el),key);return;}
  popFootnote(a,'加载中…',key);
  findFootnoteHtmlAcrossChapters(footnoteSearchOrder(ci),frag).then(function(html){
    if(fnPopKey===key)popFootnote(a,html||'（未找到注释内容）',key);
  }).catch(function(){if(fnPopKey===key)popFootnote(a,'（注释加载失败）',key);});
}
var sMarks=[],sIdx=-1;
function clearSearch(){
  for(var i=0;i<sMarks.length;i++){var m=sMarks[i];if(m.parentNode){m.parentNode.replaceChild(document.createTextNode(m.textContent),m);}}
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
function doSearch(term){
  clearSearch();
  term=(term||'').trim();
  if(!term){relayout();parent.postMessage({searchPos:0,searchCount:0},'*');return;}
  var low=term.toLowerCase(),len=term.length;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
    if(!n.nodeValue)return NodeFilter.FILTER_REJECT;
    var p=n.parentNode?n.parentNode.nodeName:'';
    if(p==='SCRIPT'||p==='STYLE'||p==='MARK')return NodeFilter.FILTER_REJECT;
    return n.nodeValue.toLowerCase().indexOf(low)>=0?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
  }});
  var nodes=[],nd;while(nd=walker.nextNode())nodes.push(nd);
  for(var k=0;k<nodes.length;k++){
    var node=nodes[k],text=node.nodeValue,lowt=text.toLowerCase(),idx,last=0,frag=document.createDocumentFragment();
    while((idx=lowt.indexOf(low,last))>=0){
      if(idx>last)frag.appendChild(document.createTextNode(text.slice(last,idx)));
      var mk=document.createElement('mark');mk.className='search-hit';mk.textContent=text.slice(idx,idx+len);
      frag.appendChild(mk);sMarks.push(mk);last=idx+len;
    }
    if(last<text.length)frag.appendChild(document.createTextNode(text.slice(last)));
    if(node.parentNode)node.parentNode.replaceChild(frag,node);
  }
  applyCols();
  if(sMarks.length){sIdx=0;focusMatch();}else{parent.postMessage({searchPos:0,searchCount:0},'*');}
}
function focusMatch(){
  for(var i=0;i<sMarks.length;i++)sMarks[i].classList.toggle('cur',i===sIdx);
  if(sIdx>=0&&sMarks[sIdx])gotoPage(pageOf(sMarks[sIdx]));
  parent.postMessage({searchPos:sIdx+1,searchCount:sMarks.length},'*');
}
function searchNav(d){if(!sMarks.length)return;sIdx=(sIdx+d+sMarks.length)%sMarks.length;focusMatch();}
