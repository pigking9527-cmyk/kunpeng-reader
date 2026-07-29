// ---- 单页/双页模式切换锚点 ----
function sourceAnchorRangeForOffset(offset){
  var recs=sourceTextRecords(),at=Math.max(0,parseInt(offset,10)||0);
  for(var i=0;i<recs.length;i++){
    var rec=recs[i],len=(rec.node.nodeValue||'').length;
    if(at>=rec.end&&i<recs.length-1)continue;
    if(at>rec.end)continue;
    var start=Math.max(0,Math.min(len,at-rec.start)),end=Math.min(len,start+1);
    if(end===start&&i<recs.length-1)continue;
    var range=document.createRange();
    try{range.setStart(rec.node,start);range.setEnd(rec.node,end);return range;}catch(_){return null;}
  }
  return null;
}
function clearModeSwitchAnchor(){
  if(!root)return;
  var marks=root.querySelectorAll('.rr-mode-switch-anchor');
  for(var i=0;i<marks.length;i++){
    var mark=marks[i],pairs=mark.__rrModeSwitchPairs;
    var spacer=mark.__rrModeSwitchSpacer;
    if(spacer&&spacer.parentNode)spacer.remove();
    if(pairs&&pairs.length){
      // 目标字符可能位于 section/article/div/p/span 多层结构内。拆分时
      // 从内到外复制尾部；恢复时必须从外到内合并，才能把每一层放回
      // 原父节点，且不会永久改变 EPUB 的正文结构。
      for(var j=pairs.length-1;j>=0;j--){
        var pair=pairs[j],origin=pair&&pair.origin,tail=pair&&pair.tail;
        if(!origin||!tail||!tail.parentNode)continue;
        while(tail.firstChild)origin.appendChild(tail.firstChild);
        tail.remove();
      }
      if(pairs[0]&&pairs[0].origin)try{pairs[0].origin.normalize();}catch(_){}
    }else{
      mark.classList.remove('rr-mode-switch-anchor');
      mark.removeAttribute('data-reader-mode-switch');
      mark.removeAttribute('data-reader-offset');
      mark.removeAttribute('data-reader-split');
    }
  }
  if(marks.length)sourceTextCache=null;
}
// 章节题图没有文字偏移。题图仍在当前页时不要强制标题另起一栏，否则会产生图标空页。
function hasVisibleLeadMediaBeforeAnchor(offset){
  if(!root||offset==null)return false;
  var range=sourceAnchorRangeForOffset(offset);
  if(!range)return false;
  var anchorBox=range.getBoundingClientRect();
  if((!anchorBox||(!anchorBox.width&&!anchorBox.height))&&range.startContainer&&range.startContainer.parentElement){
    anchorBox=range.startContainer.parentElement.getBoundingClientRect();
  }
  var vr=viewRect();
  if(!anchorBox||anchorBox.bottom<=vr.top+2||anchorBox.top>=vr.bottom-2||anchorBox.right<=vr.left+2||anchorBox.left>=vr.right-2)return false;
  var media=root.querySelectorAll('img,svg,canvas,video');
  for(var i=0;i<media.length;i++){
    var item=media[i];
    if(!(item.compareDocumentPosition(range.startContainer)&Node.DOCUMENT_POSITION_FOLLOWING))continue;
    var r=item.getBoundingClientRect();
    if(r.bottom>vr.top+2&&r.top<vr.bottom-2&&r.right>vr.left+2&&r.left<vr.right-2)return true;
  }
  return false;
}
// CSS 多栏只可靠地接受多栏根的直接子节点作为强制断栏点。旧实现只拆分
// 最近的 p/div；当它仍嵌在 section/article 内时，Chromium 会忽略动态
// break-before，目标文字因此仍停在栏中部。这里从目标字符开始，逐层把
// “本节点及其后续兄弟”拆到父节点的尾部副本，直到得到 root 的直接子节点。
// 每层 origin/tail 都被记录，下一次重排前可无损合并回来。
function forceModeSwitchAnchorColumn(offset,preserveLeadMedia){
  if(!root||offset==null||preserveLeadMedia)return false;
  var range=sourceAnchorRangeForOffset(offset);
  if(!range)return false;
  var child=range.startContainer,pairs=[];
  if(!child||child.nodeType!==3||!child.parentNode)return false;
  try{
    var textLen=(child.nodeValue||'').length,start=Math.max(0,Math.min(textLen,range.startOffset));
    if(start>0||start===textLen)child=child.splitText(start);
    while(child&&child.parentNode&&child.parentNode!==root){
      var origin=child.parentNode,host=origin.parentNode;
      if(!host)return false;
      var tail=origin.cloneNode(false);
      if(tail.nodeType===1)tail.removeAttribute('id');
      // 这是原段落在当前阅读位置之后的续接部分，不是新段落。EPUB 常给
      // p 设置 text-indent:2em；Chromium 在强制分栏后会把克隆块重新
      // 当成段首，导致切回分页模式时首行凭空多出两个字的缩进。
      if(tail.nodeType===1)tail.classList.add('rr-mode-switch-continuation');
      var moving=child;
      while(moving){
        var next=moving.nextSibling;
        tail.appendChild(moving);
        moving=next;
      }
      host.insertBefore(tail,origin.nextSibling);
      pairs.push({origin:origin,tail:tail});
      child=tail;
    }
  }catch(_){
    // 若中途失败，立即按相反顺序恢复，不能把半拆分 DOM 留给分页器。
    for(var rollback=pairs.length-1;rollback>=0;rollback--){
      var rp=pairs[rollback];
      while(rp.tail.firstChild)rp.origin.appendChild(rp.tail.firstChild);
      if(rp.tail.parentNode)rp.tail.remove();
    }
    if(pairs[0]&&pairs[0].origin)try{pairs[0].origin.normalize();}catch(__){}
    sourceTextCache=null;
    return false;
  }
  if(!child||child.parentNode!==root||child.nodeType!==1||!pairs.length){
    // 没有成功拆到多栏根时同样必须回滚；否则一次失败会永久改变章节 DOM，
    // 后续再切回单页便可能直接落到章首。
    for(var rollback2=pairs.length-1;rollback2>=0;rollback2--){
      var rp2=pairs[rollback2];
      while(rp2.tail.firstChild)rp2.origin.appendChild(rp2.tail.firstChild);
      if(rp2.tail.parentNode)rp2.tail.remove();
    }
    if(pairs[0]&&pairs[0].origin)try{pairs[0].origin.normalize();}catch(_){}
    sourceTextCache=null;
    return false;
  }
  var mark=child;
  mark.__rrModeSwitchPairs=pairs;
  mark.setAttribute('data-reader-split','root-path');
  mark.classList.add('rr-mode-switch-anchor');
  mark.setAttribute('data-reader-mode-switch','anchor');
  mark.setAttribute('data-reader-offset',String(offset));
  sourceTextCache=null;
  return mark;
}
// Chromium 对“动态拆出的段落 + break-before:column”并不总是执行强制分栏。
// 若目标文字仍位于当前栏中部，就用一个临时、无正文的块补齐该栏剩余高度。
// 这样目标首行会自然落在下一栏顶部；占位块会在下次重排前由上面函数清除。
function padModeSwitchAnchorToColumnTop(mark){
  if(!mark||!root||isScrollMode()||!mark.parentNode)return false;
  var rootBox=root.getBoundingClientRect(),box=mark.getBoundingClientRect();
  var columnH=Math.max(1,Math.round(parseFloat(root.style.height)||root.clientHeight||viewportHeight()));
  var targetTop=Math.max(0,mg(S.marginTop));
  var within=((box.top-rootBox.top-targetTop)%columnH+columnH)%columnH;
  if(within<=Math.max(4,lineHeightPx()*.22))return false;
  var spacer=document.createElement('div');
  spacer.setAttribute('aria-hidden','true');
  spacer.setAttribute('data-reader-generated','mode-switch-spacer');
  spacer.setAttribute('data-reader-mode-switch-spacer','1');
  spacer.style.cssText='display:block!important;width:1px!important;height:'+Math.max(1,Math.ceil(columnH-within))+'px!important;margin:0!important;padding:0!important;border:0!important;line-height:0!important;font-size:0!important;';
  mark.parentNode.insertBefore(spacer,mark);
  mark.__rrModeSwitchSpacer=spacer;
  return true;
}
function modeSwitchAnchorAtVisibleTop(offset){
  if(offset==null)return false;
  var visible=visibleTopTextAnchor(),actual=anchorTextOffset(visible);
  if(actual==null)return false;
  var target=sourceAnchorRangeForOffset(offset),sample=visible&&visible.range;
  var tr=target&&anchorRect({range:target}),sr=sample&&anchorRect({range:sample});
  if(!tr||!sr)return false;
  var sameLine=Math.abs(tr.top-sr.top)<=Math.max(3,lineHeightPx()*.25);
  return sameLine&&actual>=offset-1&&actual<=offset+12;
}
