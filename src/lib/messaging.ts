/**
 * src/lib/messaging.ts
 * ---------------------------------------------------------------
 * 拡張機能内を飛び交うメッセージの「型の唯一の正解 (SSoT)」。
 * Content Script / Background / Popout の3者は必ずここだけを import する。
 * ---------------------------------------------------------------
 */

/* ============================================================
 * 1. ドメインモデル
 * ========================================================== */

export interface Settings {
  defaultVolume: number   // 0-100
  speedStep: number       // 倍速の刻み幅 例: 0.1
  autoPlayNext: boolean   // キューの自動連続再生
  feedMaxRows: number     // チャット保持上限（メモリリーク防止）
  autoOpenPopout: boolean // YouTubeの動画ページを開いたら自動でサブ画面を開く
  autoClosePopout: boolean // 対象のYouTubeタブが全部閉じられたらサブ画面も閉じる
  language: "ja" | "en"   // 拡張機能自体のUI言語（YouTube側の表示言語とは独立）
  deeplApiKey: string      // DeepL API（無料枠）のキー。空文字なら翻訳機能は無効
  translateTargetLang: string // コメント翻訳の翻訳先言語（DeepLの言語コード）
}

export const DEFAULT_SETTINGS: Settings = {
  defaultVolume: 50,
  speedStep: 0.1,
  autoPlayNext: true,
  feedMaxRows: 300,
  autoOpenPopout: true,
  autoClosePopout: true,
  language: "ja",
  deeplApiKey: "",
  translateTargetLang: "JA"
}

export interface QueueItem {
  id: string           // UUID（キュー内での一意キー。videoIdとは別）
  videoId: string
  title: string
  channelName: string
  thumbnailUrl: string
  duration: number     // 秒。取得不能時は 0
  // 関連動画カードのメタ行。YouTube の表示文言をそのまま持つ（"168万" / "12万 回視聴"、"5 か月前"）。
  // 言語・略記はメイン画面に追随する。取得できなければ省略（サブ画面はその項目を出さない）。
  viewCount?: string
  publishedAt?: string
}

/**
 * 返信を空で返したときの理由。診断用の短いコードで、Popout がそのまま画面に出す。
 * - not-found:       指定idのコメントが現在のコメント欄に見つからない（親を展開し直しても）
 * - no-reply-thread: 見つかったが自身の返信欄を持たない（旧UIの包まれていない返信）
 * - no-toggle:       展開ボタンが見つからず、返信も現れなかった
 * - timeout:         展開したが、待ち時間内に返信が現れなかった（YouTube側の遅延）
 */
export type ReplyLoadFailure = "not-found" | "no-reply-thread" | "no-toggle" | "timeout"

export interface TimestampNote {
  id: string
  videoId: string
  timestamp: number    // 秒
  content: string
  createdAt: number    // Unix ms
}

/**
 * チャット絵文字は <img> 要素で表現される。
 * HTML文字列のまま渡すとXSS経路になるため、必ずトークン列に分解して受け渡す。
 */
export type RichToken =
  | { t: "text"; v: string }
  | { t: "emoji"; url: string; alt: string }
  // コメント中のリンク。hrefはCS側で実URLへ正規化済み（http/httpsのみ）。
  // ★ 表示テキスト(v)は当てにできない。YouTubeは長いURLを「…」で省略して表示するため、
  //   テキストから組み立て直すと壊れたURLになる。必ずhrefを使うこと。
  | { t: "link"; href: string; v: string }
  // コメント中の「同じ動画」を指すタイムスタンプ（例: "1:23"）。
  // 別タブで開くのではなく、メイン画面の再生位置をここへ飛ばす。
  | { t: "timestamp"; seconds: number; v: string }

export type FeedKind = "comment" | "chat"

export interface FeedItem {
  id: string
  author: string
  avatarUrl: string
  tokens: RichToken[]  // 描画はこちらを使う
  text: string         // 検索・フォールバック用のプレーンテキスト
  publishedAt?: string
  badge?: "member" | "moderator" | "owner" | "verified"
  superChat?: { amount: string; bgColor: string }
  likeCount?: number   // 取得できなければ省略（表示側は"—"扱い）
  liked?: boolean      // メイン画面上での「いいね」状態
  replyCount?: number  // 0または未定義なら返信なし
  // ★ 「返信はあるが件数が読めない」。入れ子の返信のトグルは「返信を表示」で**数字を持たない**
  //   （2026-11-08 実測）。件数だけを頼りにすると、その返信にはサブ画面でトグルが出ず、
  //   ユーザーは返信へ辿り着けない（報告「返信が表示されない」）。
  hasReplies?: boolean
  parentId?: string    // 返信コメントの場合、親コメントのid（未定義ならトップレベル）
  // 固定コメントの帯。YouTube側の文言をそのまま入れる（例: "@channel さんによって固定されています"）
  pinnedLabel?: string
}

