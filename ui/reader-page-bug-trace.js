// 正文 WebView 的脱敏问题轨迹。与分页模块共享作用域，但不接触正文内容。
var chapterPending=0;
var pageTurnTraceSequence=0;
var pageTurnTraceInput='unknown';
// 仅采集分页几何数值，不读取或发送任何正文文字。用于判断“末页空白”到底是
// 可用高度不足、浏览器提前换栏，还是某个布局分支改写了容器尺寸。
function pagedLayoutSnapshot(){
  if(!root||!pager||(S&&S.flowMode)==='scroll')return null;
  try{
    var pr=pager.getBoundingClientRect(),rr=root.getBoundingClientRect(),pl=typeof pageLayout==='function'?pageLayout():null;
    var step=Math.max(1,Number(pl&&pl.pageStep)||window.innerWidth||1),current={},following={};
    var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node,range=document.createRange();
    function addLine(bucket,r){
      var key=Math.round(r.top)+':'+Math.round(r.bottom),old=bucket[key];
      if(!old)bucket[key]={top:r.top,bottom:r.bottom,height:r.height};
      else{old.top=Math.min(old.top,r.top);old.bottom=Math.max(old.bottom,r.bottom);old.height=Math.max(old.height,r.height);}
    }
    while((node=walker.nextNode())){
      if(!(node.nodeValue||'').trim())continue;
      try{range.selectNodeContents(node);}catch(_){continue;}
      var rects=range.getClientRects();
      for(var i=0;i<rects.length;i++){
        var r=rects[i];if(r.width<1||r.height<3)continue;
        var index=Math.floor((r.left-pr.left+1)/step);
        if(index===0&&r.right>pr.left-1&&r.left<pr.right+1)addLine(current,r);
        else if(index===1&&r.left<pr.right+step+1)addLine(following,r);
      }
    }
    var here=Object.keys(current).map(function(key){return current[key];}).sort(function(a,b){return a.bottom-b.bottom;});
    var next=Object.keys(following).map(function(key){return following[key];}).sort(function(a,b){return a.top-b.top;});
    var last=here.length?here[here.length-1]:null,first=next.length?next[0]:null,style=getComputedStyle(root),padBottom=parseFloat(style.paddingBottom)||0;
    function px(value){return Math.round(Number(value)||0);}
    var tailStats=root.__rrPageTailTightStats||{};
    return {layout_fast:!!fastChapterLayout,layout_view_height:px(pr.height),layout_root_height:px(rr.height),layout_root_style_height:px(parseFloat(root.style.height)),layout_padding_bottom:px(padBottom),layout_line_height:px(parseFloat(style.lineHeight)),layout_step:px(step),layout_current_line_count:here.length,layout_last_top:last?px(last.top-pr.top):-1,layout_last_bottom:last?px(last.bottom-pr.top):-1,layout_last_height:last?px(last.height):0,layout_next_top:first?px(first.top-pr.top):-1,layout_next_bottom:first?px(first.bottom-pr.top):-1,layout_next_height:first?px(first.height):0,layout_visible_free:last?px(pr.bottom-last.bottom):-1,layout_content_free:last?px(pr.bottom-padBottom-last.bottom):-1,layout_tail_cross:px(tailStats.cross),layout_tail_fit:px(tailStats.fit),layout_tail_tightened:px(tailStats.tightened)};
  }catch(_){return null;}
}
function readerBugTrace(kind,outcome,e,extra){
  var x=e&&Number.isFinite(e.clientX)?e.clientX:null,y=e&&Number.isFinite(e.clientY)?e.clientY:null;
  var target=e&&e.target,tag=target&&target.tagName?String(target.tagName).toLowerCase():'unknown';
  if(target&&target.closest){
    if(target.closest('a'))tag='link';
    else if(target.closest('button'))tag='button';
    else if(target.closest('input,select,textarea'))tag='input';
    else if(target.closest('.hl-rect[data-hi],mark.hl'))tag='highlight';
    else if(target.closest('img,svg,canvas'))tag='media';
  }
  var data={kind:kind||'event',source:'reader_page',outcome:outcome||'handled',target:tag,chapter:curCh,page:pageInCh};
  data.pages=Math.max(0,Number(pagesInCh)||0);
  data.chapter_pending=Math.max(0,Number(chapterPending)||0);
  data.chapter_turn_pending=typeof chapterTurnPending!=='undefined'&&!!chapterTurnPending;
  data.turn_fx_active=!!(pager&&pager.classList&&pager.classList.contains('turn-fx'));
  data.turn_timer_active=typeof turnFxTimer!=='undefined'&&!!turnFxTimer;
  data.scroll_paged=!!scrollPagedView;
  data.flow_mode=(S&&S.flowMode)||'unknown';
  data.page_mode=(S&&S.pageMode)||'unknown';
  if(kind==='turn'||kind==='chapter'){
    var layout=pagedLayoutSnapshot();
    if(layout)Object.keys(layout).forEach(function(key){data[key]=layout[key];});
  }
  if(x!==null){data.x_pct=Math.max(0,Math.min(100,Math.round(x/Math.max(1,window.innerWidth)*1000)/10));data.zone=x<window.innerWidth*.4?'left':(x>window.innerWidth*.6?'right':'center');}
  if(y!==null)data.y_pct=Math.max(0,Math.min(100,Math.round(y/Math.max(1,window.innerHeight)*1000)/10));
  if(extra&&typeof extra==='object'){
    ['direction','key','duration_ms','chapter','page','pages','turn_id','input','before_chapter','before_page','after_chapter','after_page',
      'image_mode','image_source_page','image_candidate_page','image_top','image_width','image_height',
      'image_free_height','image_preview_height','image_next_count','image_future_count','image_skipped_text','image_near_top','image_text_before','image_probed'
    ].forEach(function(key){if(extra[key]!==undefined)data[key]=extra[key];});
  }
  parent.postMessage({bugTrace:data},'*');
}
function markPageTurnInput(input){pageTurnTraceInput=input||'unknown';}
function beginPageTurnBugTrace(direction){
  var token={id:++pageTurnTraceSequence,direction:direction,chapter:curCh,page:pageInCh,input:pageTurnTraceInput||'unknown'};
  pageTurnTraceInput='unknown';
  readerBugTrace('turn','requested',null,{turn_id:token.id,direction:token.direction,input:token.input,before_chapter:token.chapter,before_page:token.page});
  return token;
}
function finishPageTurnBugTrace(token){
  if(!token)return;
  var moved=token.chapter!==curCh||token.page!==pageInCh;
  var busy=chapterPending>0||(typeof chapterTurnPending!=='undefined'&&chapterTurnPending);
  readerBugTrace('turn',moved?'applied':(busy?'turn_busy':'no_change'),null,{turn_id:token.id,direction:token.direction,input:token.input,before_chapter:token.chapter,before_page:token.page,after_chapter:curCh,after_page:pageInCh});
}
function beginChapterBugTrace(chapter,where){
  chapterPending++;
  var token={chapter:chapter,started:performance.now()};
  readerBugTrace('chapter','chapter_start',null,{direction:where==='end'?'backward':'forward',chapter:chapter,page:0});
  return token;
}
function finishChapterBugTrace(token,ready,page){
  chapterPending=Math.max(0,chapterPending-1);
  readerBugTrace('chapter',ready?'chapter_ready':'chapter_error',null,{duration_ms:performance.now()-token.started,chapter:token.chapter,page:ready?page:0});
}
