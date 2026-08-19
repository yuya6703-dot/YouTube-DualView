/**
 * src/contents/youtube-main.ts — Content Script（親ページ）
 * 親YouTubeページのプレイヤー操作、関連動画、通常コメント同期を担当する。
 *
 * ★ 再生ステータス配信にsetIntervalは使わず、video event駆動にする。
 *   1秒intervalはPort接続中のSPA DOM再バインド保険にだけ使う。
 */
import type { PlasmoCSConfig } from "plasmo"
import {
  PORT_PLAYER,
  STATUS_INTERVAL_MS,
  registerHandlers,
  type PlayerCommand,
  type FeedItem,
  type PageKind,
  type PageState,
  type PlayerStatus,
  type QueueItem,
  type StreamCommand,
  type StreamEvent,
  type VideoKind
} from "~lib/messaging"
import {
  DIAGNOSE_VERSION,
  SELECTORS,
  parseClockDuration,
  q,
  qa,
  text,
  toTokens,
  diagnoseDetail,
  sampleOutlines,
  exposeDevHelpers
} from "~lib/selectors"

export const config: PlasmoCSConfig = {
  matches: ["https://www.youtube.com/*"],
  all_frames: false, // ライブチャットは現在の対象外。親ページだけに限定する
  run_at: "document_idle"
}

/* ============ 状態 ============ */
const ports = new Set<chrome.runtime.Port>()
let boundVideo: HTMLVideoElement | null = null
let lastPushAt = 0
let lastVideoId: string | null = null
let navigationCommandGeneration = 0

const getVideo = () => q<HTMLVideoElement>(SELECTORS.player.video)
const getVideoId = () => new URLSearchParams(location.search).get("v")

function getKind(): VideoKind {
  if (!getVideoId()) return "unknown"
  // Phase 1 で archive 判定を精緻化する
  return q(SELECTORS.player.liveBadge) ? "live" : "video"
}

function buildStatus(): PlayerStatus {
  const v = getVideo()
  return {
    videoId: getVideoId(),
    title: text(SELECTORS.meta.title),
    channelName: text(SELECTORS.meta.channel),
    currentTime: v?.currentTime ?? 0,
    // ライブ配信では duration が Infinity になるため 0 に潰す
    duration: v && Number.isFinite(v.duration) ? v.duration : 0,
    volume: v ? Math.round(v.volume * 100) : 0,
    muted: v?.muted ?? false,
    playbackRate: v?.playbackRate ?? 1,
    paused: v?.paused ?? true,
    ended: v?.ended ?? false,
    kind: getKind(),
    sampledAt: Date.now() // Popout側の外挿(補間)用
  }
}

function emit(ev: StreamEvent) {
  for (const p of ports) {
    try {
      p.postMessage(ev)
    } catch {
      ports.delete(p) // 切断済み
    }
  }
  if (ports.size === 0) {
    stopWatchPageObservers()
    unbindVideo()
  }
}

const initialPageState = (kind: PageKind): PageState => ({
  kind,
  phase: "idle",
  loaded: 0,
  hasMore: true
})

let commentPageState = initialPageState("comment")
let relatedPageState = initialPageState("related")
// YouTubeが過去DOMを仮想化・再生成しても、同じ動画で取得済みの全件をPopoutへ再水和できるよう保持する。
let commentItemCache = new Map<string, FeedItem>()
let relatedItemCache = new Map<string, QueueItem>()
let relatedPaginationEstablished = false

function resetVideoCaches() {
  commentItemCache = new Map()
  relatedItemCache = new Map()
  relatedPaginationEstablished = false
}

function getPageState(kind: PageKind): PageState {
  return kind === "comment" ? commentPageState : relatedPageState
}

function updatePageState(next: PageState) {
  if (next.kind === "comment") commentPageState = next
  else relatedPageState = next
  emit({ type: "PAGE_STATE", payload: next })
}

function makePageState(
  kind: PageKind,
  phase: PageState["phase"],
  loaded: number,
  hasMore: boolean,
  error?: string
): PageState {
  return { kind, phase, loaded, hasMore, ...(error ? { error } : {}) }
}

const pushStatus = () => {
  if (ports.size === 0) return
  emit({ type: "STATUS", payload: buildStatus() })
}

/* ============ <video> イベント購読 ============ */

const IMMEDIATE_EVENTS = [
  "play", "pause", "volumechange", "ratechange",
  "seeked", "loadedmetadata", "durationchange", "emptied", "ended"
] as const

function onTimeUpdate() {
  const now = performance.now()
  if (now - lastPushAt < STATUS_INTERVAL_MS) return // 250msスロットル
  lastPushAt = now
  pushStatus()
}

function onImmediate() {
  lastPushAt = performance.now()
  pushStatus()
}

/** SPA遷移で <video> が差し替わる場合に備え、都度バインドし直す */
function bindVideo() {
  if (ports.size === 0) return
  const v = getVideo()
  if (!v || v === boundVideo) return
  if (boundVideo) {
    boundVideo.removeEventListener("timeupdate", onTimeUpdate)
    IMMEDIATE_EVENTS.forEach((e) => boundVideo!.removeEventListener(e, onImmediate))
  }
  boundVideo = v
  v.addEventListener("timeupdate", onTimeUpdate)
  IMMEDIATE_EVENTS.forEach((e) => v.addEventListener(e, onImmediate))
  pushStatus()
}

function unbindVideo() {
  if (!boundVideo) return
  boundVideo.removeEventListener("timeupdate", onTimeUpdate)
  IMMEDIATE_EVENTS.forEach((e) => boundVideo!.removeEventListener(e, onImmediate))
  boundVideo = null
}

/** YouTube は History API 遷移。ページリロードは発生しない */
function onNavigated() {
  const id = getVideoId()
  if (id === lastVideoId) return
  if (ports.size === 0) {
    resetVideoCaches()
    lastVideoId = id
    navigationStartCommentSnapshot = null
    stopWatchPageObservers()
    return
  }
  const previousVideoId = lastVideoId
  const staleCommentEls = previousVideoId === null
    ? []
    : navigationStartCommentSnapshot?.videoId === previousVideoId
      ? navigationStartCommentSnapshot.elements
      // yt-navigate-startを取りこぼした場合は、permalinkの動画IDが現URLと異なる要素だけを旧DOMとする。
      : commentContainerEl && document.contains(commentContainerEl)
        ? qa(SELECTORS.comments.thread, commentContainerEl)
            .filter((el) => !belongsToCurrentVideo(el))
        : []
  navigationStartCommentSnapshot = null
  lastVideoId = id
  relatedLoadRun += 1
  relatedLoading = false
  commentLoadRun += 1
  commentLoading = false
  relatedPageState = initialPageState("related")
  commentPageState = initialPageState("comment")
  resetVideoCaches()
  bindVideo()
  emit({ type: "VIDEO_CHANGED", payload: { videoId: id, kind: getKind() } })
  // ライブチャットstreamは未実装のため、親ページ側feedは常にcommentとして扱う。
  emit({ type: "FEED_RESET", payload: { kind: "comment" } })
  emit({ type: "PAGE_STATE", payload: relatedPageState })
  emit({ type: "PAGE_STATE", payload: commentPageState })
  // 同じvideo要素が再利用され、media eventがナビゲーションより先に済んでいても
  // PopoutをVIDEO_CHANGED後のnull状態に残さない。
  pushStatus()
  if (id) {
    watchRelated() // 動画が変わるたびに関連動画欄を監視し直す（自動取得）
    // 初回フルロードには混入し得る「前動画」がないため、既存コメントを待たずに配信する。
    // 実在するwatch動画から別のwatch動画へSPA遷移した場合だけ、古いDOMの消滅を待つ。
    watchComments(true, previousVideoId !== null, staleCommentEls)
  } else {
    stopWatchPageObservers()
  }
}

document.addEventListener("yt-navigate-finish", onNavigated)
document.addEventListener("yt-navigate-start", capturePreNavigationComments)
// yt-navigate-finish が来ないケース（初回・戻る）の保険。1秒間隔なのでスロットル影響は無視できる
setInterval(() => {
  if (ports.size === 0) return
  bindVideo()
  onNavigated()
  // ★ 監視対象がページから切り離されていたら張り直す。
  //   YouTubeがSPA遷移でコンテナ要素ごと差し替えると、MutationObserverは
  //   detachedな古い要素を見続けて沈黙し、前の動画の情報が残り続ける。
  //   初回探索時点でまだ要素が生成されていない場合も、watchページにいる間は
  //   nullを再探索する。検索結果ページ等では不要な探索を繰り返さない。
  if (location.pathname === "/watch" && getVideoId()) {
    if (!relatedContainerEl || !document.contains(relatedContainerEl)) watchRelated()
    if (!commentContainerEl || !document.contains(commentContainerEl)) watchComments(false)
    else {
      reviveCommentPagingIfAvailable()
      if (currentCommentThreads().length === 0 && getPageState("comment").phase === "idle") {
        loadMoreComments()
      }
    }
  }
}, 1000)