export type VideoKind = "video" | "live" | "archive" | "unknown"

/** メイン画面の動画に対する自分の評価。DOM（評価ボタンの aria-pressed）が正。 */
export interface VideoRating {
  liked: boolean
  disliked: boolean
  // 高評価の件数。YouTube の表示文言のまま（"1.2万" / "12K"）。件数を非公開にしている動画では省略
  likeCount?: string
}

export type VideoRatingAction = "like" | "dislike"

/** 動画の投稿チャンネル。登録ボタンが見つからなければ status の channel ごと null になる。 */
export interface ChannelState {
  subscribed: boolean
}

/**
 * メイン画面のサイドバー（YouTubeの呼称は guide）の1項目。
 *
 * ★ URLは組み立てない。遷移はメイン画面の同じ項目をクリックして YouTube 自身にさせる
 *   （「ショート」のように href を持たない項目があり、URL方式では再現できないため）。
 *   `href` は同じ項目を見つけ直すための目印として持つ。表示には使わない。
 * ★ `iconPath` は YouTube のアイコン `<svg>` の中にある `<path d>` の値だけ。
 *   HTMLは持ち込まない（D-15と同じ理由）。受け取り側は自前の `<svg>` に `d` として渡す。
 */
/**
 * コメントの並び替えの選択肢。文言はYouTubeの表示をそのまま運ぶ（自前で訳さない）。
 * ★ 選択状態は aria-selected 由来で、表示言語に依存しない。
 */
export interface CommentSortOption {
  /** 位置由来の安定キー（"o0" など）。ズレたときは label で引き直す */
  id: string
  label: string
  /** 「注目のコメントを表示」などの説明。無ければ空 */
  hint: string
  selected: boolean
}
export interface CommentSortState {
  available: boolean
  options: CommentSortOption[]
}
export const EMPTY_COMMENT_SORT: CommentSortState = { available: false, options: [] }

export interface GuideEntry {
  id: string          // 位置ベースの目印 "s1:e4"。ズレたときは href / title で引き直す
  title: string       // YouTubeの表示文言のまま
  href: string        // 空のことがある（「ショート」「もっと見る」等）
  avatarUrl: string   // チャンネルの項目だけ。読み込み前は空
  iconPath: string    // SVGのパスデータ。取れなければ空
}

export interface GuideSection {
  title: string       // 見出しの無い区切りもある（空文字）
  entries: GuideEntry[]
}

/** available=false はサイドバーをまだ組み立てられていない（メイン画面側の事情） */
export interface GuideState {
  available: boolean
  sections: GuideSection[]
}

export const EMPTY_GUIDE: GuideState = { available: false, sections: [] }

export interface PlayerStatus {
  videoId: string | null
  title: string
  channelName: string
  channelAvatarUrl: string   // チャンネルのアイコン。読み込み前は空
  channelSubscribers: string // 登録者数。YouTube の表示文言のまま。非公開なら空
  rating: VideoRating | null // 評価ボタンが見つからなければ null（サブ画面は評価ボタンを出さない）
  channel: ChannelState | null // 登録ボタンが見つからなければ null（サブ画面は登録ボタンを出さない）
  currentTime: number
  duration: number
  volume: number       // 0-100（HTMLVideoElement の 0-1 から変換済み）
  muted: boolean
  playbackRate: number
  paused: boolean
  ended: boolean        // キューの自動連続再生のトリガーに使う
  kind: VideoKind
  sampledAt: number    // 取得時刻。サブ画面側の外挿(補間)に使う
}

export type PlayerCommand =
  | { command: "play" }
  | { command: "pause" }
  | { command: "toggle" }
  | { command: "volume"; value: number }   // 0-100
  | { command: "mute"; value: boolean }
  | { command: "seek"; value: number }     // 絶対秒
  | { command: "seekBy"; value: number }   // 相対秒 (+/-)
  | { command: "speed"; value: number }    // 絶対倍率
  | { command: "speedBy"; value: number }  // 相対（speedStep 単位）
  | { command: "fullscreen" }

