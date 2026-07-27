# 鲲鹏阅读器 v1.9.5

v1.9.5 聚焦跨端发布、书架批量整理和阅读页分页稳定性。

## 新增与改进

- 多选图书可批量添加标签或加入收藏书单；分类只追加、不覆盖，已存在的关系会提示。
- Android 首版提供六入口书架、EPUB/TXT 系统导入和 Download 自动导入、后台 EPUB 解析缓存、筛选/布局持久化及封面阅读进度。
- Android 阅读页支持滚动与整页左右翻页；高亮、批注、书签、词典、翻译、Web 搜索等自定义划词菜单，并兼容 EPUB 图文、章节头图和脚注。
- 建立跨端 contracts、fixtures、ADR 和协作状态文档，为 Windows、macOS、Android、iOS/iPad 后续共享同步规则和产品语义。

## 修复

- 高亮菜单切换横排/九宫格后会重新按实际高度定位；页末选区也保持完整可见和可点击。
- macOS 按文本边界和完整行进行分页测量，修复滚动裁切、首尾半行和图文分页边界异常。

## 发布资产

- Windows x64：NSIS 安装包、单文件便携版和 `SHA256SUMS.txt`。
- macOS Apple Silicon：DMG、App ZIP 和 `SHA256SUMS-macOS.txt`；当前为临时签名，尚未经过 Apple Developer ID 公证。
- Android：Profile APK 和 `SHA256SUMS-Android.txt`；本次为书架、导入、阅读与划词工具首版。