/* ============ 関連動画パーサー ============ */

const RELATED_IMAGE_ATTRIBUTES = [
  "src", "srcset", "data-src", "data-srcset",
  "data-lazy-src", "data-thumb", "data-thumbnail-url"
] as const

// YouTubeはカードの骨格を先に置き、リンク・タイトル・画像を別々に後挿入する。
// 画像だけでなくタイトルの遅延ハイドレーションも再取得の契機にする。
const RELATED_OBSERVED_ATTRIBUTES = [
  ...RELATED_IMAGE_ATTRIBUTES,
  "href", "title", "aria-label", "alt", "data-title"
] as const

function normalizeRelatedThumbnailUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim().replace(/^['"]|['"]$/g, "")
  if (!value) return null
  try {
    const url = new URL(value, location.href)
    const host = url.hostname.toLowerCase()
    const isYouTubeImageHost =
      host === "ytimg.com" ||
      host.endsWith(".ytimg.com") ||
      host === "img.youtube.com"
    return url.protocol === "https:" && isYouTubeImageHost ? url.href : null
  } catch {
    return null
  }
}

/** srcsetから最大幅/最大倍率の候補を優先して返す。 */
function parseThumbnailSrcset(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((part, index) => {
      const [url = "", descriptor = ""] = part.trim().split(/\s+/, 2)
      const numeric = Number.parseFloat(descriptor)
      const score = Number.isFinite(numeric)
        ? numeric * (descriptor.endsWith("x") ? 10000 : 1)
        : index
      return { url, score }
    })
    .sort((a, b) => b.score - a.score)
    .map(({ url }) => url)
}

function extractRelatedThumbnail(el: Element): string {
  const img = q<HTMLImageElement>(SELECTORS.related.thumb, el)
  const sourceSrcsets = qa<HTMLSourceElement>(SELECTORS.related.thumbSource, el)
    .flatMap((source) => parseThumbnailSrcset(source.getAttribute("srcset")))
  const candidates = [
    img?.currentSrc,
    ...parseThumbnailSrcset(img?.getAttribute("srcset")),
    ...parseThumbnailSrcset(img?.getAttribute("data-srcset")),
    img?.getAttribute("src"),
    img?.getAttribute("data-src"),
    img?.getAttribute("data-lazy-src"),
    img?.getAttribute("data-thumb"),
    img?.getAttribute("data-thumbnail-url"),
    ...sourceSrcsets
  ]
  for (const candidate of candidates) {
    const normalized = normalizeRelatedThumbnailUrl(candidate)
    if (normalized) return normalized
  }
  return ""
}

const normalizeRelatedTitle = (raw: string | null | undefined): string => {
  const value = (raw ?? "").replace(/\s+/g, " ").trim()
  // ゼロ幅文字だけの遅延placeholderは空扱いするが、実タイトル中のZWJ等は保持する。
  const hasVisibleContent = value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().length > 0
  return hasVisibleContent ? value : ""
}

/**
 * q()/text()は「存在する最初の候補」を返すため、その要素がまだ空だと後続候補を試さない。
 * 関連カードだけは全タイトル候補を順に調べ、最初の非空値を採用する。
 */
function extractRelatedTitle(
  el: Element,
  videoId: string,
  videoLinks: readonly HTMLAnchorElement[]
): string {
  const readAttributes = (node: Element): string => {
    const candidates = [
      node.getAttribute("title"),
      node.getAttribute("aria-label"),
      node.getAttribute("data-title")
    ]
    for (const candidate of candidates) {
      const value = normalizeRelatedTitle(candidate)
      if (value) return value
    }
    return ""
  }

  const readElement = (node: Element): string => {
    return normalizeRelatedTitle(node.textContent) || readAttributes(node)
  }

  for (const selector of SELECTORS.related.title) {
    let nodes: NodeListOf<Element>
    try {
      nodes = el.querySelectorAll(selector)
    } catch {
      continue
    }
    for (const node of nodes) {
      const value = readElement(node)
      if (value) return value
    }
  }

  // 最初のwatchリンクはサムネイル用で属性が空のことがある。
  // 同じ動画IDを指すタイトルリンクを含め、カード内の全リンクを確認する。
  for (const link of videoLinks) {
    try {
      if (new URL(link.href, location.origin).searchParams.get("v") !== videoId) continue
    } catch {
      continue
    }
    // サムネイルリンクのtextContentには時間バッジだけが入るDOMがあるため、
    // 汎用リンクfallbackでは表示テキストをタイトルと推測せず、明示属性だけを見る。
    const value = readAttributes(link)
    if (value) return value
  }

  const thumbnail = q<HTMLImageElement>(SELECTORS.related.thumb, el)
  const finalCandidates = [
    thumbnail?.getAttribute("alt"),
    el.getAttribute("title"),
    el.getAttribute("aria-label"),
    el.getAttribute("data-title")
  ]
  for (const candidate of finalCandidates) {
    const value = normalizeRelatedTitle(candidate)
    if (value) return value
  }
  return ""
}

/** 新旧関連カードDOMが同じ一覧に混在しても、片方を丸ごと捨てずDOM順で返す。 */
function findRelatedItems(container: Element): Element[] {
  const unique = new Set<Element>()
  for (const selector of SELECTORS.related.item) {
    try {
      container.querySelectorAll(selector).forEach((item) => unique.add(item))
    } catch {
      // A/Bテスト用の候補が一時的に無効でも、残りの候補で継続する。
    }
  }
  return Array.from(unique).sort((a, b) => {
    const position = a.compareDocumentPosition(b)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
}

/**
 * 1件の関連動画要素から QueueItem を組み立てる。
 * 広告カードは /watch?v= を持たないため videoId が取れず、自然に除外される。
 */
function parseRelatedItem(el: Element): QueueItem | null {
  const videoLinks = qa<HTMLAnchorElement>(SELECTORS.related.link, el)
  const link = videoLinks[0]
  let videoId: string | null = null
  try {
    videoId = link ? new URL(link.href, location.origin).searchParams.get("v") : null
  } catch {
    return null
  }
  if (!videoId) return null

  return {
    // 同じ推薦を再送してもReact行を作り直さないよう、動画IDを安定キーにする。
    id: videoId,
    videoId,
    title: extractRelatedTitle(el, videoId, videoLinks),
    channelName: text(SELECTORS.related.channel, el),
    thumbnailUrl: extractRelatedThumbnail(el),
    duration: parseClockDuration(text(SELECTORS.related.duration, el))
  }
}

function fetchRelated(): QueueItem[] {
  // 同じカード要素が説明欄等に現れるA/Bテストでも、関連動画外を混ぜない。
  const container = relatedContainerEl && document.contains(relatedContainerEl)
    ? relatedContainerEl
    : q(SELECTORS.related.container)
  if (!container) return Array.from(relatedItemCache.values())
  for (const item of findRelatedItems(container).map(parseRelatedItem)) {
    if (!item) continue
    const existing = relatedItemCache.get(item.videoId)
    relatedItemCache.set(item.videoId, existing ? {
      ...existing,
      title: item.title || existing.title,
      channelName: item.channelName || existing.channelName,
      thumbnailUrl: item.thumbnailUrl || existing.thumbnailUrl,
      duration: item.duration || existing.duration
    } : item)
  }
  return Array.from(relatedItemCache.values())
}

/**
 * 関連動画欄を監視し、内容が変わるたびに自動でPopoutへ配信する。
 * YouTubeはSPA遷移のたびに関連動画DOMを非同期で埋めるため、
 * ナビゲーション直後の1回取得だけでは0件のことが多い。
 *
 * ★ 非機能要件どおりデバウンス必須。関連動画欄は1件ずつ非同期でサムネイルが
 *   差し込まれるため、無防備に監視すると数十msおきにパース処理が走ってしまう。
 */
let relatedObserver: MutationObserver | null = null
let relatedDebounceId: number | null = null
/**
 * ★ 監視中のコンテナ要素を保持する理由:
 *   YouTubeはSPA遷移で #related や #comments の要素自体を作り直すことがある。
 *   その場合 MutationObserver はページから切り離された古い要素を見続けることになり、
 *   以降の変化を一切検知できない（＝前の動画の情報が residual として残り続ける）。
 *   1秒間隔の保険ループで document.contains() を確認し、外れていたら張り直す。
 */
let relatedContainerEl: Element | null = null
let relatedLoadRun = 0
let relatedLoading = false

function findRelatedContinuation(container: Element | null = relatedContainerEl): HTMLElement | null {
  if (!container || !document.contains(container)) return null
  return q<HTMLElement>(SELECTORS.related.continuation, container)
}

function scheduleRelatedEmit() {
  if (relatedDebounceId !== null) window.clearTimeout(relatedDebounceId)
  relatedDebounceId = window.setTimeout(() => {
    relatedDebounceId = null
    const items = fetchRelated()
    // 同一動画内でコンテナが再構築され0件になった場合も、古い一覧を残さない。
    emit({ type: "RELATED", payload: items })
    if (!relatedLoading) {
      // 初回DOMではcontinuationが少し遅れて現れるため、absenceだけで即「完了」にしない。
      // 明示ローダーが複数回確認してdoneにした後だけ末尾として扱う。
      const hasMore =
        findRelatedContinuation() !== null ||
        items.length > relatedPageState.loaded ||
        relatedPageState.phase !== "done"
      updatePageState(makePageState("related", hasMore ? "idle" : "done", items.length, hasMore))
    }
  }, 400)
}

function watchRelated() {
  relatedObserver?.disconnect()
  if (relatedDebounceId !== null) {
    window.clearTimeout(relatedDebounceId)
    relatedDebounceId = null
  }
  const container = q(SELECTORS.related.container)
  relatedContainerEl = container
  if (!container) return // 検索結果ページ等、関連動画欄がないページでは何もしない
  relatedObserver = new MutationObserver(scheduleRelatedEmit)
  relatedObserver.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...RELATED_OBSERVED_ATTRIBUTES]
  })
  scheduleRelatedEmit() // 遷移前から既に埋まっている場合に備え、初回も一応スケジュールする
}

