// ---- 滚动分页纯几何规则 ----
// 与阅读页的其他模块在编译期拼接为同一份脚本。这里不读取 DOM、设置或
// 全局状态；调用方只传入已测得的行/块几何与分页索引，仍由布局模块负责
// 读取滚动容器、构建视觉图层和驱动 EPUB/PDF 命令式引擎。
var ReaderPageScrollRules=(function(){
  function boundedIndex(length,index){
    var size=Math.max(0,Math.floor(Number(length)||0));
    if(!size)return 0;
    var value=Math.floor(Number(index)||0);
    return Math.max(0,Math.min(size-1,value));
  }
  function boundedTop(value,maxTop){
    var max=Math.max(0,Number(maxTop)||0);
    return Math.max(0,Math.min(max,Math.round(Number(value)||0)));
  }
  function firstUnfinishedItemIndex(items,startIdx,bottom){
    if(!items||!items.length)return -1;
    var start=boundedIndex(items.length,startIdx),limit=Number(bottom)||0;
    for(var i=start;i<items.length;i++){
      if((Number(items[i]&&items[i].bottom)||0)>limit+.5)return i;
    }
    return items.length;
  }
  function pageBottomForSlice(pageTop,viewHeight,nextItem){
    var top=Number(pageTop)||0,fullBottom=top+Math.max(0,Number(viewHeight)||0);
    if(nextItem&&nextItem.type==='block'&&nextItem.atomic&&!nextItem.preview
      &&Number(nextItem.top)<fullBottom-1&&Number(nextItem.bottom)>fullBottom+.5){
      return Math.max(top,Math.min(fullBottom,Math.round(Number(nextItem.top)||0)));
    }
    return fullBottom;
  }
  function pageTopForStartItem(items,startIdx,navMaxTop,topPad){
    if(!items||!items.length||startIdx<=0)return 0;
    var item=items[boundedIndex(items.length,startIdx)];
    return boundedTop((Number(item&&item.top)||0)-(Number(topPad)||0),navMaxTop);
  }
  function alignedPageStart(items,startIdx,navMaxTop,topPad){
    if(!items||!items.length)return {startIdx:0,pageTop:0};
    var start=boundedIndex(items.length,startIdx);
    var pageTop=pageTopForStartItem(items,start,navMaxTop,topPad),guard=0;
    while(start>0&&(Number(items[start-1]&&items[start-1].bottom)||0)>pageTop+1&&guard++<1000){
      start--;
      pageTop=pageTopForStartItem(items,start,navMaxTop,topPad);
    }
    return {startIdx:start,pageTop:pageTop};
  }
  function nearestBreakIndex(breaks,top){
    if(!breaks||!breaks.length)return 0;
    var target=Number(top)||0,best=0,bestDistance=Infinity;
    for(var i=0;i<breaks.length;i++){
      var distance=Math.abs((Number(breaks[i])||0)-target);
      if(distance<bestDistance){best=i;bestDistance=distance;}
    }
    return best;
  }
  function pageIndexForTop(breaks,top,epsilon){
    if(!breaks||!breaks.length)return 0;
    var target=Number(top)||0,slop=Number(epsilon)||0,index=0;
    for(var i=0;i<breaks.length;i++){
      if((Number(breaks[i])||0)<=target+slop)index=i;else break;
    }
    return boundedIndex(breaks.length,index);
  }
  return Object.freeze({
    firstUnfinishedItemIndex:firstUnfinishedItemIndex,
    pageBottomForSlice:pageBottomForSlice,
    pageTopForStartItem:pageTopForStartItem,
    alignedPageStart:alignedPageStart,
    nearestBreakIndex:nearestBreakIndex,
    pageIndexForTop:pageIndexForTop
  });
})();
