/**
 * src/lib/i18n.ts
 * ---------------------------------------------------------------
 * UI文言の日本語/英語切り替え。
 * ★ chrome.i18n（_locales/messages.json）は使わない。あれはブラウザのOS言語に
 *   自動追従する仕組みで、アプリ内で手動切り替えるこの用途には合わない。
 *   代わりに Settings.language を唯一の情報源にした素朴な辞書引きにする。
 * ★ 数字を含む文言（「返信3件」/「3 replies」）は文字列結合ではなく関数にする。
 *   語順が言語によって変わるため、テンプレート文字列の組み立て直しでは対応できない。
 * ---------------------------------------------------------------
 */

export type Language = "ja" | "en"

export interface Dictionary {
  // 接続バッジ
  badgeConnected: string
  badgeConnecting: string
  badgeRetrying: string
  badgeNoTab: string

  // ヘッダー / 検索
  searchPlaceholder: string
  clearSearch: string
  splitView: string
  splitHorizontal: string
  splitVertical: string
  back: string
  exitFullscreen: string
  enterFullscreen: string

  // no-tab案内
  noTabLine1: string
  noTabLine2: string

  // 見出しに付く件数表示（例: 「関連動画（12件）」/ "Related (12)"）
  countSuffix: (n: number) => string

  // 共通ラベル
  related: string
  comments: string
  queue: string
  notes: string
  diagnostics: string

  // 一覧の続き読み込み(PagingTail)
  pagingLoading: (label: string) => string
  pagingErrorFallback: (label: string) => string
  pagingRetry: string
  pagingEmpty: (label: string) => string
  pagingDone: (label: string, count: number) => string
  pagingAutoFirst: (label: string) => string
  pagingAutoMore: (label: string) => string

  titleLoading: string
  addToQueue: string

  // 再生パネル
  paused: string
  playing: string
  live: string
  seekBack10: string
  seekForward10: string
  play: string
  pause: string
  unmute: string
  mute: string
  playbackSpeed: string
  refresh: string

  // 次に再生
  queueEmptyHint: string

  // タイムスタンプメモ
  addNoteAtCurrentTime: string
  collapse: string
  expand: string
  addNoteAt: (time: string) => string
  notePlaceholder: string
  cancel: string
  save: string
  notesEmptyHint: string
  jumpToPosition: string
  deleteNote: string
  delete: string

  // コメント
  showFullscreen: string
  commentPlaceholder: string
  postButton: string
  posting: string
  like: string
  unlike: string
  replyCount: (n: number) => string
  replyAction: string
  replyPlaceholder: string
  repliesUnavailable: string
  replyPostedNoticeNoRefresh: string
  errCommMain: string
  errPostFailed: string
  errReplyFailed: string

  // 診断
  diagSummary: (v: number, ok: number, all: number, samples: number) => string
  diagHint: string
  copied: string
  copyResult: string
  diagRunning: string
  diagRun: string

  // 並べ替え等
  dragToReorder: string
  playAndRemoveFromQueue: string
  removeFromQueue: string
  playInMain: string

  // サイズ切り替え
  small: string
  medium: string
  large: string
  fontSizeLabel: (size: string) => string
  relatedSizeGroupLabel: string
  relatedSizeLabel: (size: string) => string

  // 設定画面(options.tsx)
  optionsTitle: string
  optionsAutoSaved: string
  optionsSavedBadge: string
  sectionPlayback: string
  defaultVolumeLabel: string
  defaultVolumeHint: string
  speedStepLabel: string
  speedStepHint: string
  sectionPopoutOpenClose: string
  autoOpenLabel: string
  autoOpenHint: string
  autoCloseLabel: string
  autoCloseHint: string
  sectionAutoplay: string
  autoPlayNextLabel: string
  autoPlayNextHint: string
  displaySizeLabel: string
  displaySizeHint: string
  feedMaxRowsLabel: string
  feedMaxRowsHint: string
  fontSizeSectionLabel: string
  fontSizeHint: string
  resetToDefaults: string
  sectionLanguage: string
  languageLabel: string
  languageHint: string
  languageJa: string
  languageEn: string

  // コメントの手動翻訳（DeepL）
  translateAction: string
  translating: string
  showOriginal: string
  translatedBy: (lang: string) => string
  translateErrNoKey: string
  translateErrInvalidKey: string
  translateErrQuota: string
  translateErrNetwork: string
  translateErrGeneric: string
  sectionTranslate: string
  deeplApiKeyLabel: string
  deeplApiKeyHint: string
  deeplApiKeyPlaceholder: string
  translateTargetLangLabel: string
  translateTargetLangHint: string
}