/** サブ画面の関連動画末尾から、YouTubeの次の推薦バッチを段階取得する。 */
function loadMoreRelated() {
  if (relatedLoading || ports.size === 0 || !getVideoId()) return

  relatedLoading = true
  const run = ++relatedLoadRun
  const beforeIds = new Set(fetchRelated().map((item) => item.videoId))
  let attempts = 0
  let lastActivatedTarget: HTMLElement | null = null
  let lastActivatedAt = 0
  let activatedContinuation = false
  const clickedContinuations = new WeakSet<HTMLElement>()
  updatePageState(makePageState("related", "loading", beforeIds.size, true))

  const finish = (phase: PageState["phase"], hasMore: boolean, error?: string) => {
    if (run !== relatedLoadRun) return
    relatedLoading = false
    const items = fetchRelated()
    emit({ type: "RELATED", payload: items })
    updatePageState(makePageState("related", phase, items.length, hasMore, error))
  }

  const tryOnce = () => {
    if (run !== relatedLoadRun || ports.size === 0 || !getVideoId()) {
      if (run === relatedLoadRun) relatedLoading = false
      return
    }

    const currentContainer = q(SELECTORS.related.container)
    if (currentContainer && currentContainer !== relatedContainerEl) watchRelated()
    const items = fetchRelated()
    if (items.some((item) => !beforeIds.has(item.videoId))) {
      if (activatedContinuation) relatedPaginationEstablished = true
      // カード追加より次continuationの挿入が遅いDOM世代があるため、増加直後は
      // absenceだけで末尾確定せず、次の要求で安定して不在かを再確認する。
      finish("idle", true)
      return
    }

    const continuation = findRelatedContinuation()
    if (attempts >= 8) {
      // continuationを一度も正常に進められていない動画では、セレクタ不一致と
      // 真の末尾を区別できない。「完了」と誤表示せず再試行可能なerrorにする。
      if (!continuation && items.length > 0 && relatedPaginationEstablished) finish("done", false)
      else finish("error", true, "関連動画の続きを読み込めませんでした。再試行してください。")
      return
    }
    attempts += 1

    const target = continuation ?? (
      items.length === 0
        ? (currentContainer ?? q<HTMLElement>(SELECTORS.related.activation))
        : null
    )
    if (!target) {
      window.setTimeout(tryOnce, 800)
      return
    }

    const now = Date.now()
    if (target === lastActivatedTarget && now - lastActivatedAt < 3000) {
      window.setTimeout(tryOnce, 800)
      return
    }
    lastActivatedTarget = target
    lastActivatedAt = now

    // 任意の親コンテナ内のボタンは絶対に押さない。既知のcontinuation host内にある
    // 専用ボタンだと確認できた場合だけ正規操作を使い、それ以外は交差刺激へ戻す。
    if (continuation) activatedContinuation = true
    if (
      continuation &&
      !clickedContinuations.has(continuation) &&
      clickContinuationControl(continuation, SELECTORS.related.continuationButton)
    ) {
      clickedContinuations.add(continuation)
      window.setTimeout(tryOnce, 1000)
    } else {
      // ボタンが存在してもprogrammatic clickで進まないA/B DOMでは、次回から交差刺激へ切り替える。
      nudgeIntoViewport(target, () => window.setTimeout(tryOnce, 1000), 700)
    }
  }

  tryOnce()
}

/* ============ コメント欄パーサー（自動監視） ============ */

/**
 * コメントは「関連動画欄」と違って壊れやすい前提が異なる:
 * 既に配信済みのスレッドを重複配信しないよう、要素単位で既読管理する。
 * ★ videoIdをまたいでも安全なよう、動画が変わるたびに watchComments() で作り直す。
 */
let seenCommentEls = new WeakSet<Element>()
let seenCommentIds = new Set<string>()
let commentObserver: MutationObserver | null = null
let commentDebounceId: number | null = null
let commentContainerEl: Element | null = null
let pendingCommentNavigation = false
let pendingFreshCommentWait = false
let pendingUnsafeCommentEls: Element[] = []
let unsafeCommentEls = new WeakSet<Element>()
let unsafeCommentIds = new Set<string>()
let navigationStartCommentSnapshot: { videoId: string | null; elements: Element[] } | null = null
/**
 * 動画切り替え直後、YouTubeが前の動画のコメントDOMをまだ消していない期間がある。
 * そのまま配信すると「前の動画のコメントが新着として流れてくる」状態になるため、
 * SPA遷移開始時に存在した要素だけを旧DOMとして識別し、それらは配信しない。
 */
let awaitingFreshComments = false
let awaitingSince = 0
const COMMENT_DEBOUNCE_MS = 400
const FRESH_COMMENTS_TIMEOUT_MS = 4000

/** SPA遷移開始時点の要素だけを「前動画のDOM」として記録する。 */
function capturePreNavigationComments() {
  if (ports.size === 0) {
    navigationStartCommentSnapshot = null
    return
  }
  const container = commentContainerEl && document.contains(commentContainerEl)
    ? commentContainerEl
    : q(SELECTORS.comments.section)
  navigationStartCommentSnapshot = {
    videoId: lastVideoId,
    elements: container ? qa(SELECTORS.comments.thread, container) : []
  }
}

/** 公開時刻リンクのlcは同一コメントでDOMが再生成されても変わらない。 */
function getStableCommentId(el: Element): string | null {
  const link = q<HTMLAnchorElement>(SELECTORS.comments.published, el)
  if (link) {
    try {
      const lc = new URL(link.getAttribute("href") ?? link.href, location.origin)
        .searchParams.get("lc")
      if (lc) return `lc:${lc}`
    } catch {
      // 下のDOM内容由来IDへフォールバックする。
    }
  }

  const domId = el.getAttribute("data-id") ?? el.id
  const author = text(SELECTORS.comments.author, el)
  const published = text(SELECTORS.comments.published, el)
  const body = text(SELECTORS.comments.body, el)
  if (!domId && !author && !published && !body) return null // skeletonはコメントとして識別しない
  const source = `${getVideoId() ?? ""}\u0000${domId}\u0000${author}\u0000${published}\u0000${body}`
  let hash = 2166136261
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `fallback:${(hash >>> 0).toString(36)}`
}

/** コメントのpermalinkが動画IDを持つ場合、SPA遷移中の旧動画コメントを確実に除外する。 */
function belongsToCurrentVideo(el: Element): boolean {
  const link = q<HTMLAnchorElement>(SELECTORS.comments.published, el)
  if (!link) return true // URLを持たないDOM世代では既存のunsafe判定に委ねる
  try {
    const linkedVideoId = new URL(link.getAttribute("href") ?? link.href, location.origin)
      .searchParams.get("v")
    return linkedVideoId === null || linkedVideoId === getVideoId()
  } catch {
    return true
  }
}

function isSeenComment(el: Element): boolean {
  const id = getStableCommentId(el)
  return id ? seenCommentIds.has(id) : seenCommentEls.has(el)
}

function markCommentSeen(el: Element) {
  const id = getStableCommentId(el)
  if (id) seenCommentIds.add(id)
  else seenCommentEls.add(el)
}

function isUnsafeComment(el: Element): boolean {
  const id = getStableCommentId(el)
  return id ? unsafeCommentIds.has(id) : unsafeCommentEls.has(el)
}

function markCommentUnsafe(el: Element) {
  const id = getStableCommentId(el)
  if (id) unsafeCommentIds.add(id)
  else unsafeCommentEls.add(el)
}

/**
 * 安定IDから現在のDOM要素を逆引きする。要素の参照自体は保持しない
 * （SPA遷移やDOM再生成で参照が容易にdetachするため、必要なときに毎回引き直す）。
 * トップレベルのスレッドと、既に展開済みの返信の両方を対象にする。
 */
