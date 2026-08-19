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
}

export const DEFAULT_SETTINGS: Settings = {
  defaultVolume: 50,
  speedStep: 0.1,
  autoPlayNext: true,
  feedMaxRows: 300,
  autoOpenPopout: true,
  autoClosePopout: true
}

export interface QueueItem {
  id: string           // UUID（キュー内での一意キー。videoIdとは別）
  videoId: string
  title: string
  channelName: string
  thumbnailUrl: string
  duration: number     // 秒。取得不能時は 0
}

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
  parentId?: string    // 返信コメントの場合、親コメントのid（未定義ならトップレベル）
}

export type VideoKind = "video" | "live" | "archive" | "unknown"

export interface PlayerStatus {
  videoId: string | null
  title: string
  channelName: string
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
  // 展開済みならクリックせずそのまま読み出す（誤って畳んでしまわないため）
  COMMENT_LOAD_REPLIES: { req: { commentId: string }; res: { items: FeedItem[] } }
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
  splitRatio: "splitRatio"            // 分割ビューの片側の割合（0.2〜0.8）
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