const ja: Dictionary = {
  badgeConnected: "接続中",
  badgeConnecting: "接続しています…",
  badgeRetrying: "再接続しています…",
  badgeNoTab: "YouTubeタブが未検出",

  searchPlaceholder: "YouTubeを検索",
  clearSearch: "検索欄をクリア",
  splitView: "関連動画とコメントを半々で表示",
  splitHorizontal: "左右に分割",
  splitVertical: "上下に分割",
  back: "戻る",
  exitFullscreen: "全画面を解除",
  enterFullscreen: "サブ画面を全画面にする",

  noTabLine1: "YouTubeの動画ページを開いてください。",
  noTabLine2: "検出すると自動で接続します。",

  countSuffix: (n) => `（${n}件）`,

  related: "関連動画",
  comments: "コメント",
  queue: "次に再生",
  notes: "タイムスタンプメモ",
  diagnostics: "セレクタ診断",

  pagingLoading: (label) => `${label}を読み込んでいます…`,
  pagingErrorFallback: (label) => `${label}を読み込めませんでした`,
  pagingRetry: "再試行",
  pagingEmpty: (label) => `取得できる${label}はありません`,
  pagingDone: (label, count) => `${label}を最後まで読み込みました（${count}件）`,
  pagingAutoFirst: (label) => `メイン画面を操作せず${label}を自動で読み込みます…`,
  pagingAutoMore: (label) => `下へ進むと${label}の続きを自動で読み込みます`,

  titleLoading: "（タイトルを読み込んでいます…）",
  addToQueue: "次に再生キューへ追加",

  paused: "一時停止中",
  playing: "再生中",
  live: "ライブ",
  seekBack10: "10秒戻す",
  seekForward10: "10秒進める",
  play: "再生",
  pause: "一時停止",
  unmute: "ミュート解除",
  mute: "ミュート",
  playbackSpeed: "再生速度",
  refresh: "更新する",

  queueEmptyHint: "関連動画の＋ボタンから追加できます",

  addNoteAtCurrentTime: "現在の再生位置にメモを追加",
  collapse: "折りたたむ",
  expand: "開く",
  addNoteAt: (time) => `${time} の位置にメモを追加`,
  notePlaceholder: "メモの内容（Enterで保存 / Escでキャンセル）",
  cancel: "キャンセル",
  save: "保存",
  notesEmptyHint: "再生中に＋ボタンでメモを追加できます",
  jumpToPosition: "この位置にジャンプ",
  deleteNote: "メモを削除",
  delete: "削除",

  showFullscreen: "画面いっぱいに表示",
  commentPlaceholder: "コメントを追加",
  postButton: "投稿",
  posting: "投稿中…",
  like: "いいね",
  unlike: "いいねを取り消す",
  replyCount: (n) => `返信 ${n}件`,
  replyAction: "返信する",
  replyPlaceholder: "返信を入力",
  repliesUnavailable: "返信を取得できませんでした",
  replyPostedNoticeNoRefresh: "返信を投稿しました（一覧の再取得はできませんでした）",
  errCommMain: "メイン画面と通信できませんでした。YouTubeタブを再読み込みしてください。",
  errPostFailed: "投稿できませんでした。メイン画面でログインしているか確認してください。",
  errReplyFailed: "返信できませんでした。メイン画面でログインしているか確認してください。",

  diagSummary: (v, ok, all, samples) =>
    `v${v} ・ ${ok} / ${all} 項目が見つかりました ・ DOM骨格 ${samples} 件`,
  diagHint: "YouTube側のDOM変更で壊れた箇所を特定します",
  copied: "コピーしました",
  copyResult: "結果をコピー",
  diagRunning: "診断中…",
  diagRun: "診断する",

  dragToReorder: "ドラッグして並べ替え",
  playAndRemoveFromQueue: "この動画を再生してキューから外す",
  removeFromQueue: "キューから削除",
  playInMain: "メイン画面でこの動画を再生",

  small: "小",
  medium: "中",
  large: "大",
  fontSizeLabel: (size) => `文字サイズ: ${size}`,
  relatedSizeGroupLabel: "関連動画の表示サイズ",
  relatedSizeLabel: (size) => `関連動画の表示サイズ: ${size}`,

  optionsTitle: "設定",
  optionsAutoSaved: "変更は自動的に保存されます",
  optionsSavedBadge: "保存しました",
  sectionPlayback: "再生",
  defaultVolumeLabel: "初期音量",
  defaultVolumeHint: "サブ画面を新規に開いたときの初期値（今後の機能で使用）",
  speedStepLabel: "速度の刻み幅",
  speedStepHint: "サブ画面の速度＋／－ボタンを押したときの増減量",
  sectionPopoutOpenClose: "サブ画面の開閉",
  autoOpenLabel: "YouTubeを開いたら自動でサブ画面を開く",
  autoOpenHint: "動画ページを開いたときに自動で起動します。既に開いている場合は前面化しません（視聴の邪魔をしないため）",
  autoCloseLabel: "YouTubeタブを閉じたらサブ画面も閉じる",
  autoCloseHint: "他にYouTubeタブが残っている場合は閉じません",
  sectionAutoplay: "自動再生",
  autoPlayNextLabel: "キューの自動連続再生",
  autoPlayNextHint: "動画が終わったら「次に再生」キューの先頭を自動的に再生します",
  displaySizeLabel: "表示サイズ",
  displaySizeHint: "サムネイル、タイトル、チャンネル名、行間をまとめて変更します",
  feedMaxRowsLabel: "ストリーミング最大保持件数",
  feedMaxRowsHint: "通常コメントは最後まで閲覧できるよう全件保持します。この上限は将来のライブチャットなど流れ続ける表示にだけ適用します",
  fontSizeSectionLabel: "文字サイズ",
  fontSizeHint: "サブ画面のコメント欄と同じ設定です",
  resetToDefaults: "既定値に戻す",
  sectionLanguage: "言語",
  languageLabel: "表示言語",
  languageHint: "サブ画面・設定画面の表示言語を切り替えます（YouTube側の表示言語には影響しません）",
  languageJa: "日本語",
  languageEn: "English",

  translateAction: "翻訳",
  translating: "翻訳中…",
  showOriginal: "元の文章を表示",
  translatedBy: (lang) => `${lang}から翻訳（DeepL）`,
  translateErrNoKey: "設定画面でDeepLのAPIキーを登録してください",
  translateErrInvalidKey: "APIキーが無効です。設定画面を確認してください",
  translateErrQuota: "DeepLの利用上限に達しました",
  translateErrNetwork: "通信エラーが発生しました",
  translateErrGeneric: "翻訳に失敗しました",
  sectionTranslate: "コメントの翻訳",
  deeplApiKeyLabel: "DeepL APIキー（無料枠）",
  deeplApiKeyHint: "コメントの「翻訳」ボタンを押したときだけ、そのコメント本文がDeepLへ送信されます。空欄なら翻訳機能は無効のままです。キーは https://www.deepl.com/ja/your-account/keys から無料で取得できます",
  deeplApiKeyPlaceholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx",
  translateTargetLangLabel: "翻訳先の言語",
  translateTargetLangHint: "コメントを翻訳するときの変換先言語です"
}