function findCommentElementById(id: string): Element | null {
  const container = commentContainerEl && document.contains(commentContainerEl)
    ? commentContainerEl
    : q(SELECTORS.comments.section)
  if (!container) return null

  for (const el of qa(SELECTORS.comments.thread, container)) {
    if (getStableCommentId(el) === id) return el
  }
  for (const el of qa(SELECTORS.comments.replyItem, container)) {
    if (getStableCommentId(el) === id) return el
  }
  return null
}

/**
 * "1.2万" "3,400" のような日本語混じりの数値表示を概算のnumberに変換する。
 * 読めなければ undefined（"件数不明"として表示側が"—"を出す）。
 */
function parseApproxCount(raw: string): number | undefined {
  const s = raw.trim()
  if (!s) return undefined
  const m = s.match(/([\d,.]+)\s*(万|億)?/)
  const digits = m?.[1]
  if (!digits) return undefined
  const base = Number(digits.replace(/,/g, ""))
  if (Number.isNaN(base)) return undefined
  if (m[2] === "万") return Math.round(base * 10000)
  if (m[2] === "億") return Math.round(base * 100000000)
  return Math.round(base)
}

/** いいねボタンの押下状態を読む。トグル系ボタンは aria-pressed で表現されることが多い */
function readLikedState(likeButton: HTMLElement | null): boolean {
  if (!likeButton) return false
  return (
    likeButton.getAttribute("aria-pressed") === "true" ||
    likeButton.getAttribute("aria-checked") === "true" ||
    likeButton.classList.contains("style-default-active")
  )
}

function readLikeCount(el: Element): number | undefined {
  const btn = q<HTMLElement>(SELECTORS.comments.likeButton, el)
  const label = btn?.getAttribute("aria-label") ?? text(SELECTORS.comments.likeButton, el)
  if (!label) return undefined
  return parseApproxCount(label)
}

function readReplyCount(el: Element): number | undefined {
  const raw = text(SELECTORS.comments.replyCountText, el)
  if (!raw) return undefined
  return parseApproxCount(raw)
}

/**
 * 新規コメント/返信の共通投稿処理。
 * 入力欄はcontenteditableなdivで、Reactの制御コンポーネントのように
 * textContentを直接書き換えるだけではYouTube側の内部状態（投稿ボタンの活性化）が
 * 更新されない。execCommand("insertText")は非推奨だがcontenteditable編集領域に対しては
 * 今も動作し、本物のinputイベントを発火させるため、YouTube側のリスナーに正しく伝わる
 * （2026-08-19 実機確認: これがないと投稿ボタンがdisabledのまま変化しない）。
 */
async function submitCommentBox(box: Element, text_: string): Promise<boolean> {
  const editable = q<HTMLElement>(SELECTORS.comments.commentBoxEditable, box)
  if (!editable) return false

  editable.focus()
  // ★ execCommand("insertText") は「キャレット位置への挿入」であって置換ではない。
  //   投稿欄に前回の失敗分やユーザーがメイン画面で打ちかけた文字が残っていると、
  //   それに連結された別物の文章がそのまま公開投稿されてしまう。
  //   非折りたたみの選択範囲に対する insertText は選択内容を置き換えるため、
  //   まず中身を全選択してから挿入し、常に「入力欄の内容 === 渡した本文」を保証する。
  const selection = window.getSelection()
  if (selection) {
    const range = document.createRange()
    range.selectNodeContents(editable)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  document.execCommand("insertText", false, text_)
  // execCommandが効かない環境向けの保険。反映されていなければ手動でイベントも発火する。
  if ((editable.textContent ?? "").trim().length === 0 && text_.trim().length > 0) {
    editable.textContent = text_
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text_ }))
  }
  // ★ 投稿直前の最終防衛線。全選択→挿入が何らかの理由で効かず、入力欄の中身が
  //   渡した本文と一致しない状態のまま投稿ボタンを押すと、意図しない文章が公開される。
  //   一致しない場合は投稿せず失敗として返し、Popout側にエラーを出させる。
  //   ※ contenteditableでは改行が <br>/<div> として表現され textContent からは消えるため、
  //     空白類をすべて無視して比較する。余計な文字の混入だけを検出できれば目的は足りる。
  const squash = (s: string) => s.replace(/\s+/gu, "")
  if (squash(editable.textContent ?? "") !== squash(text_)) return false

  // 投稿ボタンの活性化はYouTube側の内部状態更新を経るため、反映を少し待つ
  await new Promise((resolve) => window.setTimeout(resolve, 300))

  const submit = q<HTMLElement>(SELECTORS.comments.commentBoxSubmit, box)
  if (!submit || submit.matches(":disabled, [disabled], [aria-disabled='true']")) return false
  submit.click()
  return true
}

/**
 * 指定コメントの返信一覧を読み出す。必要なら返信スレッドを展開してから読む。
 *
 * ★「返信を見る」トグルからの取得と、返信を投稿した直後の読み直しの両方がここを通る。
 *   以前は投稿直後だけ「少し待って1回読むだけ」の素朴な実装になっており、
 *   スレッドが畳まれたままだと必ず0件になって「返信を取得できませんでした」と
 *   表示されていた（投稿自体は成功しているのに失敗したように見える）。
 */
async function loadRepliesFor(commentId: string): Promise<FeedItem[]> {
  const el = findCommentElementById(commentId)
  if (!el) return []

  // ★ 既に展開済みのスレッドでトグルを押すと畳んでしまうため、
  //   返信がDOMに出ていない場合だけクリックする。
  const alreadyLoaded = qa(SELECTORS.comments.replyItem, el).length > 0
  if (!alreadyLoaded) {
    const toggle = q<HTMLElement>(SELECTORS.comments.replyToggle, el)
    if (toggle && !toggle.matches(":disabled, [disabled], [aria-disabled='true']")) {
      toggle.click()
    }
    // 展開ボタンを押しても、返信本体はcontinuation-item-renderer側の
    // IntersectionObserverで別途遅延読み込みされる（related動画/コメント本体と同じ罠）。
    // メイン画面を実際にスクロールしない前提のこの拡張では自然には交差しないため、
    // 短い間隔で様子を見ながらnudgeIntoViewportで刺激する（他機能に合わせて700ms間隔）。
    for (let attempt = 0; attempt < 6; attempt++) {
      const target = findCommentElementById(commentId)
      const continuation = target && q<HTMLElement>(SELECTORS.comments.repliesContinuation, target)
      if (continuation) nudgeIntoViewport(continuation, () => {}, 700)
      await new Promise((resolve) => window.setTimeout(resolve, 700))
      const refreshed = findCommentElementById(commentId)
      if (refreshed && qa(SELECTORS.comments.replyItem, refreshed).length > 0) break
    }
  }

  const parent = findCommentElementById(commentId)
  if (!parent) return []
  const items: FeedItem[] = []
  for (const replyEl of qa(SELECTORS.comments.replyItem, parent)) {
    const item = parseCommentThread(replyEl)
    if (item) items.push({ ...item, parentId: commentId })
  }
  return items
}

function parseCommentThread(el: Element): FeedItem | null {
  const publishedAt = text(SELECTORS.comments.published, el)
  const id = getStableCommentId(el)
  if (!id) return null // 内容未設定のskeletonはコメントとして配信・キャッシュしない
  const likeButton = q<HTMLElement>(SELECTORS.comments.likeButton, el)
  const likeCount = readLikeCount(el)
  const replyCount = readReplyCount(el)
  return {
    // permalinkのlc、またはDOM内容由来のfallback hashを安定キーにする。
    id,
    author: text(SELECTORS.comments.author, el),
    avatarUrl: q<HTMLImageElement>(SELECTORS.comments.avatar, el)?.src ?? "",
    tokens: toTokens(q(SELECTORS.comments.body, el)),
    text: text(SELECTORS.comments.body, el),
    ...(publishedAt ? { publishedAt } : {}),
    ...(likeButton ? { liked: readLikedState(likeButton) } : {}),
    ...(likeCount !== undefined ? { likeCount } : {}),
    ...(replyCount ? { replyCount } : {})
  }
}

function emitUnseenCommentThreads(threads: Element[]) {
  const fresh: FeedItem[] = []
  for (const el of threads) {
    if (!belongsToCurrentVideo(el) || isSeenComment(el) || isUnsafeComment(el)) continue
    markCommentSeen(el)
    const item = parseCommentThread(el)
    if (!item) continue
    if (commentItemCache.has(item.id)) continue
    commentItemCache.set(item.id, item)
    fresh.push(item)
  }
  if (fresh.length > 0) emit({ type: "FEED_APPEND", payload: { kind: "comment", items: fresh } })
}