/* ============================================================
 * 2. Request / Response 契約
 *    受け手が Content Script か Service Worker かを明示する。
 * ========================================================== */

import type { DiagnoseReport } from "~lib/selectors"

export type Contract = {
  /* --- 受け手: Content Script --- */
  PLAYER_GET_STATUS:  { req: void;                    res: PlayerStatus }
  PLAYER_COMMAND:     { req: PlayerCommand;           res: PlayerStatus }
  DOM_FETCH_RELATED:  { req: void;                    res: QueueItem[] }
  DOM_FETCH_FEED:     { req: { limit?: number };      res: { kind: FeedKind; items: FeedItem[] } }
  NAVIGATE_SEARCH:    { req: { query: string };       res: { ok: true } }
  NAVIGATE_TO_VIDEO:  { req: { videoId: string; startSeconds?: number }; res: { ok: true } }
  // コメントのいいねをトグルする。メイン画面のボタンを実際にクリックして結果を読み戻すため、
  // 楽観的更新はPopout側で行わずCSからの返り値を正とする（YouTube側のレート制限等で
  // 反映されない場合も、見た目と実態が食い違わないようにするため）
  COMMENT_TOGGLE_LIKE: { req: { commentId: string };  res: { liked: boolean; likeCount?: number } }
  // 返信欄を開く。メイン画面でまだ展開されていなければクリックして展開させ、
  // 展開済みならクリックせずそのまま読み出す（誤って畳んでしまわないため）。
  // ★ 空で返すときは reason を添える。Popout は「返信を取得できませんでした（timeout）」の
  //   ように表示し、次にクリックされたら再取得する（空を最終結果として記憶しない）。
  // ★ prefetch: true は「サブ画面で行が見えたので先回りして準備する」要求。CS側は先読みを
  //   1件ずつ直列に処理し（並走すると continuation の nudge が祖先スタイルを取り合う）、
  //   ユーザーのクリック（prefetch なし）は待たずに即実行、同じidが処理中なら結果を共有する。
  // ★ ancestors は「この返信にたどり着くまでに開く必要がある親」を外側から順に並べたもの。
  //   返信はメイン画面で親が展開されている間しかDOMに無く、メイン画面が読み込み直されると
  //   消える。サブ画面は返信の行を持ち続けるため、これが無いと以後ずっと not-found になる
  //   （2026-11-08 ユーザー報告「返信が表示されない」）。トップレベルのコメントでは空。
  COMMENT_LOAD_REPLIES: {
    req: { commentId: string; ancestors?: string[]; prefetch?: boolean }
    res: { items: FeedItem[]; reason?: ReplyLoadFailure }
  }
  // 新規コメントの投稿。成功すればコメント本体の自動監視(FEED_APPEND)が
  // 自然に新着として拾うため、ここでは成否だけ返す。
  // ★ videoId は「この下書きを書いた動画」。メイン画面はいま開いている動画と突き合わせ、
  //   違えば投稿しない。これが無いと、下書きを書いたあとに動画が変わった場合
  //   （サブ画面から関連動画を選ぶ・キューの自動送り・メイン画面側の自動再生）、
  //   CS側は「いま開いている動画」へそのまま公開投稿してしまう。
  //   公開・取り消し不能な操作なので、取り違えは絶対に起こさない。
  COMMENT_POST: {
    req: { text: string; videoId: string }
    res: { ok: boolean; reason?: "video-changed" }
  }
  // 返信の投稿。返信は自動監視の対象外（COMMENT_LOAD_REPLIESと同じくオンデマンド取得）
  // なので、投稿後の最新の返信一覧をこちらから返してPopout側の状態を更新させる。
  COMMENT_REPLY: { req: { commentId: string; text: string }; res: { ok: boolean; items: FeedItem[] } }
  // 動画の高評価/低評価をトグルする。COMMENT_TOGGLE_LIKE と同じくメイン画面のボタンを押して読み戻す。
  // applied: false は押しても状態が変わらなかった（未ログインでログイン案内が出た等）。
  VIDEO_RATE: { req: { action: VideoRatingAction }; res: { rating: VideoRating | null; applied: boolean } }
  // チャンネル登録。★解除は扱わない。登録済みのボタンを押すと YouTube は「登録を解除」を含む
  // メニューを開くため、サブ画面からの要求では登録済みのボタンを絶対に押さない。
  CHANNEL_SUBSCRIBE: { req: void; res: { channel: ChannelState | null; applied: boolean } }
  // サイドバーの中身を読む。まだ組み立てられていなければ、メイン画面のドロワーを
  // 見えないように一度だけ開いて組み立てさせる（時間がかかるので非同期）。
  DOM_FETCH_GUIDE: { req: void; res: GuideState }
  // コメントの並び替え。取得と切り替え。
  // ★ 切り替えるとYouTubeは**同じスレッド要素を使い回して中身だけ書き換える**
  //   （2026-11-09 実測: 旧要素20件がDOMに残り、idも18件が重複）。既読集合を抱えたまま
  //   だと新しい順序を取り込めないため、CS側は動画が変わったときと同じく feed を作り直す。
  DOM_FETCH_COMMENT_SORT: { req: void; res: CommentSortState }
  COMMENT_SORT_SELECT: {
    req: { id: string; label: string }
    res: { ok: boolean; sort: CommentSortState }
  }
  // サイドバーの項目を押す。遷移も「もっと見る」の展開も YouTube 自身にさせるので、
  // 押した後の一覧を読み直して一緒に返す（サブ画面はそれで描き直す）。
  GUIDE_ACTIVATE: {
    req: { id: string; title: string; href: string }
    res: { ok: boolean; guide: GuideState }
  }
  DIAGNOSE_SELECTORS: { req: void;                    res: DiagnoseReport }

  /* --- 受け手: Service Worker --- */
  OPEN_POPOUT:        { req: void;                    res: { windowId: number } }
  GET_TARGET_TAB:     { req: void;                    res: { tabId: number | null } }
  SET_TARGET_TAB:     { req: { tabId: number };       res: { ok: true } }
}

