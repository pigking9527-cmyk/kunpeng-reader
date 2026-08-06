// ---- 读到全书末页 ----
// 只在向前进入末页时通知一次；离开末页后重新启用，初次恢复到末页不会打扰用户。
var readerEndNotified=false;
function notifyReaderEndIfReached(dir){
  var atEnd=curCh>=CH-1&&pageInCh>=pagesInCh-1;
  if(!atEnd){readerEndNotified=false;return false;}
  if(dir>0&&!readerEndNotified){readerEndNotified=true;parent.postMessage({bookEnd:true},'*');return true;}
  return false;
}