function flushCommentEmit() {
  commentDebounceId = null
  const container = commentContainerEl
  const threads = container && document.contains(container)
    ? qa(SELECTORS.comments.thread, container)
    : []

  // 旧要素と新要素が同時に存在しても、新要素だけは直ちに配信できる。
  // 要素数が一瞬0になることには依存しないため、debounce中の0→追加も取りこぼさない。
  if (awaitingFreshComments) {
    emitUnseenCommentThreads(threads)
    const hasUnsafeThreads = threads.some(isUnsafeComment)
    if (!hasUnsafeThreads) {
      awaitingFreshComments = false
      reviveCommentPagingIfAvailable()
      return
    }

    const elapsed = Date.now() - awaitingSince
    if (elapsed < FRESH_COMMENTS_TIMEOUT_MS) {
      // DOM変化がもう起きなくても、4秒経過時点で必ずもう一度評価する。
      commentDebounceId = window.setTimeout(
        flushCommentEmit,
        FRESH_COMMENTS_TIMEOUT_MS - elapsed
      )
      return
    }
    // 4秒後も残る旧要素はunsafeのまま無視し、以後追加される新要素だけを通常配信する。
    awaitingFreshComments = false
    reviveCommentPagingIfAvailable()
    return
  }

  emitUnseenCommentThreads(threads)
  reviveCommentPagingIfAvailable()
}

/** terminal確定後にcontinuationが遅れて現れた場合、自動ページングを再開する。 */
function reviveCommentPagingIfAvailable() {
  if (
    !commentLoading &&
    findTopLevelCommentContinuation() &&
    (commentPageState.phase === "done" || commentPageState.phase === "error" || !commentPageState.hasMore)
  ) {
    updatePageState(makePageState("comment", "idle", commentItemCache.size, true))
  }
}

function scheduleCommentEmit() {
  if (commentDebounceId !== null) window.clearTimeout(commentDebounceId)
  commentDebounceId = window.setTimeout(flushCommentEmit, COMMENT_DEBOUNCE_MS)
}

/**
 * YouTubeはコメント欄を IntersectionObserver で遅延読み込みしており、
 * メイン画面上で実際にスクロールして画面内に入れないと <ytd-comment-thread-renderer>
 * が1件もDOMに生まれない（ゴースト/スピナーのプレースホルダーのみの状態が続く）。
 *
 * サブモニタ運用ではメイン画面を手でスクロールする発想自体が起きないため、
 * 「一瞬だけ画面内に入れてすぐ元の位置へ戻す」ことで、視聴の邪魔をせずに
 * YouTube側の遅延読み込みだけを起動させる。
 *
 * ★ 動画切り替え直後の一発勝負だと失敗することがある。YouTube側が
 *   IntersectionObserverを実際に張り終える前に実行してしまうと、交差イベントが
 *   誰にも観測されず不発に終わる。そのため「まだコメントが1件も無ければ再試行」を
 *   間隔を空けて数回繰り返す。動画が変わったら token で古い再試行連鎖を打ち切る。
 */
let commentsRetryToken = 0
let commentLoadRun = 0
let commentLoading = false

/**
 * 対象要素を一時的にビューポート内へ移し、YouTubeのIntersectionObserverを起動する。
 *
 * ページのscrollTopは変更しない。以前の opacity:0 / z-index:-1 / 120ms は、
 * 可視性判定やバックグラウンドタイマーで不発になり得たため、24pxの実交差領域を
 * 十分な時間だけ作る。変更したCSSプロパティだけを復元し、YouTube側の同時更新を壊さない。
 */
const activeNudges = new WeakMap<HTMLElement, Array<() => void>>()
const CONTINUATION_HOST_SELECTOR = "ytd-continuation-item-renderer, yt-continuation-item-renderer"

/** 検証済みcontinuation host内の専用操作だけを押す。親領域の任意ボタンには触れない。 */
function clickContinuationControl(
  target: HTMLElement,
  buttonCandidates: readonly string[]
): boolean {
  const host = target.matches(CONTINUATION_HOST_SELECTOR)
    ? target
    : target.querySelector<HTMLElement>(CONTINUATION_HOST_SELECTOR)
  if (!host || host.getAttribute("aria-busy") === "true") return false
  const button = q<HTMLElement>(buttonCandidates, host)
  if (!button || button.matches(":disabled, [disabled], [aria-disabled='true']")) return false
  button.click()
  return true
}

type StyleSnapshot = {
  el: HTMLElement
  hidden: boolean
  forcedHidden: boolean | null
  properties: Array<{
    name: string
    value: string
    priority: string
    forcedValue: string | null
    forcedPriority: string | null
  }>
}

const TARGET_NUDGE_PROPERTIES = [
  "position", "top", "right", "bottom", "left", "width", "height",
  "min-width", "min-height", "display", "visibility", "opacity", "z-index",
  "pointer-events", "content-visibility", "contain", "overflow", "transform"
] as const

function snapshotProperties(el: HTMLElement, properties: readonly string[]): StyleSnapshot {
  return {
    el,
    hidden: el.hidden,
    forcedHidden: null,
    properties: properties.map((name) => ({
      name,
      value: el.style.getPropertyValue(name),
      priority: el.style.getPropertyPriority(name),
      forcedValue: null,
      forcedPriority: null
    }))
  }
}

function forceHidden(snapshot: StyleSnapshot, value: boolean) {
  snapshot.forcedHidden = value
  snapshot.el.hidden = value
}

function forceProperty(snapshot: StyleSnapshot, name: string, value: string, priority = "important") {
  const property = snapshot.properties.find((candidate) => candidate.name === name)
  if (property) {
    property.forcedValue = value
    property.forcedPriority = priority
  }
  snapshot.el.style.setProperty(name, value, priority)
}

function restoreSnapshot(snapshot: StyleSnapshot) {
  // 介入中にYouTube自身が同じinline値を更新した場合、その新しい値を古いsnapshotで潰さない。
  if (snapshot.forcedHidden === null || snapshot.el.hidden === snapshot.forcedHidden) {
    snapshot.el.hidden = snapshot.hidden
  }
  for (const property of snapshot.properties) {
    // snapshot対象に含めただけで実際には強制していない値は、YouTube側の更新を尊重する。
    if (property.forcedValue === null) continue
    if (
      snapshot.el.style.getPropertyValue(property.name) !== property.forcedValue ||
      snapshot.el.style.getPropertyPriority(property.name) !== property.forcedPriority
    ) continue
    if (property.value) snapshot.el.style.setProperty(property.name, property.value, property.priority)
    else snapshot.el.style.removeProperty(property.name)
  }
}

function nudgeIntoViewport(el: HTMLElement, done: () => void, dwellMs = 700) {
  // ★安全装置: 動画プレイヤーを含む要素は絶対に動かさない。
  //   セレクタの候補配列が想定と違う（より広い）要素を掴んでしまった場合でも、
  //   ここで必ず弾く。一時的にせよプレイヤーの祖先を position:fixed で縮めると、
  //   YouTube自身のプレイヤーが内部で持つサイズ計算が壊れ、
  //   スタイルを元に戻しても映像が真っ暗なまま復帰しないことがある。
  const player = q<HTMLElement>(SELECTORS.player.root)
  if (player && el.contains(player)) {
    done() // 何もせず次の試行に委ねる（呼び出し側のリトライで自然に回復する）
    return
  }

  // 初回読み込みと追加読み込みが同じcontinuationを同時に刺激すると、
  // 後発処理が「一時style」を原状として復元してしまう。同一要素の操作は共有する。
  const waiting = activeNudges.get(el)
  if (waiting) {
    waiting.push(done)
    return
  }
  activeNudges.set(el, [done])

  const targetSnapshot = snapshotProperties(el, TARGET_NUDGE_PROPERTIES)
  const snapshots: StyleSnapshot[] = [targetSnapshot]
  // content-visibility/hidden の祖先内ではfixed子要素も交差しないため、必要な祖先だけ一時解除する。
  for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const computed = getComputedStyle(parent)
    const clipsDescendants = [computed.overflow, computed.overflowX, computed.overflowY]
      .some((value) => value === "hidden" || value === "clip")
    const contain = computed.getPropertyValue("contain")
    if (
      parent.hidden ||
      computed.display === "none" ||
      computed.visibility === "hidden" ||
      computed.getPropertyValue("content-visibility") !== "visible" ||
      clipsDescendants ||
      (contain !== "" && contain !== "none")
    ) {
      const properties = [
        "display", "visibility", "content-visibility",
        "overflow-x", "overflow-y", "contain"
      ] as const
      const snapshot = snapshotProperties(parent, properties)
      snapshots.push(snapshot)
      forceHidden(snapshot, false)
      if (computed.display === "none") forceProperty(snapshot, "display", "block")
      if (computed.visibility === "hidden") forceProperty(snapshot, "visibility", "visible")
      forceProperty(snapshot, "content-visibility", "visible")
      if (computed.overflowX === "hidden" || computed.overflowX === "clip") {
        forceProperty(snapshot, "overflow-x", "visible")
      }
      if (computed.overflowY === "hidden" || computed.overflowY === "clip") {
        forceProperty(snapshot, "overflow-y", "visible")
      }
      if (contain !== "" && contain !== "none") forceProperty(snapshot, "contain", "none")
    }
  }

  forceHidden(targetSnapshot, false)
  const forced: Record<(typeof TARGET_NUDGE_PROPERTIES)[number], string> = {
    position: "fixed", top: "1px", right: "1px", bottom: "auto", left: "auto",
    width: "24px", height: "24px", "min-width": "24px", "min-height": "24px",
    display: "block", visibility: "visible", opacity: "1", "z-index": "2147483647",
    "pointer-events": "none", "content-visibility": "visible", contain: "none",
    overflow: "hidden", transform: "none"
  }
  for (const [name, value] of Object.entries(forced)) {
    forceProperty(targetSnapshot, name, value)
  }

  let rect = el.getBoundingClientRect()
  if (
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= window.innerWidth ||
    rect.top >= window.innerHeight
  ) {
    // transform祖先がfixed containing blockになっていても、実測差分でviewport内へ補正する。
    forceProperty(
      targetSnapshot,
      "transform",
      `translate(${Math.round(8 - rect.left)}px, ${Math.round(8 - rect.top)}px)`
    )
    rect = el.getBoundingClientRect()
  }
  void rect // 同期レイアウトを確定し、YouTube側IntersectionObserverの次回評価へ載せる

  window.setTimeout(() => {
    for (const snapshot of snapshots.reverse()) restoreSnapshot(snapshot)
    const callbacks = activeNudges.get(el) ?? []
    activeNudges.delete(el)
    callbacks.forEach((callback) => callback())
  }, dwellMs)
}