export type Action = keyof Contract
export type Req<A extends Action> = Contract[A]["req"]
export type Res<A extends Action> = Contract[A]["res"]

export interface Envelope<A extends Action = Action> {
  action: A
  payload: Req<A>
}

/** 境界の外に例外を投げないための結果型（sendMessage は throw しやすい） */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * 失敗側への絞り込み用ガード。
 *
 * プロジェクト側は `strict: true` を明示しているが、通信境界の失敗側を
 * 呼び出し側で読みやすく、確実に絞り込むため型ガードを残す。
 */
export function isErr<T>(r: Result<T>): r is { ok: false; error: string } {
  return !r.ok
}

/* ============================================================
 * 3. 常時接続 Port（Popout ⇄ Content Script 直結の本線）
 * ========================================================== */

/**
 * セレクタ診断の結果型。実体は selectors.ts にあるが、
 * メッセージの戻り値である以上、型のSSoTであるこのファイルから参照できる必要がある。
 */
export type { DiagnoseDetail, DiagnoseReport } from "~lib/selectors"

export const PORT_PLAYER = "yt-dualview:player" as const

/** 再生位置の同期間隔。250ms = 4Hz。これ以上速くしても人間には見えない */
export const STATUS_INTERVAL_MS = 250

export type PageKind = "comment" | "related"
export type PagePhase = "idle" | "loading" | "done" | "error"

/** DOM continuation の進行状態。Popout側の自動ページングと再試行UIに使う。 */
export interface PageState {
  kind: PageKind
  phase: PagePhase
  loaded: number
  hasMore: boolean
  error?: string
  // 0件で確定したとき、YouTube 側が一覧に出している理由の文言（「コメントはオフになっています。」等）。
  // 言語はメイン画面に追随する。無ければサブ画面は汎用の「取得できる◯◯はありません」を出す。
  message?: string
}

export const RELATED_DISPLAY_SIZES = ["sm", "md", "lg"] as const
export type RelatedDisplaySize = typeof RELATED_DISPLAY_SIZES[number]
export const DEFAULT_RELATED_DISPLAY_SIZE: RelatedDisplaySize = "md"

export function isRelatedDisplaySize(value: unknown): value is RelatedDisplaySize {
  return typeof value === "string" &&
    (RELATED_DISPLAY_SIZES as readonly string[]).includes(value)
}

