// ---- 读到全书末页 ----
// 进入末页时必须让正文保持完整可见；只有用户已经在末页、再次向后翻页时才通知。
// 离开末页后重新启用，避免关闭推荐后原地重复弹出。
var readerEndNotified=false;
function notifyReaderEndIfReached(dir,boundaryAttempt){
  var atEnd=curCh>=CH-1&&pageInCh>=pagesInCh-1;
  if(!atEnd){readerEndNotified=false;return false;}
  if(dir>0&&boundaryAttempt===true&&!readerEndNotified){readerEndNotified=true;parent.postMessage({bookEnd:true},'*');return true;}
  return false;
}