/**
 * サブ画面のコメント一覧を最下部までスクロールしたときに呼ばれ、
 * YouTube側に「次のバッチ」を読み込ませる。
 *
 * 初回0件でも、既にスレッドが存在する場合でも同じ経路を使う。
 * 読み込まれた分は既存の MutationObserver が拾って FEED_APPEND される。
 *
 * 1要求が完了するまで次要求をまとめ、成功・末尾・タイムアウトを必ずPopoutへ返す。
 */
function currentCommentThreads(): Element[] {
  const container = commentContainerEl && document.contains(commentContainerEl)
    ? commentContainerEl
    : q(SELECTORS.comments.section)
  if (!container) return []
  return qa(SELECTORS.comments.thread, container)
    .filter((el) => belongsToCurrentVideo(el) && !isUnsafeComment(el))
}

function findTopLevelCommentContinuation(): HTMLElement | null {
  const container = commentContainerEl && document.contains(commentContainerEl)
    ? commentContainerEl
    : q(SELECTORS.comments.section)
  if (!container) return null
  // qa()は最初にヒットした候補だけを返すため、そこが返信用だけだった場合に
  // 後続候補のトップレベルcontinuationを探索できない。候補ごとに除外後の有効件を探す。
  for (const selector of SELECTORS.comments.continuation) {
    const candidate = Array.from(container.querySelectorAll<HTMLElement>(selector))
      .find((el) => !el.closest("ytd-comment-thread-renderer, ytd-comment-replies-renderer"))
    if (candidate) return candidate
  }
  return null
}

function commentsAreDefinitelyEmpty(container: Element | null): boolean {
  if (!container) return false
  const message = q<HTMLElement>(SELECTORS.comments.emptyMessage, container)
  if (message?.textContent?.trim()) return true
  const countText = text(SELECTORS.comments.count, container).normalize("NFKC")
  const numericToken = countText.match(/\d[\d,.]*/)?.[0]
  if (!numericToken) return false
  const count = Number(numericToken.replace(/,/g, ""))
  return Number.isFinite(count) && count === 0
}

function loadMoreComments() {
  if (commentLoading || ports.size === 0 || !getVideoId()) return

  commentLoading = true
  const run = ++commentLoadRun
  const token = commentsRetryToken
  const beforeThreads = currentCommentThreads()
  const beforeIds = new Set(beforeThreads.map(getStableCommentId).filter((id): id is string => id !== null))
  const beforeCount = beforeThreads.length
  let attempts = 0
  let lastActivatedTarget: HTMLElement | null = null
  let lastActivatedAt = 0
  const clickedContinuations = new WeakSet<HTMLElement>()
  updatePageState(makePageState("comment", "loading", commentItemCache.size, true))

  const finish = (phase: PageState["phase"], hasMore: boolean, error?: string) => {
    if (run !== commentLoadRun) return
    commentLoading = false
    const threads = currentCommentThreads()
    emitUnseenCommentThreads(threads)
    scheduleCommentEmit()
    updatePageState(makePageState("comment", phase, commentItemCache.size, hasMore, error))
  }

  const tryOnce = () => {
    if (
      run !== commentLoadRun ||
      ports.size === 0 ||
      token !== commentsRetryToken ||
      !getVideoId()
    ) {
      if (run === commentLoadRun) commentLoading = false
      return
    }

    const currentContainer = q(SELECTORS.comments.section)
    if (currentContainer && currentContainer !== commentContainerEl) watchComments(false)
    const threads = currentCommentThreads()
    if (threads.length === 0 && commentsAreDefinitelyEmpty(currentContainer)) {
      finish("done", false)
      return
    }
    const grew = threads.length > beforeCount || threads.some((thread) => {
      const id = getStableCommentId(thread)
      return id !== null && !beforeIds.has(id)
    })
    if (grew) {
      // continuationの挿入はコメントDOMより遅れることがある。次要求側で末尾を確定する。
      finish("idle", true)
      return
    }

    const continuation = findTopLevelCommentContinuation()
    if (attempts >= 12) {
      if (!continuation && (threads.length > 0 || commentsAreDefinitelyEmpty(currentContainer))) {
        finish("done", false)
      }
      else finish("error", true, "コメントを読み込めませんでした。再試行してください。")
      return
    }
    attempts += 1

    const target = continuation ?? (
      threads.length === 0
        ? (currentContainer ?? q<HTMLElement>(SELECTORS.comments.activation))
        : null
    )
    if (!target) {
      window.setTimeout(tryOnce, 800)
      return
    }

    const now = Date.now()
    if (target === lastActivatedTarget && now - lastActivatedAt < 3000) {
      window.setTimeout(tryOnce, 800)
      return
    }
    lastActivatedTarget = target
    lastActivatedAt = now

    if (
      continuation &&
      !clickedContinuations.has(continuation) &&
      clickContinuationControl(continuation, SELECTORS.comments.continuationButton)
    ) {
      clickedContinuations.add(continuation)
      window.setTimeout(tryOnce, 1000)
    } else {
      nudgeIntoViewport(target, () => window.setTimeout(tryOnce, 1000), 700)
    }
  }
  tryOnce()
}

/**
 * @param isNavigation 動画切り替えによる呼び出しか（コンテナ張り直しだけの場合はfalse）
 * @param shouldAwaitFresh 前動画のコメントDOM消滅を待つ必要があるか。初回ロードではfalse。
 * @param staleElements yt-navigate-start時点で存在した、前動画由来と確定できる要素。
 */
function watchComments(
  isNavigation = true,
  shouldAwaitFresh = isNavigation,
  staleElements: Element[] = []
) {
  commentObserver?.disconnect()
  // 実ナビゲーション時だけ世代を進める。1秒保険の再探索で進めると、
  // 初回ローダーが毎秒無効化されて永遠に完了しない。
  if (isNavigation) {
    commentsRetryToken += 1
    commentLoadRun += 1
    commentLoading = false
  }
  if (commentDebounceId !== null) {
    window.clearTimeout(commentDebounceId)
    commentDebounceId = null
  }
  // ナビゲーション直後にコメント欄が未生成でも、後続の再探索まで状態を保持する。
  if (isNavigation) {
    pendingCommentNavigation = true
    pendingFreshCommentWait = shouldAwaitFresh
    pendingUnsafeCommentEls = staleElements
  }

  const container = q(SELECTORS.comments.section)
  commentContainerEl = container
  if (!container) {
    // 0件時でもサブ側から初期化を要求できるよう、#below等の親領域を刺激する。
    loadMoreComments()
    return
  }

  if (pendingCommentNavigation) {
    pendingCommentNavigation = false
    seenCommentEls = new WeakSet() // 動画が変わったら既読状態もリセット
    seenCommentIds = new Set()
    unsafeCommentEls = new WeakSet()
    unsafeCommentIds = new Set()
    for (const el of pendingUnsafeCommentEls) {
      markCommentSeen(el)
      markCommentUnsafe(el)
    }
    const hasUnsafeThreads = qa(SELECTORS.comments.thread, container)
      .some(isUnsafeComment)
    awaitingFreshComments = pendingFreshCommentWait && hasUnsafeThreads
    pendingFreshCommentWait = false
    pendingUnsafeCommentEls = []
    awaitingSince = awaitingFreshComments ? Date.now() : 0
  }

  commentObserver = new MutationObserver(scheduleCommentEmit)
  commentObserver.observe(container, { childList: true, subtree: true })
  scheduleCommentEmit() // 遷移時点で既に読み込み済みのコメントも拾う
  loadMoreComments()
}

