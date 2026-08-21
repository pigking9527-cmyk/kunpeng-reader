// Static main-window copy. This module is bundled into app-i18n.js; it is not a second runtime.

type LocaleCopy = Record<string, string>;
type LocaleCatalog = Record<string, LocaleCopy>;

export const SETTINGS_COPY: LocaleCatalog = {
  "zh-CN": {
    defaultOpenTitle: "默认打开方式",
    defaultOpenDescription:
      "安装版支持将 EPUB 和 PDF 设为由鲲鹏阅读器打开；点击右侧即可设置。",
    defaultOpenButton: "设置 EPUB / PDF 默认应用",
    recoveryTitle: "数据恢复点",
    recoveryLoading: "正在读取恢复点状态…",
    recoveryCreate: "立即创建",
    recoveryCreating: "正在创建…",
    recoverySelected: "恢复选中恢复点",
    recoveryRestoring: "正在恢复…",
    recoveryStatus:
      "已保留 {count} 个恢复点，共 {size}；最近一次 {latest}。每日自动创建，最多保留 7 个。",
    recoveryEmpty: "尚无恢复点；软件会每日自动创建，最多保留 7 个。",
    recoveryOption: "恢复点 {created}（{size}）",
    recoverySelect: "选择数据恢复点",
    dataExport: "⬆ 导出数据包",
    dataImport: "⬇ 导入数据包",
    recoveryReadFailed: "恢复点状态读取失败：{error}",
  },
  "zh-TW": {
    defaultOpenTitle: "預設開啟方式",
    defaultOpenDescription:
      "安裝版支援將 EPUB 和 PDF 設為由鯤鵬閱讀器開啟；按右側按鈕即可設定。",
    defaultOpenButton: "設定 EPUB / PDF 預設應用程式",
    recoveryTitle: "資料恢復點",
    recoveryLoading: "正在讀取恢復點狀態…",
    recoveryCreate: "立即建立",
    recoveryCreating: "正在建立…",
    recoverySelected: "恢復選取的恢復點",
    recoveryRestoring: "正在恢復…",
    recoveryStatus:
      "已保留 {count} 個恢復點，共 {size}；最近一次 {latest}。每日自動建立，最多保留 7 個。",
    recoveryEmpty: "尚無恢復點；軟體會每日自動建立，最多保留 7 個。",
    recoveryOption: "恢復點 {created}（{size}）",
    recoverySelect: "選擇資料恢復點",
    dataExport: "⬆ 匯出資料包",
    dataImport: "⬇ 匯入資料包",
    recoveryReadFailed: "讀取恢復點狀態失敗：{error}",
  },
  en: {
    defaultOpenTitle: "Default apps",
    defaultOpenDescription:
      "The installed app can open EPUB and PDF files. Use the action on the right to set them as defaults.",
    defaultOpenButton: "Set EPUB / PDF defaults",
    recoveryTitle: "Recovery points",
    recoveryLoading: "Loading recovery-point status…",
    recoveryCreate: "Create now",
    recoveryCreating: "Creating…",
    recoverySelected: "Restore selected point",
    recoveryRestoring: "Restoring…",
    recoveryStatus:
      "{count} recovery points retained ({size}); latest: {latest}. One is created daily, with up to 7 retained.",
    recoveryEmpty:
      "No recovery points yet. The app creates one daily and retains up to 7.",
    recoveryOption: "Recovery point {created} ({size})",
    recoverySelect: "Choose a recovery point",
    dataExport: "⬆ Export data package",
    dataImport: "⬇ Import data package",
    recoveryReadFailed: "Could not read recovery-point status: {error}",
  },
  ja: {
    defaultOpenTitle: "既定の開き方",
    defaultOpenDescription:
      "インストール版では EPUB と PDF を鯤鵬閲覧器で開けます。右側の操作から既定に設定できます。",
    defaultOpenButton: "EPUB / PDF の既定アプリを設定",
    recoveryTitle: "復元ポイント",
    recoveryLoading: "復元ポイントの状態を読み込んでいます…",
    recoveryCreate: "今すぐ作成",
    recoveryCreating: "作成中…",
    recoverySelected: "選択したポイントを復元",
    recoveryRestoring: "復元中…",
    recoveryStatus:
      "{count} 個の復元ポイントを保持中（{size}）。最新: {latest}。毎日自動作成され、最大 7 個を保持します。",
    recoveryEmpty:
      "復元ポイントはありません。毎日自動作成され、最大 7 個を保持します。",
    recoveryOption: "復元ポイント {created}（{size}）",
    recoverySelect: "復元ポイントを選択",
    dataExport: "⬆ データパッケージをエクスポート",
    dataImport: "⬇ データパッケージをインポート",
    recoveryReadFailed: "復元ポイントの状態を読み込めませんでした: {error}",
  },
  ko: {
    defaultOpenTitle: "기본 열기 방식",
    defaultOpenDescription:
      "설치 버전에서는 EPUB과 PDF를 쿤펑 리더로 열 수 있습니다. 오른쪽 버튼으로 기본 앱을 설정하세요.",
    defaultOpenButton: "EPUB / PDF 기본 앱 설정",
    recoveryTitle: "복구 지점",
    recoveryLoading: "복구 지점 상태를 불러오는 중…",
    recoveryCreate: "지금 만들기",
    recoveryCreating: "만드는 중…",
    recoverySelected: "선택한 지점 복원",
    recoveryRestoring: "복원 중…",
    recoveryStatus:
      "복구 지점 {count}개를 보관 중({size}), 최근: {latest}. 매일 자동으로 만들며 최대 7개를 보관합니다.",
    recoveryEmpty:
      "복구 지점이 없습니다. 매일 자동으로 만들며 최대 7개를 보관합니다.",
    recoveryOption: "복구 지점 {created}({size})",
    recoverySelect: "복구 지점 선택",
    dataExport: "⬆ 데이터 패키지 내보내기",
    dataImport: "⬇ 데이터 패키지 가져오기",
    recoveryReadFailed: "복구 지점 상태를 읽지 못했습니다: {error}",
  },
  fr: {
    defaultOpenTitle: "Applications par défaut",
    defaultOpenDescription:
      "La version installée peut ouvrir les fichiers EPUB et PDF. Utilisez l’action à droite pour les définir par défaut.",
    defaultOpenButton: "Définir les valeurs EPUB / PDF",
    recoveryTitle: "Points de récupération",
    recoveryLoading: "Chargement de l’état des points de récupération…",
    recoveryCreate: "Créer maintenant",
    recoveryCreating: "Création…",
    recoverySelected: "Restaurer le point sélectionné",
    recoveryRestoring: "Restauration…",
    recoveryStatus:
      "{count} points de récupération conservés ({size}) ; dernier : {latest}. Un point est créé chaque jour, jusqu’à 7 conservés.",
    recoveryEmpty:
      "Aucun point de récupération. L’application en crée un chaque jour et en conserve jusqu’à 7.",
    recoveryOption: "Point de récupération {created} ({size})",
    recoverySelect: "Choisir un point de récupération",
    dataExport: "⬆ Exporter le paquet de données",
    dataImport: "⬇ Importer le paquet de données",
    recoveryReadFailed:
      "Impossible de lire l’état des points de récupération : {error}",
  },
  de: {
    defaultOpenTitle: "Standard-Apps",
    defaultOpenDescription:
      "Die installierte App kann EPUB- und PDF-Dateien öffnen. Legen Sie sie mit der Aktion rechts als Standard fest.",
    defaultOpenButton: "EPUB / PDF als Standard festlegen",
    recoveryTitle: "Wiederherstellungspunkte",
    recoveryLoading: "Wiederherstellungspunkte werden geladen…",
    recoveryCreate: "Jetzt erstellen",
    recoveryCreating: "Wird erstellt…",
    recoverySelected: "Ausgewählten Punkt wiederherstellen",
    recoveryRestoring: "Wird wiederhergestellt…",
    recoveryStatus:
      "{count} Wiederherstellungspunkte ({size}) gespeichert; letzter: {latest}. Täglich wird einer erstellt, maximal 7 werden behalten.",
    recoveryEmpty:
      "Noch keine Wiederherstellungspunkte. Die App erstellt täglich einen und behält maximal 7.",
    recoveryOption: "Wiederherstellungspunkt {created} ({size})",
    recoverySelect: "Wiederherstellungspunkt auswählen",
    dataExport: "⬆ Datenpaket exportieren",
    dataImport: "⬇ Datenpaket importieren",
    recoveryReadFailed:
      "Status der Wiederherstellungspunkte konnte nicht gelesen werden: {error}",
  },
  es: {
    defaultOpenTitle: "Aplicaciones predeterminadas",
    defaultOpenDescription:
      "La aplicación instalada puede abrir archivos EPUB y PDF. Use la acción de la derecha para establecerla como predeterminada.",
    defaultOpenButton: "Configurar EPUB / PDF predeterminados",
    recoveryTitle: "Puntos de recuperación",
    recoveryLoading: "Cargando el estado de los puntos de recuperación…",
    recoveryCreate: "Crear ahora",
    recoveryCreating: "Creando…",
    recoverySelected: "Restaurar el punto seleccionado",
    recoveryRestoring: "Restaurando…",
    recoveryStatus:
      "Se conservan {count} puntos de recuperación ({size}); último: {latest}. Se crea uno cada día, hasta un máximo de 7.",
    recoveryEmpty:
      "Aún no hay puntos de recuperación. La aplicación crea uno al día y conserva hasta 7.",
    recoveryOption: "Punto de recuperación {created} ({size})",
    recoverySelect: "Elegir un punto de recuperación",
    dataExport: "⬆ Exportar paquete de datos",
    dataImport: "⬇ Importar paquete de datos",
    recoveryReadFailed:
      "No se pudo leer el estado de los puntos de recuperación: {error}",
  },
  ru: {
    defaultOpenTitle: "Приложения по умолчанию",
    defaultOpenDescription:
      "Установленная версия может открывать EPUB и PDF. Настройте их кнопкой справа.",
    defaultOpenButton: "Настроить EPUB / PDF по умолчанию",
    recoveryTitle: "Точки восстановления",
    recoveryLoading: "Загрузка состояния точек восстановления…",
    recoveryCreate: "Создать сейчас",
    recoveryCreating: "Создание…",
    recoverySelected: "Восстановить выбранную точку",
    recoveryRestoring: "Восстановление…",
    recoveryStatus:
      "Сохранено точек восстановления: {count} ({size}); последняя: {latest}. Одна создаётся ежедневно, хранится не более 7.",
    recoveryEmpty:
      "Точек восстановления пока нет. Приложение создаёт одну ежедневно и хранит не более 7.",
    recoveryOption: "Точка восстановления {created} ({size})",
    recoverySelect: "Выбрать точку восстановления",
    dataExport: "⬆ Экспортировать пакет данных",
    dataImport: "⬇ Импортировать пакет данных",
    recoveryReadFailed:
      "Не удалось прочитать состояние точек восстановления: {error}",
  },
  "pt-BR": {
    defaultOpenTitle: "Aplicativos padrão",
    defaultOpenDescription:
      "A versão instalada pode abrir arquivos EPUB e PDF. Use a ação à direita para defini-los como padrão.",
    defaultOpenButton: "Definir padrões EPUB / PDF",
    recoveryTitle: "Pontos de recuperação",
    recoveryLoading: "Carregando o estado dos pontos de recuperação…",
    recoveryCreate: "Criar agora",
    recoveryCreating: "Criando…",
    recoverySelected: "Restaurar ponto selecionado",
    recoveryRestoring: "Restaurando…",
    recoveryStatus:
      "{count} pontos de recuperação mantidos ({size}); mais recente: {latest}. Um é criado diariamente, com até 7 mantidos.",
    recoveryEmpty:
      "Ainda não há pontos de recuperação. O aplicativo cria um por dia e mantém até 7.",
    recoveryOption: "Ponto de recuperação {created} ({size})",
    recoverySelect: "Escolher ponto de recuperação",
    dataExport: "⬆ Exportar pacote de dados",
    dataImport: "⬇ Importar pacote de dados",
    recoveryReadFailed:
      "Não foi possível ler o estado dos pontos de recuperação: {error}",
  },
};
