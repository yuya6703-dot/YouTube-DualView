/**
 * src/lib/usePlayerPort.ts
 * Popout ⇄ Content Script の常時接続を管理するReact Hook。
 * 切断時は指数バックオフで自動再接続する（タブ再読込・SW停止に耐える）。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  DEFAULT_SETTINGS,
  LOCAL_KEYS,
  PORT_PLAYER,
  SESSION_KEYS,
  askBackground,
  type FeedItem,
  type FeedKind,
  type PageState,
  type PlayerCommand,
  type PlayerStatus,
  type QueueItem,
  type Settings,
  type StreamCommand,
  type StreamEvent
} from "~lib/messaging"

export type ConnState = "connecting" | "connected" | "no-tab" | "retrying"

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const
const MIN_FEED_MAX_ROWS = 20
const MAX_FEED_MAX_ROWS = 2000
const EMPTY_COMMENT_PAGE: PageState = { kind: "comment", phase: "idle", loaded: 0, hasMore: true }
const EMPTY_RELATED_PAGE: PageState = { kind: "related", phase: "idle", loaded: 0, hasMore: true }

function resolveFeedMaxRows(stored: unknown): number {
  const saved =
    typeof stored === "object" && stored !== null ? (stored as Partial<Settings>) : undefined
  const settings = { ...DEFAULT_SETTINGS, ...saved }
  const value = settings.feedMaxRows
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.feedMaxRows
  }
  return Math.min(MAX_FEED_MAX_ROWS, Math.max(MIN_FEED_MAX_ROWS, Math.trunc(value)))
}

export function usePlayerPort() {
  const [state, setState] = useState<ConnState>("connecting")
  const [status, setStatus] = useState<PlayerStatus | null>(null)
  const [related, setRelated] = useState<QueueItem[] | null>(null)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [commentPage, setCommentPage] = useState<PageState>(EMPTY_COMMENT_PAGE)
  const [relatedPage, setRelatedPage] = useState<PageState>(EMPTY_RELATED_PAGE)
  const [tabId, setTabId] = useState<number | null>(null)

  const portRef = useRef<chrome.runtime.Port | null>(null)
  const attemptRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const aliveRef = useRef(true)
  // 対象タブ変更やeffectの再実行より前に開始した非同期接続を無効化する。
  const connectionGenerationRef = useRef(0)
  // options.tsx で変更された設定値。onMessageリスナーのクロージャからは
  // refで参照する（stateだとリスナー登録時点の古い値を掴んだままになる）
  const feedMaxRowsRef = useRef(DEFAULT_SETTINGS.feedMaxRows)
  const feedKindRef = useRef<FeedKind>("comment")

  useEffect(() => {
    let alive = true
    let revision = 0

    const applyFeedLimit = (stored: unknown) => {
      if (!alive) return
      const cap = resolveFeedMaxRows(stored)
      feedMaxRowsRef.current = cap
      // 通常コメントは最後まで遡れることが要件なので切り捨てない。
      // 上限は将来のライブチャットのように流れ続けるフィードだけへ適用する。
      if (feedKindRef.current !== "comment") {
        setFeed((prev) => (prev.length > cap ? prev.slice(prev.length - cap) : prev))
      }
    }

    const handleSettingsChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== "local") return
      const change = changes[LOCAL_KEYS.settings]
      if (!change) return
      revision += 1
      applyFeedLimit(change.newValue)
    }

    chrome.storage.onChanged.addListener(handleSettingsChange)
    const readRevision = revision
    void chrome.storage.local.get(LOCAL_KEYS.settings).then((r) => {
      // 読み込み中に設定変更通知が来た場合は、その新しい値を古い取得結果で戻さない。
      if (revision === readRevision) applyFeedLimit(r[LOCAL_KEYS.settings])
    })

    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(handleSettingsChange)
    }
  }, [])

  const scheduleRetry = useCallback((connect: () => void) => {
    const wait = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)]
      ?? BACKOFF_MS[BACKOFF_MS.length - 1]
    attemptRef.current += 1
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      connect()
    }, wait)
  }, [])

  const connect = useCallback(async () => {
    if (!aliveRef.current) return
    const generation = connectionGenerationRef.current

    const res = await askBackground("GET_TARGET_TAB", undefined)
    if (!aliveRef.current || generation !== connectionGenerationRef.current) return

    if (!res.ok || res.data.tabId === null) {
      setState("no-tab")
      setTabId(null)
      scheduleRetry(connect)
      return
    }

    const id = res.data.tabId
    setTabId(id)

    // ⚠ CSが未注入でもここでは例外にならず、onDisconnect で通知される
    const port = chrome.tabs.connect(id, { name: PORT_PLAYER })
    portRef.current = port

    port.onMessage.addListener((ev: StreamEvent) => {
      if (generation !== connectionGenerationRef.current || portRef.current !== port) return
      attemptRef.current = 0 // 実データが来た時点で健全と判断
      setState("connected")
      if (ev.type === "STATUS") setStatus(ev.payload)
      if (ev.type === "RELATED") setRelated(ev.payload)
      if (ev.type === "PAGE_STATE") {
        if (ev.payload.kind === "comment") setCommentPage(ev.payload)
        else setRelatedPage(ev.payload)
      }
      if (ev.type === "FEED_RESET") {
        feedKindRef.current = ev.payload.kind
        setFeed([])
      }
      if (ev.type === "FEED_APPEND") {
        feedKindRef.current = ev.payload.kind
        setFeed((prev) => {
          // ★ 同じidが再送されたら「追加」ではなく「更新」する。
          //   コメントは発見した瞬間に1回だけ解析されるため、YouTubeが
          //   アイコン画像のsrcを入れる前に読むと空のまま固定されてしまう。
          //   CS側が後からアイコンを埋めて送り直せるよう、upsertにしておく。
          const index = new Map(prev.map((item, i) => [item.id, i]))
          const updated = prev.slice()
          const added: FeedItem[] = []
          for (const item of ev.payload.items) {
            const at = index.get(item.id)
            if (at === undefined) added.push(item)
            else updated[at] = item
          }
          const merged = added.length > 0 ? [...updated, ...added] : updated
          // 通常コメントは「サブだけで最後まで遡れる」ことを優先して全件保持する。
          // 将来ライブチャットを再実装した場合だけ、流れ続けるデータへ保持上限を適用する。
          if (ev.payload.kind === "comment") return merged
          const cap = feedMaxRowsRef.current
          return merged.length > cap ? merged.slice(merged.length - cap) : merged
        })
      }
      if (ev.type === "VIDEO_CHANGED") {
        setStatus(null)
        setRelated(null) // 動画が変わったら古い関連動画リストを持ち越さない
        setCommentPage(EMPTY_COMMENT_PAGE)
        setRelatedPage(EMPTY_RELATED_PAGE)
        // feed は少し遅れて届く FEED_RESET が別途クリアするので、ここでは触らない
      }
    })

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError // lastError を読まないと警告が出る
      if (portRef.current === port) portRef.current = null
      if (!aliveRef.current || generation !== connectionGenerationRef.current) return
      setState("retrying")
      scheduleRetry(connect)
    })
  }, [scheduleRetry])

  useEffect(() => {
    aliveRef.current = true

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (!aliveRef.current || areaName !== "session") return

      const change = changes[SESSION_KEYS.targetTabId]
      if (!change || change.oldValue === change.newValue) return

      // 旧PortのonDisconnectや処理中のGET_TARGET_TABが再接続を重複させないよう、
      // 世代を先に進めてから旧接続を破棄する。
      connectionGenerationRef.current += 1
      attemptRef.current = 0
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }

      const previousPort = portRef.current
      portRef.current = null
      previousPort?.disconnect()

      const nextTabId = typeof change.newValue === "number" ? change.newValue : null
      setTabId(nextTabId)
      setStatus(null)
      setRelated(null)
      setFeed([])
      feedKindRef.current = "comment"
      setCommentPage(EMPTY_COMMENT_PAGE)
      setRelatedPage(EMPTY_RELATED_PAGE)
      setState(nextTabId === null ? "no-tab" : "connecting")
      void connect()
    }

    chrome.storage.onChanged.addListener(handleStorageChange)
    void connect()
    return () => {
      aliveRef.current = false
      connectionGenerationRef.current += 1
      chrome.storage.onChanged.removeListener(handleStorageChange)
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const port = portRef.current
      portRef.current = null
      port?.disconnect()
    }
  }, [connect])

  const send = useCallback((msg: StreamCommand) => {
    try {
      portRef.current?.postMessage(msg)
    } catch {
      setState("retrying")
    }
  }, [])

  const command = useCallback(
    (payload: PlayerCommand) => send({ type: "COMMAND", payload }),
    [send]
  )

  const requestRelated = useCallback(() => send({ type: "REQUEST_RELATED" }), [send])
  const requestMoreFeed = useCallback(() => send({ type: "REQUEST_MORE_FEED" }), [send])
  const requestMoreRelated = useCallback(() => send({ type: "REQUEST_MORE_RELATED" }), [send])

  return {
    state,
    status,
    related,
    feed,
    commentPage,
    relatedPage,
    tabId,
    command,
    requestRelated,
    requestMoreFeed,
    requestMoreRelated,
    send
  }
}

/**
 * 250ms間隔のSTATUSを滑らかに描画するための外挿。
 * Popoutは常に可視なのでタイマーが劣化しない前提。
 */
export function useSmoothTime(status: PlayerStatus | null): number {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 100)
    return () => clearInterval(id)
  }, [])

  if (!status) return 0
  if (status.paused) return status.currentTime
  const elapsed = (Date.now() - status.sampledAt) / 1000
  const t = status.currentTime + elapsed * status.playbackRate
  return status.duration > 0 ? Math.min(t, status.duration) : t
}