/** watchページを離れたとき、detached DOMへの監視・遅延処理を残さない。 */
function stopWatchPageObservers() {
  relatedObserver?.disconnect()
  relatedObserver = null
  relatedContainerEl = null
  if (relatedDebounceId !== null) {
    window.clearTimeout(relatedDebounceId)
    relatedDebounceId = null
  }

  commentObserver?.disconnect()
  commentObserver = null
  commentContainerEl = null
  if (commentDebounceId !== null) {
    window.clearTimeout(commentDebounceId)
    commentDebounceId = null
  }
  pendingCommentNavigation = false
  pendingFreshCommentWait = false
  pendingUnsafeCommentEls = []
  navigationStartCommentSnapshot = null
  awaitingFreshComments = false
  awaitingSince = 0
  commentsRetryToken++
  commentLoadRun++
  commentLoading = false
  relatedLoadRun++
  relatedLoading = false
}

/* ============ コマンド適用 ============ */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const requestPlay = (video: HTMLVideoElement) => {
  // ブラウザの自動再生ポリシー等でrejectされても、未処理Promiseにしない。
  void video.play().catch(() => pushStatus())
}

function applyCommand(cmd: PlayerCommand) {
  const v = getVideo()
  if (!v) return
  switch (cmd.command) {
    case "play":   requestPlay(v); break
    case "pause":  v.pause(); break
    case "toggle": v.paused ? requestPlay(v) : v.pause(); break
    case "volume":
      if (!Number.isFinite(cmd.value)) break
      v.volume = clamp(cmd.value, 0, 100) / 100
      if (v.volume > 0) v.muted = false
      break
    case "mute":   v.muted = cmd.value; break
    case "seek":
      if (!Number.isFinite(cmd.value)) break
      try {
        v.currentTime = Number.isFinite(v.duration)
          ? clamp(cmd.value, 0, v.duration)
          : Math.max(0, cmd.value)
      } catch {
        // metadata準備前やライブ範囲外のseekはプレイヤー状態を変えずに無視する。
      }
      break
    case "seekBy":
      if (!Number.isFinite(cmd.value)) break
      try {
        v.currentTime = Math.max(0, v.currentTime + cmd.value)
      } catch {
        // seekと同じく、不安定なメディア状態では無視する。
      }
      break
    case "speed":
      if (!Number.isFinite(cmd.value)) break
      v.playbackRate = clamp(cmd.value, 0.1, 4) // HTMLMediaElementの実用域
      break
    case "speedBy":
      if (!Number.isFinite(cmd.value)) break
      v.playbackRate = clamp(
        Math.round((v.playbackRate + cmd.value) * 100) / 100, // 浮動小数点誤差を潰す
        0.1, 4
      )
      break
    case "fullscreen":
      q<HTMLElement>(["button.ytp-fullscreen-button"])?.click()
      break
  }
}

/** 新しく接続したPortだけへイベントを送り、既存Portの一覧を重複更新しない。 */
function postToPort(port: chrome.runtime.Port, ev: StreamEvent): boolean {
  try {
    port.postMessage(ev)
    return true
  } catch {
    ports.delete(port)
    if (ports.size === 0) {
      stopWatchPageObservers()
      unbindVideo()
    }
    return false
  }
}

/**
 * 現在の動画のコメント一覧スナップショットを返す。
 *
 * DOM上に残っている安全な行をキャッシュへ統合したうえで、過去に取得済みの分も含めて返す。
 * Port再接続時の再水和と、単発の DOM_FETCH_FEED の両方が同じ結果を返すよう共通化している。
 * ★ markCommentSeen() の副作用込みで既存挙動を維持する。ここで配り終えた行を
 *   後から FEED_APPEND の「新着」として二重に流さないため。
 */
function collectCommentItems(): FeedItem[] {
  const currentVideoId = getVideoId()
  const container = commentContainerEl
  const cacheMatchesVideo = Boolean(currentVideoId && lastVideoId === currentVideoId)
  const canHydrateComments = Boolean(
    cacheMatchesVideo &&
    !pendingCommentNavigation &&
    container &&
    document.contains(container)
  )

  if (canHydrateComments && container) {
    const threads = qa(SELECTORS.comments.thread, container)
      .filter((el) => belongsToCurrentVideo(el) && !isUnsafeComment(el))
    for (const el of threads) {
      markCommentSeen(el)
      const item = parseCommentThread(el)
      if (!item) continue
      commentItemCache.set(item.id, item)
    }
  }
  // コンテナが一時的に未生成でも、同一動画で以前取得済みの行は失わず返す。
  return cacheMatchesVideo ? Array.from(commentItemCache.values()) : []
}

/**
 * 新規・再接続Portへ現在状態を直接再水和する。
 * コメントは動画世代が確定済みの安全な要素だけをsnapshotとして送る。
 */
function rehydratePort(port: chrome.runtime.Port) {
  const onWatchPage = location.pathname === "/watch" && getVideoId() !== null
  const relatedItems = onWatchPage ? fetchRelated() : []
  const commentItems = collectCommentItems()

  if (!postToPort(port, { type: "RELATED", payload: relatedItems })) return

  // ライブチャット配信は未実装なので、再接続時のfeedは一貫してcommentとして初期化する。
  if (!postToPort(port, { type: "FEED_RESET", payload: { kind: "comment" } })) return
  if (!postToPort(port, {
    type: "PAGE_STATE",
    payload: { ...relatedPageState, loaded: relatedItems.length }
  })) return
  if (!postToPort(port, {
    type: "PAGE_STATE",
    payload: { ...commentPageState, loaded: commentItems.length }
  })) return

  if (commentItems.length > 0) {
    postToPort(port, { type: "FEED_APPEND", payload: { kind: "comment", items: commentItems } })
  }
}

/* ============ Port 受け入れ ============ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_PLAYER) return // 想定外のPortは受け付けない

  const wasInactive = ports.size === 0
  ports.add(port)
  if (wasInactive) {
    // Port不在中は監視を止めているため、現在ページを「初回」として安全に再開する。
    const currentVideoId = getVideoId()
    if (currentVideoId !== lastVideoId) resetVideoCaches()
    lastVideoId = currentVideoId
    navigationStartCommentSnapshot = null
    relatedPageState = initialPageState("related")
    commentPageState = initialPageState("comment")
    if (location.pathname === "/watch" && lastVideoId) {
      watchRelated()
      watchComments(true, false)
    } else {
      stopWatchPageObservers()
    }
  }
  bindVideo()
  pushStatus() // 接続直後に必ず1回投げる（初期表示の空白を防ぐ）
  rehydratePort(port)

  port.onMessage.addListener((msg: StreamCommand) => {
    switch (msg.type) {
      case "COMMAND":
        applyCommand(msg.payload)
        onImmediate() // 適用結果を即座に返す（UIの往復レイテンシ体感を消す）
        break
      case "REQUEST_RELATED":
        {
          const items = fetchRelated()
          postToPort(port, { type: "RELATED", payload: items })
          if (
            findRelatedContinuation() &&
            (relatedPageState.phase === "done" || relatedPageState.phase === "error" || !relatedPageState.hasMore)
          ) {
            updatePageState(makePageState("related", "idle", items.length, true))
          }
        }
        break
      case "REQUEST_MORE_FEED":
        loadMoreComments()
        break
      case "REQUEST_MORE_RELATED":
        loadMoreRelated()
        break
      case "SET_FEED_STREAMING":
        break // 非表示時に監視を止める最適化は未実装（Phase 2で検討）
    }
  })

  port.onDisconnect.addListener(() => {
    ports.delete(port)
    if (ports.size === 0) {
      stopWatchPageObservers()
      unbindVideo()
    }
  })
})

/* ============ 単発メッセージ ============ */

/**
 * 指定動画へ遷移する。
 *
 * 既存の実リンクがある場合だけ、そのリンクが持つYouTube側のclick処理を使う。
 * 実リンクが無いときは、SPAを装った素anchorではなく通常遷移で確実性を優先する。
 */
/**
 * YouTube自身のSPAルーター(`ytd-app`の`yt-navigate`)へ遷移を依頼する。
 * 対象動画のアンカーがDOMに無い場合（フルスクリーン中など）の受け皿。
 *
 * ★ Content Scriptは隔離ワールドで動くため、CustomEventのdetailがページ側へ
 *   構造化複製されて届くかは環境依存の面がある。届かなければ何も起きないので、
 *   一定時間後に実際に遷移したかを確認し、駄目なら通常遷移へ落とす
 *   （フルスクリーンは失われるが、「動画が変わらない」よりはましという判断）。
 */
function navigateViaYouTubeRouter(
  videoId: string,
  url: URL,
  startSeconds: number,
  generation: number
) {
  const app = document.querySelector("ytd-app")
  if (!app) {
    location.assign(url.href)
    return
  }

  app.dispatchEvent(new CustomEvent("yt-navigate", {
    detail: {
      endpoint: {
        commandMetadata: {
          webCommandMetadata: {
            url: url.pathname + url.search,
            webPageType: "WEB_PAGE_TYPE_WATCH",
            rootVe: 3832
          }
        },
        watchEndpoint: { videoId }
      }
    },
    bubbles: true,
    composed: true
  }))

  window.setTimeout(() => {
    if (generation !== navigationCommandGeneration) return
    if (getVideoId() === videoId) {
      if (startSeconds > 0) seekAfterNavigation(videoId, startSeconds, generation)
      return
    }
    location.assign(url.href)
  }, 700)
}

