// 正文 WebView 的脱敏问题轨迹。与分页模块共享作用域，但不接触正文内容。
var chapterPending=0;
var pageTurnTraceSequence=0;
var pageTurnTraceInput='unknown';
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
  if(x!==null){data.x_pct=Math.max(0,Math.min(100,Math.round(x/Math.max(1,window.innerWidth)*1000)/10));data.zone=x<window.innerWidth*.4?'left':(x>window.innerWidth*.6?'right':'center');}
  if(y!==null)data.y_pct=Math.max(0,Math.min(100,Math.round(y/Math.max(1,window.innerHeight)*1000)/10));
  if(extra&&typeof extra==='object'){
    ['direction','key','duration_ms','chapter','page','pages','turn_id','input','before_chapter','before_page','after_chapter','after_page'].forEach(function(key){if(extra[key]!==undefined)data[key]=extra[key];});
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
