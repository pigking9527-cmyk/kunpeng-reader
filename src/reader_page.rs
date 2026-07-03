/// 合并页的基础样式 + 分页脚本。
///  - CSS 多栏(column)把整本内容按“一屏一栏”排版，行只会在栏间断开 → 永不切字。
///  - 用 pager.scrollLeft 一页页翻；向父窗口上报 当前页/总页/进度。
///  - 监听父窗口消息：settings（阅读设置）、gotoAnchor（目录跳转）、pageTurn（翻页）。
pub(crate) const READER_PAGE_HEAD: &str = r##"<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#fff}
body{opacity:0;transition:opacity .12s ease}
body.ready{opacity:1}
*::-webkit-scrollbar{width:0;height:0;display:none}
#pager{position:fixed;inset:0;overflow:hidden}
.rr{height:100vh;box-sizing:border-box;column-fill:auto;overflow-wrap:break-word;word-break:break-word;text-align:justify}
.rr img{max-width:100%;max-height:86vh;height:auto}
/* 任何内容都不得超过一栏宽，否则该栏会变宽、后续页码错位导致正文整体右移 */
.rr *{max-width:100%}
.rr pre{white-space:pre-wrap;word-break:break-word}
.rr table{table-layout:fixed;width:100%}
/* markdown 渲染样式 */
.md-body h1{font-size:1.6em;margin:.6em 0 .4em;font-weight:700;line-height:1.3}
.md-body h2{font-size:1.35em;margin:.6em 0 .4em;font-weight:700;line-height:1.3}
.md-body h3{font-size:1.15em;margin:.5em 0 .3em;font-weight:700}
.md-body h4,.md-body h5,.md-body h6{margin:.5em 0 .3em;font-weight:700}
.md-body p{margin:.5em 0}
.md-body ul,.md-body ol{margin:.4em 0;padding-left:1.6em}
.md-body li{margin:.2em 0}
.md-body blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid #bbb;color:#666}
.md-body code{font-family:Consolas,Menlo,monospace;background:rgba(135,131,120,.15);border-radius:4px;padding:.1em .3em;font-size:.92em}
.md-body pre{background:rgba(135,131,120,.12);border-radius:6px;padding:.7em .9em;overflow:auto;white-space:pre-wrap}
.md-body pre code{background:none;padding:0}
.md-body a{color:#2b6cff;text-decoration:none}
.md-body hr{border:none;border-top:1px solid #ccc;margin:1em 0}
.md-body table{border-collapse:collapse;width:auto}
.md-body th,.md-body td{border:1px solid #ccc;padding:4px 8px}
.md-body h1,.md-body h2,.md-body h3{break-after:avoid;-webkit-column-break-after:avoid}
body.theme-dark .md-body blockquote{color:#aaa;border-color:#555}
body.theme-dark .md-body code,body.theme-dark .md-body pre{background:rgba(255,255,255,.08)}
body.theme-dark .md-body hr{border-color:#444}
body.theme-dark .md-body th,body.theme-dark .md-body td{border-color:#555}
/* MOBI/AZW3：内容本就是 HTML；按记录号引用的图片无法解析 src，隐藏避免破图 */
.mobi-body img:not([src]){display:none}
.mobi-body p{margin:.5em 0}
.rr-end{break-before:column;-webkit-column-break-before:always;width:1px;height:1px;font-size:0}
#measurer{position:fixed;left:-99999px;top:0;overflow:hidden;pointer-events:none}
mark.search-hit{background:#ffe58a;color:inherit}
::highlight(tts){background:#ffd54a;color:#111}
mark.search-hit.cur{background:#ff9f40}
mark.hl{background:#fff3a0;color:inherit;border-radius:2px;cursor:pointer;box-shadow:inset 0 -2px 0 rgba(214,170,30,.5)}
mark.hl.has-note{box-shadow:inset 0 -2px 0 rgba(43,108,255,.6)}
#sel-menu{position:fixed;display:none;z-index:99999}
#sel-menu button{font:12px/1 system-ui,'Microsoft YaHei',sans-serif;color:#4a463e;background:#faf8f2;border:1px solid #e4ddcd;border-radius:6px;padding:5px 9px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.14);white-space:nowrap}
#sel-menu button:hover{background:#f1ebdc}
#sel-menu button+button{margin-left:4px}
#hl-menu{position:fixed;display:none;z-index:99999}
#hl-menu button{font:12px/1 system-ui,'Microsoft YaHei',sans-serif;color:#4a463e;background:#faf8f2;border:1px solid #e4ddcd;border-radius:6px;padding:5px 9px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.14);white-space:nowrap}
#hl-menu button:hover{background:#f1ebdc}
#hl-menu button+button{margin-left:4px}
#fn-pop{position:fixed;display:none;z-index:100001;left:8px;right:8px;max-height:58vh;overflow:auto;background:#fff7c0;border:1px solid #e6d77a;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:12px 16px 16px;font-size:16px;line-height:1.85;color:#3a3320;font-family:system-ui,'Microsoft YaHei',sans-serif}
#fn-pop .fn-close{float:right;cursor:pointer;color:#8a7a30;font-size:20px;line-height:1;margin:-2px -4px 0 10px}
#fn-pop .fn-body p{margin:0 0 .5em}
#fn-pop a{color:#2b6cff;text-decoration:none}
#dict-pop{position:fixed;display:none;z-index:100002;left:8px;right:8px;max-width:560px;margin:0 auto;max-height:52vh;overflow:auto;background:#fff;border:1px solid #e2e2e6;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.28);padding:12px 16px 14px;font-family:system-ui,'Microsoft YaHei',sans-serif;color:#222}
#dict-pop .dc-close{float:right;cursor:pointer;color:#aaa;font-size:18px;line-height:1;margin:-2px -4px 0 10px}
#dict-pop .dc-word{font-size:18px;font-weight:700;color:#1a1a1a}
#dict-pop .dc-phon{font-size:14px;color:#2b6cff;margin-left:8px;font-weight:400}
#dict-pop .dc-spk{cursor:pointer;margin-left:10px;font-size:16px;user-select:none;vertical-align:-1px}
#dict-pop .dc-spk:hover{opacity:.7}
#dict-pop .dc-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;padding-right:24px}
#dict-pop .dc-toggle{margin-left:auto;align-self:center;display:inline-flex;border:1px solid #d8d8de;border-radius:6px;overflow:hidden}
#dict-pop .dc-toggle .dt{cursor:pointer;font-size:12px;padding:2px 9px;color:#666;user-select:none}
#dict-pop .dc-toggle .dt.on{background:#2b6cff;color:#fff}
body.theme-dark #dict-pop .dc-toggle{border-color:#555}
body.theme-dark #dict-pop .dc-toggle .dt{color:#bbb}
#dict-pop .dc-def{font-size:15px;line-height:1.85;color:#333;margin-top:8px;text-align:left;text-align-last:left}
#dict-pop .dc-defblk{white-space:pre-wrap;margin-top:8px;text-align:left;text-align-last:left}
#dict-pop .dc-defblk:first-child{margin-top:0}
#dict-pop .dc-lb{display:inline-block;font-size:11px;color:#fff;background:#9aa3b2;border-radius:4px;padding:0 6px;margin-right:6px;vertical-align:2px}
#dict-pop .dc-miss{color:#999}
body.theme-dark #dict-pop .dc-def{color:#cfcfcf}
body.theme-dark #dict-pop{background:#2a2a2e;border-color:#444;color:#ddd}
body.theme-dark #dict-pop .dc-word{color:#fff}
body.theme-dark #dict-pop .dc-def{color:#cfcfcf}
body.theme-sepia #dict-pop{background:#fbf5e3;border-color:#e4ddcd}
#hl-note{position:fixed;display:none;z-index:100000;width:400px;max-width:92vw;background:#fffdf5;border:1px solid #e4ddcd;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.22);padding:14px;font-family:system-ui,'Microsoft YaHei',sans-serif}
#hl-note .ctx{font-size:15px;line-height:1.8;color:#444;max-height:150px;overflow:auto;margin-bottom:10px;padding:10px 12px;background:#fbf5e3;border-radius:8px}
#hl-note .ctx mark.hl{background:#ffd95a;color:inherit;box-shadow:none}
#hl-note textarea{width:100%;box-sizing:border-box;font-size:16px;line-height:1.65;min-height:100px;border:1px solid #ddd;border-radius:8px;padding:10px;resize:vertical;font-family:inherit;outline:none}
#hl-note textarea:focus{border-color:#5aa0ff}
#hl-note .row{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
#hl-note button.act{font:14px/1 system-ui,'Microsoft YaHei',sans-serif;padding:8px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}
#hl-note button.save{background:#2b6cff;color:#fff;border-color:#2b6cff}
#hl-note button.del{color:#c0392b;border-color:#e2b6ae;background:#fff}
</style>
<script>
var S={fontFamily:"",fontSize:18,lineHeight:1.7,paraSpacing:0.6,letterSpacing:0,marginTop:18,marginBottom:24,marginLeft:28,marginRight:28};
var root,pager,curCh=0,pageInCh=0,pagesInCh=1,pageStep=1,headSeen={},chapChars=0;
var downX=null,downY=null,didDrag=false;
var overlayOpen=false; // 外壳里搜索框/设置面板是否打开（打开时正文点击只用于关闭它）
var ttsOn=false,ttsMap=[],ttsText='',ttsSents=[],ttsVoice=null,ttsRate=1,ttsSi=0,ttsGen=0,ttsAudioEl=null,ttsCache={},ttsWaiting=-1,ttsPlayedAny=false; // 朗读状态
function userNav(){parent.postMessage({userNav:1},'*');} // 用户主动翻页（键盘/滚轮）通知外壳关闭浮层
var measurer,chapterPages=[],measureDone=false,measureToken=0,measureTimer=null,pageSig='';
// 版式签名：窗口尺寸+字体/字号/行距/段距/字间距/页边距 都一致才能复用缓存的页数
function layoutSig(){return [window.innerWidth,window.innerHeight,S.fontSize,S.lineHeight,S.paraSpacing,S.letterSpacing,S.fontFamily,S.marginTop,S.marginBottom,S.marginLeft,S.marginRight].join('|');}
var CH=window.__CH__||0, ID=window.__ID__||0;
var VC=null; // 虚拟章节列表 [{ch:spine序号, frag:锚点}]（按目录顺序），用于在大文件内细分逻辑章节
// 算出“当前在第几个逻辑章节（0 基）”：取目录顺序中位置 <= 当前阅读位置的最后一条
function computeLogical(){
  if(!VC||!VC.length)return {lc:curCh,lt:CH};
  var idx=0;
  for(var k=0;k<VC.length;k++){
    var v=VC[k];
    if(v.ch<curCh){idx=k;}
    else if(v.ch===curCh){
      var pg=0;if(v.frag){var el=document.getElementById(v.frag);if(el)pg=pageOf(el);}
      if(pg<=pageInCh){idx=k;}else{break;}
    }else{break;}
  }
  return {lc:idx,lt:VC.length};
}
function applyStyle(){
  var st=document.getElementById('user-style');
  if(!st){st=document.createElement('style');st.id='user-style';document.head.appendChild(st);}
  var c='.rr{padding:'+mg(S.marginTop)+'px '+mg(S.marginRight)+'px '+mg(S.marginBottom)+'px '+mg(S.marginLeft)+'px;';
  if(S.fontSize)c+='font-size:'+S.fontSize+'px;';
  if(S.lineHeight)c+='line-height:'+S.lineHeight+';';
  c+='letter-spacing:'+S.letterSpacing+'px;';
  if(S.fontFamily)c+='font-family:'+S.fontFamily+';';
  c+='}';
  if(S.fontFamily)c+='.rr *{font-family:'+S.fontFamily+' !important;}';
  if(S.lineHeight)c+='.rr p,.rr div,.rr li{line-height:'+S.lineHeight+';}';
  c+='.rr p{margin-top:0;margin-bottom:'+S.paraSpacing+'em;}';
  // 有些书给每个元素写死了内联 font-size（如本书 16px），会压过阅读器字号设置 → 让其继承（正文跟随设置）
  if(S.fontSize){
    c+='.rr [style*="font-size"]{font-size:inherit !important;}';
    c+='.rr h1{font-size:1.7em;} .rr h2{font-size:1.4em;} .rr h3{font-size:1.2em;} .rr h4{font-size:1.1em;}';
    c+='.rr sup,.rr sub{font-size:.75em;}'; // 上下标（注释角标）仍保持小一号
  }
  var bg='#fff',fg='#222';
  if(S.theme==='dark'){bg='#1c1c1e';fg='#d2d2d2';}
  else if(S.theme==='sepia'){bg='#f4ecd8';fg='#5b4636';}
  c+='html,body{background:'+bg+' !important;}';
  if(S.theme&&S.theme!=='light'){c+='.rr,.rr *{color:'+fg+' !important;}';}
  // 强制横排：有些书自带 -epub-writing-mode:vertical-rl（竖排），覆盖成横排左→右
  c+='html,body,.rr,.rr *{writing-mode:horizontal-tb !important;-webkit-writing-mode:horizontal-tb !important;-epub-writing-mode:horizontal-tb !important;text-orientation:mixed !important;}.rr{direction:ltr !important;}';
  st.textContent=c;
}
// 页边距夹到非负且有上限：负内边距会破坏分栏排版（正文溢出/整体变形）
function mg(v){v=parseInt(v,10);if(isNaN(v)||v<0)return 0;return v>240?240:v;}
function applyCols(){
  var vw=window.innerWidth, vh=window.innerHeight, ml=mg(S.marginLeft), mr=mg(S.marginRight), colW=Math.max(100, vw-ml-mr);
  root.style.height=vh+'px';root.style.columnWidth=colW+'px';root.style.columnGap=(ml+mr)+'px';
  // 末尾有一个强制分栏的占位空栏（rr-end），让滚动条能到达真正的最后一页；页数要减掉它
  pageStep=vw;pagesInCh=Math.max(1,Math.round(pager.scrollWidth/vw)-1);
}
function report(){
  var chFrac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
  var gP=0,gT=0;
  if(measureDone){for(var i=0;i<CH;i++)gT+=chapterPages[i]||1;for(var j=0;j<curCh;j++)gP+=chapterPages[j]||1;gP+=pageInCh+1;}
  // 进度优先按“整书页位置”算（章节大小不均时仍平滑）；未测量完再退回按章节估算
  // 用 0 基：首页(gP=1)=0%、末页(gP=gT)=100%
  var prog;
  if(measureDone&&gT>0)prog=gT>1?((gP-1)/(gT-1))*100:0;
  else prog=CH>0?((curCh+chFrac)/CH)*100:0;
  var L=computeLogical();
  var pageChars=pagesInCh>0?Math.round(chapChars/pagesInCh):chapChars; // 当前页约略字数（按本章字数/页数均摊）
  parent.postMessage({chapter:curCh,chFrac:chFrac,page:pageInCh+1,total:pagesInCh,totalCh:CH,progress:prog,gPage:gP,gTotal:gT,logicalCh:L.lc,logicalTotal:L.lt,pageChars:pageChars},'*');
  // 注意：不在这里记录锚点。report() 也会被 relayout() 调到；若每次都重取锚点，
  // 拖动字号滑块时会把“重排后已偏移的顶部”当成新锚点，逐步累积漂移→整页跑掉。
  // 锚点只在用户“导航”（翻页/跳章/跳搜索命中）时更新，见 captureAnchor()。
}
// 记录当前页顶部锚点（精确到字符）。仅在用户主动导航后调用，供之后的重排锁定位置。
function captureAnchor(){curTopAnchor=topAnchor();}
function measureChapterPages(html){
  if(!measurer)return 1;
  var vw=window.innerWidth,vh=window.innerHeight,colW=Math.max(100,vw-S.marginLeft-S.marginRight);
  measurer.style.width=vw+'px';measurer.style.height=vh+'px';measurer.style.columnWidth=colW+'px';measurer.style.columnGap=(S.marginLeft+S.marginRight)+'px';
  measurer.innerHTML=html;
  return Math.max(1,Math.round(measurer.scrollWidth/vw));
}
function measureAll(){
  if(measureDone&&pageSig===layoutSig())return; // 版式没变、已有页数 → 不重算
  var tok=++measureToken;measureDone=false;chapterPages=new Array(CH).fill(0);
  var i=0;
  function step(){
    if(tok!==measureToken)return;
    if(i>=CH){if(measurer)measurer.innerHTML='';measureDone=true;pageSig=layoutSig();report();
      parent.postMessage({measured:{sig:pageSig,pages:chapterPages.slice()}},'*');return;} // 测完落盘缓存
    fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
      if(tok!==measureToken)return;chapterPages[i]=measureChapterPages(d.body||'');i++;setTimeout(step,0);
    }).catch(function(){chapterPages[i]=1;i++;setTimeout(step,0);});
  }
  step();
}
// 外壳送来缓存的页数：版式签名一致就直接采用，跳过测量
function applyPageCache(pc){
  if(!pc||!pc.pages||pc.pages.length!==CH)return;
  if(pc.sig!==layoutSig())return; // 版式变了，缓存作废，照常测量
  measureToken++; // 作废可能在跑的测量
  chapterPages=pc.pages.slice();measureDone=true;pageSig=pc.sig;
  if(measureTimer){clearTimeout(measureTimer);measureTimer=null;}
  report();
}
function scheduleMeasure(){if(measureTimer)clearTimeout(measureTimer);measureTimer=setTimeout(measureAll,1200);}
// 滚动条按“全书页位置”精确定位：已测量完→映射到具体章+页（同章直接翻页，平滑；跨章才加载）；
// 未测量完→退回按章节粗跳。这样点滑块附近不再原地跳，拖动也能平滑跟随。
function gotoGlobalFrac(frac){
  frac=Math.max(0,Math.min(1,frac));
  if(measureDone){
    var gt=0,i;for(i=0;i<CH;i++)gt+=chapterPages[i]||1;if(gt<1)gt=1;
    var gp=Math.round(frac*(gt-1)),acc=0,tc=CH-1,tp=0;
    for(i=0;i<CH;i++){var cp=chapterPages[i]||1;if(gp<acc+cp){tc=i;tp=gp-acc;break;}acc+=cp;}
    if(tc===curCh)gotoPage(tp);else showChapter(tc,tp);
  }else{
    showChapter(Math.min(CH-1,Math.floor(frac*CH)),'start');
  }
}
function gotoPage(p){pageInCh=Math.max(0,Math.min(pagesInCh-1,p));pager.scrollLeft=pageInCh*pageStep;report();captureAnchor();}
function pageOf(el){var r=el.getBoundingClientRect(),pr=pager.getBoundingClientRect();var x=r.left-pr.left+pager.scrollLeft;return Math.floor((x+1)/pageStep);}
function showChapter(i,where,frag){
  i=Math.max(0,Math.min(CH-1,i));
  return fetch(location.origin+'/chapter/'+ID+'/'+i).then(function(r){return r.json();}).then(function(d){
    curCh=i;if(d.head)injectHead(d.head,headSeen);root.innerHTML=(d.body||'')+'<div class="rr-end"></div>';chapChars=(root.textContent||'').replace(/\s/g,'').length;applyStyle();applyCols();applyHighlights();
    pageInCh=0;
    if(where==='end')pageInCh=pagesInCh-1;else if(typeof where==='number')pageInCh=Math.max(0,Math.min(pagesInCh-1,where));
    if(frag){var el=document.getElementById(frag);if(el)pageInCh=pageOf(el);}
    pager.scrollLeft=pageInCh*pageStep;report();captureAnchor();
  }).catch(function(){});
}
var curTopAnchor=null; // 实时记录的当前页顶部锚点（精确到字符）
// 视口左上角对应的"字符级"锚点。长段落跨多列时，元素级锚点的 left 是段首所在列，
// 会让重排后跳回段首（如金庸全集的超长段落）；用 caret 定位到具体字符即可避免。
function topAnchor(){
  var x=Math.max(2,(S.marginLeft||0)+8), y=Math.max(2,(S.marginTop||0)+8);
  var rng=null;
  if(document.caretRangeFromPoint){ rng=document.caretRangeFromPoint(x,y); }
  else if(document.caretPositionFromPoint){ var cp=document.caretPositionFromPoint(x,y); if(cp){rng=document.createRange();rng.setStart(cp.offsetNode,cp.offset);rng.collapse(true);} }
  if(rng){
    try{var n=rng.startContainer,o=rng.startOffset;if(n.nodeType===3&&o<n.nodeValue.length)rng.setEnd(n,o+1);}catch(e){}
    return {range:rng};
  }
  var el=document.elementFromPoint(x,y);
  while(el&&el!==root&&el.nodeType===1){ if((el.textContent||'').trim()) return {el:el}; el=el.parentNode; }
  return null;
}
function anchorValid(a){
  if(!a)return false;
  if(a.range){var n=a.range.startContainer;return !!(n&&n.isConnected);}
  if(a.el){return !!a.el.isConnected;}
  return false;
}
function anchorPage(a){
  var r=null;
  if(a.range){ r=a.range.getBoundingClientRect(); if(r&&!r.width&&!r.height&&!r.left&&!r.top){var rs=a.range.getClientRects();if(rs&&rs.length)r=rs[0];} }
  else if(a.el){ r=a.el.getBoundingClientRect(); }
  if(!r)return pageInCh;
  var pr=pager.getBoundingClientRect();
  var x=r.left-pr.left+pager.scrollLeft;
  return Math.max(0,Math.min(pagesInCh-1,Math.floor((x+1)/pageStep)));
}
function relayout(){
  if(!root)return;
  // 用"重排前"就记好的锚点（resize 时浏览器已先重排，临时再取就晚了）
  var anchor=anchorValid(curTopAnchor)?curTopAnchor:topAnchor();
  applyStyle();applyCols();
  if(anchor){ pageInCh=anchorPage(anchor); }
  else if(pageInCh>pagesInCh-1){ pageInCh=pagesInCh-1; }
  pager.scrollLeft=pageInCh*pageStep;report();
}
function nextPage(){if(pageInCh<pagesInCh-1)gotoPage(pageInCh+1);else if(curCh<CH-1)showChapter(curCh+1,'start');}
function prevPage(){if(pageInCh>0)gotoPage(pageInCh-1);else if(curCh>0)showChapter(curCh-1,'end');}
function reveal(){document.body.classList.add('ready');}
// ---- 高亮/批注 ----
var HL=[]; // 全书高亮 [{chapter,start,end,text,note}]，数组下标即后端 index
function clearHighlights(){
  if(!root)return;var ms=root.querySelectorAll('mark.hl');
  for(var i=0;i<ms.length;i++){var m=ms[i];if(m.parentNode)m.parentNode.replaceChild(document.createTextNode(m.textContent),m);}
  root.normalize();
}
function wrapRange(s,e,idx,note){
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null);
  var pos=0,node,segs=[];
  while(node=walker.nextNode()){
    var len=node.nodeValue.length,ns=pos,ne=pos+len;pos=ne;
    var a=Math.max(s,ns),b=Math.min(e,ne);
    if(a<b)segs.push({node:node,from:a-ns,to:b-ns});
    if(ne>=e)break;
  }
  for(var i=segs.length-1;i>=0;i--){var w=segs[i];try{
    var r=document.createRange();r.setStart(w.node,w.from);r.setEnd(w.node,w.to);
    var mk=document.createElement('mark');mk.className='hl'+(note?' has-note':'');mk.setAttribute('data-hi',idx);if(note)mk.title=note;
    r.surroundContents(mk);
  }catch(_){}}
}
function applyHighlights(){
  if(!root)return;
  for(var i=0;i<HL.length;i++){var h=HL[i];if(h.chapter===curCh)wrapRange(h.start,h.end,i,h.note||'');}
}
function refreshHighlights(){clearHighlights();applyHighlights();}
function selOffsets(){
  var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return null;
  var r=sel.getRangeAt(0);var t=r.toString();if(!t||!t.length)return null;
  var pre=document.createRange();pre.selectNodeContents(root);
  try{pre.setEnd(r.startContainer,r.startOffset);}catch(e){return null;}
  var start=pre.toString().length;
  return {start:start,end:start+t.length,text:t};
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
    if(rf>0.005)gotoPage(Math.round(rf*(pagesInCh-1)));
    reveal();parent.postMessage({ready:1},'*');
    scheduleMeasure(); // 后台测量全书页数
  });
}
function init(){
  pager=document.getElementById('pager');root=document.getElementById('reader-root');measurer=document.getElementById('measurer');
  loadInit();
  setTimeout(function(){reveal();parent.postMessage({ready:1},'*');},8000); // 兜底
  // 记录是否发生了拖动（用于区分“单击翻页”与“拖动选字”）
  document.addEventListener('mousedown',function(e){downX=e.clientX;downY=e.clientY;didDrag=false;if(e.detail>1)e.preventDefault();}); // e.detail>1：双击/三击 → 阻止浏览器选词/选段（连点翻页常被当双击而误选）
  document.addEventListener('mousemove',function(e){if(downX!==null&&(Math.abs(e.clientX-downX)>4||Math.abs(e.clientY-downY)>4))didDrag=true;});
  document.addEventListener('click',function(e){
    parent.postMessage({uiClick:1},'*');
    if(overlayOpen){return;} // 有搜索框/设置浮层时，点击正文只用于关闭浮层，不翻页/不弹菜单
    // 点到已高亮的文字 → 出高亮菜单，不翻页
    var hm=e.target.closest?e.target.closest('mark.hl'):null;
    if(hm){e.stopPropagation();showHlMenu(parseInt(hm.getAttribute('data-hi'),10));return;}
    if(e.target.closest&&e.target.closest('#fn-pop'))return; // 注释弹窗内点击：不翻页
    var a=e.target.closest?e.target.closest('a'):null;
    if(a){var href=a.getAttribute('href')||'';
      if(href.charAt(0)==='#'){e.preventDefault();
        var m=/^#c(\d+)(?:~(.+))?$/.exec(href);
        var frag=m?m[2]:href.slice(1), ciT=m?parseInt(m[1],10):curCh;
        if(isNoteLink(a)&&frag){showFootnote(a,ciT,frag);return;} // 注释角标 → 弹注释正文
        if(m){var ci=ciT,fr=frag;if(ci===curCh){if(fr){var el=document.getElementById(fr);if(el)gotoPage(pageOf(el));}}else showChapter(ci,'start',fr);}
        else{var el2=document.getElementById(href.slice(1));if(el2)gotoPage(pageOf(el2));}
      }
      return;
    }
    hideFn(); // 点别处 → 收起注释弹窗
    // 拖动选字（或存在选中文字）时不翻页，让 web 搜索菜单稳定停在高亮处
    var sel=window.getSelection?window.getSelection():null;
    if(didDrag||(sel&&!sel.isCollapsed&&sel.toString().trim())){return;}
    var x=e.clientX;if(x>window.innerWidth*0.6)nextPage();else if(x<window.innerWidth*0.4)prevPage();else parent.postMessage({centerTap:1},'*');
  });
  document.addEventListener('keydown',function(e){if(((e.ctrlKey||e.metaKey)&&(e.key==='f'||e.key==='F'))||e.key==='F3')e.preventDefault();},true); // 禁用浏览器自带查找
  document.addEventListener('keydown',function(e){
    if(e.key==='PageDown'||e.key==='ArrowRight'||(e.key===' '&&!e.shiftKey)){e.preventDefault();userNav();nextPage();}
    else if(e.key==='PageUp'||e.key==='ArrowLeft'||(e.key===' '&&e.shiftKey)){e.preventDefault();userNav();prevPage();}
  });
  var wheelLock=false;
  document.addEventListener('wheel',function(e){e.preventDefault();if(wheelLock)return;if(Math.abs(e.deltaY)<4&&Math.abs(e.deltaX)<4)return;userNav();if(e.deltaY>0||e.deltaX>0)nextPage();else prevPage();wheelLock=true;setTimeout(function(){wheelLock=false;},220);},{passive:false});
  window.addEventListener('resize',function(){relayout();scheduleMeasure();});
  setupSelMenu();
  setupHlUi();
  setupFn();
  setupDict();
  document.addEventListener('contextmenu',function(e){e.preventDefault();}); // 禁用浏览器右键菜单
}
// 选中文字后弹出“web搜索”菜单 → 通知父窗口用浏览器搜索
var selMenu=null;
function hideSelMenu(){if(selMenu)selMenu.style.display='none';}
function setupSelMenu(){
  selMenu=document.createElement('div');selMenu.id='sel-menu';
  var btn=document.createElement('button');btn.type='button';btn.textContent='🔍 web搜索';
  var btnDict=document.createElement('button');btnDict.type='button';btnDict.textContent='📖 词典';
  var btnHL=document.createElement('button');btnHL.type='button';btnHL.textContent='🖍 高亮';
  var btnNote=document.createElement('button');btnNote.type='button';btnNote.textContent='📝 批注';
  var btnBm=document.createElement('button');btnBm.type='button';btnBm.textContent='🔖 书签';
  selMenu.appendChild(btn);selMenu.appendChild(btnDict);selMenu.appendChild(btnHL);selMenu.appendChild(btnNote);selMenu.appendChild(btnBm);
  document.body.appendChild(selMenu);
  [btn,btnDict,btnHL,btnNote,btnBm].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  btnDict.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    if(t)openDict(t,getSelContext());
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
    hideSelMenu();
  });
  btnNote.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();parent.postMessage({addHighlightNote:o},'*');}
    hideSelMenu();
  });
  function showSelMenuAtSelection(){
    var sel=window.getSelection?window.getSelection():null;
    var t=sel?sel.toString().trim():'';
    if(!t){hideSelMenu();return;}
    hideHlMenu(); // 出选区菜单时，先收起"已高亮"菜单，保证同时只有一个
    var rect;try{rect=sel.getRangeAt(0).getBoundingClientRect();}catch(_){hideSelMenu();return;}
    if(!rect||(!rect.width&&!rect.height)){hideSelMenu();return;}
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
  document.addEventListener('keydown',hideSelMenu);
}

// ---- 点击/悬停"已高亮文字" → 一个菜单（web搜索 / 取消高亮 / 批注）；批注用父窗口的大批注页 ----
var hlMenu=null,activeHi=-1,hlHideTimer=null;
function mkBtn(txt){var b=document.createElement('button');b.type='button';b.textContent=txt;return b;}
function hideHlMenu(){if(hlMenu)hlMenu.style.display='none';}
function markEl(idx){return root?root.querySelector('mark.hl[data-hi="'+idx+'"]'):null;}
function selActive(){var s=window.getSelection?window.getSelection():null;return !!(s&&!s.isCollapsed&&s.toString().trim());}
function showHlMenu(idx){
  if(selActive())return;          // 还在选字（如刚高亮完）就不弹，避免和选区菜单同时出现
  hideSelMenu();                  // 任何时候只保留一个工具栏
  activeHi=idx;var el=markEl(idx);if(!el)return;
  hlMenu.style.display='block';
  var rect=el.getBoundingClientRect();
  var mw=hlMenu.offsetWidth||200,mh=hlMenu.offsetHeight||34;
  var left=rect.left+rect.width/2-mw/2;left=Math.max(6,Math.min(window.innerWidth-mw-6,left));
  var top=rect.top-mh-8;if(top<6)top=rect.bottom+8;
  hlMenu.style.left=left+'px';hlMenu.style.top=top+'px';
}
function setupHlUi(){
  hlMenu=document.createElement('div');hlMenu.id='hl-menu';
  var mWeb=mkBtn('🔍 web搜索'),mDict=mkBtn('📖 词典'),mDel=mkBtn('🗑 取消高亮'),mNote=mkBtn('📝 批注');
  hlMenu.append(mWeb,mDict,mDel,mNote);document.body.appendChild(hlMenu);
  [mWeb,mDict,mDel,mNote].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  mWeb.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)parent.postMessage({webSearch:h.text},'*');hideHlMenu();});
  mDict.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)openDict(h.text,h.context||'');hideHlMenu();});
  mDel.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({removeHighlight:activeHi},'*');hideHlMenu();});
  mNote.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({openAnnotations:activeHi},'*');hideHlMenu();});
  hlMenu.addEventListener('mouseenter',function(){if(hlHideTimer)clearTimeout(hlHideTimer);});
  hlMenu.addEventListener('mouseleave',function(){hlHideTimer=setTimeout(hideHlMenu,400);});

  // 悬停高亮 → 出菜单；移开延时收起
  root.addEventListener('mouseover',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi'),10));}});
  root.addEventListener('mouseout',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
  document.addEventListener('mousedown',function(e){if(hlMenu&&!hlMenu.contains(e.target))hideHlMenu();});
  document.addEventListener('wheel',function(){hideHlMenu();},{passive:true});
}
// 取选区所在"整段"的纯文本（作为批注上下文，存起来供大批注页展示）
function getSelContext(){
  var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount)return '';
  var node=sel.getRangeAt(0).startContainer;var el=node.nodeType===1?node:node.parentNode;
  // 优先取最近的段落元素 <p>，没有再退回其它块级元素
  var block=el&&el.closest?(el.closest('p')||el.closest('li,blockquote,td,div,section')):el;
  var txt=((block||el).textContent||'').replace(/\s+/g,' ').trim();
  return txt.length>800?txt.slice(0,800)+'…':txt; // 整段，过长才截断
}