/** Content Script → Popout */
export type StreamEvent =
  | { type: "STATUS";        payload: PlayerStatus }
  | { type: "FEED_APPEND";   payload: { kind: FeedKind; items: FeedItem[] } }
  // 返信のアイコンが後から埋まったときの送り直し。返信はサブ画面の行の中に保持されていて
  // 一覧(feed)には無いため、FEED_APPEND で送ると通常コメントとして追加されてしまう。
  // items は parentId を持つ返信。Popout は id → avatarUrl の表として持ち、描画時に補う。
  | { type: "REPLY_AVATAR";  payload: { items: FeedItem[] } }
  | { type: "FEED_RESET";    payload: { kind: FeedKind } }
  | { type: "RELATED";       payload: QueueItem[] }
  | { type: "PAGE_STATE";    payload: PageState }
  | { type: "VIDEO_CHANGED"; payload: { videoId: string | null; kind: VideoKind } }

/** Popout → Content Script */
export type StreamCommand =
  | { type: "COMMAND";             payload: PlayerCommand }
  | { type: "REQUEST_RELATED" }
  // サブ画面のコメント一覧を最下部までスクロールしたとき、次のバッチの読み込みを促す
  | { type: "REQUEST_MORE_FEED" }
  // サブ画面の関連動画一覧を最下部までスクロールしたとき、次の推薦バッチを読み込む
  | { type: "REQUEST_MORE_RELATED" }
  | { type: "SET_FEED_STREAMING";  payload: boolean } // 非表示時に監視を止めて負荷を下げる

/* ============================================================
 * 4. ストレージキー
 *    session は SW 再起動をまたいで生存し、ブラウザ終了で消える。
 * ========================================================== */

export const SESSION_KEYS = {
  targetTabId: "targetTabId",
  popoutWindowId: "popoutWindowId"
} as const

export const LOCAL_KEYS = {
  settings: "settings",
  queue: "queue",
  notes: "notes",              // Record<videoId, TimestampNote[]>
  popoutBounds: "popoutBounds", // サブモニターでのウィンドウ位置を記憶
  commentFontSize: "commentFontSize", // コメント欄の文字サイズ設定（Popout単独の見た目設定）
  relatedDisplaySize: "relatedDisplaySize", // 関連動画カード（サムネ・文字・行間）の表示サイズ
  splitHorizontal: "splitHorizontal", // 分割ビューを左右(true)にするか上下(false)にするか
  splitRatio: "splitRatio",           // 分割ビューの片側の割合（0.2〜0.8）
  guideOpen: "guideOpen"              // サブ画面のサイドバーを開いているか

} as const

/* ============================================================
 * 5. 送受信ヘルパー
 * ========================================================== */

/** Popout → Content Script（対象タブIDが必要） */
export async function askContent<A extends Action>(
  tabId: number,
  action: A,
  payload: Req<A>
): Promise<Result<Res<A>>> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action, payload } as Envelope<A>)
    return (res as Result<Res<A>>) ?? { ok: false, error: "NO_RESPONSE" }
  } catch (e) {
    // CS未注入・タブ閉鎖時はここに来る。呼び出し側で再接続を促す。
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Popout / Content Script → Service Worker */
export async function askBackground<A extends Action>(
  action: A,
  payload: Req<A>
): Promise<Result<Res<A>>> {
  try {
    const res = await chrome.runtime.sendMessage({ action, payload } as Envelope<A>)
    return (res as Result<Res<A>>) ?? { ok: false, error: "NO_RESPONSE" }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

type HandlerMap = {
  [A in Action]?: (payload: Req<A>, sender: chrome.runtime.MessageSender) => Res<A> | Promise<Res<A>>
}

/**
 * 受け手側（CS / SW）のハンドラ登録。
 * ★ 非同期応答するには listener が同期的に true を返す必要がある。
 *   ここを忘れると sendResponse 前にチャネルが閉じ、呼び出し側が undefined を受ける。
 */
export function registerHandlers(handlers: HandlerMap): void {
  chrome.runtime.onMessage.addListener(
    (msg: Envelope, sender, sendResponse: (r: Result<unknown>) => void) => {
      const handler = handlers[msg.action] as
        | ((p: unknown, s: chrome.runtime.MessageSender) => unknown)
        | undefined
      if (!handler) return false // 自分宛でなければ他のリスナーに委ねる

      Promise.resolve(handler(msg.payload, sender))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
        )
      return true
    }
  )
}
