// ---- 高亮菜单纯矩形规则 ----
// 与阅读页的其他模块在编译期拼接为同一份脚本。这里不读取 DOM、设置或
// 全局状态；调用方传入已测得的矩形、指针位置和分页键，仍由批注模块负责
// 选区、渲染、事件、IPC 与 EPUB/PDF 命令式阅读引擎。
var ReaderPageHighlightRules=(function(){
  function finite(value,fallback){
    var number=Number(value);
    return Number.isFinite(number)?number:(fallback||0);
  }
  function envelope(rects){
    var left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    (rects||[]).forEach(function(rect){
      left=Math.min(left,finite(rect&&rect.left));
      top=Math.min(top,finite(rect&&rect.top));
      right=Math.max(right,finite(rect&&rect.right));
      bottom=Math.max(bottom,finite(rect&&rect.bottom));
    });
    if(!Number.isFinite(left))return {left:0,top:0,right:0,bottom:0,width:0,height:0};
    return {left:left,top:top,right:right,bottom:bottom,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
  }
  function nearestRect(rects,pointer){
    if(!rects||!rects.length)return null;
    if(!pointer||!Number.isFinite(Number(pointer.x))||!Number.isFinite(Number(pointer.y)))return rects[0];
    var x=Number(pointer.x),y=Number(pointer.y),best=rects[0],bestDistance=Infinity;
    for(var i=0;i<rects.length;i++){
      var rect=rects[i],left=finite(rect&&rect.left),right=finite(rect&&rect.right),top=finite(rect&&rect.top),bottom=finite(rect&&rect.bottom);
      if(x>=left-3&&x<=right+3&&y>=top-5&&y<=bottom+5)return rect;
      var cx=Math.max(left,Math.min(right,x)),cy=Math.max(top,Math.min(bottom,y));
      var dx=x-cx,dy=y-cy,distance=dx*dx+dy*dy;
      if(distance<bestDistance){bestDistance=distance;best=rect;}
    }
    return best;
  }
  function groupedEnvelopes(items,groupKey){
    var groups={};
    (items||[]).forEach(function(item){
      var key=String(groupKey(item));
      (groups[key]||(groups[key]=[])).push(item);
    });
    return Object.keys(groups).map(function(key){return envelope(groups[key]);});
  }
  function placement(rects,pointer,pageKey,lineKey){
    if(!rects||!rects.length)return null;
    var pages={};
    rects.forEach(function(rect){
      var key=String(pageKey(rect));
      (pages[key]||(pages[key]=[])).push(rect);
    });
    var pageKeys=Object.keys(pages).sort(function(a,b){return Number(a)-Number(b);});
    if(pageKeys.length>1)return {rect:envelope(pages[pageKeys[0]]),above:true};
    var lines=groupedEnvelopes(rects,lineKey);
    if(lines.length<=1)return {rect:nearestRect(rects,pointer),above:false};
    var last=lines[0];
    lines.forEach(function(rect){if(rect.bottom>last.bottom||(rect.bottom===last.bottom&&rect.right>last.right))last=rect;});
    return {rect:last,above:false};
  }
  return Object.freeze({envelope:envelope,nearestRect:nearestRect,groupedEnvelopes:groupedEnvelopes,placement:placement});
})();