// ---- 注释/脚注：点角标 → 就地弹出注释正文（而不是跳过去）----
var fnPop=null;
function hideFn(){if(fnPop)fnPop.style.display='none';}
function setupFn(){
  fnPop=document.createElement('div');fnPop.id='fn-pop';
  fnPop.innerHTML='<span class="fn-close">✕</span><div class="fn-body"></div>';
  document.body.appendChild(fnPop);
  fnPop.querySelector('.fn-close').addEventListener('click',function(e){e.stopPropagation();hideFn();});
  fnPop.addEventListener('mousedown',function(e){e.stopPropagation();});
  fnPop.addEventListener('click',function(e){e.stopPropagation();if(e.target.closest&&e.target.closest('a'))e.preventDefault();}); // 弹窗内点击不翻页/不跳锚
  document.addEventListener('mousedown',function(e){if(fnPop&&fnPop.style.display==='block'&&!fnPop.contains(e.target))hideFn();});
  document.addEventListener('wheel',hideFn,{passive:true});
}
// ---- 离线词典：选中文字/已高亮 → 就地弹释义（释义由外壳查后端再回传）----
var dictPop=null,dictRect=null,dictContext='';
function hideDict(){if(dictPop)dictPop.style.display='none';}
function setupDict(){
  dictPop=document.createElement('div');dictPop.id='dict-pop';
  dictPop.innerHTML='<span class="dc-close">✕</span><div class="dc-head"></div><div class="dc-def"></div>';
  document.body.appendChild(dictPop);
  dictPop.querySelector('.dc-close').addEventListener('click',function(e){e.stopPropagation();hideDict();});
  dictPop.addEventListener('mousedown',function(e){e.stopPropagation();});
  dictPop.addEventListener('click',function(e){e.stopPropagation();});
  document.addEventListener('mousedown',function(e){if(dictPop&&dictPop.style.display==='block'&&!dictPop.contains(e.target))hideDict();});
  document.addEventListener('wheel',function(){hideDict();},{passive:true});
}
function placeDict(){
  dictPop.style.display='block';
  var ph=dictPop.offsetHeight,r=dictRect;
  var top=(r?r.bottom:120)+10;
  if(top+ph>window.innerHeight-8)top=(r?r.top:120)-ph-10;
  if(top<8)top=8;
  dictPop.style.top=top+'px';
}
function openDict(term,context){
  if(!dictPop)setupDict();
  try{var s=window.getSelection();dictRect=(s&&s.rangeCount)?s.getRangeAt(0).getBoundingClientRect():null;}catch(_){dictRect=null;}
  dictContext=(context||'').replace(/\s+/g,' ').trim();
  if(!dictContext)dictContext=getSelContext();
  dictPop.querySelector('.dc-head').textContent='查词中…';
  dictPop.querySelector('.dc-def').textContent='';dictPop.querySelector('.dc-def').className='dc-def';
  placeDict();
  parent.postMessage({dict:term},'*');
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
function renderDict(){
  if(!dictPop||!lastDict)return;
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
  def.className='dc-def';
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
  var ty=((a.getAttribute('epub:type')||'')+' '+(a.getAttribute('role')||'')+' '+(a.className||'')).toLowerCase();
  if(/note|footnote|endnote|annoref/.test(ty))return true;
  var t=(a.textContent||'').trim();
  return /^[\[【（(]?\s*\d{1,4}\s*[\]】）)]?$/.test(t);
}
function fnSelector(frag){return '[id="'+String(frag).replace(/"/g,'\\"')+'"]';}
function popFootnote(a,html){
  if(!fnPop)setupFn();
  fnPop.querySelector('.fn-body').innerHTML=html;
  fnPop.style.display='block';
  var rect=a.getBoundingClientRect();
  var ph=fnPop.offsetHeight;
  var top=rect.bottom+10;
  if(top+ph>window.innerHeight-8)top=rect.top-ph-10; // 下方放不下 → 放上方
  if(top<8)top=8;
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
function showFootnote(a,ci,frag){
  if(ci===curCh){
    var el=document.querySelector(fnSelector(frag));
    if(el){popFootnote(a,noteHtml(el));return;}
  }
  popFootnote(a,'加载中…');
  fetch(location.origin+'/chapter/'+ID+'/'+ci).then(function(r){return r.json();}).then(function(d){
    var tmp=document.createElement('div');tmp.innerHTML=d.body||'';
    var el=tmp.querySelector(fnSelector(frag));
    popFootnote(a,el?noteHtml(el):'（未找到注释内容）');
  }).catch(function(){popFootnote(a,'（注释加载失败）');});
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
  pager.scrollLeft=pageInCh*pageStep;
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
    var rr=r.getBoundingClientRect(),pr=pager.getBoundingClientRect();
    var x=rr.left-pr.left+pager.scrollLeft,pg=Math.floor((x+1)/pageStep);
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
  if(e.data.settings){S=Object.assign(S,e.data.settings);relayout();scheduleMeasure();}
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
  if(e.data.highlights){HL=e.data.highlights;refreshHighlights();}
  if(e.data.showHlMenuFor!==undefined){var si=e.data.showHlMenuFor;setTimeout(function(){if(window.getSelection)window.getSelection().removeAllRanges();showHlMenu(si);},40);}
  if(e.data.dictResult!==undefined){showDictResult(e.data.dictResult);}
  if(e.data.gotoHighlight!==undefined){var hi=e.data.gotoHighlight,h=HL[hi];if(h){showChapter(h.chapter,'start').then(function(){var el=root.querySelector('mark.hl[data-hi="'+hi+'"]');if(el)gotoPage(pageOf(el));});}}
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
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
</script>"##;
#[cfg(test)]
mod tests {
    use super::READER_PAGE_HEAD;

    #[test]
    fn reader_page_head_keeps_required_hooks() {
        assert!(READER_PAGE_HEAD.contains("window.addEventListener('message'"));
        assert!(READER_PAGE_HEAD.contains("function showChapter"));
        assert!(READER_PAGE_HEAD.contains("parent.postMessage"));
        assert!(READER_PAGE_HEAD.contains("ttsStart"));
    }
}