function navigateToVideo(videoId: string, generation: number, startSeconds?: number) {
  const url = new URL("/watch", location.origin)
  url.searchParams.set("v", videoId)
  const normalizedStartSeconds = typeof startSeconds === "number" && Number.isFinite(startSeconds)
    ? Math.max(0, Math.floor(startSeconds))
    : 0
  if (normalizedStartSeconds > 0) {
    url.searchParams.set("t", String(normalizedStartSeconds))
  }

  // hrefを正規URLへ同期的に差し替え、元要素のYouTube管理click listenerを維持する。
  // list/index等の余計なパラメータは引き継がず、tもこのURLと後続seekの両方で担保する。
  const existing = document.querySelector<HTMLAnchorElement>(
    `a[href*="/watch?v=${CSS.escape(videoId)}"]`
  )
  if (!existing) {
    // ★ メイン画面がフルスクリーンだと関連動画欄が描画されず、対象動画のアンカーが
    //   DOMに存在しないことがある。ここで location.assign() するとページ全体が
    //   再読み込みされ、フルスクリーンが必ず解除される（2026-08-19 実機で報告）。
    //   YouTube自身のSPAルーターを直接叩けばアンカー無しでも遷移でき、
    //   実DOM検証では #movie_player と <video> の要素同一性が保たれるため
    //   フルスクリーンも維持される（YouTube側がexitFullscreen()を呼ばないことも確認済み）。
    navigateViaYouTubeRouter(videoId, url, normalizedStartSeconds, generation)
    return
  }

  const previousHref = existing.getAttribute("href")
  const previousTarget = existing.getAttribute("target")
  try {
    existing.setAttribute("href", url.pathname + url.search)
    existing.removeAttribute("target")
    existing.click()
  } finally {
    if (previousHref === null) existing.removeAttribute("href")
    else existing.setAttribute("href", previousHref)
    if (previousTarget === null) existing.removeAttribute("target")
    else existing.setAttribute("target", previousTarget)
  }

  if (normalizedStartSeconds > 0) {
    seekAfterNavigation(videoId, normalizedStartSeconds, generation)
  }
}

/** SPA側がtを無視しても、対象videoIdのプレイヤーが準備できた後に時刻を適用する。 */
function seekAfterNavigation(videoId: string, seconds: number, generation: number) {
  const videoBeforeNavigation = getVideo()
  let attempts = 0
  const MAX_ATTEMPTS = 16

  const trySeek = () => {
    if (generation !== navigationCommandGeneration) return
    attempts++
    const video = getVideo()
    // YouTubeがvideo要素を再利用する場合もあるため、1秒後からは同一要素を許容する。
    const playerIsReady = video && (video !== videoBeforeNavigation || attempts >= 4)
    if (getVideoId() === videoId && playerIsReady) {
      try {
        video.currentTime = seconds
        onImmediate()
        return
      } catch {
        // metadata準備前のseek拒否は次の試行で回復させる。
      }
    }
    if (attempts < MAX_ATTEMPTS) window.setTimeout(trySeek, 300)
  }

  window.setTimeout(trySeek, 150)
}

registerHandlers({
  PLAYER_GET_STATUS: () => buildStatus(),
  // 本線はPort経由の StreamCommand "COMMAND"。こちらはPortが切れている間でも
  // 単発で操作できるようにするフォールバック経路（契約・仕様書と実装を一致させる）。
  PLAYER_COMMAND: (cmd) => {
    applyCommand(cmd)
    return buildStatus()
  },
  DOM_FETCH_RELATED: () => fetchRelated(),
  // 本線はPort経由の FEED_APPEND ストリーム。こちらは単発取得のフォールバック。
  // ライブチャットは対象外(D-20)のため kind は常に "comment"。
  DOM_FETCH_FEED: ({ limit }) => {
    const items = collectCommentItems()
    const capped = typeof limit === "number" && limit > 0 ? items.slice(0, limit) : items
    return { kind: "comment" as const, items: capped }
  },
  NAVIGATE_SEARCH: ({ query }) => {
    navigationCommandGeneration++
    const url = new URL("/results", location.origin)
    url.searchParams.set("search_query", query)
    location.assign(url.href)
    return { ok: true } as const
  },
  NAVIGATE_TO_VIDEO: ({ videoId, startSeconds }) => {
    const generation = ++navigationCommandGeneration
    // ★以前はここでネイティブフルスクリーンからの復帰を試みていたが削除した。
    //   SPA遷移でフルスクリーンが解除された場合、chrome.runtime経由の非同期メッセージ
    //   ハンドラ（setTimeout配下）からの .click() は「ユーザー操作起点」とみなされず、
    //   Fullscreen APIのtransient activation要件によりブラウザ側で黙って拒否される。
    //   つまり復帰は原理的に成功しない。何もしない方が正直な実装であり、
    //   失敗する処理を残すこと自体が不要な複雑さと誤解のもとになる。
    navigateToVideo(videoId, generation, startSeconds)
    return { ok: true } as const
  },
  COMMENT_TOGGLE_LIKE: async ({ commentId }) => {
    const el = findCommentElementById(commentId)
    if (!el) return { liked: false }

    const likeButton = q<HTMLElement>(SELECTORS.comments.likeButton, el)
    if (!likeButton || likeButton.matches(":disabled, [disabled], [aria-disabled='true']")) {
      return { liked: readLikedState(likeButton) }
    }
    likeButton.click()

    // YouTube側の状態更新（DOM属性・カウント表示の書き換え）は非同期。
    // 実際に反映された値を読み戻すため一呼吸置く。
    await new Promise((resolve) => window.setTimeout(resolve, 250))
    const refreshed = findCommentElementById(commentId) ?? el
    const refreshedButton = q<HTMLElement>(SELECTORS.comments.likeButton, refreshed)
    const likeCount = readLikeCount(refreshed)
    return {
      liked: readLikedState(refreshedButton),
      ...(likeCount !== undefined ? { likeCount } : {})
    }
  },
  COMMENT_LOAD_REPLIES: async ({ commentId }) => ({ items: await loadRepliesFor(commentId) }),
  COMMENT_POST: async ({ text: body }) => {
    let box = q<HTMLElement>(SELECTORS.comments.commentBox)
    if (!box) {
      // ページ読み込み直後はプレースホルダだけが存在し、クリックして初めて
      // 本物のytd-commentboxが生成される（返信欄と同じパターン）。
      const trigger = q<HTMLElement>(SELECTORS.comments.commentBoxTrigger)
      if (!trigger) return { ok: false }
      trigger.click()
      for (let attempt = 0; attempt < 5 && !box; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 200))
        box = q<HTMLElement>(SELECTORS.comments.commentBox)
      }
    }
    if (!box) return { ok: false }
    // 新規に投稿されたコメントは既存のコメント自動監視(watchComments/FEED_APPEND)が
    // 拾うため、ここで結果を組み立てて返す必要はない。成否だけ返す。
    const ok = await submitCommentBox(box, body)
    return { ok }
  },
  COMMENT_REPLY: async ({ commentId, text: body }) => {
    const thread = findCommentElementById(commentId)
    if (!thread) return { ok: false, items: [] }

    let box = q<HTMLElement>(SELECTORS.comments.replyCommentBox, thread)
    if (!box) {
      const trigger = q<HTMLElement>(SELECTORS.comments.replyButton, thread)
      if (!trigger || trigger.matches(":disabled, [disabled], [aria-disabled='true']")) {
        return { ok: false, items: [] }
      }
      trigger.click()
      // 返信欄(ytd-commentbox[is-reply])が生成されるのを少し待つ
      for (let attempt = 0; attempt < 5 && !box; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 200))
        const refreshed = findCommentElementById(commentId)
        box = refreshed && q<HTMLElement>(SELECTORS.comments.replyCommentBox, refreshed)
      }
    }
    if (!box) return { ok: false, items: [] }

    const ok = await submitCommentBox(box, body)
    if (!ok) return { ok: false, items: [] }

    // 投稿がDOMへ反映されるのを一呼吸待ってから、最新の返信一覧を読み直して返す。
    // ★ 読み直しは「返信を見る」と同じ loadRepliesFor() を通す。返信スレッドは
    //   投稿しただけでは展開されないままのことがあり、単純に読むと必ず0件になって
    //   投稿は成功しているのに「返信を取得できませんでした」と表示されてしまう。
    await new Promise((resolve) => window.setTimeout(resolve, 500))
    return { ok: true, items: await loadRepliesFor(commentId) }
  },
  DIAGNOSE_SELECTORS: () => ({ v: DIAGNOSE_VERSION, checks: diagnoseDetail(), samples: sampleOutlines() })
})

exposeDevHelpers()
