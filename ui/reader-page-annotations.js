// ---- 高亮/批注 ----
// This file runs inside the chapter iframe, isolated from reader-i18n.js.  It
// receives S.uiLanguage from the reader shell and keeps every transient menu
// in the same language as the surrounding reader.
var READER_PAGE_COPY={
  'zh-CN':{yellow:'黄色',green:'绿色',blue:'蓝色',pink:'粉色',web:'网页搜索',dict:'词典',translate:'翻译',copy:'复制',highlight:'高亮',correct:'改错',excerpt:'书摘',cross:'跨书搜索',semantic:'相似语义',aiReader:'智读',note:'批注',bookmark:'书签',removeHighlight:'取消高亮',display:'显示',both:'图文',text:'文字',icon:'图标',colorful:'多彩高亮',layout:'布局',row:'横排',grid:'九宫格',size:'大小',small:'小',medium:'中',large:'大',dragSort:'拖动排序',searchEngineGoogle:'谷歌',searchEngineBaidu:'百度',original:'原文',cancel:'取消',save:'保存',downloadImage:'下载图片',generatingImage:'正在生成图片…',downloadStarted:'已开始下载',source:'原文',translation:'译文',loading:'加载中…',autoDetect:'自动检测',chinese:'中文',english:'英文',japanese:'日文',korean:'韩文',systemLanguage:'系统语言',translationFailed:'翻译失败',fillCredential:'请填写',checkCredential:'正在检查凭据配置…',savingCredential:'正在安全保存凭据…',dictionarySettings:'词典增强设置',lookingUp:'查词中…',meaningHint:'词义提示',possibleSenses:'可能义项',contextHint:'结合当前句子',hypernyms:'上位词',synonyms:'近义',antonyms:'反义',dictionaryEnhancementUnavailable:'当前词没有可用的“{option}”数据，未开启。',notFoundDefinition:'（未找到该词的释义）',noDefinition:'（无释义）',pronunciation:'发音',externalDictionary:'外置词典',footnoteLoading:'加载中…',footnoteNotFound:'（未找到注释内容）',footnoteFailed:'（注释加载失败）'},
  'zh-TW':{yellow:'黃色',green:'綠色',blue:'藍色',pink:'粉色',web:'網頁搜尋',dict:'詞典',translate:'翻譯',copy:'複製',highlight:'螢光標記',correct:'校正',excerpt:'書摘',cross:'跨書搜尋',semantic:'相似語義',aiReader:'智讀',note:'批註',bookmark:'書籤',removeHighlight:'取消標記',display:'顯示',both:'圖文',text:'文字',icon:'圖示',colorful:'多彩標記',layout:'版面',row:'橫排',grid:'九宮格',size:'大小',small:'小',medium:'中',large:'大',dragSort:'拖曳排序',searchEngineGoogle:'Google',searchEngineBaidu:'百度',original:'原文',cancel:'取消',save:'儲存',downloadImage:'下載圖片',generatingImage:'正在產生圖片…',downloadStarted:'已開始下載',source:'原文',translation:'譯文',loading:'載入中…',autoDetect:'自動偵測',chinese:'中文',english:'英文',japanese:'日文',korean:'韓文',systemLanguage:'系統語言',translationFailed:'翻譯失敗',fillCredential:'請填寫',checkCredential:'正在檢查憑據設定…',savingCredential:'正在安全儲存憑據…',dictionarySettings:'詞典增強設定',lookingUp:'查詞中…',meaningHint:'詞義提示',possibleSenses:'可能義項',contextHint:'結合目前句子',hypernyms:'上位詞',synonyms:'近義詞',antonyms:'反義詞',notFoundDefinition:'（找不到該詞釋義）',noDefinition:'（無釋義）',pronunciation:'發音',externalDictionary:'外部詞典',footnoteLoading:'載入中…',footnoteNotFound:'（找不到註釋內容）',footnoteFailed:'（註釋載入失敗）'},
  en:{yellow:'Yellow',green:'Green',blue:'Blue',pink:'Pink',web:'Web search',dict:'Dictionary',translate:'Translate',copy:'Copy',highlight:'Highlight',correct:'Correct',excerpt:'Excerpt',cross:'Search library',semantic:'Similar meaning',aiReader:'AI Reader',note:'Note',bookmark:'Bookmark',removeHighlight:'Remove highlight',display:'Display',both:'Icon + text',text:'Text',icon:'Icon',colorful:'Highlight colors',layout:'Layout',row:'Row',grid:'Grid',size:'Size',small:'Small',medium:'Medium',large:'Large',dragSort:'Drag to reorder',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu',original:'Original',cancel:'Cancel',save:'Save',downloadImage:'Download image',generatingImage:'Creating image…',downloadStarted:'Download started',source:'Source',translation:'Translation',loading:'Loading…',autoDetect:'Detect automatically',chinese:'Chinese',english:'English',japanese:'Japanese',korean:'Korean',systemLanguage:'System language',translationFailed:'Translation failed',fillCredential:'Enter',checkCredential:'Checking credential setup…',savingCredential:'Saving credentials securely…',dictionarySettings:'Dictionary options',lookingUp:'Looking up…',meaningHint:'Meaning hint',possibleSenses:'Possible senses',contextHint:'In this context',hypernyms:'Broader terms',synonyms:'Synonyms',antonyms:'Antonyms',dictionaryEnhancementUnavailable:'No {option} data is available for this word, so it remains off.',notFoundDefinition:'(No definition found)',noDefinition:'(No definition)',pronunciation:'Pronunciation',externalDictionary:'External dictionary',footnoteLoading:'Loading…',footnoteNotFound:'(Footnote not found)',footnoteFailed:'(Could not load footnote)'},
  ja:{yellow:'黄色',green:'緑色',blue:'青色',pink:'ピンク',web:'ウェブ検索',dict:'辞書',translate:'翻訳',copy:'コピー',highlight:'ハイライト',correct:'修正',excerpt:'抜粋',cross:'本棚を検索',semantic:'類似した意味',aiReader:'AI 読解',note:'注釈',bookmark:'しおり',removeHighlight:'ハイライトを削除',display:'表示',both:'アイコンと文字',text:'文字',icon:'アイコン',colorful:'色付きハイライト',layout:'レイアウト',row:'横並び',grid:'グリッド',size:'サイズ',small:'小',medium:'中',large:'大',dragSort:'ドラッグして並べ替え',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu',original:'原文',cancel:'キャンセル',save:'保存',downloadImage:'画像をダウンロード',generatingImage:'画像を作成中…',downloadStarted:'ダウンロードを開始しました',source:'原文',translation:'翻訳',loading:'読み込み中…',autoDetect:'自動検出',chinese:'中国語',english:'英語',japanese:'日本語',korean:'韓国語',systemLanguage:'システム言語',translationFailed:'翻訳に失敗しました',fillCredential:'入力してください:',checkCredential:'認証情報を確認中…',savingCredential:'認証情報を安全に保存中…',dictionarySettings:'辞書の設定',lookingUp:'検索中…',meaningHint:'語義のヒント',possibleSenses:'候補の語義',contextHint:'文脈での意味',hypernyms:'上位語',synonyms:'類義語',antonyms:'対義語',notFoundDefinition:'（定義が見つかりません）',noDefinition:'（定義がありません）',pronunciation:'発音',externalDictionary:'外部辞書',footnoteLoading:'読み込み中…',footnoteNotFound:'（注釈が見つかりません）',footnoteFailed:'（注釈を読み込めません）'}
};
var READER_HIGHLIGHT_COPY={
  'zh-CN':{highlightMenuSettings:'高亮菜单设置'},
  'zh-TW':{highlightMenuSettings:'螢光標記選單設定'},
  en:{highlightMenuSettings:'Highlight menu settings'},
  ja:{highlightMenuSettings:'ハイライトメニュー設定'},
  ko:{yellow:'노란색',green:'초록색',blue:'파란색',pink:'분홍색',web:'웹 검색',dict:'사전',translate:'번역',copy:'복사',highlight:'하이라이트',correct:'교정',excerpt:'발췌',cross:'서재 검색',semantic:'유사 의미',aiReader:'AI 읽기',note:'주석',bookmark:'책갈피',removeHighlight:'하이라이트 삭제',highlightMenuSettings:'하이라이트 메뉴 설정',display:'표시',both:'아이콘 + 텍스트',text:'텍스트',icon:'아이콘',colorful:'하이라이트 색상',layout:'레이아웃',row:'가로 배열',grid:'격자',size:'크기',small:'작게',medium:'보통',large:'크게',dragSort:'끌어서 순서 변경',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  fr:{yellow:'Jaune',green:'Vert',blue:'Bleu',pink:'Rose',web:'Recherche Web',dict:'Dictionnaire',translate:'Traduire',copy:'Copier',highlight:'Surligner',correct:'Corriger',excerpt:'Extrait',cross:'Rechercher dans la bibliothèque',semantic:'Sens similaire',aiReader:'Lecture IA',note:'Note',bookmark:'Signet',removeHighlight:'Supprimer le surlignage',highlightMenuSettings:'Réglages du menu de surlignage',display:'Affichage',both:'Icône + texte',text:'Texte',icon:'Icône',colorful:'Couleurs de surlignage',layout:'Disposition',row:'Ligne',grid:'Grille',size:'Taille',small:'Petite',medium:'Moyenne',large:'Grande',dragSort:'Faire glisser pour réorganiser',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  de:{yellow:'Gelb',green:'Grün',blue:'Blau',pink:'Rosa',web:'Websuche',dict:'Wörterbuch',translate:'Übersetzen',copy:'Kopieren',highlight:'Markieren',correct:'Korrigieren',excerpt:'Auszug',cross:'Bibliothek durchsuchen',semantic:'Ähnliche Bedeutung',aiReader:'KI-Lesen',note:'Notiz',bookmark:'Lesezeichen',removeHighlight:'Markierung entfernen',highlightMenuSettings:'Einstellungen des Markierungsmenüs',display:'Anzeige',both:'Symbol + Text',text:'Text',icon:'Symbol',colorful:'Markierungsfarben',layout:'Layout',row:'Zeile',grid:'Raster',size:'Größe',small:'Klein',medium:'Mittel',large:'Groß',dragSort:'Zum Sortieren ziehen',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  es:{yellow:'Amarillo',green:'Verde',blue:'Azul',pink:'Rosa',web:'Búsqueda web',dict:'Diccionario',translate:'Traducir',copy:'Copiar',highlight:'Resaltar',correct:'Corregir',excerpt:'Extracto',cross:'Buscar en la biblioteca',semantic:'Significado similar',aiReader:'Lectura con IA',note:'Nota',bookmark:'Marcador',removeHighlight:'Quitar resaltado',highlightMenuSettings:'Ajustes del menú de resaltado',display:'Visualización',both:'Icono + texto',text:'Texto',icon:'Icono',colorful:'Colores de resaltado',layout:'Diseño',row:'Fila',grid:'Cuadrícula',size:'Tamaño',small:'Pequeño',medium:'Mediano',large:'Grande',dragSort:'Arrastrar para reordenar',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  ru:{yellow:'Жёлтый',green:'Зелёный',blue:'Синий',pink:'Розовый',web:'Поиск в интернете',dict:'Словарь',translate:'Перевести',copy:'Копировать',highlight:'Выделить',correct:'Исправить',excerpt:'Цитата',cross:'Поиск по библиотеке',semantic:'Похожий смысл',aiReader:'ИИ-чтение',note:'Примечание',bookmark:'Закладка',removeHighlight:'Удалить выделение',highlightMenuSettings:'Настройки меню выделения',display:'Отображение',both:'Значок + текст',text:'Текст',icon:'Значок',colorful:'Цвета выделения',layout:'Макет',row:'Строка',grid:'Сетка',size:'Размер',small:'Маленький',medium:'Средний',large:'Большой',dragSort:'Перетащите для изменения порядка',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'},
  'pt-BR':{yellow:'Amarelo',green:'Verde',blue:'Azul',pink:'Rosa',web:'Pesquisa na Web',dict:'Dicionário',translate:'Traduzir',copy:'Copiar',highlight:'Destacar',correct:'Corrigir',excerpt:'Trecho',cross:'Pesquisar na biblioteca',semantic:'Sentido semelhante',aiReader:'Leitura com IA',note:'Nota',bookmark:'Marcador',removeHighlight:'Remover destaque',highlightMenuSettings:'Configurações do menu de destaque',display:'Exibição',both:'Ícone + texto',text:'Texto',icon:'Ícone',colorful:'Cores de destaque',layout:'Layout',row:'Linha',grid:'Grade',size:'Tamanho',small:'Pequeno',medium:'Médio',large:'Grande',dragSort:'Arraste para reordenar',searchEngineGoogle:'Google',searchEngineBaidu:'Baidu'}
};
Object.keys(READER_HIGHLIGHT_COPY).forEach(function(locale){
  READER_PAGE_COPY[locale]=Object.assign(READER_PAGE_COPY[locale]||{},READER_HIGHLIGHT_COPY[locale]);
});
Object.assign(READER_PAGE_COPY['zh-CN'],{gray:'灰色'});
Object.assign(READER_PAGE_COPY['zh-TW'],{gray:'灰色'});
Object.assign(READER_PAGE_COPY.en,{gray:'Gray'});
Object.assign(READER_PAGE_COPY.ja,{gray:'グレー'});
Object.assign(READER_PAGE_COPY.ko,{gray:'회색'});
Object.assign(READER_PAGE_COPY.fr,{gray:'Gris'});
Object.assign(READER_PAGE_COPY.de,{gray:'Grau'});
Object.assign(READER_PAGE_COPY.es,{gray:'Gris'});
Object.assign(READER_PAGE_COPY.ru,{gray:'Серый'});
Object.assign(READER_PAGE_COPY['pt-BR'],{gray:'Cinza'});
function readerPageLanguage(){var raw=(S&&S.uiLanguage)||document.documentElement.lang||'zh-CN';if(READER_PAGE_COPY[raw])return raw;var base=String(raw).split('-')[0];return base==='zh'?'zh-CN':(READER_PAGE_COPY[base]?base:'en');}
function readerPageText(key){var lang=readerPageLanguage(),copy=READER_PAGE_COPY[lang]||READER_PAGE_COPY.en;return copy[key]||READER_PAGE_COPY.en[key]||key;}
// 初次排版本章首页后才能恢复锚点；恢复完成前禁止持久化这个临时位置。
var initialResumePending=true;
var HL=[]; // 全书高亮 [{chapter,start,end,text,note}]，数组下标即后端 index
var hlOverlay=null,sourceTextCache=null,highlightRenderTimer=null;
function generatedTextNode(node){
  var el=node&&node.nodeType===3?node.parentElement:(node&&node.nodeType===1?node:null);
  // rr-mode-switch-anchor 承载的是从原段落拆出的真实正文，不是生成文字；
  // 必须参与原文偏移、高亮和搜索，否则切换模式后所有后续偏移都会错位。
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
// 智读侧栏开关专用的锚点事务。它不依赖第一次 resize 事件：父窗口会给出真实
// iframe 宽度，正文页等到该宽度连续两帧不变后才恢复，避免重排后又被后续 resize 覆盖。
var readerSideViewportRestoreRaf=0;
function readerSideViewportDiag(tx,phase,extra){
  if(!tx)return;
  var sampled=null,sampledOffset=null;
  try{sampled=topAnchor();sampledOffset=sideAnchorVirtualOffset!=null?sideAnchorVirtualOffset:anchorTextOffset(sampled);}catch(_){}
  var payload={
    id:tx.id,phase:phase,chapter:curCh,page:pageInCh+1,pages:pagesInCh,
    targetOffset:tx.offset,sampledOffset:sampledOffset,width:Math.round(window.innerWidth||0),
    expectedWidth:tx.expectedWidth||0,preparedWidth:tx.preparedWidth||0,
    flow:S.flowMode,pageMode:S.pageMode,virtualOffset:sideAnchorVirtualOffset
  };
  if(extra)for(var k in extra)payload[k]=extra[k];
  parent.postMessage({readerPerf:'ai_side_anchor '+JSON.stringify(payload)},'*');
}
function finishReaderSideViewportRestore(tx,reason){
  if(!tx||tx!==window.__readerSideViewportTxn||tx.finished)return;
  tx.finished=true;
  var range=sourceRangeForOffsets(tx.offset,tx.offset+1);
  if(range){
    curTopAnchor={range:range};
    relayout({
      anchor:curTopAnchor,anchorOffset:tx.offset,sidePaneResize:true,
      exactScroll:isScrollMode(),scrollOffset:tx.viewportOffset
    });
  }
  requestAnimationFrame(function(){
    if(tx!==window.__readerSideViewportTxn)return;
    // 再以同一原始偏移定位一次，确保浏览器在本帧完成列宽计算后不会覆盖落点。
    var latestRange=sourceRangeForOffsets(tx.offset,tx.offset+1);
    if(latestRange){
      curTopAnchor={range:latestRange};
      relayout({
        anchor:curTopAnchor,anchorOffset:tx.offset,sidePaneResize:true,
        exactScroll:isScrollMode(),scrollOffset:tx.viewportOffset
      });
      captureAnchor();
      // 常规整页只能显示页首；这里在上层展示从原阅读锚点开始的临时页，
      // 让开/关智读不会把当前文字吸回宽页的章节开头。
      if(!isScrollMode())renderSideAnchorVirtualPage(tx.offset);
    }
    readerSideViewportDiag(tx,'restored',{reason:reason||'stable'});
    window.__readerSideViewportTxn=null;
  });
}
function scheduleReaderSideViewportRestore(tx){
  if(!tx||tx!==window.__readerSideViewportTxn||!tx.committed||tx.finished)return;
  if(readerSideViewportRestoreRaf)cancelAnimationFrame(readerSideViewportRestoreRaf);
  var started=performance.now(),lastWidth=-1,stableFrames=0;
  function waitForStableWidth(){
    if(tx!==window.__readerSideViewportTxn||tx.finished)return;
    var width=Math.round(window.innerWidth||0),expected=Math.round(tx.expectedWidth||0);
    var matches=!expected||Math.abs(width-expected)<=2;
    stableFrames=(matches&&width===lastWidth)?stableFrames+1:0;
    lastWidth=width;
    if(matches&&stableFrames>=2){finishReaderSideViewportRestore(tx,'stable');return;}
    if(performance.now()-started>1200){finishReaderSideViewportRestore(tx,'timeout');return;}
    readerSideViewportRestoreRaf=requestAnimationFrame(waitForStableWidth);
  }
  readerSideViewportRestoreRaf=requestAnimationFrame(waitForStableWidth);
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
      d.style.setProperty('--hl-color',highlightColorValue(h.color));
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
  return {start:start,end:end,text:t,range_anchor:{start:sourceOffsetAnchor(start),end:sourceOffsetAnchor(end)}};
}
function sourceOffsetAnchor(offset){
  offset=Math.max(0,parseInt(offset,10)||0);
  return {
    chapter:curCh,
    dom_path:'',
    text_offset:offset,
    context_before:sourceTextAround(Math.max(0,offset-72),offset,0,0),
    context_after:sourceTextAround(offset,offset+112,0,0),
    viewport_offset:0
  };
}
function injectHead(htmlStr,seen){
  var tmp=document.createElement('div');tmp.innerHTML=htmlStr;
  var nodes=tmp.querySelectorAll('link,style');
  var waits=[];
  for(var i=0;i<nodes.length;i++){
    var node=nodes[i],key=node.outerHTML;
    if(seen[key]){waits.push(seen[key]);continue;}
    if((node.tagName||'').toLowerCase()==='link'&&String(node.rel||node.getAttribute('rel')||'').toLowerCase()==='stylesheet'){
      seen[key]=new Promise(function(resolve){
        var settled=false,timer=null;
        function done(){if(settled)return;settled=true;if(timer)clearTimeout(timer);resolve();}
        node.addEventListener('load',done,{once:true});node.addEventListener('error',done,{once:true});
        timer=setTimeout(done,2000);document.head.appendChild(node);
      });
    }else{
      document.head.appendChild(node);seen[key]=Promise.resolve();
    }
    waits.push(seen[key]);
  }
  return Promise.all(waits);
}
function restoreStoredReadingAnchor(anchor){
  if(!anchor||typeof sourceRangeForOffsets!=='function')return false;
  var offset=Math.max(0,parseInt(anchor.text_offset,10)||0);
  var before=String(anchor.context_before||''),after=String(anchor.context_after||'');
  // 若书籍导入后 HTML 略有变化，优先用附近上下文校验；偏移已不可靠时再在本章中寻找锚点。
  var directBefore=before?sourceTextAround(Math.max(0,offset-before.length),offset,0,0):'';
  var directAfter=after?sourceTextAround(offset,offset+after.length,0,0):'';
  if((before&&directBefore!==before)||(after&&directAfter!==after)){
    var probe=after||before;
    if(probe){
      var whole=sourceTextAround(0,Number.MAX_SAFE_INTEGER,0,0);
      var found=nearestTextOccurrence(whole,probe,after?offset:Math.max(0,offset-probe.length));
      if(found>=0)offset=after?found:found+probe.length;
    }
  }
  var range=sourceRangeForOffsets(offset,offset+1);
  if(!range)return false;
  var rect=null;try{rect=range.getBoundingClientRect();}catch(_){rect=null;}
  if(!rect)return false;
  if(isScrollMode()&&scrollPort()){
    var pr=viewRect(),sp=scrollPort();
    var top=Math.max(0,Math.round((sp.scrollTop||0)+rect.top-pr.top-(Number(anchor.viewport_offset)||0)));
    scrollProgrammaticUntil=Date.now()+180;scrollProgrammaticTarget=top;sp.scrollTop=top;
    pageInCh=pageIndexForScrollTop(top);
  }else{
    var pageAnchor={range:range};
    if(isDualPage()&&typeof alignDualAnchorToLeftPage==='function'&&alignDualAnchorToLeftPage(pageAnchor))setViewOffset();
    else gotoPage(pageOf({getBoundingClientRect:function(){return rect;}}));
  }
  curTopAnchor={range:range};
  return true;
}
function nearestTextOccurrence(whole,probe,expected){
  if(!whole||!probe)return -1;
  expected=Math.max(0,parseInt(expected,10)||0);
  var best=-1,bestDistance=Number.POSITIVE_INFINITY,from=0;
  while(from<=whole.length){
    var found=whole.indexOf(probe,from);
    if(found<0)break;
    var distance=Math.abs(found-expected);
    if(distance<bestDistance){best=found;bestDistance=distance;}
    if(distance===0)break;
    from=found+1;
  }
  return best;
}
function loadInit(){
  var p=new URLSearchParams(location.search);
  try{S=Object.assign(S,JSON.parse(decodeURIComponent(p.get('s')||'{}')));}catch(e){}
  var storedPosition=null;try{storedPosition=JSON.parse(decodeURIComponent(p.get('ra')||'null'));}catch(_){storedPosition=null;}
  var rc=parseInt(p.get('rc')||'0',10)||0, rf=parseFloat(p.get('rf')||'0')||0;
  if(storedPosition&&storedPosition.anchor&&Number.isFinite(storedPosition.chapter))rc=storedPosition.chapter;
  showChapter(rc,'start').then(function(){
    var resumePage=Math.round(rf*(pagesInCh-1));
    var restored=storedPosition&&storedPosition.anchor&&restoreStoredReadingAnchor(storedPosition.anchor);
    // 双页续读以保存时的 spread 为准。字符锚点只负责找到同一段文字，不能
    // 在重开时把右栏改成新的左栏；那会引入 dualStartColumn=1，并让页数
    // 恰好漂移一页。恢复后统一回到标准偶数列起始，再按保存比例定位 spread。
    if(restored&&isDualPage()){
      dualStartColumn=0;
      pagesInCh=fastChapterLayout?fastPagedPageCount(root):pagedPageCountFromContent(root);
      resumePage=Math.round(rf*(pagesInCh-1));
      pageInCh=Math.max(0,Math.min(pagesInCh-1,resumePage));
      setViewOffset();
    }else if(restored&&resumePage>0&&Math.abs(pageInCh-resumePage)>0){
      pageInCh=Math.max(0,Math.min(pagesInCh-1,resumePage));
      setViewOffset();
    }
    if(!restored){
      if(resumePage>0)gotoPage(resumePage);
      else if(isScrollMode()&&scrollPort()){pageInCh=0;scrollPort().scrollTop=0;scrollProgrammaticTarget=0;}
    }
    // 第一次上报只更新页码显示，不得立即覆盖已保存位置；用户真正翻页或
    // 关闭窗口时，reader shell 才会提交恢复后的稳定锚点。
    initialResumePending=false;
    captureAnchor();
    report(false,true);
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
  // 使用 Pointer Events 并捕获指针：通过触控板远程操作时，旧 mouseup 可能在
  // 指针离开正文 iframe 后丢失，外层就收不到完整手势，造成书架可用而阅读页无效。
  var readerGestureDrawing=false,readerGesturePointerId=null,readerGestureSource='';
  function reportReaderGesture(phase,e){parent.postMessage({readerGesture:{phase:phase,x:e.clientX,y:e.clientY}},'*');}
  function startReaderGesture(e,source){if(readerGestureDrawing)return;readerGestureDrawing=true;readerGestureSource=source;readerGesturePointerId=source==='pointer'?e.pointerId:null;if(source==='pointer')try{document.documentElement.setPointerCapture(e.pointerId);}catch(_){}reportReaderGesture('start',e);e.preventDefault();}
  function finishReaderGesture(e,phase){if(!readerGestureDrawing)return;readerGestureDrawing=false;readerGesturePointerId=null;readerGestureSource='';reportReaderGesture(phase,e);if(e.preventDefault)e.preventDefault();}
  document.addEventListener('pointerdown',function(e){if(e.button===2)startReaderGesture(e,'pointer');},true);
  document.addEventListener('pointermove',function(e){if(!readerGestureDrawing||readerGestureSource!=='pointer'||e.pointerId!==readerGesturePointerId)return;reportReaderGesture('move',e);e.preventDefault();},true);
  document.addEventListener('pointerup',function(e){if(readerGestureDrawing&&readerGestureSource==='pointer'&&e.pointerId===readerGesturePointerId)finishReaderGesture(e,'end');},true);
  document.addEventListener('pointercancel',function(e){if(readerGestureDrawing&&readerGestureSource==='pointer'&&e.pointerId===readerGesturePointerId)finishReaderGesture(e,'cancel');},true);
  // ToSwak 等远程触控板有时只注入 MouseEvent，不会同时产生 PointerEvent。
  // 保留这条兜底链，且以 source 标记与上面的 pointer 链互斥。
  document.addEventListener('mousedown',function(e){if(e.button===2)startReaderGesture(e,'mouse');},true);
  document.addEventListener('mousemove',function(e){if(!readerGestureDrawing||readerGestureSource!=='mouse')return;reportReaderGesture('move',e);e.preventDefault();},true);
  document.addEventListener('mouseup',function(e){if(readerGestureDrawing&&readerGestureSource==='mouse')finishReaderGesture(e,'end');},true);
  window.addEventListener('blur',function(){if(!readerGestureDrawing)return;readerGestureDrawing=false;readerGesturePointerId=null;readerGestureSource='';parent.postMessage({readerGesture:{phase:'cancel',x:0,y:0}},'*');},true);
  document.addEventListener('contextmenu',function(e){if(readerGestureDrawing)e.preventDefault();},true);
  document.addEventListener('mousedown',function(e){downX=e.clientX;downY=e.clientY;didDrag=false;if(e.detail>1)e.preventDefault();}); // e.detail>1：双击/三击 → 阻止浏览器选词/选段（连点翻页常被当双击而误选）
  document.addEventListener('mousemove',function(e){if(downX!==null&&(Math.abs(e.clientX-downX)>4||Math.abs(e.clientY-downY)>4))didDrag=true;});
  document.addEventListener('mouseup',function(){downX=null;downY=null;});
  var macFastTap=null;
  var isMacWebKit=IS_MAC_WEBKIT;
  function tapHasSelection(){
    var sel=window.getSelection?window.getSelection():null;
    return !!(sel&&!sel.isCollapsed&&sel.toString().trim());
  }
  function normalizedTapZones(){
    var defaults=[{id:'zone-1',action:'prev',x:0,y:0,width:400,height:1000},{id:'zone-2',action:'center',x:400,y:0,width:200,height:1000},{id:'zone-3',action:'next',x:600,y:0,width:400,height:1000}];
    var supplied=Array.isArray(S.clickZones)?S.clickZones.filter(function(item){return item&&typeof item==='object';}):[];
    var source=(supplied.length?supplied:defaults).slice(0,12);
    function overlaps(a,b){return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
    function trim(zone,blocker){
      if(!overlaps(zone,blocker))return zone;
      var l=Math.max(zone.x,blocker.x),t=Math.max(zone.y,blocker.y),r=Math.min(zone.x+zone.width,blocker.x+blocker.width),b=Math.min(zone.y+zone.height,blocker.y+blocker.height);
      var parts=[Object.assign({},zone,{width:l-zone.x}),Object.assign({},zone,{x:r,width:zone.x+zone.width-r}),Object.assign({},zone,{height:t-zone.y}),Object.assign({},zone,{y:b,height:zone.y+zone.height-b})].filter(function(part){return part.width>=20&&part.height>=20;});
      parts.sort(function(a,b){return b.width*b.height-a.width*a.height;});return parts[0]||null;
    }
    var normalized=source.map(function(raw,index){
      var fallback=defaults[index]||{id:'zone-'+(index+1),action:'none',x:350,y:350,width:300,height:300};
      var x=Math.max(0,Math.min(980,Math.round(Number(raw.x)||0))),y=Math.max(0,Math.min(980,Math.round(Number(raw.y)||0)));
      return{id:typeof raw.id==='string'?raw.id:fallback.id,action:['prev','center','next','none'].indexOf(raw.action)>=0?raw.action:fallback.action,x:x,y:y,width:Math.max(20,Math.min(1000-x,Math.round(Number(raw.width)||fallback.width))),height:Math.max(20,Math.min(1000-y,Math.round(Number(raw.height)||fallback.height)))};
    });
    var accepted=[];normalized.forEach(function(zone){var candidate=zone;accepted.forEach(function(blocker){if(candidate)candidate=trim(candidate,blocker);});if(candidate)accepted.push(candidate);});return accepted;
  }
  function tapActionAt(x,y){
    var nx=Math.max(0,Math.min(1000,Number(x)/Math.max(1,window.innerWidth)*1000)),ny=Math.max(0,Math.min(1000,Number(y)/Math.max(1,window.innerHeight)*1000));
    var match=normalizedTapZones().find(function(zone){return nx>=zone.x&&nx<=zone.x+zone.width&&ny>=zone.y&&ny<=zone.y+zone.height;});
    return match?match.action:'none';
  }
  function rememberReaderJump(kind){
    var frac=pagesInCh>1?pageInCh/(pagesInCh-1):0;
    parent.postMessage({readerJump:{kind:kind==='footnote'?'footnote':'link',chapter:Math.max(0,curCh||0),chFrac:Math.max(0,Math.min(1,frac))}},'*');
  }
  function handleReaderTap(e){
    if(typeof queuePendingReaderModeInput==='function'&&queuePendingReaderModeInput({kind:'tap',event:e})){
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    var target=e.target;
    var inFootnote=!!(target.closest&&target.closest('#fn-pop'));
    var targetAnchor=target.closest?target.closest('a'):null;
    // 注释角标与其弹层是独立交互：不能把这次点击冒充成正文点击，
    // 否则外壳会打开/关闭工具栏，和脚注弹层争夺同一次操作。
    if(!inFootnote&&!(targetAnchor&&isNoteLink(targetAnchor)))parent.postMessage({uiClick:1},'*');
    var tapAction=tapActionAt(e.clientX,e.clientY);
    if(chapterPending>0){readerBugTrace('click','chapter_pending',e);return;}
    if(overlayOpen){
      readerBugTrace('click','overlay',e);
      // 关闭浮层的同一次中间点击也切换工具栏，不要求用户再点一次。
      if(tapAction==='center')parent.postMessage({centerTap:1},'*');
      return;
    }
    // 点到已高亮的文字 → 出高亮菜单，不翻页
    var hm=target.closest?target.closest('.hl-rect[data-hi],mark.hl'):null;
    if(hm){readerBugTrace('click','highlight',e);e.stopPropagation();showHlMenu(parseInt(hm.getAttribute('data-hi'),10),true,hm,e);return;}
    var a=targetAnchor;
    if(inFootnote&&!a){readerBugTrace('click','footnote',e);return;} // 注释弹窗正文：不翻页
    if(a){var href=a.getAttribute('href')||'';
      readerBugTrace('click',inFootnote?'footnote':'link',e);
      if(href.charAt(0)==='#'){e.preventDefault();e.stopPropagation();
        var m=/^#c(\d+)(?:~(.+))?$/.exec(href);
        var frag=m?m[2]:href.slice(1), ciT=m?parseInt(m[1],10):curCh;
        var footnoteJump=inFootnote||isNoteLink(a);
        if(!inFootnote&&pageDebugSettingOn('reader_footnotes')&&footnoteJump&&frag){showFootnote(a,ciT,frag);return;} // 正文注释角标 → 弹注释正文
        if(m){
          var ci=ciT,fr=frag;
          if(ci===curCh){
            if(fr){var el=document.getElementById(fr);if(el){var targetPage=pageOf(el);hideFn();if(targetPage!==pageInCh){rememberReaderJump(footnoteJump?'footnote':'link');gotoPage(targetPage);}}}
          }else{rememberReaderJump(footnoteJump?'footnote':'link');hideFn();showChapter(ci,'start',fr);}
        }else{
          var el2=document.getElementById(href.slice(1));
          if(el2){var targetPage2=pageOf(el2);hideFn();if(targetPage2!==pageInCh){rememberReaderJump(footnoteJump?'footnote':'link');gotoPage(targetPage2);}}
        }
      }
      return;
    }
    hideFn(); // 点别处 → 收起注释弹窗
    // 拖动选字（或存在选中文字）时不翻页，让 web 搜索菜单稳定停在高亮处
    if(didDrag){readerBugTrace('click','drag',e);return;}
    // mouseup 后清理短暂选区的定时器晚于 click。若本次没有真实拖动，
    // 直接清掉浏览器偶发产生的残留选区并继续翻页，避免第一次点击被吞。
    if(tapHasSelection()){
      if(window.getSelection)window.getSelection().removeAllRanges();
      hideSelMenu();
    }
    var tapStarted=performance.now();
    if(tapAction==='next'){readerBugTrace('click','page_next',e);parent.postMessage({readerNavigated:1},'*');markPageTurnInput('tap');nextPage();reportReaderPaintPerf('tap_next',tapStarted,'chapter='+curCh);}
    else if(tapAction==='prev'){readerBugTrace('click','page_prev',e);parent.postMessage({readerNavigated:1},'*');markPageTurnInput('tap');prevPage();reportReaderPaintPerf('tap_prev',tapStarted,'chapter='+curCh);}
    else if(tapAction==='center'){readerBugTrace('click','center',e);parent.postMessage({centerTap:1},'*');}
    else readerBugTrace('click','none',e);
  }
  // macOS 的 WKWebView 在部分点击序列中较晚派发 click。只对正文空白/文字区
  // 使用更早的 pointerup 翻页，并吞掉紧随其后的 click，避免 Windows 行为变化。
  if(isMacWebKit)document.addEventListener('pointerup',function(e){
    if(e.button!==0||e.isPrimary===false||didDrag)return;
    if(e.target.closest&&e.target.closest('a,button,input,select,textarea,#fn-pop,.hl-rect[data-hi],mark.hl'))return;
    macFastTap={at:Date.now(),x:e.clientX,y:e.clientY,target:e.target};
    handleReaderTap(e);
  });
  document.addEventListener('click',function(e){
    if(macFastTap&&Date.now()-macFastTap.at<700&&macFastTap.target===e.target&&Math.abs(macFastTap.x-e.clientX)<5&&Math.abs(macFastTap.y-e.clientY)<5){
      readerBugTrace('click','mac_duplicate',e);macFastTap=null;e.preventDefault();e.stopPropagation();return;
    }
    macFastTap=null;
    handleReaderTap(e);
  });
  document.addEventListener('keydown',function(e){if(((e.ctrlKey||e.metaKey)&&(e.key==='f'||e.key==='F'))||e.key==='F3')e.preventDefault();},true); // 禁用浏览器自带查找
  function handleReaderKey(e){
    if(e.key==='PageDown'||e.key==='ArrowRight'||e.key==='ArrowDown'||(e.key===' '&&!e.shiftKey)){readerBugTrace('key','page_next',null,{direction:'forward',key:e.key===' '?'space':e.key});e.preventDefault();userNav();markPageTurnInput('keyboard');nextPage();}
    else if(e.key==='PageUp'||e.key==='ArrowLeft'||e.key==='ArrowUp'||(e.key===' '&&e.shiftKey)){readerBugTrace('key','page_prev',null,{direction:'backward',key:e.key===' '?'space':e.key});e.preventDefault();userNav();markPageTurnInput('keyboard');prevPage();}
  }
  document.addEventListener('keydown',function(e){
    if(e.isComposing||e.key==='Process'||e.keyCode===229)return;
    if(typeof queuePendingReaderModeInput==='function'&&queuePendingReaderModeInput({kind:'key',event:e})){e.preventDefault();return;}
    handleReaderKey(e);
  });
  // 触控板一次滑动会产生多个 wheel。macOS 整屏模式已在原生层去除
  // momentumPhase 尾流；此处仅把同一段直接输入合并，微小 delta 会先累计，
  // 避免轻划被随机丢弃。
  var pageWheelGesture=null,pageWheelGestureTimer=null,pageWheelStartDelta=0,pageWheelTraceEvents=0,pageWheelGestureTraceEvents=0,pageWheelLastTraceAt=0,scrollChapterLock=false;
  var PAGE_WHEEL_QUIET_MS=64,PAGE_WHEEL_START_DELTA_PX=2;
  function armPageWheelGestureQuietTimer(gesture){
    if(pageWheelGestureTimer)clearTimeout(pageWheelGestureTimer);
    pageWheelGestureTimer=setTimeout(function(){
      if(pageWheelGesture===gesture){
        pageWheelGesture=null;pageWheelStartDelta=0;
        tracePageWheel('rearmed',null,null,0,{direction:gesture.direction,wheel_timer_active:false});
        pageWheelGestureTraceEvents=0;
      }
      pageWheelGestureTimer=null;
    },PAGE_WHEEL_QUIET_MS);
  }
  // 不限制单一触控板手势的诊断条数：问题记录本身只保留最近两分钟，
  // 同时只写入脱敏的输入几何和状态，不记录书籍正文、坐标或任何用户内容。
  function tracePageWheel(phase,e,gesture,delta,extra){
    pageWheelGestureTraceEvents++;
    pageWheelTraceEvents++;
    var now=performance.now(),gap=pageWheelLastTraceAt?Math.round(now-pageWheelLastTraceAt):-1;
    pageWheelLastTraceAt=now;
    function num(value){return Math.round(Number(value||0)*100)/100;}
    var age=gesture&&gesture.started?Math.round(now-gesture.started):-1;
    var data={direction:gesture&&gesture.direction||undefined,wheel_seq:pageWheelTraceEvents,wheel_delta_x:num(e&&e.deltaX),wheel_delta_y:num(e&&e.deltaY),wheel_delta_px:num(delta),wheel_delta_mode:Math.round(e&&e.deltaMode||0),wheel_gap_ms:gap,wheel_accumulated_px:num(pageWheelStartDelta),wheel_threshold_px:PAGE_WHEEL_START_DELTA_PX,wheel_quiet_ms:PAGE_WHEEL_QUIET_MS,wheel_gesture_age_ms:age,wheel_gesture_active:!!gesture,wheel_timer_active:!!pageWheelGestureTimer,wheel_event_cancelable:!!(e&&e.cancelable),wheel_replay:!!(e&&e.replay),wheel_mode_pending:!!(extra&&extra.wheel_mode_pending)};
    readerBugTrace('wheel',phase,null,data);
    parent.postMessage({readerPerf:'page_wheel '+JSON.stringify({
      n:pageWheelTraceEvents,phase:phase,dx:data.wheel_delta_x,dy:data.wheel_delta_y,px:data.wheel_delta_px,
      gap:data.wheel_gap_ms,accumulated:data.wheel_accumulated_px,mode:data.wheel_delta_mode,cancelable:data.wheel_event_cancelable,gesture:data.wheel_gesture_active,replay:data.wheel_replay,modePending:data.wheel_mode_pending,ts:Math.round(e&&e.timeStamp||0)
    })},'*');
    return data;
  }
  function handleReaderWheel(e){
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
      }else if(e.replay){
        // 原始 wheel 已在等待重排时被取消；把首条输入的位移精确交给新滚动容器。
        var replayPort=scrollPort();
        if(replayPort){
          var replayTop=Math.max(0,Math.min(scrollMaxTop(),(replayPort.scrollTop||0)+d));
          replayPort.scrollTop=replayTop;
          pageInCh=pageIndexForScrollTop(replayTop);
          report();
        }
        e.preventDefault();
      }
      return;
    }
    e.preventDefault();
    var delta=wheelDeltaPx(e),gesture=pageWheelGesture;
    if(gesture){
      tracePageWheel('ignored',e,gesture,delta);
      // 所有连续 wheel 都属于同一触控板手势，惯性强弱与方向抖动都不另翻页。
      armPageWheelGestureQuietTimer(gesture);
      return;
    }
    // macOS 触控板刚触碰时经常先给出 1px 左右的 delta。累计后再判定方向，
    // 不要求某一单独事件恰好超过阈值，连续滑动就不会出现“有时不翻页”。
    pageWheelStartDelta+=delta;
    var magnitude=Math.abs(pageWheelStartDelta);
    if(magnitude<PAGE_WHEEL_START_DELTA_PX){tracePageWheel('accumulating',e,null,delta);return;}
    var direction=pageWheelStartDelta>0?1:-1;
    pageWheelStartDelta=0;
    gesture={direction:direction,started:performance.now()};
    pageWheelGesture=gesture;
    pageWheelGestureTraceEvents=0;
    var wheelTurnTrace=tracePageWheel('turn',e,gesture,delta);
    userNav();markPageTurnInput('wheel',wheelTurnTrace);
    if(direction>0)nextPage();else prevPage();
    armPageWheelGestureQuietTimer(gesture);
  }
  function readerModeWheelReplay(e){
    return {kind:'wheel',event:{deltaX:e.deltaX,deltaY:e.deltaY,deltaMode:e.deltaMode,timeStamp:e.timeStamp,replay:true,preventDefault:function(){}}};
  }
  window.replayPendingReaderModeInput=function(input){
    if(!input)return;
    if(input.kind==='tap'){handleReaderTap(input.event);return;}
    if(input.kind==='key'){handleReaderKey(input.event);return;}
    if(input.kind==='wheel'){handleReaderWheel(input.event);}
  };
  document.addEventListener('wheel',function(e){
    if(typeof queuePendingReaderModeInput==='function'&&queuePendingReaderModeInput(readerModeWheelReplay(e))){tracePageWheel('mode_pending',e,pageWheelGesture,wheelDeltaPx(e),{wheel_mode_pending:true});e.preventDefault();return;}
    handleReaderWheel(e);
  },{passive:false});
  window.addEventListener('resize',function(){
    var sideTxn=window.__readerSideViewportTxn;
    modeSwitchDiagEvent('resize_before');
    // 智读只改变临时正文宽度：保留已完成/增量页数缓存，也不把右上角页数
    // 切回加载图标。真实窗口变化会由父页面发送新的稳定统计宽度。
    if(!sideTxn){
      if(pageSig&&pageSig!==pageCountSig())invalidateMeasure();
      parent.postMessage({layoutBusy:1},'*');
    }
    // commit 前的瞬间 resize 不使用新页面顶部作为锚点；commit 后由事务在最终宽度稳定时恢复。
    if(sideTxn&&sideTxn.committed&&!sideTxn.finished)scheduleReaderSideViewportRestore(sideTxn);
    else if(!sideTxn)relayout();
    modeSwitchDiagEvent('resize_after');
    if(!sideTxn)scheduleMeasure();
  });
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
var HL_MENU_LAYOUT_KEY='highlightMenuLayoutV1';
var HL_WEB_ENGINE_KEY='highlightWebSearchEngineV1';
var HL_MENU_COLOR_KEY='highlightMenuMultiColorV1';
var HL_SELECTED_COLOR_KEY='highlightMenuColorV1';
var hlMenuPreferencesRestoring=false,hlMenuPreferencesSynced=false;
var HL_COLORS=[
  {key:'y',labelKey:'gray',value:'rgba(126,136,148,.34)'},
  {key:'g',labelKey:'green',value:'rgba(135,220,151,.42)'},
  {key:'b',labelKey:'blue',value:'rgba(119,185,255,.42)'},
  {key:'p',labelKey:'pink',value:'rgba(255,143,184,.42)'}
];
var HL_MENU_ACTIONS=[
  {key:'web',icon:'web'}, {key:'dict',icon:'dict'}, {key:'translate',icon:'translate'},
  {key:'copy',icon:'copy'}, {key:'highlight',icon:'highlight'}, {key:'correct',icon:'correct'},
  {key:'excerpt',icon:'excerpt'}, {key:'cross',icon:'cross'}, {key:'semantic',icon:'semantic'},
  {key:'aiReader',icon:'aiReader'}, {key:'note',icon:'note'}, {key:'bookmark',icon:'bookmark'}
];
function defaultHlMenuConfig(){return HL_MENU_ACTIONS.map(function(a){return {key:a.key,show:true};});}
function hlActionLabel(key){return readerPageText(key);}
function hlActionIcon(key){for(var i=0;i<HL_MENU_ACTIONS.length;i++){if(HL_MENU_ACTIONS[i].key===key)return HL_MENU_ACTIONS[i].icon||'';}return '';}
function hlActionIconMarkup(key){
  var icons={
    web:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.7"/><path d="m15.1 15.1 4.2 4.2"/></svg>',
    dict:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.3c3.1-1.2 5.5-.7 7.5 1.1v12c-2-1.8-4.4-2.3-7.5-1.1zM19.5 5.3c-3.1-1.2-5.5-.7-7.5 1.1v12c2-1.8 4.4-2.3 7.5-1.1z"/></svg>',
    translate:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h8M8.5 4.5c0 5.1-1.9 8.5-4.5 10.5M5.7 11.5c1.4 1.4 3.1 2.5 5.3 3.1M15.2 7.5l4.3 10M16.7 14h5.1"/></svg>',
    copy:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="7" width="10" height="12" rx="1.8"/><path d="M15.5 7V5.8A1.8 1.8 0 0 0 13.7 4H6.8A1.8 1.8 0 0 0 5 5.8v8.7a1.8 1.8 0 0 0 1.8 1.8H8"/></svg>',
    highlight:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5.3 15.8 8.9-8.9 3.4 3.4-8.9 8.9-4.2.8zM13.3 7.8l1.4-1.4a1.7 1.7 0 0 1 2.4 0l1.2 1.2a1.7 1.7 0 0 1 0 2.4l-1.4 1.4M4 21h16"/></svg>',
    remove:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 7.5h13M9 7.5V5.7h6v1.8M7.5 7.5l.8 11h7.4l.8-11M10.2 11v4.2M13.8 11v4.2"/></svg>',
    correct:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m8.3 12.1 2.3 2.4 5.1-5.2"/></svg>',
    excerpt:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 9.1H5.8A1.8 1.8 0 0 0 4 10.9v3.3A1.8 1.8 0 0 0 5.8 16h1.7v-3.2H5.8M15.5 9.1h1.7a1.8 1.8 0 0 1 1.8 1.8v3.3a1.8 1.8 0 0 1-1.8 1.8h-1.7v-3.2h1.7"/></svg>',
    cross:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h8v13H5zM13 8h6v10h-6zM7.5 9h3M7.5 12h3M15.2 11h1.8M15.2 14h1.8"/></svg>',
    semantic:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.2" cy="12" r="1.7"/><circle cx="17.8" cy="6.5" r="1.7"/><circle cx="17.8" cy="17.5" r="1.7"/><path d="m7.7 11.3 8.5-4M7.7 12.7l8.5 4"/></svg>',
    aiReader:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.2L18.5 10l-5 1.7L12 17l-1.5-5.3L5.5 10l5-1.8zM18.4 15.1l.7 2.4 2.4.7-2.4.7-.7 2.4-.7-2.4-2.4-.7 2.4-.7z"/></svg>',
    note:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5h13v10.2h-7l-4.2 3v-3H5.5zM8.5 9h7M8.5 12h4.8"/></svg>',
    bookmark:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10v15l-5-3.3-5 3.3z"/></svg>'
  };
  return icons[key]||'';
}
function hlColorLabel(color){return readerPageText((color&&color.labelKey)||'yellow');}
function readHlMenuMode(){var m='';try{m=localStorage.getItem(HL_MENU_MODE_KEY)||'';}catch(_){}return (m==='text'||m==='icon'||m==='both')?m:'text';}
function saveHlMenuMode(mode){try{localStorage.setItem(HL_MENU_MODE_KEY,mode);}catch(_){}notifyHighlightMenuPreferences();}
function readHlMenuSize(){var s='';try{s=localStorage.getItem(HL_MENU_SIZE_KEY)||'';}catch(_){}return (s==='medium'||s==='large'||s==='small')?s:'medium';}
function saveHlMenuSize(size){try{localStorage.setItem(HL_MENU_SIZE_KEY,size);}catch(_){}notifyHighlightMenuPreferences();}
function readHlMenuLayout(){var s='';try{s=localStorage.getItem(HL_MENU_LAYOUT_KEY)||'';}catch(_){}return s==='row'?'row':'grid';}
function saveHlMenuLayout(layout){try{localStorage.setItem(HL_MENU_LAYOUT_KEY,layout==='grid'?'grid':'row');}catch(_){}notifyHighlightMenuPreferences();}
function readHlWebEngine(){var s='';try{s=localStorage.getItem(HL_WEB_ENGINE_KEY)||'';}catch(_){}return s==='google'?'google':'baidu';}
function saveHlWebEngine(engine){try{localStorage.setItem(HL_WEB_ENGINE_KEY,engine==='google'?'google':'baidu');}catch(_){}notifyHighlightMenuPreferences();}
function readHlMenuColorEnabled(){var s='';try{s=localStorage.getItem(HL_MENU_COLOR_KEY)||'';}catch(_){}return s!=='0';}
function saveHlMenuColorEnabled(enabled){try{localStorage.setItem(HL_MENU_COLOR_KEY,enabled?'1':'0');}catch(_){}notifyHighlightMenuPreferences();}
function readHlColor(){var s='';try{s=localStorage.getItem(HL_SELECTED_COLOR_KEY)||'';}catch(_){}return HL_COLORS.some(function(c){return c.key===s;})?s:'y';}
function saveHlColor(color){try{localStorage.setItem(HL_SELECTED_COLOR_KEY,HL_COLORS.some(function(c){return c.key===color;})?color:'y');}catch(_){}}
function highlightColorValue(color){for(var i=0;i<HL_COLORS.length;i++)if(HL_COLORS[i].key===color)return HL_COLORS[i].value;return HL_COLORS[0].value;}
function updateMenuSizeClass(container){
  if(!container)return;
  var size=readHlMenuSize();
  container.classList.remove('hm-size-small','hm-size-medium','hm-size-large');
  container.classList.add('hm-size-'+size);
}
function updateActionButton(it){
  if(!it||!it.button)return;
  var mode=readHlMenuMode(),label=it.labelKey?readerPageText(it.labelKey):(it.label||hlActionLabel(it.key)),icon=it.icon||hlActionIcon(it.key);
  it.button.title=label;it.button.setAttribute('aria-label',label);
  var iconMarkup=hlActionIconMarkup(icon);
  if(mode==='icon')it.button.innerHTML=iconMarkup||label;
  else if(mode==='text')it.button.textContent=label;
  else it.button.innerHTML=(iconMarkup?'<span class="hm-icon">'+iconMarkup+'</span>':'')+'<span class="hm-label">'+label+'</span>';
}
function refreshConfiguredMenus(){
  applyConfiguredMenu(selMenu,selMenuItems,selMenu&&selMenu._setBtn);
  applyConfiguredMenu(hlMenu,hlMenuItems,hlMenu&&hlMenu._setBtn);
  // 切换横排/九宫格、字号、显示方式或多彩高亮都会改变菜单尺寸；
  // 可见菜单必须立即按新尺寸重算，不能沿用切换前的 top。
  repositionVisibleHighlightMenu(selMenu);
  repositionVisibleHighlightMenu(hlMenu);
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
function saveHlMenuConfig(cfg){try{localStorage.setItem(HL_MENU_CFG_KEY,JSON.stringify(cfg));}catch(_){}notifyHighlightMenuPreferences();}
// This compact, content-free shape is the only part of the selection menu
// configuration used by the original reader preferences panel. The reader page retains
// ownership of the actual selection, menu DOM and action handlers.
function highlightMenuPreferencesSnapshot(){
  return {
    displayMode:readHlMenuMode(),
    layout:readHlMenuLayout(),
    size:readHlMenuSize(),
    webSearchEngine:readHlWebEngine(),
    colorful:readHlMenuColorEnabled(),
    actions:readHlMenuConfig().map(function(item){return {key:item.key,visible:item.show!==false};})
  };
}
function notifyHighlightMenuPreferences(){
  if(hlMenuPreferencesRestoring||!hlMenuPreferencesSynced)return;
  try{parent.postMessage({readerHighlightMenuPreferences:highlightMenuPreferencesSnapshot()},'*');}catch(_){}
}
function normalizeHighlightMenuActions(value){
  if(!Array.isArray(value))return null;
  var known={},out=[];
  HL_MENU_ACTIONS.forEach(function(action){known[action.key]=true;});
  value.slice(0,HL_MENU_ACTIONS.length).forEach(function(item){
    var key=String((item&&item.key)||'');
    if(!known[key]||out.some(function(existing){return existing.key===key;}))return;
    out.push({key:key,show:item.visible!==false});
  });
  HL_MENU_ACTIONS.forEach(function(action){if(!out.some(function(item){return item.key===action.key;}))out.push({key:action.key,show:true});});
  return out;
}
function updateHighlightMenuPreferences(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return highlightMenuPreferencesSnapshot();
  hlMenuPreferencesRestoring=true;
  try{
    if(value.displayMode==='text'||value.displayMode==='icon'||value.displayMode==='both')saveHlMenuMode(value.displayMode);
    if(value.layout==='grid'||value.layout==='row')saveHlMenuLayout(value.layout);
    if(value.size==='small'||value.size==='medium'||value.size==='large')saveHlMenuSize(value.size);
    if(value.webSearchEngine==='baidu'||value.webSearchEngine==='google')saveHlWebEngine(value.webSearchEngine);
    if(typeof value.colorful==='boolean')saveHlMenuColorEnabled(value.colorful);
    var actions=normalizeHighlightMenuActions(value.actions);
    if(actions)saveHlMenuConfig(actions);
  }catch(_){}
  hlMenuPreferencesRestoring=false;
  hlMenuPreferencesSynced=true;
  refreshConfiguredMenus();
  if(hlSettingsPop&&hlSettingsPop.style.display!=='none')renderHlSettings();
  var snapshot=highlightMenuPreferencesSnapshot();
  notifyHighlightMenuPreferences();
  return snapshot;
}
window.ReaderHighlightMenuSettings=Object.freeze({
  get:function(){return highlightMenuPreferencesSnapshot();},
  update:function(value){return updateHighlightMenuPreferences(value);},
  activate:function(){hlMenuPreferencesSynced=true;return highlightMenuPreferencesSnapshot();}
});
function applyConfiguredMenu(container,items,setBtn){
  if(!container)return;
  updateMenuSizeClass(container);
  var layout=readHlMenuLayout();
  container.classList.toggle('hm-layout-grid',layout==='grid');
  container.classList.toggle('hm-layout-row',layout!=='grid');
  var actionHost=container._actionHost;
  if(!actionHost){actionHost=document.createElement('span');actionHost.className='hm-action-host';container._actionHost=actionHost;}
  var colorHost=container._colorHost;
  if(!colorHost){colorHost=document.createElement('span');colorHost.className='hm-color-host';container._colorHost=colorHost;}
  var cfg=readHlMenuConfig(),map={};
  items.forEach(function(it){map[it.key]=it;});
  items.forEach(function(it){var node=it.host||it.button;if(node&&node.parentNode)node.parentNode.removeChild(node);});
  if(actionHost.parentNode)actionHost.parentNode.removeChild(actionHost);
  if(colorHost.parentNode)colorHost.parentNode.removeChild(colorHost);
  if(setBtn&&setBtn.parentNode)setBtn.parentNode.removeChild(setBtn);
  cfg.forEach(function(c){var it=map[c.key];if(it&&c.show!==false){updateActionButton(it);var node=it.host||it.button;node.classList.add('hm-menu-item');actionHost.appendChild(node);}});
  container.appendChild(actionHost);
  var useColors=readHlMenuColorEnabled();
  container.classList.toggle('hm-with-colors',useColors);
  if(useColors){
    colorHost.innerHTML='';
    var selected=readHlColor();
    HL_COLORS.forEach(function(c){
      var b=document.createElement('button');b.type='button';b.className='hm-color-button'+(c.key===selected?' selected':'');b.title=readerPageText('highlight')+' · '+hlColorLabel(c);b.setAttribute('aria-label',b.title);b.style.setProperty('--hm-color',c.value);
      b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});
      b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();saveHlColor(c.key);if(typeof container._onColorPick==='function')container._onColorPick(c.key);refreshConfiguredMenus();});
      colorHost.appendChild(b);
    });
    container.appendChild(colorHost);
  }
  if(setBtn){var settingsLabel=readerPageText('highlightMenuSettings');setBtn.classList.add('hm-settings-button');setBtn.title=settingsLabel;setBtn.setAttribute('aria-label',settingsLabel);container.appendChild(setBtn);}
}
function renderHlSettings(){
  if(!hlSettingsPop)return;
  var cfg=readHlMenuConfig();
  hlSettingsPop.setAttribute('aria-label',readerPageText('highlightMenuSettings'));
  hlSettingsPop.innerHTML='<div class="hs-mode hs-appearance"><span class="hs-mode-label">'+readerPageText('display')+'</span><span class="hs-mode-buttons hs-display-buttons"><button type="button" data-mode="both">'+readerPageText('both')+'</button><button type="button" data-mode="text">'+readerPageText('text')+'</button><button type="button" data-mode="icon">'+readerPageText('icon')+'</button></span><span class="hs-mode-label hs-color-label">'+readerPageText('colorful')+'</span><label class="hs-switch"><input class="hs-color-enabled" type="checkbox"><span class="hs-slider"></span></label></div><div class="hs-mode hs-layout-size"><span class="hs-mode-label">'+readerPageText('layout')+'</span><span class="hs-mode-buttons hs-layout-buttons"><button type="button" data-layout="row">'+readerPageText('row')+'</button><button type="button" data-layout="grid">'+readerPageText('grid')+'</button></span><span class="hs-mode-label">'+readerPageText('size')+'</span><span class="hs-mode-buttons hs-size-buttons"><button type="button" data-size="small">'+readerPageText('small')+'</button><button type="button" data-size="medium">'+readerPageText('medium')+'</button><button type="button" data-size="large">'+readerPageText('large')+'</button></span></div><div class="hs-list"></div>';
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
  var layout=readHlMenuLayout();
  [].slice.call(hlSettingsPop.querySelectorAll('.hs-layout-buttons button')).forEach(function(b){
    b.className=b.dataset.layout===layout?'on':'';
    b.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();saveHlMenuLayout(b.dataset.layout);
      renderHlSettings();refreshConfiguredMenus();
    });
  });
  var colorEnabled=hlSettingsPop.querySelector('.hs-color-enabled');
  colorEnabled.checked=readHlMenuColorEnabled();
  colorEnabled.addEventListener('change',function(){saveHlMenuColorEnabled(colorEnabled.checked);refreshConfiguredMenus();});
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
      if(!readerAnimationSettingOn('highlightSettings')){list.insertBefore(ph,beforeNode||null);return;}
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
    var bounds=list.getBoundingClientRect();
    var maxTop=Math.max(bounds.top,bounds.bottom-row.offsetHeight);
    var top=Math.max(bounds.top,Math.min(maxTop,clientY-dragState.offsetY));
    var probeY=Math.max(bounds.top,Math.min(bounds.bottom,clientY));
    row.style.top=top+'px';
    var rows=[].slice.call(list.querySelectorAll('.hs-row')).filter(function(r){return r!==row;});
    for(var i=0;i<rows.length;i++){
      var box=rows[i].getBoundingClientRect();
      if(probeY<box.top+box.height/2){animateRowsAroundInsert(rows[i]);return;}
    }
    animateRowsAroundInsert(null);
  }
  cfg.forEach(function(c){
    var row=document.createElement('div');row.className='hs-row';row.dataset.key=c.key;
    var name=document.createElement('span');name.className='hs-name';name.textContent=hlActionLabel(c.key);
    var sw=document.createElement('label');sw.className='hs-switch';
    var input=document.createElement('input');input.type='checkbox';input.checked=c.show!==false;
    var slider=document.createElement('span');slider.className='hs-slider';sw.append(input,slider);
    var grip=document.createElement('button');grip.type='button';grip.className='hs-grip';grip.title=readerPageText('dragSort');
    if(c.key==='web'){
      row.classList.add('hs-web-row');
      var engines=document.createElement('span');engines.className='hs-mode-buttons hs-engine-buttons';
      ['baidu','google'].forEach(function(engine){
        var b=document.createElement('button');b.type='button';b.dataset.engine=engine;b.textContent=engine==='google'?readerPageText('searchEngineGoogle'):readerPageText('searchEngineBaidu');
        b.className=readHlWebEngine()===engine?'on':'';
        b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();saveHlWebEngine(engine);renderHlSettings();});
        engines.appendChild(b);
      });
      row.append(name,engines,sw,grip);
    }else row.append(name,sw,grip);
    list.appendChild(row);
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
function hideHlSettings(){if(hlSettingsPop){hlSettingsPop.style.display='none';hlSettingsPop.classList.remove('hs-opening');}}
var hlTextPop=null,excerptPage=null,excerptText='',correctDraft=null;
function hideHlTextPop(){if(hlTextPop)hlTextPop.style.display='none';}
function ensureHighlightTextPop(){
  if(!hlTextPop){
    hlTextPop=document.createElement('div');hlTextPop.id='hl-text-pop';
    hlTextPop.innerHTML='<button class="ht-close" type="button">×</button><div class="ht-title">'+readerPageText('correct')+'</div><div class="ht-original"></div><textarea></textarea><div class="ht-row"><button class="act cancel" type="button">'+readerPageText('cancel')+'</button><button class="act save" type="button">'+readerPageText('save')+'</button></div>';
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
  hlTextPop.querySelector('.ht-original').textContent=readerPageText('original')+'：'+(h.text||'');
  hlTextPop.querySelector('textarea').value=highlightDisplayText(h);
  var el=markEl(idx),r=el?el.getBoundingClientRect():{left:window.innerWidth/2,top:window.innerHeight/2,bottom:window.innerHeight/2,width:0};
  placeHighlightTextPop(r);
}
function showCorrectionDraft(o,rect){
  if(!o)return;
  ensureHighlightTextPop();
  correctDraft=o;
  activeHi=-1;
  hlTextPop.querySelector('.ht-original').textContent=readerPageText('original')+'：'+(o.text||'');
  hlTextPop.querySelector('textarea').value=o.text||'';
  placeHighlightTextPop(rect);
}
function hideExcerptPage(){if(excerptPage)excerptPage.style.display='none';}
function closeReaderPageGestureSurface(){
  if(excerptPage&&excerptPage.style.display==='block'){hideExcerptPage();return true;}
  if(hlTextPop&&hlTextPop.style.display==='block'){hideHlTextPop();return true;}
  return false;
}
function showExcerptPage(text){
  var t=(text||'').trim();if(!t)return;
  excerptText=t;
  if(!excerptPage){
    excerptPage=document.createElement('div');excerptPage.id='excerpt-page';
    excerptPage.innerHTML='<div class="ex-card"><div class="ex-head"><div class="ex-title">'+readerPageText('excerpt')+'</div><button class="ex-close" type="button">×</button></div><div class="ex-body"><div class="ex-quote"></div></div><div class="ex-foot"><span class="ex-status"></span><button class="ex-download" type="button">'+readerPageText('downloadImage')+'</button></div></div>';
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
  if(st)st.textContent=readerPageText('generatingImage');
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
  ctx.fillStyle='rgba(75,58,37,.54)';ctx.font='22px "Microsoft YaHei", system-ui, sans-serif';ctx.fillText(readerPageText('excerpt'),pad,cssH-pad+18);
  var dataUrl=canvas.toDataURL('image/png');
  try{
    if(parent&&parent!==window){
      parent.postMessage({downloadImage:{name:readerPageText('excerpt')+'.png',dataUrl:dataUrl}},'*');
      return;
    }
  }catch(_){}
  var a=document.createElement('a');a.download=readerPageText('excerpt')+'.png';a.href=dataUrl;document.body.appendChild(a);a.click();a.remove();
  if(st)st.textContent=readerPageText('downloadStarted');
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
  hlSettingsPop.classList.remove('hs-opening');
  if(readerAnimationSettingOn('highlightSettings')){void hlSettingsPop.offsetWidth;hlSettingsPop.classList.add('hs-opening');}
}
// ---- 翻译面板：UI 先就位；实际 API 需用户配置后才发送文本到外部服务 ----
var trPop=null,trRect=null,trText='',trCredentialDirty=false,trCredentialStatus={};
function hideTranslate(){if(trPop)trPop.style.display='none';}
function setupTranslate(){
  trPop=document.createElement('div');trPop.id='tr-pop';
  trPop.innerHTML='<div class="tr-row"><div><div class="tr-title">'+readerPageText('source')+'</div><div class="tr-text tr-src"></div></div><select class="tr-select tr-source"><option value="auto">'+readerPageText('autoDetect')+'</option><option value="zh-CN">'+readerPageText('chinese')+'</option><option value="en">'+readerPageText('english')+'</option><option value="ja">'+readerPageText('japanese')+'</option><option value="ko">'+readerPageText('korean')+'</option></select></div><div class="tr-sep"></div><div class="tr-row"><div><div class="tr-title">'+readerPageText('translation')+'</div><div class="tr-text tr-dst tr-muted">'+readerPageText('loading')+'</div></div><select class="tr-select tr-target"><option value="system">'+readerPageText('systemLanguage')+'</option><option value="zh-CN">'+readerPageText('chinese')+'</option><option value="en">'+readerPageText('english')+'</option><option value="ja">'+readerPageText('japanese')+'</option><option value="ko">'+readerPageText('korean')+'</option></select></div><div class="tr-provider"><select class="tr-select tr-api"><option value="baidu">Baidu</option><option value="tencent">Tencent</option><option value="deepl">DeepL</option><option value="google">Google</option></select></div><div class="tr-api-fields"><input class="tr-input tr-api-id"><input class="tr-input tr-api-key" type="password"></div>';
  document.body.appendChild(trPop);
  try{
    trPop.querySelector('.tr-api').value=localStorage.getItem('translateProvider')||'baidu';
    trPop.querySelector('.tr-source').value=localStorage.getItem('translateSourceLang')||'auto';
    trPop.querySelector('.tr-target').value=localStorage.getItem('translateTargetLang')||'system';
  }catch(_){}
  trPop.addEventListener('mousedown',function(e){e.stopPropagation();});
  trPop.addEventListener('click',function(e){e.stopPropagation();});
  ['.tr-source','.tr-target'].forEach(function(sel){trPop.querySelector(sel).addEventListener('change',function(){saveTranslatePrefs();requestTranslate();});});
  trPop.querySelector('.tr-api').addEventListener('change',function(){try{localStorage.setItem('translateProvider',trPop.querySelector('.tr-api').value);}catch(_){} parent.postMessage({setTranslationActiveProvider:trPop.querySelector('.tr-api').value},'*');updateTranslateApiFields();requestTranslate();});
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
  if(provider==='baidu')return {id:'Baidu AppID',key:'Baidu API key'};
  if(provider==='tencent')return {id:'Tencent SecretId',key:'Tencent SecretKey'};
  if(provider==='deepl')return {id:'DeepL API key',key:'DeepL API key (optional)'};
  if(provider==='google')return {id:'Google API key',key:'Google API key (optional)'};
  return {id:'AppID / API key',key:'API key'};
}
function applyTranslationProfiles(status){
  if(!trPop||!status)return;
  var select=trPop.querySelector('.tr-api'),profiles=Array.isArray(status.profiles)?status.profiles.filter(function(p){return p&&p.configured;}):[];
  if(!profiles.length)return;
  var current=status.activeProvider||status.active_provider||select.value;
  select.innerHTML='';
  profiles.forEach(function(profile){var opt=document.createElement('option');opt.value=profile.provider;opt.textContent=translateApiLabel(profile.provider).id.replace(/ AppID| SecretId| API Key/,'');select.appendChild(opt);trCredentialStatus[profile.provider]=profile;});
  select.value=profiles.some(function(profile){return profile.provider===current;})?current:profiles[0].provider;
  try{localStorage.setItem('translateProvider',select.value);}catch(_){}
  updateTranslateApiFields();
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
  trPop.querySelector('.tr-dst').textContent=readerPageText('loading');
  trPop.querySelector('.tr-dst').className='tr-text tr-dst tr-muted';
  placeTranslate();requestTranslate();parent.postMessage({getTranslationProfiles:1},'*');
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
      dst.textContent=readerPageText('fillCredential')+' '+dirtyLabel.id+(api==='deepl'||api==='google'?'。':' + '+dirtyLabel.key+'。');
      dst.className='tr-text tr-dst tr-error';placeTranslate();return;
    }
    dst.textContent=readerPageText('savingCredential');dst.className='tr-text tr-dst tr-muted';placeTranslate();
    parent.postMessage({saveTranslationCredential:{provider:api,apiId:apiId,apiKey:apiKey}},'*');return;
  }
  var status=trCredentialStatus[api];
  if(!status){dst.textContent=readerPageText('checkCredential');dst.className='tr-text tr-dst tr-muted';parent.postMessage({getTranslationCredentialStatus:api},'*');placeTranslate();return;}
  if(!status.configured){
    var label=translateApiLabel(api);
    dst.textContent=readerPageText('fillCredential')+' '+label.id+(api==='deepl'||api==='google'?'。':' + '+label.key+'。');
    dst.className='tr-text tr-dst tr-error';
    placeTranslate();return;
  }
  dst.textContent=readerPageText('loading');dst.className='tr-text tr-dst tr-muted';placeTranslate();
  parent.postMessage({translateText:{text:trText,source:trPop.querySelector('.tr-source').value,target:trPop.querySelector('.tr-target').value,provider:api,credentialConfigId:status.config_id||('translate:'+api)}},'*');
}
function showTranslateResult(r){
  if(!trPop)return;
  var dst=trPop.querySelector('.tr-dst');
  if(r&&r.ok){dst.textContent=r.translated||'';dst.className='tr-text tr-dst';}
  else{dst.textContent=(r&&r.error)||readerPageText('translationFailed');dst.className='tr-text tr-dst tr-error';}
  placeTranslate();
}
// Called after the shell posts a new S.uiLanguage.  The iframe has no access
// to the parent window's i18n module, so visible transient controls must be
// rebuilt here rather than waiting for the next selection.
function refreshReaderPageLanguage(){
  if(selMenu)applyConfiguredMenu(selMenu,selMenuItems,selMenu._setBtn);
  if(hlMenu)applyConfiguredMenu(hlMenu,hlMenuItems,hlMenu._setBtn);
  if(hlSettingsPop&&hlSettingsPop.style.display!=='none')renderHlSettings();
  if(hlTextPop){
    var title=hlTextPop.querySelector('.ht-title'),cancel=hlTextPop.querySelector('.cancel'),save=hlTextPop.querySelector('.save');
    if(title)title.textContent=readerPageText('correct');if(cancel)cancel.textContent=readerPageText('cancel');if(save)save.textContent=readerPageText('save');
    var original=hlTextPop.querySelector('.ht-original');if(original)original.textContent=readerPageText('original')+'：'+original.textContent.replace(/^[^：:]+[：:]/,'');
  }
  if(excerptPage){var exTitle=excerptPage.querySelector('.ex-title'),exDownload=excerptPage.querySelector('.ex-download');if(exTitle)exTitle.textContent=readerPageText('excerpt');if(exDownload)exDownload.textContent=readerPageText('downloadImage');}
  if(dictPop){var gear=dictPop.querySelector('.dc-gear');if(gear)gear.title=readerPageText('dictionarySettings');if(lastDict)renderDict();}
  // Translation labels are part of generated select markup.  Recreate only
  // an open panel; hidden panels can be rebuilt lazily without a visual jump.
  if(trPop){var open=trPop.style.display==='block',text=trText,rect=trRect;trPop.remove();trPop=null;if(open&&text)openTranslate(text,rect);}
}
function setupSelMenu(){
  selMenu=document.createElement('div');selMenu.id='sel-menu';
  selMenu._onColorPick=function(color){
    var o=selOffsets();
    if(o){o.chapter=curCh;o.context=getSelContext();o.color=color;parent.postMessage({addHighlight:o},'*');}
    if(window.getSelection)window.getSelection().removeAllRanges();
    hideSelMenu();
  };
  var btn=document.createElement('button');btn.type='button';
  var btnDict=document.createElement('button');btnDict.type='button';
  var btnTr=document.createElement('button');btnTr.type='button';
  var btnCopy=document.createElement('button');btnCopy.type='button';
  var btnHL=document.createElement('button');btnHL.type='button';
  var btnCorrect=document.createElement('button');btnCorrect.type='button';
  var btnExcerpt=document.createElement('button');btnExcerpt.type='button';
  var btnCross=document.createElement('button');btnCross.type='button';
  var btnSemantic=document.createElement('button');btnSemantic.type='button';
  var btnAiReader=document.createElement('button');btnAiReader.type='button';
  var btnNote=document.createElement('button');btnNote.type='button';
  var btnBm=document.createElement('button');btnBm.type='button';
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
    {key:'aiReader',button:btnAiReader},
    {key:'note',button:btnNote},
    {key:'bookmark',button:btnBm}
  ];
  selMenu._setBtn=btnSet;
  applyConfiguredMenu(selMenu,selMenuItems,btnSet);
  document.body.appendChild(selMenu);
  [btn,btnDict,btnTr,btnCopy,btnHL,btnCorrect,btnExcerpt,btnCross,btnSemantic,btnAiReader,btnNote,btnBm,btnSet].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
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
    if(t)parent.postMessage({webSearch:{term:t,engine:readHlWebEngine()}},'*');
    hideSelMenu();
  });
  btnHL.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();o.color=readHlColor();parent.postMessage({addHighlight:o},'*');}
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
  btnAiReader.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var o=selOffsets(),t=(o?o.text:(window.getSelection?window.getSelection().toString():''))||'';t=t.trim();
    if(t)parent.postMessage({aiReader:{text:t,anchorStart:o&&o.start,anchorEnd:o&&o.end}},'*');
    if(window.getSelection)window.getSelection().removeAllRanges();
    hideSelMenu();
  });
  btnNote.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var o=selOffsets();if(o){o.chapter=curCh;o.context=getSelContext();o.color=readHlColor();parent.postMessage({addHighlightNote:o},'*');}
    if(window.getSelection)window.getSelection().removeAllRanges();
    hideSelMenu();
  });
  btnCopy.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var t=(window.getSelection?window.getSelection().toString():'').trim();
    copyTextToClipboard(t);
    hideSelMenu();
  });
  btnSet.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();showHlSettings(selMenu);hideSelMenu();});
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
    selMenu._menuPreferredAbove=false;
    selMenu._menuPointerX=rect.left+rect.width/2;
    applyConfiguredMenu(selMenu,selMenuItems,selMenu._setBtn);
    selMenu.style.display='block';
    repositionVisibleHighlightMenu(selMenu);
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
function visibleHighlightLineRects(idx,fallbackEl){
  var rects=[],range=highlightRange(idx);
  try{if(range)rects=[].slice.call(range.getClientRects());}catch(_){rects=[];}
  if(!rects.length&&fallbackEl&&fallbackEl.getClientRects){try{rects=[].slice.call(fallbackEl.getClientRects());}catch(_){rects=[];}}
  var vw=window.innerWidth||1,vh=window.innerHeight||1;
  return rects.filter(function(r){return r&&r.width>0&&r.height>0&&r.right>0&&r.left<vw&&r.bottom>0&&r.top<vh;});
}
function highlightPageKey(rect){
  // 与 anchorPage() 一致：分页模式用横向列位置区分页；滚动模式没有“跨页菜单”概念。
  if(typeof usesLineBreakPaging==='function'&&usesLineBreakPaging())return 0;
  if(typeof pageStep!=='number'||pageStep<=0||typeof viewRect!=='function')return 0;
  var pr=viewRect();
  return Math.floor((rect.left-pr.left+viewOffset+1)/pageStep);
}
function highlightRectEnvelope(rects){
  return ReaderPageHighlightRules.envelope(rects);
}
function nearestHighlightRect(rects,evt){
  return ReaderPageHighlightRules.nearestRect(rects,evt&&typeof evt.clientX==='number'&&typeof evt.clientY==='number'?{x:evt.clientX,y:evt.clientY}:null);
}
function highlightLineGroups(rects){
  // 同一行内的多个内联片段应看成一行，否则单行高亮会误判为多行。
  return ReaderPageHighlightRules.groupedEnvelopes(rects,function(r){return highlightPageKey(r)+':'+Math.round(r.top)+':'+Math.round(r.bottom);});
}
function highlightMenuPlacement(idx,fallbackEl,evt){
  var rects=visibleHighlightLineRects(idx,fallbackEl);
  if(!rects.length){var fallback=anchorRectForElement(fallbackEl,evt);return {rect:fallback,above:false};}
  // 跨页优先较早一页；同页多行紧跟末行，单行则跟随指针所在文字片段。
  return ReaderPageHighlightRules.placement(rects,evt&&typeof evt.clientX==='number'&&typeof evt.clientY==='number'?{x:evt.clientX,y:evt.clientY}:null,highlightPageKey,function(r){return highlightPageKey(r)+':'+Math.round(r.top)+':'+Math.round(r.bottom);});
}
function readerViewportHeight(){
  // iframe 的 innerHeight 偶尔会滞后一帧；以 layout viewport 的较小值为准，
  // 避免把菜单误判为“下方还有空间”而塞到页末文字里。
  var inner=Number(window.innerHeight)||0;
  var client=Number(document.documentElement&&document.documentElement.clientHeight)||0;
  if(inner&&client)return Math.min(inner,client);
  return inner||client||800;
}
function placeHighlightMenuVertically(menu,rect,preferAbove){
  var safe=6,gap=6,vh=readerViewportHeight();
  // 必须在菜单 display:block 后读取。横排、九宫格、多彩高亮的真实高度都不同，
  // 不能再用固定 34px 估算。
  var mh=Math.min(Math.max(Number(menu&&menu.offsetHeight)||34,1),Math.max(1,vh-safe*2));
  var aboveTop=rect.top-mh-gap,belowTop=rect.bottom+gap;
  var canAbove=aboveTop>=safe,canBelow=belowTop+mh<=vh-safe;
  var above=!!preferAbove,top;
  if(preferAbove){
    if(canAbove){above=true;top=aboveTop;}
    else if(canBelow){above=false;top=belowTop;}
  }else{
    if(canBelow){above=false;top=belowTop;}
    else if(canAbove){above=true;top=aboveTop;}
  }
  // 视口非常矮时两侧都不足：仍完整留在可视区，优先留在空间更多的一侧。
  if(top===undefined){
    var roomAbove=Math.max(0,rect.top-safe-gap),roomBelow=Math.max(0,vh-safe-rect.bottom-gap);
    above=roomAbove>=roomBelow;
    top=above?aboveTop:belowTop;
  }
  top=Math.max(safe,Math.min(vh-mh-safe,top));
  return {top:top,above:above,height:mh};
}
function repositionVisibleHighlightMenu(menu){
  if(!menu||menu.style.display!=='block'||!menu._anchorRect)return;
  var rect=menu._anchorRect,mw=menu.offsetWidth||200;
  var x=typeof menu._menuPointerX==='number'?menu._menuPointerX:rect.left+rect.width/2;
  var left=Math.max(6,Math.min(window.innerWidth-mw-6,x-mw/2));
  var vertical=placeHighlightMenuVertically(menu,rect,!!menu._menuPreferredAbove);
  menu.style.left=left+'px';menu.style.top=vertical.top+'px';
  menu._menuAbove=vertical.above;
}
function showHlMenu(idx,force,anchor,evt){
  if(selActive()&&!force)return;   // 还在选字（如刚高亮完）就不弹，避免和选区菜单同时出现
  hideSelMenu();                  // 任何时候只保留一个工具栏
  activeHi=idx;var el=anchor||markEl(idx)||virtualMarkEl(idx);
  if(!el){var hr=visibleHighlightRect(idx);if(hr)el={getBoundingClientRect:function(){return hr;},getClientRects:function(){return [hr];}};}
  if(!el)return;
  applyConfiguredMenu(hlMenu,hlMenuItems,hlMenu&&hlMenu._setBtn);
  hlMenu.style.display='block';
  var placement=highlightMenuPlacement(idx,el,evt),rect=placement.rect;
  hlMenu._anchorRect=rect;
  hlMenu._menuPreferredAbove=placement.above;
  hlMenu._menuPointerX=evt&&typeof evt.clientX==='number'?evt.clientX:rect.left+rect.width/2;
  repositionVisibleHighlightMenu(hlMenu);
}
function setupHlUi(){
  hlMenu=document.createElement('div');hlMenu.id='hl-menu';
  hlMenu._onColorPick=function(color){if(activeHi>=0)parent.postMessage({setHighlightColor:{index:activeHi,color:color}},'*');};
  var mWeb=mkBtn(''),mDict=mkBtn(''),mTr=mkBtn(''),mCopy=mkBtn(''),mDel=mkBtn(''),mCorrect=mkBtn(''),mExcerpt=mkBtn(''),mCross=mkBtn(''),mSemantic=mkBtn(''),mAiReader=mkBtn(''),mNote=mkBtn(''),mSet=mkBtn('⚙');
  hlMenuItems=[
    {key:'web',button:mWeb},
    {key:'dict',button:mDict},
    {key:'translate',button:mTr},
    {key:'copy',button:mCopy},
    {key:'highlight',button:mDel,labelKey:'removeHighlight',icon:'remove'},
    {key:'correct',button:mCorrect},
    {key:'excerpt',button:mExcerpt},
    {key:'cross',button:mCross},
    {key:'semantic',button:mSemantic},
    {key:'aiReader',button:mAiReader},
    {key:'note',button:mNote}
  ];
  hlMenu._setBtn=mSet;
  applyConfiguredMenu(hlMenu,hlMenuItems,mSet);
  document.body.appendChild(hlMenu);
  [mWeb,mDict,mTr,mCopy,mDel,mCorrect,mExcerpt,mCross,mSemantic,mAiReader,mNote,mSet].forEach(function(b){b.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});});
  mWeb.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)parent.postMessage({webSearch:{term:highlightDisplayText(h),engine:readHlWebEngine()}},'*');hideHlMenu();});
  mDict.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)openDict(highlightDisplayText(h),h.context||'');hideHlMenu();});
  mTr.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi],el=markEl(activeHi);if(h)openTranslate(highlightDisplayText(h),el?el.getBoundingClientRect():null);hideHlMenu();});
  mCopy.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)copyTextToClipboard(highlightDisplayText(h));hideHlMenu();});
  mDel.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({removeHighlight:activeHi},'*');hideHlMenu();});
  mCorrect.addEventListener('click',function(e){e.stopPropagation();var idx=activeHi;hideHlMenu();if(idx>=0)showHighlightTextEditor(idx);});
  mExcerpt.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];hideHlMenu();if(h)showExcerptPage(highlightDisplayText(h));});
  mCross.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)parent.postMessage({crossSearch:highlightDisplayText(h)},'*');hideHlMenu();});
  mSemantic.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];if(h)parent.postMessage({semanticSearch:highlightDisplayText(h)},'*');hideHlMenu();});
  mAiReader.addEventListener('click',function(e){e.stopPropagation();var h=HL[activeHi];hideHlMenu();if(h)parent.postMessage({aiReader:{text:highlightDisplayText(h),anchorStart:h.start,anchorEnd:h.end}},'*');});
  mNote.addEventListener('click',function(e){e.stopPropagation();if(activeHi>=0)parent.postMessage({openAnnotations:activeHi},'*');hideHlMenu();});
  mSet.addEventListener('click',function(e){e.stopPropagation();showHlSettings(hlMenu);hideHlMenu();});
  hlMenu.addEventListener('mouseenter',function(){if(hlHideTimer)clearTimeout(hlHideTimer);});
  hlMenu.addEventListener('mouseleave',function(){if(hlSettingsPop&&hlSettingsPop.style.display==='block')return;hlHideTimer=setTimeout(hideHlMenu,400);});

  // 悬停高亮 → 出菜单；移开延时收起
  root.addEventListener('mouseover',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi'),10),false,m,e);}});
  root.addEventListener('mousemove',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m&&activeHi===parseInt(m.getAttribute('data-hi'),10))showHlMenu(activeHi,false,m,e);});
  root.addEventListener('mouseout',function(e){var m=e.target.closest?e.target.closest('mark.hl'):null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
  if(hlOverlay){
    hlOverlay.addEventListener('mouseover',function(e){var m=e.target.closest?e.target.closest('.hl-rect[data-hi]'):null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi'),10),false,m,e);}});
    hlOverlay.addEventListener('mousemove',function(e){var m=e.target.closest?e.target.closest('.hl-rect[data-hi]'):null;if(m&&activeHi===parseInt(m.getAttribute('data-hi'),10))showHlMenu(activeHi,false,m,e);});
    hlOverlay.addEventListener('mouseout',function(e){var m=e.target.closest?e.target.closest('.hl-rect[data-hi]'):null;if(m){hlHideTimer=setTimeout(hideHlMenu,400);}});
    hlOverlay.addEventListener('click',function(e){var m=e.target.closest?e.target.closest('.hl-rect[data-hi]'):null;if(m){e.preventDefault();e.stopPropagation();showHlMenu(parseInt(m.getAttribute('data-hi'),10),true,m,e);}});
  }
  if(virtualPage){
    virtualPage.addEventListener('mouseover',function(e){var m=e.target.closest?e.target.closest('.vp-hl[data-hi]'):null;if(m){if(hlHideTimer)clearTimeout(hlHideTimer);showHlMenu(parseInt(m.getAttribute('data-hi'),10),false,m,e);}});
    virtualPage.addEventListener('mousemove',function(e){var m=e.target.closest?e.target.closest('.vp-hl[data-hi]'):null;if(m&&activeHi===parseInt(m.getAttribute('data-hi'),10))showHlMenu(activeHi,false,m,e);});
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
  // 非链接内容仍会由阅读页的 inFootnote 分支吞掉，不会触发翻页；但链接必须
  // 冒泡到该分支，才能复用既有的跨章/同章锚点跳转，并在跳转后收起注释卡片。
  fnPop.addEventListener('click',function(e){if(e.target.closest&&e.target.closest('a'))e.preventDefault();});
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
var dictPop=null,dictRect=null,dictContext='',dictSettingsStatus='';
var DICT_HN_SETTINGS_KEY='dictEnhancementSettingsV2';
var DICT_HN_CFG=[
  {key:'plain',labelKey:'meaningHint'}, {key:'sense',labelKey:'possibleSenses'},
  {key:'context',labelKey:'contextHint'}, {key:'hypernyms',labelKey:'hypernyms'},
  {key:'synonyms',labelKey:'synonyms'}, {key:'antonyms',labelKey:'antonyms'}
];
function dictHnSettings(){
  var defaults={plain:false,sense:false,context:false,hypernyms:false,synonyms:false,antonyms:false};
  try{
    var raw=localStorage.getItem(DICT_HN_SETTINGS_KEY);
    if(raw){
      var v=JSON.parse(raw)||{};
      return {
        plain:v.plain===true,
        sense:v.sense===true,
        context:v.context===true,
        hypernyms:v.hypernyms===true,
        synonyms:v.synonyms===true,
        antonyms:v.antonyms===true
      };
    }
  }catch(_){}
  return defaults;
}
function setDictHnSettings(v){try{localStorage.setItem(DICT_HN_SETTINGS_KEY,JSON.stringify(v));}catch(_){}}
function dictEnhancementAvailable(result,key){
  var h=result&&result.hownet;
  if(!h)return false;
  var field=key==='context'?'example_note':key;
  var value=h[field];
  return Array.isArray(value)?value.length>0:typeof value==='string'?value.trim().length>0:value!=null;
}
function dictEnhancementUnavailableText(cfg){
  return readerPageText('dictionaryEnhancementUnavailable').replace('{option}',readerPageText(cfg.labelKey));
}
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
    gear.title=readerPageText('dictionarySettings');
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
  dictPop.innerHTML='<button class="dc-gear" type="button" title="'+readerPageText('dictionarySettings')+'">⚙</button><div class="dc-settings"></div><div class="dc-head"></div><div class="dc-def"></div>';
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
  if(dictSettingsStatus){
    var status=document.createElement('div');status.className='dc-settings-status';status.textContent=dictSettingsStatus;pop.appendChild(status);
  }
  DICT_HN_CFG.forEach(function(cfg){
    var row=document.createElement('label');row.className='dc-set-row';
    var name=document.createElement('span');name.textContent=readerPageText(cfg.labelKey);row.appendChild(name);
    var sw=document.createElement('span');sw.className='dc-switch';
    var input=document.createElement('input');input.type='checkbox';input.checked=st[cfg.key]!==false;
    var slider=document.createElement('span');slider.className='dc-slider';
    input.addEventListener('change',function(e){
      e.stopPropagation();
      if(input.checked&&!dictEnhancementAvailable(lastDict,cfg.key)){
        input.checked=false;
        st[cfg.key]=false;
        setDictHnSettings(st);
        dictSettingsStatus=dictEnhancementUnavailableText(cfg);
        renderDictSettings(pop);pop.classList.add('show');placeDictSettings(pop);
        return;
      }
      dictSettingsStatus='';
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
  dictPop.querySelector('.dc-head').textContent=readerPageText('lookingUp');
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
  if(st.plain!==false)appendDictTextBlock(box,readerPageText('meaningHint'),h.plain);
  if(st.sense!==false)appendDictTextBlock(box,readerPageText('possibleSenses'),h.sense);
  if(st.context!==false)appendDictTextBlock(box,readerPageText('contextHint'),h.example_note);
  if(st.hypernyms!==false)appendDictTags(box,readerPageText('hypernyms'),h.hypernyms);
  if(st.synonyms!==false)appendDictTags(box,readerPageText('synonyms'),h.synonyms);
  if(st.antonyms!==false)appendDictTags(box,readerPageText('antonyms'),h.antonyms);
  if(box.childNodes.length)def.appendChild(box);
}
function renderDict(){
  if(!dictPop||!lastDict)return;
  ensureDictControls();
  var r=lastDict,head=dictPop.querySelector('.dc-head'),def=dictPop.querySelector('.dc-def');
  head.innerHTML='';def.innerHTML='';
  var w=document.createElement('span');w.className='dc-word';w.textContent=r.word||'';head.appendChild(w);
  if(!r.found){def.textContent=readerPageText('notFoundDefinition');def.className='dc-def dc-miss';return;}
  if(r.phonetic){var ph=document.createElement('span');ph.className='dc-phon';ph.textContent=(r.lang==='en')?('['+r.phonetic+']'):r.phonetic;head.appendChild(ph);}
  if(r.lang==='en'){
    parent.postMessage({dictPrefetch:r.word},'*');
    var spk=document.createElement('span');spk.className='dc-spk';spk.textContent='🔊';spk.title=readerPageText('pronunciation');
    spk.addEventListener('click',function(e){e.stopPropagation();speakWord(r.word);});head.appendChild(spk);
  }
  if(r.sources&&r.sources.length){
    r.sources.forEach(function(src,idx){
      var det=document.createElement('details');det.className='dc-source';if(idx===0)det.open=true;
      var sum=document.createElement('summary');
      var label=src.source_name||readerPageText('externalDictionary');
      var sw=src.word&&src.word!==r.word?(' · '+src.word):'';
      var ph=src.phonetic?(' · '+src.phonetic):'';
      sum.textContent=label+sw+ph;
      var body=document.createElement('div');body.className='dc-source-body';
      if(src.def){var blk=document.createElement('div');blk.className='dc-defblk';var lb=document.createElement('span');lb.className='dc-lb';lb.textContent=readerPageText('chinese');blk.appendChild(lb);var tx=document.createElement('span');tx.textContent=src.def;blk.appendChild(tx);body.appendChild(blk);}
      if(src.def_en){var blk2=document.createElement('div');blk2.className='dc-defblk';var lb2=document.createElement('span');lb2.className='dc-lb';lb2.textContent=readerPageText('english');blk2.appendChild(lb2);var tx2=document.createElement('span');tx2.textContent=src.def_en;blk2.appendChild(tx2);body.appendChild(blk2);}
      if(!body.childNodes.length){body.textContent=readerPageText('noDefinition');}
      det.append(sum,body);def.appendChild(det);
    });
    appendHowNetBlocks(def,r);
    return;
  }
  if(r.source_name){
    var srcBadge=document.createElement('div');srcBadge.className='dc-src';srcBadge.textContent=r.source_name;def.appendChild(srcBadge);
  }
  var sources=[];
  if(r.def)sources.push({k:'c',label:readerPageText('chinese'),text:r.def});
  if(r.def_en)sources.push({k:'e',label:readerPageText('english'),text:r.def_en});
  if(!sources.length){def.textContent=readerPageText('noDefinition');def.className='dc-def dc-miss';return;}
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
  lastDict=r;dictSettingsStatus='';renderDict();
  if(r&&r.found&&r.lang==='en'&&r.autoSpeak)speakWord(r.word); // 按生词本设置决定是否自动读一次
  if(r&&r.found)parent.postMessage({vocabAdd:{word:r.word,lang:r.lang,def:r.def||'',def_en:r.def_en||'',phonetic:r.phonetic||'',example:dictContext||''}},'*'); // 记入生词本
  placeDict();
}
// 是否是"注释角标"链接：epub:type/role/class 含 note，或链接文字形如
// [23] / (3) / 23 / 注1。最后一种常见于中文书的跨章节注文。
function isNoteLink(a){
  var cls=String(a&&a.className||'');
  if(a&&(a.getAttribute('data-rr-note-ref')==='1'||/\brr-note-ref\b/.test(cls)))return true;
  var ty=((a.getAttribute('epub:type')||'')+' '+(a.getAttribute('role')||'')+' '+cls).toLowerCase();
  if(/note|footnote|endnote|annoref/.test(ty))return true;
  var t=(a.textContent||'').trim();
  return /^[\[【（(]?\s*(?:(?:注|註)\s*)?\d{1,4}\s*[\]】）)]?$/.test(t);
}
function fnSelector(frag){return '[id="'+String(frag).replace(/"/g,'\\"')+'"]';}
function popFootnote(a,html,key){
  if(!fnPop)setupFn();
  fnPopKey=key||'';
  fnPop.querySelector('.fn-body').innerHTML=html;
  fnPop.scrollTop=0;
  fnPop.style.display='block';
  var rect=a.getBoundingClientRect();
  var pw=fnPop.offsetWidth;
  var ph=fnPop.offsetHeight;
  var viewportWidth=Math.max(16,window.innerWidth||document.documentElement.clientWidth||16);
  var left=rect.left+rect.width/2-pw/2;
  left=Math.max(8,Math.min(left,Math.max(8,viewportWidth-pw-8)));
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
  popFootnote(a,readerPageText('footnoteLoading'),key);
  findFootnoteHtmlAcrossChapters(footnoteSearchOrder(ci),frag).then(function(html){
    if(fnPopKey===key)popFootnote(a,html||readerPageText('footnoteNotFound'),key);
  }).catch(function(){if(fnPopKey===key)popFootnote(a,readerPageText('footnoteFailed'),key);});
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