const en: Dictionary = {
  badgeConnected: "Connected",
  badgeConnecting: "Connecting…",
  badgeRetrying: "Reconnecting…",
  badgeNoTab: "No YouTube tab found",

  searchPlaceholder: "Search YouTube",
  clearSearch: "Clear search",
  splitView: "Split view: related videos + comments",
  splitHorizontal: "Split left/right",
  splitVertical: "Split top/bottom",
  back: "Back",
  exitFullscreen: "Exit fullscreen",
  enterFullscreen: "Make this window fullscreen",

  noTabLine1: "Open a YouTube video in another tab.",
  noTabLine2: "It will connect automatically once found.",

  countSuffix: (n) => ` (${n})`,

  related: "Related",
  comments: "Comments",
  queue: "Up next",
  notes: "Timestamp notes",
  diagnostics: "Selector diagnostics",

  pagingLoading: (label) => `Loading ${label}…`,
  pagingErrorFallback: (label) => `Couldn't load ${label}`,
  pagingRetry: "Retry",
  pagingEmpty: (label) => `No ${label} available`,
  pagingDone: (label, count) => `Loaded all ${label} (${count})`,
  pagingAutoFirst: (label) => `Loading ${label} automatically…`,
  pagingAutoMore: (label) => `Scroll down to load more ${label}`,

  titleLoading: "(Loading title…)",
  addToQueue: "Add to up-next queue",

  paused: "Paused",
  playing: "Playing",
  live: "Live",
  seekBack10: "Back 10 seconds",
  seekForward10: "Forward 10 seconds",
  play: "Play",
  pause: "Pause",
  unmute: "Unmute",
  mute: "Mute",
  playbackSpeed: "Speed",
  refresh: "Refresh",

  queueEmptyHint: "Add videos with the + button on a related video",

  addNoteAtCurrentTime: "Add a note at the current position",
  collapse: "Collapse",
  expand: "Expand",
  addNoteAt: (time) => `Add a note at ${time}`,
  notePlaceholder: "Note text (Enter to save / Esc to cancel)",
  cancel: "Cancel",
  save: "Save",
  notesEmptyHint: "Add a note while playing with the + button",
  jumpToPosition: "Jump to this position",
  deleteNote: "Delete note",
  delete: "Delete",

  showFullscreen: "Show fullscreen",
  commentPlaceholder: "Add a comment",
  postButton: "Post",
  posting: "Posting…",
  like: "Like",
  unlike: "Remove like",
  replyCount: (n) => `${n} ${n === 1 ? "reply" : "replies"}`,
  replyAction: "Reply",
  replyPlaceholder: "Add a reply",
  repliesUnavailable: "Couldn't load replies",
  replyPostedNoticeNoRefresh: "Reply posted (couldn't refresh the list)",
  errCommMain: "Couldn't reach the main tab. Try reloading the YouTube tab.",
  errPostFailed: "Couldn't post. Check that you're logged in on the main tab.",
  errReplyFailed: "Couldn't reply. Check that you're logged in on the main tab.",

  diagSummary: (v, ok, all, samples) =>
    `v${v} ・ ${ok} / ${all} checks passed ・ ${samples} DOM samples`,
  diagHint: "Finds what broke after a YouTube DOM change",
  copied: "Copied",
  copyResult: "Copy result",
  diagRunning: "Running…",
  diagRun: "Run diagnostics",

  dragToReorder: "Drag to reorder",
  playAndRemoveFromQueue: "Play this video and remove it from the queue",
  removeFromQueue: "Remove from queue",
  playInMain: "Play this video in the main tab",

  small: "S",
  medium: "M",
  large: "L",
  fontSizeLabel: (size) => `Font size: ${size}`,
  relatedSizeGroupLabel: "Related video card size",
  relatedSizeLabel: (size) => `Related video card size: ${size}`,

  optionsTitle: "Settings",
  optionsAutoSaved: "Changes save automatically",
  optionsSavedBadge: "Saved",
  sectionPlayback: "Playback",
  defaultVolumeLabel: "Default volume",
  defaultVolumeHint: "Initial value when the sub window opens (reserved for a future feature)",
  speedStepLabel: "Speed step",
  speedStepHint: "How much the +/- speed buttons change per press",
  sectionPopoutOpenClose: "Opening & closing",
  autoOpenLabel: "Automatically open the sub window when YouTube opens",
  autoOpenHint: "Launches automatically when a video page opens. Won't refocus it if it's already open, so it doesn't interrupt playback.",
  autoCloseLabel: "Close the sub window when the YouTube tab closes",
  autoCloseHint: "Won't close it if other YouTube tabs are still open",
  sectionAutoplay: "Autoplay",
  autoPlayNextLabel: "Autoplay the up-next queue",
  autoPlayNextHint: "When a video ends, automatically plays the top of the up-next queue",
  displaySizeLabel: "Card size",
  displaySizeHint: "Changes thumbnail, title, channel name, and line spacing together",
  feedMaxRowsLabel: "Max rows kept for streaming feeds",
  feedMaxRowsHint: "Regular comments are always kept in full so you can scroll back through all of them. This limit only applies to a future live-chat-style feed that keeps streaming in.",
  fontSizeSectionLabel: "Font size",
  fontSizeHint: "Same setting as the comment font size in the sub window",
  resetToDefaults: "Reset to defaults",
  sectionLanguage: "Language",
  languageLabel: "Display language",
  languageHint: "Switches the language of the sub window and this settings page (does not affect YouTube's own display language)",
  languageJa: "日本語",
  languageEn: "English",

  translateAction: "Translate",
  translating: "Translating…",
  showOriginal: "Show original",
  translatedBy: (lang) => `Translated from ${lang} (DeepL)`,
  translateErrNoKey: "Set a DeepL API key on the settings page first",
  translateErrInvalidKey: "Invalid API key. Check the settings page",
  translateErrQuota: "DeepL usage limit reached",
  translateErrNetwork: "A network error occurred",
  translateErrGeneric: "Translation failed",
  sectionTranslate: "Comment translation",
  deeplApiKeyLabel: "DeepL API key (free tier)",
  deeplApiKeyHint: "A comment's text is sent to DeepL only when you press its \"Translate\" button. Leave this blank to keep translation disabled. Get a free key at https://www.deepl.com/en/your-account/keys",
  deeplApiKeyPlaceholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx",
  translateTargetLangLabel: "Translate to",
  translateTargetLangHint: "The language comments are translated into"
}

const DICTIONARIES: Record<Language, Dictionary> = { ja, en }

export function isLanguage(value: unknown): value is Language {
  return value === "ja" || value === "en"
}

export function getDictionary(language: Language): Dictionary {
  return DICTIONARIES[language]
}
