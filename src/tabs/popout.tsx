/**
 * src/tabs/popout.tsx → build後 tabs/popout.html
 * サブ画面: プレイヤー操作、関連動画、通常コメント、検索、診断、次に再生キュー、
 * タイムスタンプメモを表示する。
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core"
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Check, ChevronDown, ChevronUp, ClipboardCopy, Columns2, CornerDownRight, Expand, GripVertical, ListPlus, ListVideo, Loader2, Maximize2, MessageSquare, Minimize2, Pause, Pin, Play, Plus, RefreshCw, RotateCcw, RotateCw, Rows2, Search, Shrink, Stethoscope, StickyNote, ThumbsUp, Trash2, Volume2, VolumeX, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import {
  DEFAULT_RELATED_DISPLAY_SIZE,
  DEFAULT_SETTINGS,
  LOCAL_KEYS,
  askContent,
  isRelatedDisplaySize,
  isErr,
  type DiagnoseReport,
  type FeedItem,
  type PageState,
  type QueueItem,
  type RelatedDisplaySize,
  type Settings,
  type TimestampNote
} from "~lib/messaging"
import { translateText } from "~lib/deepl"
import { getDictionary, type Dictionary } from "~lib/i18n"
import { DIAGNOSE_VERSION } from "~lib/selectors"
import { usePlayerPort, useSmoothTime, type ConnState } from "~lib/usePlayerPort"
import "~style.css"

const fmt = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return "0:00"
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`
}

type CommentFontSize = "sm" | "md" | "lg"

const COMMENT_SIZE_CLASSES: Record<CommentFontSize, { meta: string; body: string }> = {
  sm: { meta: "text-[11px]", body: "text-[11px]" },
  md: { meta: "text-[12px]", body: "text-[13px]" },
  lg: { meta: "text-[13px]", body: "text-[15px]" }
}

const BADGE_CLASS: Record<ConnState, string> = {
  connected:  "bg-emerald-500/15 text-emerald-400",
  connecting: "bg-slate-500/15 text-slate-400",
  retrying:   "bg-amber-500/15 text-amber-400",
  "no-tab":   "bg-rose-500/15 text-rose-400"
}

const RELATED_SIZE_CLASSES: Record<RelatedDisplaySize, {
  intrinsicSize: string
  button: string
  thumbnail: string
  title: string
  channel: string
}> = {
  sm: {
    intrinsicSize: "92px",
    button: "gap-3 px-4 py-2.5",
    thumbnail: "w-32",
    title: "line-clamp-3 text-[13px] leading-snug",
    channel: "mt-1 text-[11px]"
  },
  md: {
    intrinsicSize: "128px",
    button: "gap-3.5 px-4 py-2.5",
    thumbnail: "w-48",
    title: "line-clamp-3 text-[15px] leading-snug",
    channel: "mt-1 text-[12px]"
  },
  lg: {
    intrinsicSize: "168px",
    button: "gap-4 px-4 py-3",
    thumbnail: "w-64",
    title: "line-clamp-4 text-[17px] leading-snug",
    channel: "mt-1.5 text-[13px]"
  }
}

/**
 * 一覧末尾が表示領域へ入ったら次ページを1度だけ要求する。
 * scrollHeightが短くスクロールイベント自体が起きない初回0件にも対応する。
 */
function usePagingSentinel(
  sentinelRef: React.RefObject<HTMLLIElement>,
  enabled: boolean,
  layoutKey: string,
  state: ConnState,
  page: PageState,
  itemCount: number,
  requestMore: () => void
) {
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (
      !enabled ||
      state !== "connected" ||
      page.phase !== "idle" ||
      !page.hasMore ||
      !sentinel
    ) return

    const root = sentinel.parentElement
    if (!root) return

    let requested = false
    const requestOnce = () => {
      if (requested) return
      requested = true
      requestMore()
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestOnce()
      },
      { root, rootMargin: "200px 0px" }
    )
    observer.observe(sentinel)

    // IntersectionObserverの初回通知を待たず、短いリストは確実に自動充填する。
    const frame = window.requestAnimationFrame(() => {
      if (root.scrollHeight <= root.clientHeight + 200) requestOnce()
    })

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [enabled, itemCount, layoutKey, page.hasMore, page.loaded, page.phase, requestMore, sentinelRef, state])
}

export default function Popout() {
  const {
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
    requestMoreRelated
  } = usePlayerPort()
  const smoothTime = useSmoothTime(status)

  // ドラッグ中は受信STATUSでバーが跳ねないよう、ローカル値を優先する
  const [seeking, setSeeking] = useState<number | null>(null)
  const [volume, setVolume] = useState(50)
  useEffect(() => setSeeking(null), [status?.videoId])
  useEffect(() => {
    if (status) setVolume(status.muted ? 0 : status.volume)
  }, [status?.volume, status?.muted])

  const commitSeek = () => {
    if (seeking !== null) command({ command: "seek", value: seeking })
    setSeeking(null)
  }

  // セレクタ診断（D-19: 壊れた箇所を3秒で特定できる状態を常に保つ）
  const [diag, setDiag] = useState<DiagnoseReport | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [diagBusy, setDiagBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [playerOpen, setPlayerOpen] = useState(false) // 初期は閉じる（サブ画面は一覧を見るのが主目的）
  const [relatedOpen, setRelatedOpen] = useState(true)
  const [commentsOpen, setCommentsOpen] = useState(true)
  const [commentsFullscreen, setCommentsFullscreen] = useState(false)
  const [splitView, setSplitView] = useState(false) // 関連動画とコメントを半々で全画面表示
  const [splitHorizontal, setSplitHorizontal] = useState(false) // true=左右分割 / false=上下分割
  const [splitRatio, setSplitRatio] = useState(0.5) // 関連動画側が占める割合（0.2〜0.8）
  const [windowFullscreen, setWindowFullscreen] = useState(false)

  // ブラウザ側のUI（F11やEscでの解除）と表示を食い違わせないため、イベントで同期する
  useEffect(() => {
    const sync = () => setWindowFullscreen(document.fullscreenElement !== null)
    document.addEventListener("fullscreenchange", sync)
    return () => document.removeEventListener("fullscreenchange", sync)
  }, [])

  const toggleWindowFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      // ユーザー操作起点でないと拒否されることがある。失敗しても表示は壊さない
    }
  }
  const [commentFontSize, setCommentFontSize] = useState<CommentFontSize>("sm")
  const [relatedDisplaySize, setRelatedDisplaySize] = useState<RelatedDisplaySize>(
    DEFAULT_RELATED_DISPLAY_SIZE
  )

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const t = getDictionary(settings.language)

  // 次に再生キュー。background/SWは関与せずPopout単独で状態を持つ
  // （D-05: SWの責務はウィンドウ管理とタブ解決のみ）。storage.localへ都度保存する。
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [queueOpen, setQueueOpen] = useState(true)
  const queueLoaded = useRef(false) // 読み込み完了前の空配列を誤って保存しないためのガード

  // タイムスタンプメモ。動画IDごとの配列としてPopout単独でstorage.localへ保存する
  // （D-05: SWは関与しない。キューと同じ理由）
  const [notesByVideo, setNotesByVideo] = useState<Record<string, TimestampNote[]>>({})
  const [notesOpen, setNotesOpen] = useState(true)
  const notesLoaded = useRef(false)
  const [composingNote, setComposingNote] = useState<{ timestamp: number; text: string } | null>(null)

  // 新規コメントの投稿。投稿自体の反映は既存のコメント自動監視(FEED_APPEND)に任せる
  const [newCommentText, setNewCommentText] = useState("")
  const [newCommentPosting, setNewCommentPosting] = useState(false)
  const [newCommentError, setNewCommentError] = useState<string | null>(null)

  // 前回選んだ文字サイズと、options.tsxで変更された設定を読み込む
  // 開いている間の設定ページからの変更もstorage.onChangedで即時反映する。
  useEffect(() => {
    const applyFontSize = (value: unknown) => {
      if (value === "sm" || value === "md" || value === "lg") setCommentFontSize(value)
    }
    const applySettings = (value: unknown) => {
      const saved = value as Partial<Settings> | undefined
      setSettings({ ...DEFAULT_SETTINGS, ...saved })
    }
    const applyRelatedDisplaySize = (value: unknown) => {
      setRelatedDisplaySize(
        isRelatedDisplaySize(value) ? value : DEFAULT_RELATED_DISPLAY_SIZE
      )
    }
    const applyQueue = (value: unknown) => {
      if (Array.isArray(value)) setQueue(value as QueueItem[])
    }
    const applyNotes = (value: unknown) => {
      if (value && typeof value === "object") setNotesByVideo(value as Record<string, TimestampNote[]>)
    }

    chrome.storage.local.get([
      LOCAL_KEYS.commentFontSize,
      LOCAL_KEYS.relatedDisplaySize,
      LOCAL_KEYS.settings,
      LOCAL_KEYS.splitHorizontal,
      LOCAL_KEYS.splitRatio,
      LOCAL_KEYS.queue,
      LOCAL_KEYS.notes
    ]).then((r) => {
      applyFontSize(r[LOCAL_KEYS.commentFontSize])
      applyRelatedDisplaySize(r[LOCAL_KEYS.relatedDisplaySize])
      applySettings(r[LOCAL_KEYS.settings])
      setSplitHorizontal(r[LOCAL_KEYS.splitHorizontal] === true)
      const ratio = r[LOCAL_KEYS.splitRatio]
      if (typeof ratio === "number" && ratio >= 0.2 && ratio <= 0.8) setSplitRatio(ratio)
      applyQueue(r[LOCAL_KEYS.queue])
      queueLoaded.current = true
      applyNotes(r[LOCAL_KEYS.notes])
      notesLoaded.current = true
    })

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== "local") return
      const settingsChange = changes[LOCAL_KEYS.settings]
      if (settingsChange) applySettings(settingsChange.newValue)
      const fontChange = changes[LOCAL_KEYS.commentFontSize]
      if (fontChange) applyFontSize(fontChange.newValue)
      const relatedSizeChange = changes[LOCAL_KEYS.relatedDisplaySize]
      if (relatedSizeChange) applyRelatedDisplaySize(relatedSizeChange.newValue)
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [])

  // queueが変わるたびに保存する。読み込み完了前（初期値の空配列）で
  // 上書き保存してしまうと、前回保存済みのキューを消してしまうためガードする。
  useEffect(() => {
    if (!queueLoaded.current) return
    void chrome.storage.local.set({ [LOCAL_KEYS.queue]: queue })
  }, [queue])

  useEffect(() => {
    if (!notesLoaded.current) return
    void chrome.storage.local.set({ [LOCAL_KEYS.notes]: notesByVideo })
  }, [notesByVideo])

  const updateCommentFontSize = (size: CommentFontSize) => {
    setCommentFontSize(size)
    void chrome.storage.local.set({ [LOCAL_KEYS.commentFontSize]: size })
  }

  /** サブ画面で選んだ動画をメイン画面で再生する。メインがフルスクリーンならその状態を維持する */
  const playVideo = (videoId: string) => {
    if (tabId === null) return
    void askContent(tabId, "NAVIGATE_TO_VIDEO", { videoId })
  }

  /** 関連動画をキューへ追加する（同じ動画が既にあれば追加しない） */
  const addToQueue = (item: QueueItem) => {
    setQueue((prev) => (prev.some((q) => q.videoId === item.videoId) ? prev : [...prev, item]))
  }

  const removeFromQueue = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id))
  }

  /** キューの項目を選んで即再生する。その項目はキューから取り除く */
  const playFromQueue = (item: QueueItem) => {
    removeFromQueue(item.id)
    playVideo(item.videoId)
  }

  const reorderQueue = (activeId: string, overId: string) => {
    setQueue((prev) => {
      const from = prev.findIndex((q) => q.id === activeId)
      const to = prev.findIndex((q) => q.id === overId)
      if (from === -1 || to === -1) return prev
      return arrayMove(prev, from, to)
    })
  }

  const currentVideoId = status?.videoId ?? null
  const currentNotes = currentVideoId ? notesByVideo[currentVideoId] ?? [] : []

  /** ＋ボタン押下時点の再生位置を凍結してメモ入力欄を開く */
  const startComposingNote = () => {
    if (currentVideoId === null) return
    setComposingNote({ timestamp: seeking ?? smoothTime, text: "" })
  }

  const cancelComposingNote = () => setComposingNote(null)

  const saveComposingNote = () => {
    if (composingNote === null || currentVideoId === null) return
    const content = composingNote.text.trim()
    if (!content) {
      setComposingNote(null)
      return
    }
    const note: TimestampNote = {
      id: crypto.randomUUID(),
      videoId: currentVideoId,
      timestamp: composingNote.timestamp,
      content,
      createdAt: Date.now()
    }
    setNotesByVideo((prev) => {
      const existing = prev[currentVideoId] ?? []
      return { ...prev, [currentVideoId]: [...existing, note].sort((a, b) => a.timestamp - b.timestamp) }
    })
    setComposingNote(null)
  }

  const removeNote = (id: string) => {
    if (currentVideoId === null) return
    setNotesByVideo((prev) => {
      const remaining = (prev[currentVideoId] ?? []).filter((n) => n.id !== id)
      // 最後の1件を消したら動画のキー自体を落とす。空配列を残すと、
      // メモを取って消しただけの動画がstorageに永久に溜まり続ける。
      if (remaining.length === 0) {
        const { [currentVideoId]: _removed, ...rest } = prev
        return rest
      }
      return { ...prev, [currentVideoId]: remaining }
    })
  }

  /** メモの時刻へジャンプする。クリック起点なのでメイン画面のフルスクリーンも維持される */
  const jumpToNote = (timestamp: number) => {
    command({ command: "seek", value: timestamp })
  }

  // 自動連続再生: 動画終了(ended)への立ち上がりを検知したときだけ次を再生する。
  // status.endedはSTATUSが届くたびに何度も"true"のまま再配信され得るため、
  // 直前の値をrefで覚えておき、false→trueの遷移だけを拾う。
  const prevEndedRef = useRef(false)
  useEffect(() => {
    const ended = status?.ended ?? false
    const wasEnded = prevEndedRef.current
    prevEndedRef.current = ended
    if (!ended || wasEnded) return
    if (!settings.autoPlayNext) return
    const next = queue[0]
    if (next) playFromQueue(next)
  }, [status?.ended, settings.autoPlayNext, queue])

  /**
   * 分割ビューの仕切りドラッグ。
   * ★ pointer capture を使う理由: ドラッグ中にカーソルが子要素（リストなど）へ
   *   入ってもイベントを取りこぼさないため。mousemove を window に張る方式より確実。
   */
  const splitBoxRef = useRef<HTMLDivElement>(null)
  const commentSentinelRef = useRef<HTMLLIElement>(null)
  const relatedSentinelRef = useRef<HTMLLIElement>(null)

  const onDividerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const box = splitBoxRef.current
    if (!box) return
    // ReactのcurrentTargetはイベント配送中だけ有効。後から発火するnative listenerでは
    // nullになるため、ここで実DOMを捕捉して以後はそれだけを参照する。
    const divider = e.currentTarget
    divider.setPointerCapture(e.pointerId)

    const move = (ev: PointerEvent) => {
      const r = box.getBoundingClientRect()
      const raw = splitHorizontal
        ? (ev.clientX - r.left) / r.width
        : (ev.clientY - r.top) / r.height
      // 端に寄せ切って片方が消えるのを防ぐ
      setSplitRatio(Math.min(0.8, Math.max(0.2, raw)))
    }
    const finish = (ev: PointerEvent) => {
      if (divider.hasPointerCapture(ev.pointerId)) divider.releasePointerCapture(ev.pointerId)
      divider.removeEventListener("pointermove", move)
      divider.removeEventListener("pointerup", finish)
      divider.removeEventListener("pointercancel", finish)
      // 確定時にだけ保存する（ドラッグ中に毎フレーム書き込まない）
      setSplitRatio((cur) => {
        void chrome.storage.local.set({ [LOCAL_KEYS.splitRatio]: cur })
        return cur
      })
    }
    divider.addEventListener("pointermove", move)
    divider.addEventListener("pointerup", finish)
    divider.addEventListener("pointercancel", finish)
  }

  const updateRelatedDisplaySize = (size: RelatedDisplaySize) => {
    setRelatedDisplaySize(size)
    void chrome.storage.local.set({ [LOCAL_KEYS.relatedDisplaySize]: size })
  }

  /**
   * コメント一覧を最下部付近までスクロールしたら、続きの読み込みを要求する。
   * YouTube本体をスクロールせずにサブ画面だけで読み進められるようにするための仕組み。
   * 読み込み中・完了後の重複要求はページ状態で止める。
   */
  const onFeedScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    if (
      commentPage.phase === "idle" &&
      commentPage.hasMore &&
      el.scrollHeight - el.scrollTop - el.clientHeight < 200
    ) requestMoreFeed()
  }

  const onRelatedScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    if (
      relatedPage.phase === "idle" &&
      relatedPage.hasMore &&
      el.scrollHeight - el.scrollTop - el.clientHeight < 200
    ) requestMoreRelated()
  }

  const commentPagingVisible = splitView || commentsFullscreen || commentsOpen
  const relatedPagingVisible = splitView || (!commentsFullscreen && relatedOpen)
  usePagingSentinel(
    commentSentinelRef,
    commentPagingVisible,
    `${splitView}:${commentsFullscreen}:${commentsOpen}`,
    state,
    commentPage,
    feed.length,
    requestMoreFeed
  )
  usePagingSentinel(
    relatedSentinelRef,
    relatedPagingVisible,
    `${splitView}:${commentsFullscreen}:${relatedOpen}:${relatedDisplaySize}`,
    state,
    relatedPage,
    related?.length ?? 0,
    requestMoreRelated
  )

  // ★ 投稿の失敗を黙って捨てない。メイン画面が未ログイン・投稿欄が無効化されている等、
  //   CS側が ok:false を返す経路は現実に複数ある。何も出さないと「押したのに反応しない」
  //   だけの状態になり、原因の切り分けが一切できなくなる。
  const postNewComment = async () => {
    if (tabId === null || newCommentPosting) return
    const body = newCommentText.trim()
    if (!body) return
    setNewCommentPosting(true)
    setNewCommentError(null)
    const res = await askContent(tabId, "COMMENT_POST", { text: body })
    setNewCommentPosting(false)
    if (isErr(res)) {
      setNewCommentError(t.errCommMain)
      return
    }
    if (!res.data.ok) {
      setNewCommentError(t.errPostFailed)
      return
    }
    setNewCommentText("")
  }

  const [searchQuery, setSearchQuery] = useState("")
  const runSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const query = searchQuery.trim()
    if (tabId === null || !query) return
    void askContent(tabId, "NAVIGATE_SEARCH", { query })
  }

  const runDiagnose = async () => {
    if (tabId === null) return
    setDiagBusy(true)
    setDiagError(null)
    const res = await askContent(tabId, "DIAGNOSE_SELECTORS", undefined)
    setDiagBusy(false)
    if (isErr(res)) {
      // CS未注入が最頻。ページのリロードで直ることを明示する
      setDiag(null)
      setDiagError(`${res.error}（YouTubeタブをリロードしてから再実行してください）`)
      return
    }
    // 受け取った結果が古いCSのものでないかを必ず検査する。
    // 古いままの結果を新しいものと誤認すると、丸ごと1往復を無駄にする。
    if (res.data?.v !== DIAGNOSE_VERSION) {
      setDiag(null)
      setDiagError(
        `古いコードが動作しています（受信 v${res.data?.v ?? "?"} / 期待 v${DIAGNOSE_VERSION}）。` +
          `YouTubeのタブで F5 を押してページを再読み込みしてから、もう一度お試しください。`
      )
      return
    }
    setDiag(res.data)
    setCopied(false)
  }

  const copyDiagnose = async () => {
    if (!diag) return
    await navigator.clipboard.writeText(JSON.stringify(diag, null, 1))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const diagOk = diag ? Object.values(diag.checks).filter((v) => v.ok).length : 0
  const diagAll = diag ? Object.keys(diag.checks).length : 0

  const badgeLabel: Record<ConnState, string> = {
    connected: t.badgeConnected,
    connecting: t.badgeConnecting,
    retrying: t.badgeRetrying,
    "no-tab": t.badgeNoTab
  }
  const badge = { label: badgeLabel[state], cls: BADGE_CLASS[state] }
  const live = status?.kind === "live"
  const displayTime = seeking ?? smoothTime
  const speed = status?.playbackRate ?? 1

  return (
    <div className="flex h-screen flex-col bg-neutral-900 text-neutral-100 antialiased">
      {/* ヘッダー兼検索バー —— 縦の表示領域を稼ぐためタイトル行は廃止し、状態表示もここに統合した */}
      <form onSubmit={runSearch} className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2.5">
        <Search size={14} className="shrink-0 text-neutral-500" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t.searchPlaceholder}
          disabled={state === "no-tab"}
          className="min-w-0 flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none disabled:opacity-40"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            aria-label={t.clearSearch}
            className="shrink-0 rounded p-0.5 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
            <X size={13} />
          </button>
        )}

        {state === "connected" && !splitView && !commentsFullscreen && (
          <button
            type="button"
            onClick={() => setSplitView(true)}
            aria-label={t.splitView}
            title={t.splitView}
            className="shrink-0 rounded p-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
            <Columns2 size={14} />
          </button>
        )}
        {splitView && (
          <>
            <button
              type="button"
              onClick={() => {
                const next = !splitHorizontal
                setSplitHorizontal(next)
                void chrome.storage.local.set({ [LOCAL_KEYS.splitHorizontal]: next })
              }}
              aria-label={splitHorizontal ? t.splitVertical : t.splitHorizontal}
              title={splitHorizontal ? t.splitVertical : t.splitHorizontal}
              className="shrink-0 rounded p-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
              {splitHorizontal ? <Rows2 size={14} /> : <Columns2 size={14} />}
            </button>
            <button
              type="button"
              onClick={() => setSplitView(false)}
              className="flex shrink-0 items-center gap-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 transition hover:bg-neutral-700 active:scale-95">
              <Minimize2 size={12} />
              {t.back}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={toggleWindowFullscreen}
          aria-label={windowFullscreen ? t.exitFullscreen : t.enterFullscreen}
          title={windowFullscreen ? t.exitFullscreen : t.enterFullscreen}
          className="shrink-0 rounded p-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
          {windowFullscreen ? <Shrink size={14} /> : <Expand size={14} />}
        </button>

        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.cls}`}>
          {badge.label}
          {tabId !== null && state === "connected" && (
            <span className="ml-1.5 opacity-60">#{tabId}</span>
          )}
        </span>
      </form>

      <main className="flex-1 overflow-y-auto p-4">
        {state === "no-tab" ? (
          <p className="mt-16 text-center text-sm leading-relaxed text-neutral-500">
            {t.noTabLine1}<br />
            {t.noTabLine2}
          </p>
        ) : splitView ? (
          <div className="flex h-full flex-col">
            {/* 仕切りをドラッグして比率を変えられる。それぞれ独立してスクロールする */}
            <div
              ref={splitBoxRef}
              className={`flex min-h-0 flex-1 ${splitHorizontal ? "flex-row" : "flex-col"}`}>
            <section
              style={{ flexBasis: `${splitRatio * 100}%` }}
              className="flex min-h-0 min-w-0 shrink-0 grow-0 flex-col rounded-lg border border-neutral-800">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 p-2">
                <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-neutral-400">
                  <ListVideo size={12} className="shrink-0" />
                  {t.related}
                  {related && <span className="text-neutral-600">{t.countSuffix(related.length)}</span>}
                </p>
                <RelatedSizeControl value={relatedDisplaySize} onChange={updateRelatedDisplaySize} t={t} />
              </div>
              <ul onScroll={onRelatedScroll} className="min-h-0 flex-1 overflow-y-auto">
                {(related ?? []).map((item) => (
                  <RelatedRow key={item.id} item={item} size={relatedDisplaySize} onPlay={playVideo} onQueue={addToQueue} t={t} />
                ))}
                <PagingTail
                  page={relatedPage}
                  itemCount={related?.length ?? 0}
                  label={t.related}
                  t={t}
                  onRetry={requestMoreRelated}
                  sentinelRef={relatedSentinelRef}
                />
              </ul>
            </section>

            {/* 仕切り。掴みやすいよう見た目より広い当たり判定を持たせる */}
            <div
              onPointerDown={onDividerDrag}
              role="separator"
              aria-orientation={splitHorizontal ? "vertical" : "horizontal"}
              className={`group flex shrink-0 items-center justify-center ${
                splitHorizontal ? "w-3 cursor-col-resize" : "h-3 cursor-row-resize"
              }`}>
              <div
                className={`rounded-full bg-neutral-700 transition group-hover:bg-neutral-500 ${
                  splitHorizontal ? "h-10 w-1" : "h-1 w-10"
                }`}
              />
            </div>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-neutral-800">
              {/* 幅が足りないときは入力欄が次の行へ折り返す（分割表示は片側が狭くなるため） */}
              <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
                <p className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-neutral-400">
                  <MessageSquare size={12} />
                  {t.comments}
                  {feed.length > 0 && <span className="text-neutral-600">{t.countSuffix(feed.length)}</span>}
                </p>
                <NewCommentComposer
                  value={newCommentText}
                  onChange={setNewCommentText}
                  onSubmit={() => void postNewComment()}
                  posting={newCommentPosting}
                  disabled={tabId === null}
                  error={newCommentError}
                  t={t}
                />
                <div className="shrink-0">
                  <FontSizeControl value={commentFontSize} onChange={updateCommentFontSize} t={t} />
                </div>
              </div>
              <ul onScroll={onFeedScroll} className="min-h-0 flex-1 overflow-y-auto">
                {feed.map((item) => (
                  <CommentRow key={item.id} item={item} size={commentFontSize} tabId={tabId} t={t} settings={settings} />
                ))}
                <PagingTail
                  page={commentPage}
                  itemCount={feed.length}
                  label={t.comments}
                  t={t}
                  onRetry={requestMoreFeed}
                  sentinelRef={commentSentinelRef}
                />
              </ul>
            </section>
            </div>
          </div>
        ) : commentsFullscreen ? (
          <div className="flex h-full flex-col">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <p className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-neutral-300">
                <MessageSquare size={13} />
                {t.comments}
                {feed.length > 0 && <span className="text-neutral-500">{t.countSuffix(feed.length)}</span>}
              </p>
              <NewCommentComposer
                value={newCommentText}
                onChange={setNewCommentText}
                onSubmit={() => void postNewComment()}
                posting={newCommentPosting}
                disabled={tabId === null}
                error={newCommentError}
                t={t}
              />
              <div className="flex shrink-0 items-center gap-2">
                <FontSizeControl value={commentFontSize} onChange={updateCommentFontSize} t={t} />
                <button
                  onClick={() => setCommentsFullscreen(false)}
                  className="flex items-center gap-1 rounded bg-neutral-800 px-2.5 py-1.5 text-[11px] text-neutral-300 transition hover:bg-neutral-700 active:scale-95">
                  <Minimize2 size={12} />
                  {t.back}
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-800">
              <ul onScroll={onFeedScroll} className="min-h-0 flex-1 overflow-y-auto">
                {feed.map((item) => (
                  <CommentRow key={item.id} item={item} size={commentFontSize} tabId={tabId} t={t} settings={settings} />
                ))}
                <PagingTail
                  page={commentPage}
                  itemCount={feed.length}
                  label={t.comments}
                  t={t}
                  onRetry={requestMoreFeed}
                  sentinelRef={commentSentinelRef}
                />
              </ul>
            </div>
          </div>
        ) : (
          <>
            {/* 動画情報（クリックでプレイヤー全体を折りたたむ） */}
            <button
              onClick={() => setPlayerOpen((v) => !v)}
              className="mb-4 flex w-full items-start justify-between gap-3 text-left">
              <div className="min-w-0">
                <p className="line-clamp-2 text-base font-medium leading-snug">
                  {status?.title || "—"}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {status?.channelName || "—"}
                  {live && (
                    <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold">
                      LIVE
                    </span>
                  )}
                </p>
              </div>
              {playerOpen ? (
                <ChevronUp size={16} className="mt-1 shrink-0 text-neutral-500" />
              ) : (
                <ChevronDown size={16} className="mt-1 shrink-0 text-neutral-500" />
              )}
            </button>

            {/* 折りたたみ中は現在の再生状態だけ1行で表示する */}
            {!playerOpen && (
              <p className="mb-4 text-[11px] tabular-nums text-neutral-500">
                {status?.paused ? t.paused : t.playing}
                {" ・ "}
                {live ? t.live : `${fmt(displayTime)} / ${fmt(status?.duration ?? 0)}`}
              </p>
            )}

            {playerOpen && (
              <>
                {/* シーク */}
                <section className="mb-6">
                  <input
                    type="range"
                    min={0}
                    max={status?.duration || 0}
                    step={0.1}
                    value={displayTime}
                     disabled={live || !status?.duration}
                     onChange={(e) => setSeeking(Number(e.target.value))}
                    onPointerUp={commitSeek}
                    onPointerCancel={commitSeek}
                    onKeyUp={(e) => {
                      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
                        commitSeek()
                      }
                    }}
                    onBlur={commitSeek}
                    className="w-full accent-red-600 disabled:opacity-30"
                  />
                  <div className="mt-1 flex justify-between text-[11px] tabular-nums text-neutral-500">
                    <span>{fmt(displayTime)}</span>
                    <span>{live ? t.live : fmt(status?.duration ?? 0)}</span>
                  </div>
                </section>

                {/* 再生コントロール */}
                <section className="mb-6 flex items-center justify-center gap-3">
                  <IconBtn onClick={() => command({ command: "seekBy", value: -10 })} label={t.seekBack10}>
                    <RotateCcw size={18} />
                  </IconBtn>
                  <button
                    onClick={() => command({ command: "toggle" })}
                    aria-label={status?.paused ? t.play : t.pause}
                    className="grid h-14 w-14 place-items-center rounded-full bg-red-600 transition hover:bg-red-500 active:scale-95">
                    {status?.paused ? <Play size={24} fill="currentColor" /> : <Pause size={24} fill="currentColor" />}
                  </button>
                  <IconBtn onClick={() => command({ command: "seekBy", value: 10 })} label={t.seekForward10}>
                    <RotateCw size={18} />
                  </IconBtn>
                </section>

                {/* 音量 */}
                <section className="mb-6 flex items-center gap-3">
                  <IconBtn
                    onClick={() => command({ command: "mute", value: !status?.muted })}
                    label={status?.muted ? t.unmute : t.mute}>
                    {status?.muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
                  </IconBtn>
                  <input
                    type="range" min={0} max={100}
                    value={volume}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setVolume(v)
                      command({ command: "volume", value: v })
                    }}
                    className="flex-1 accent-neutral-300"
                  />
                  <span className="w-9 text-right text-xs tabular-nums text-neutral-500">{volume}</span>
                </section>

                {/* 再生速度（0.1刻み） */}
                <section className="flex items-center justify-between rounded-lg bg-neutral-800 px-4 py-3">
                  <span className="text-xs text-neutral-400">{t.playbackSpeed}</span>
                  <div className="flex items-center gap-2">
                    <StepBtn onClick={() => command({ command: "speedBy", value: -settings.speedStep })}>−</StepBtn>
                    <button
                      onClick={() => command({ command: "speed", value: 1 })}
                      className="w-14 rounded py-1 text-center text-sm font-semibold tabular-nums hover:bg-neutral-800">
                      {speed.toFixed(2)}x
                    </button>
                    <StepBtn onClick={() => command({ command: "speedBy", value: settings.speedStep })}>＋</StepBtn>
                  </div>
                </section>
              </>
            )}

            {/* 関連動画 —— Phase 1: DOMから抽出したリスト。並び替え・キュー化はPhase 2 */}
            <section className="mt-6 rounded-lg border border-neutral-800">
              <button
                onClick={() => setRelatedOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
                <p className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
                  <ListVideo size={13} />
                  {t.related}
                  {related && <span className="text-neutral-500">{t.countSuffix(related.length)}</span>}
                </p>
                {relatedOpen ? <ChevronUp size={14} className="text-neutral-500" /> : <ChevronDown size={14} className="text-neutral-500" />}
              </button>

              {relatedOpen && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 px-4 py-2">
                  <RelatedSizeControl value={relatedDisplaySize} onChange={updateRelatedDisplaySize} t={t} />
                  <button
                    onClick={requestRelated}
                    disabled={tabId === null}
                    className="flex items-center gap-1 rounded bg-neutral-800 px-2.5 py-1.5 text-[11px] text-neutral-300 transition hover:bg-neutral-700 active:scale-95 disabled:opacity-30">
                    <RefreshCw size={12} />
                    {t.refresh}
                  </button>
                </div>
              )}

              {relatedOpen && (
                <ul onScroll={onRelatedScroll} className="max-h-[min(55vh,32rem)] overflow-y-auto border-t border-neutral-800">
                  {(related ?? []).map((item) => (
                    <RelatedRow key={item.id} item={item} size={relatedDisplaySize} onPlay={playVideo} onQueue={addToQueue} t={t} />
                  ))}
                  <PagingTail
                    page={relatedPage}
                    itemCount={related?.length ?? 0}
                    label={t.related}
                    t={t}
                    onRetry={requestMoreRelated}
                    sentinelRef={relatedSentinelRef}
                  />
                </ul>
              )}
            </section>

            {/* 次に再生キュー —— Phase 2: 関連動画から追加、ドラッグで並べ替え、動画終了で自動再生 */}
            <section className="mt-6 rounded-lg border border-neutral-800">
              <button
                onClick={() => setQueueOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
                <p className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
                  <ListPlus size={13} />
                  {t.queue}
                  {queue.length > 0 && <span className="text-neutral-500">{t.countSuffix(queue.length)}</span>}
                </p>
                {queueOpen ? <ChevronUp size={14} className="text-neutral-500" /> : <ChevronDown size={14} className="text-neutral-500" />}
              </button>

              {queueOpen && queue.length === 0 && (
                <p className="border-t border-neutral-800 px-4 py-3 text-[11px] text-neutral-500">
                  {t.queueEmptyHint}
                </p>
              )}

              {queueOpen && queue.length > 0 && (
                <QueueList queue={queue} onPlay={playFromQueue} onRemove={removeFromQueue} onReorder={reorderQueue} t={t} />
              )}
            </section>

            {/* タイムスタンプメモ —— Phase 2: 現在の再生位置にメモを残し、クリックでジャンプする */}
            <section className="mt-6 rounded-lg border border-neutral-800">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <button
                  onClick={() => setNotesOpen((v) => !v)}
                  className="flex flex-1 items-center gap-1.5 text-left text-xs font-medium text-neutral-300">
                  <StickyNote size={13} />
                  {t.notes}
                  {currentNotes.length > 0 && <span className="text-neutral-500">{t.countSuffix(currentNotes.length)}</span>}
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={startComposingNote}
                    disabled={currentVideoId === null || composingNote !== null}
                    aria-label={t.addNoteAtCurrentTime}
                    title={t.addNoteAtCurrentTime}
                    className="rounded p-1.5 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300 disabled:opacity-30">
                    <Plus size={14} />
                  </button>
                  <button
                    onClick={() => setNotesOpen((v) => !v)}
                    aria-label={notesOpen ? t.collapse : t.expand}
                    className="rounded p-1.5 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
                    {notesOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>

              {composingNote !== null && (
                <div className="border-t border-neutral-800 px-4 py-3">
                  <p className="mb-2 text-[11px] tabular-nums text-neutral-500">
                    {t.addNoteAt(fmt(composingNote.timestamp))}
                  </p>
                  <textarea
                    autoFocus
                    value={composingNote.text}
                    onChange={(e) =>
                      setComposingNote((prev) => (prev ? { ...prev, text: e.target.value } : prev))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        saveComposingNote()
                      } else if (e.key === "Escape") {
                        cancelComposingNote()
                      }
                    }}
                    placeholder={t.notePlaceholder}
                    rows={2}
                    className="w-full resize-none rounded bg-neutral-800 px-2.5 py-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      onClick={cancelComposingNote}
                      className="rounded px-2.5 py-1 text-[11px] text-neutral-400 transition hover:bg-neutral-800">
                      {t.cancel}
                    </button>
                    <button
                      onClick={saveComposingNote}
                      className="rounded bg-red-600 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-red-500">
                      {t.save}
                    </button>
                  </div>
                </div>
              )}

              {notesOpen && currentNotes.length === 0 && composingNote === null && (
                <p className="border-t border-neutral-800 px-4 py-3 text-[11px] text-neutral-500">
                  {t.notesEmptyHint}
                </p>
              )}

              {notesOpen && currentNotes.length > 0 && (
                <ul className="max-h-72 overflow-y-auto border-t border-neutral-800">
                  {currentNotes.map((note) => (
                    <NoteRow key={note.id} note={note} onJump={jumpToNote} onRemove={removeNote} t={t} />
                  ))}
                </ul>
              )}
            </section>

            {/* コメント —— Phase 1: DOMを自動監視して流れてくる。装飾UI(絵文字トークン等)はPhase 2 */}
            <section className="mt-6 rounded-lg border border-neutral-800">
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                <button
                  onClick={() => setCommentsOpen((v) => !v)}
                  className="flex shrink-0 items-center gap-1.5 text-left text-xs font-medium text-neutral-300">
                  <MessageSquare size={13} />
                  {t.comments}
                  {feed.length > 0 && <span className="text-neutral-500">{t.countSuffix(feed.length)}</span>}
                </button>
                {commentsOpen && (
                  <NewCommentComposer
                    value={newCommentText}
                    onChange={setNewCommentText}
                    onSubmit={() => void postNewComment()}
                    posting={newCommentPosting}
                    disabled={tabId === null}
                    error={newCommentError}
                    t={t}
                  />
                )}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {commentsOpen && feed.length > 0 && (
                    <FontSizeControl value={commentFontSize} onChange={updateCommentFontSize} t={t} />
                  )}
                  {feed.length > 0 && (
                    <button
                      onClick={() => setCommentsFullscreen(true)}
                      aria-label={t.showFullscreen}
                      className="rounded p-1.5 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
                      <Maximize2 size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => setCommentsOpen((v) => !v)}
                    aria-label={commentsOpen ? t.collapse : t.expand}
                    className="rounded p-1.5 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
                    {commentsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>

              {commentsOpen && (
                <ul onScroll={onFeedScroll} className="max-h-72 overflow-y-auto border-t border-neutral-800">
                  {feed.map((item) => (
                    <CommentRow key={item.id} item={item} size={commentFontSize} tabId={tabId} t={t} settings={settings} />
                  ))}
                  <PagingTail
                    page={commentPage}
                    itemCount={feed.length}
                    label={t.comments}
                    t={t}
                    onRetry={requestMoreFeed}
                    sentinelRef={commentSentinelRef}
                  />
                </ul>
              )}
            </section>

            {/* セレクタ診断 —— YouTubeのDOM変更で壊れた箇所を特定する */}
            <section className="mt-6 rounded-lg border border-neutral-800">
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
                    <Stethoscope size={13} />
                    {t.diagnostics}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-snug text-neutral-500">
                    {diag
                      ? t.diagSummary(diag.v, diagOk, diagAll, Object.keys(diag.samples ?? {}).length)
                      : t.diagHint}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {diag && (
                    <button
                      onClick={copyDiagnose}
                      className="flex items-center gap-1 rounded bg-neutral-800 px-2.5 py-1.5 text-[11px] text-neutral-300 transition hover:bg-neutral-700 active:scale-95">
                      {copied ? <Check size={12} /> : <ClipboardCopy size={12} />}
                      {copied ? t.copied : t.copyResult}
                    </button>
                  )}
                  <button
                    onClick={runDiagnose}
                    disabled={diagBusy || tabId === null}
                    className="rounded bg-neutral-100 px-3 py-1.5 text-[11px] font-medium text-neutral-900 transition hover:bg-white active:scale-95 disabled:opacity-30">
                    {diagBusy ? t.diagRunning : t.diagRun}
                  </button>
                </div>
              </div>

              {diagError && (
                <p className="border-t border-neutral-800 px-4 py-2.5 text-[11px] leading-snug text-rose-400">
                  {diagError}
                </p>
              )}

              {diag && (
                <div className="max-h-80 overflow-y-auto border-t border-neutral-800">
                  <table className="w-full table-fixed text-[11px]">
                    <tbody>
                      {Object.entries(diag.checks).map(([key, v]) => (
                        <tr key={key} className="border-b border-neutral-950 last:border-0">
                          <td className="w-[42%] py-1.5 pl-4 pr-2">
                            <span className={v.ok ? "text-emerald-400" : "text-rose-400"}>
                              {v.ok ? "●" : "×"}
                            </span>
                            <span className="ml-1.5 text-neutral-300">{key}</span>
                          </td>
                          <td className="truncate px-2 font-mono text-neutral-500" title={v.sel ?? ""}>
                            {v.sel ?? "—"}
                          </td>
                          <td className="w-12 py-1.5 pr-4 text-right tabular-nums text-neutral-500">
                            {v.n}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function PagingTail({
  page,
  itemCount,
  label,
  t,
  onRetry,
  sentinelRef
}: {
  page: PageState
  itemCount: number
  label: string
  t: Dictionary
  onRetry: () => void
  sentinelRef: React.RefObject<HTMLLIElement>
}) {
  let content: React.ReactNode

  if (page.phase === "loading") {
    content = (
      <span className="inline-flex items-center gap-1.5">
        <RefreshCw size={11} className="animate-spin" />
        {t.pagingLoading(label)}
      </span>
    )
  } else if (page.phase === "error") {
    content = (
      <span className="inline-flex flex-wrap items-center justify-center gap-2">
        <span className="text-rose-400">{page.error || t.pagingErrorFallback(label)}</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-300 transition hover:bg-neutral-700">
          {t.pagingRetry}
        </button>
      </span>
    )
  } else if (page.phase === "done" || !page.hasMore) {
    content = itemCount === 0
      ? t.pagingEmpty(label)
      : t.pagingDone(label, itemCount)
  } else {
    content = itemCount === 0
      ? t.pagingAutoFirst(label)
      : t.pagingAutoMore(label)
  }

  return (
    <li
      ref={sentinelRef}
      aria-live="polite"
      className="min-h-10 border-t border-neutral-950 px-3 py-2 text-center text-[11px] text-neutral-500">
      {content}
    </li>
  )
}

function IconBtn({ onClick, label, children }: {
  onClick: () => void; label: string; children: React.ReactNode
}) {
  return (
    <button onClick={onClick} aria-label={label}
      className="grid h-10 w-10 place-items-center rounded-full text-neutral-300 transition hover:bg-neutral-800 active:scale-95">
      {children}
    </button>
  )
}

function StepBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="h-8 w-8 rounded bg-neutral-800 text-lg leading-none transition hover:bg-neutral-700 active:scale-95">
      {children}
    </button>
  )
}

/** 関連動画1件。クリックでメイン画面をその動画へ遷移させる */
function RelatedRow({ item, size, onPlay, onQueue, t }: {
  item: QueueItem
  size: RelatedDisplaySize
  onPlay: (videoId: string) => void
  onQueue: (item: QueueItem) => void
  t: Dictionary
}) {
  const cls = RELATED_SIZE_CLASSES[size]
  return (
    <li
      style={{ contentVisibility: "auto", containIntrinsicSize: cls.intrinsicSize }}
      className="flex items-stretch border-b border-neutral-950 last:border-0">
      <button
        onClick={() => onPlay(item.videoId)}
        title={t.playInMain}
        className={`flex min-w-0 flex-1 overflow-hidden text-left transition hover:bg-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500/70 ${cls.button}`}>
        <div
          style={{ aspectRatio: "16 / 9" }}
          className={`relative max-w-[60%] shrink-0 overflow-hidden rounded bg-neutral-800 ${cls.thumbnail}`}>
          <RelatedThumbnail item={item} />
          {item.duration > 0 && (
            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[9px] tabular-nums text-white">
              {fmt(item.duration)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-neutral-200 ${cls.title}`}>{item.title || t.titleLoading}</p>
          <p className={`truncate text-neutral-500 ${cls.channel}`}>{item.channelName || "—"}</p>
        </div>
      </button>
      <button
        onClick={() => onQueue(item)}
        title={t.addToQueue}
        aria-label={t.addToQueue}
        className="shrink-0 self-center rounded p-1.5 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
        <ListPlus size={16} />
      </button>
    </li>
  )
}

function RelatedThumbnail({ item }: { item: QueueItem }) {
  const validVideoId = /^[A-Za-z0-9_-]{11}$/.test(item.videoId)
  const base = validVideoId
    ? `https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}`
    : null
  const candidates = Array.from(new Set([
    item.thumbnailUrl,
    base ? `${base}/mqdefault.jpg` : "",
    base ? `${base}/hqdefault.jpg` : "",
    base ? `${base}/default.jpg` : ""
  ].filter((value): value is string => value.length > 0)))
  const [candidateIndex, setCandidateIndex] = useState(0)

  useEffect(() => setCandidateIndex(0), [item.thumbnailUrl, item.videoId])
  const src = candidates[candidateIndex]
  if (!src) {
    return (
      <span className="grid h-full w-full place-items-center text-neutral-600" aria-hidden="true">
        <ListVideo size={16} />
      </span>
    )
  }

  return (
    <img
      src={src}
      alt=""
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setCandidateIndex((index) => index + 1)}
      className="h-full w-full object-cover"
    />
  )
}

/** 次に再生キューの本体。dnd-kitでドラッグ並べ替えできる */
function QueueList({ queue, onPlay, onRemove, onReorder, t }: {
  queue: QueueItem[]
  onPlay: (item: QueueItem) => void
  onRemove: (id: string) => void
  onReorder: (activeId: string, overId: string) => void
  t: Dictionary
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (over && active.id !== over.id) reorderQueueIds(active.id, over.id)
  }
  // dnd-kitのidはstring|numberのunion。このアプリでは常にstringのUUIDを渡している
  const reorderQueueIds = (activeId: string | number, overId: string | number) =>
    onReorder(String(activeId), String(overId))

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}>
      <SortableContext items={queue.map((q) => q.id)} strategy={verticalListSortingStrategy}>
        <ul className="border-t border-neutral-800">
          {queue.map((item, index) => (
            <QueueRow key={item.id} item={item} index={index} onPlay={onPlay} onRemove={onRemove} t={t} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function QueueRow({ item, index, onPlay, onRemove, t }: {
  item: QueueItem
  index: number
  onPlay: (item: QueueItem) => void
  onRemove: (id: string) => void
  t: Dictionary
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 border-b border-neutral-950 bg-neutral-800 px-1 py-1.5 last:border-0">
      <button
        {...attributes}
        {...listeners}
        aria-label={t.dragToReorder}
        className="shrink-0 cursor-grab touch-none rounded p-1.5 text-neutral-600 transition hover:text-neutral-400 active:cursor-grabbing">
        <GripVertical size={14} />
      </button>
      <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-neutral-600">{index + 1}</span>
      <button
        onClick={() => onPlay(item)}
        title={t.playAndRemoveFromQueue}
        className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded py-1 text-left transition hover:bg-neutral-800">
        <div
          style={{ aspectRatio: "16 / 9" }}
          className="relative w-16 shrink-0 overflow-hidden rounded bg-neutral-800">
          <RelatedThumbnail item={item} />
          {item.duration > 0 && (
            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[9px] tabular-nums text-white">
              {fmt(item.duration)}
            </span>
          )}
        </div>
        <div className="min-w-0">
          <p className="line-clamp-2 text-[12px] leading-snug text-neutral-200">{item.title || t.titleLoading}</p>
          <p className="truncate text-[10px] text-neutral-500">{item.channelName || "—"}</p>
        </div>
      </button>
      <button
        onClick={() => onRemove(item.id)}
        aria-label={t.removeFromQueue}
        title={t.removeFromQueue}
        className="shrink-0 rounded p-1.5 text-neutral-600 transition hover:bg-neutral-800 hover:text-neutral-300">
        <Trash2 size={14} />
      </button>
    </li>
  )
}

function NoteRow({ note, onJump, onRemove, t }: {
  note: TimestampNote
  onJump: (timestamp: number) => void
  onRemove: (id: string) => void
  t: Dictionary
}) {
  return (
    <li className="flex items-start gap-1 border-b border-neutral-950 last:border-0">
      <button
        onClick={() => onJump(note.timestamp)}
        title={t.jumpToPosition}
        className="min-w-0 flex-1 px-4 py-2.5 text-left transition hover:bg-neutral-950">
        <span className="text-[11px] font-medium tabular-nums text-red-400">{fmt(note.timestamp)}</span>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-neutral-300">{note.content}</p>
      </button>
      <button
        onClick={() => onRemove(note.id)}
        aria-label={t.deleteNote}
        title={t.delete}
        className="shrink-0 self-center rounded p-1.5 text-neutral-600 transition hover:bg-neutral-800 hover:text-rose-400">
        <Trash2 size={13} />
      </button>
    </li>
  )
}

/** 件数を短く表示する。1000未満はそのまま、以上は"1.2万"のような概算にはせず単純にkカンマ区切り */
const fmtCount = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString())

function CommentRow({ item, size, tabId, t, settings, isReply = false }: {
  item: FeedItem; size: CommentFontSize; tabId: number | null; t: Dictionary
  settings: Settings; isReply?: boolean
}) {
  const cls = COMMENT_SIZE_CLASSES[size]

  // コメントの手動翻訳（DeepL）。押した時だけ送信し、結果はこの行の中だけで保持する
  // （タブを開き直す・コメント一覧を作り直すと消える。永続化は不要な一時表示のため）。
  const [translated, setTranslated] = useState<{ text: string; sourceLang: string } | null>(null)
  const [translating, setTranslating] = useState(false)
  const [translateError, setTranslateError] = useState<string | null>(null)

  const translateErrorMessage = (code: string): string => {
    if (code === "NO_API_KEY") return t.translateErrNoKey
    if (code === "INVALID_KEY") return t.translateErrInvalidKey
    if (code === "QUOTA_EXCEEDED") return t.translateErrQuota
    if (code === "NETWORK_ERROR") return t.translateErrNetwork
    return t.translateErrGeneric
  }

  const toggleTranslate = async () => {
    if (translated) {
      setTranslated(null)
      setTranslateError(null)
      return
    }
    if (translating) return
    setTranslating(true)
    setTranslateError(null)
    const res = await translateText(settings.deeplApiKey, item.text, settings.translateTargetLang)
    setTranslating(false)
    if (!res.ok) {
      setTranslateError(translateErrorMessage(res.error))
      return
    }
    setTranslated({ text: res.data.text, sourceLang: res.data.detectedSourceLang })
  }

  // いいね: 初期値はコメント取得時点のDOMスナップショット。押した後はCSからの
  // 読み戻し値を正とする（楽観的更新でメインと状態がズレるのを避けるため）
  const [liked, setLiked] = useState(item.liked ?? false)
  const [likeCount, setLikeCount] = useState(item.likeCount)
  const [likeBusy, setLikeBusy] = useState(false)

  const toggleLike = async () => {
    if (tabId === null || likeBusy) return
    setLikeBusy(true)
    const res = await askContent(tabId, "COMMENT_TOGGLE_LIKE", { commentId: item.id })
    setLikeBusy(false)
    if (isErr(res)) return
    setLiked(res.data.liked)
    setLikeCount(res.data.likeCount)
  }

  // 返信: 一度読み込んだら保持し、開閉だけならメイン画面を再クリックしない
  const [repliesOpen, setRepliesOpen] = useState(false)
  const [replies, setReplies] = useState<FeedItem[] | null>(null)
  const [repliesLoading, setRepliesLoading] = useState(false)
  // 読み込み済みなら実件数、未読み込みならDOM取得時点のスナップショット値を使う
  // （自分で返信を投稿した直後は元のreplyCountが古くなるため）
  const displayReplyCount = replies ? replies.length : item.replyCount

  const toggleReplies = async () => {
    if (repliesOpen) {
      setRepliesOpen(false)
      return
    }
    if (replies !== null) {
      setRepliesOpen(true)
      return
    }
    if (tabId === null || repliesLoading) return
    setRepliesLoading(true)
    const res = await askContent(tabId, "COMMENT_LOAD_REPLIES", { commentId: item.id })
    setRepliesLoading(false)
    if (isErr(res)) return
    setReplies(res.data.items)
    setRepliesOpen(true)
  }

  // 返信の投稿
  const [replying, setReplying] = useState(false)
  const [replyText, setReplyText] = useState("")
  const [replyPosting, setReplyPosting] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [replyNotice, setReplyNotice] = useState<string | null>(null)

  const postReply = async () => {
    if (tabId === null || replyPosting) return
    const body = replyText.trim()
    if (!body) return
    setReplyPosting(true)
    setReplyError(null)
    const res = await askContent(tabId, "COMMENT_REPLY", { commentId: item.id, text: body })
    setReplyPosting(false)
    if (isErr(res)) {
      setReplyError(t.errCommMain)
      return
    }
    if (!res.data.ok) {
      setReplyError(t.errReplyFailed)
      return
    }
    setReplyText("")
    setReplying(false)
    // ★ 投稿の成否と、一覧を読み戻せたかは別の話。空配列で上書きすると
    //   「返信を取得できませんでした」が出て投稿自体が失敗したように見えるため、
    //   読み戻せなかったときは一覧に触れず、投稿できた旨だけを伝える。
    if (res.data.items.length > 0) {
      setReplies(res.data.items)
      setRepliesOpen(true)
      setReplyNotice(null)
    } else {
      setReplyNotice(t.replyPostedNoticeNoRefresh)
    }
  }

  return (
    <li
      style={{ contentVisibility: "auto", containIntrinsicSize: "84px" }}
      className={`flex gap-2.5 border-b border-neutral-950 px-4 py-2 last:border-0 ${isReply ? "bg-neutral-950/40" : ""}`}>
      <div className="h-7 w-7 shrink-0 overflow-hidden rounded-full bg-neutral-800">
        {item.avatarUrl && (
          <img src={item.avatarUrl} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {/* 固定コメントの帯。YouTube本体と同じく投稿者名の上に出す */}
        {item.pinnedLabel && (
          <p className="flex items-center gap-1 text-[10px] text-neutral-500">
            <Pin size={10} className="shrink-0" />
            <span className="truncate">{item.pinnedLabel}</span>
          </p>
        )}
        <p className={`flex items-baseline gap-1.5 text-neutral-400 ${cls.meta}`}>
          <span className="truncate font-medium text-neutral-300">{item.author || "—"}</span>
          {item.publishedAt && <span className="shrink-0 text-neutral-600">{item.publishedAt}</span>}
        </p>
        <p className={`mt-0.5 whitespace-pre-wrap break-words leading-snug text-neutral-300 ${cls.body}`}>
          <CommentBody item={item} tabId={tabId} />
        </p>
        {translated && (
          <div className="mt-1 rounded bg-neutral-950/60 px-2 py-1.5">
            <p className={`whitespace-pre-wrap break-words leading-snug text-neutral-200 ${cls.body}`}>
              {translated.text}
            </p>
            <p className="mt-0.5 text-[10px] text-neutral-600">{t.translatedBy(translated.sourceLang)}</p>
          </div>
        )}
        {translateError && (
          <p className="mt-1 text-[11px] leading-snug text-red-400">{translateError}</p>
        )}

        <div className="mt-1 flex items-center gap-3">
          <button
            onClick={toggleLike}
            disabled={tabId === null || likeBusy}
            aria-pressed={liked}
            aria-label={liked ? t.unlike : t.like}
            className={`flex items-center gap-1 rounded px-1 py-0.5 text-[11px] transition disabled:opacity-40 ${
              liked ? "text-red-500" : "text-neutral-500 hover:text-neutral-300"
            }`}>
            <ThumbsUp size={12} fill={liked ? "currentColor" : "none"} />
            {likeCount !== undefined && likeCount > 0 && <span className="tabular-nums">{fmtCount(likeCount)}</span>}
          </button>

          {settings.deeplApiKey.trim() !== "" && (
            <button
              onClick={toggleTranslate}
              disabled={translating}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-neutral-500 transition hover:text-neutral-300 disabled:opacity-40">
              {translating && <Loader2 size={12} className="animate-spin" />}
              {translating ? t.translating : translated ? t.showOriginal : t.translateAction}
            </button>
          )}

          {!isReply && !!displayReplyCount && (
            <button
              onClick={toggleReplies}
              disabled={repliesLoading}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-neutral-500 transition hover:text-neutral-300 disabled:opacity-40">
              {repliesLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : repliesOpen ? (
                <ChevronUp size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
              <CornerDownRight size={12} />
              {t.replyCount(displayReplyCount ?? 0)}
            </button>
          )}

          {!isReply && (
            <button
              onClick={() => {
                setReplyNotice(null)
                setReplyError(null)
                setReplying((v) => !v)
              }}
              disabled={tabId === null}
              className="rounded px-1 py-0.5 text-[11px] text-neutral-500 transition hover:text-neutral-300 disabled:opacity-40">
              {t.replyAction}
            </button>
          )}
        </div>

        {!isReply && replying && (
          <div className="mt-1.5">
            <textarea
              autoFocus
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void postReply()
                } else if (e.key === "Escape") {
                  setReplying(false)
                  setReplyText("")
                }
              }}
              placeholder={t.replyPlaceholder}
              rows={2}
              className="w-full resize-none rounded bg-neutral-800 px-2 py-1.5 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
            />
            {replyError && <p className="mt-1 text-[11px] leading-snug text-red-400">{replyError}</p>}
            <div className="mt-1 flex justify-end gap-2">
              <button
                onClick={() => {
                  setReplying(false)
                  setReplyText("")
                }}
                className="rounded px-2 py-1 text-[11px] text-neutral-400 transition hover:bg-neutral-800">
                {t.cancel}
              </button>
              <button
                onClick={postReply}
                disabled={replyPosting || !replyText.trim()}
                className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-red-500 disabled:opacity-40">
                {replyPosting ? t.posting : t.postButton}
              </button>
            </div>
          </div>
        )}

        {repliesOpen && replies && replies.length > 0 && (
          <ul className="mt-1 border-l border-neutral-800 pl-2">
            {replies.map((reply) => (
              <CommentRow key={reply.id} item={reply} size={size} tabId={tabId} t={t} settings={settings} isReply />
            ))}
          </ul>
        )}
        {repliesOpen && replies && replies.length === 0 && (
          <p className="mt-1 pl-2 text-[11px] text-neutral-600">{t.repliesUnavailable}</p>
        )}
        {replyNotice && (
          <p className="mt-1 pl-2 text-[11px] text-neutral-500">{replyNotice}</p>
        )}
      </div>
    </li>
  )
}

/**
 * コメント本文。リンクは青字で表示し、クリックでブラウザの別タブに開く。
 *
 * ★ 表示テキストからURLを組み立て直さない。YouTubeは長いURLを「…」で省略表示するため、
 *   テキスト由来だと壊れたURLになる。CS側が`<a href>`から取った実URLだけを使う。
 * ★ 素の target="_blank" は使わない。サブ画面は type:"popup" の特殊ウィンドウなので、
 *   通常タブではなく別のポップアップとして開かれることがある。
 */
function CommentBody({ item, tabId }: { item: FeedItem; tabId: number | null }) {
  if (item.tokens.length === 0) return <>{item.text}</>
  return (
    <>
      {item.tokens.map((token, index) => {
        if (token.t === "text") return <span key={index}>{token.v}</span>
        if (token.t === "emoji") {
          return (
            <img
              key={index}
              src={token.url}
              alt={token.alt}
              className="inline-block h-4 w-4 align-text-bottom"
            />
          )
        }
        if (token.t === "timestamp") {
          return (
            <a
              key={index}
              href="#"
              // 別タブは開かず、メイン画面をその時刻へシークする
              onClick={(e) => {
                e.preventDefault()
                if (tabId !== null) {
                  void askContent(tabId, "PLAYER_COMMAND", { command: "seek", value: token.seconds })
                }
              }}
              className="text-sky-400 underline underline-offset-2 transition hover:text-sky-300">
              {token.v}
            </a>
          )
        }
        return (
          <a
            key={index}
            href={token.href}
            // 表示文字と飛び先が食い違うリンクは珍しくないので、実URLを必ず確認できるようにする
            title={token.href}
            onClick={(e) => {
              e.preventDefault()
              void chrome.tabs.create({ url: token.href })
            }}
            className="break-all text-sky-400 underline underline-offset-2 transition hover:text-sky-300">
            {token.v}
          </a>
        )
      })}
    </>
  )
}

function NewCommentComposer({ value, onChange, onSubmit, posting, disabled, error, t }: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  posting: boolean
  disabled: boolean
  error: string | null
  t: Dictionary
}) {
  // 見出し行に横並びで置くため、通常は1行分の高さに収める。
  // ★ textareaのままにしてShift+Enterの改行を残す（inputに変えると複数行コメントが打てなくなる）。
  //   改行が入ったときだけ3行に広げる。
  const active = value.trim().length > 0
  return (
    <div className="min-w-[7rem] flex-1">
      <div className="flex items-center gap-1">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              onSubmit()
            } else if (e.key === "Escape") {
              onChange("")
            }
          }}
          placeholder={t.commentPlaceholder}
          disabled={disabled}
          rows={value.includes("\n") ? 3 : 1}
          className="min-w-0 flex-1 resize-none rounded bg-neutral-800 px-2 py-1 text-[11px] leading-5 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-600 disabled:opacity-40"
        />
        {active && (
          <>
            <button
              onClick={() => onChange("")}
              aria-label={t.cancel}
              className="shrink-0 rounded p-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-300">
              <X size={12} />
            </button>
            <button
              onClick={onSubmit}
              disabled={posting}
              className="shrink-0 rounded bg-red-600 px-2 py-1 text-[10px] font-medium text-white transition hover:bg-red-500 disabled:opacity-40">
              {posting ? t.posting : t.postButton}
            </button>
          </>
        )}
      </div>
      {error && <p className="mt-1 text-[10px] leading-snug text-red-400">{error}</p>}
    </div>
  )
}

function FontSizeControl({ value, onChange, t }: {
  value: CommentFontSize; onChange: (size: CommentFontSize) => void; t: Dictionary
}) {
  const OPTIONS: { key: CommentFontSize; label: string }[] = [
    { key: "sm", label: t.small },
    { key: "md", label: t.medium },
    { key: "lg", label: t.large }
  ]
  return (
    <div className="flex items-center overflow-hidden rounded border border-neutral-700">
      {OPTIONS.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          aria-label={t.fontSizeLabel(opt.label)}
          className={`px-1.5 py-1 text-[10px] transition ${
            value === opt.key
              ? "bg-neutral-700 text-neutral-100"
              : "text-neutral-500 hover:bg-neutral-800"
          }`}>
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function RelatedSizeControl({ value, onChange, t }: {
  value: RelatedDisplaySize
  onChange: (size: RelatedDisplaySize) => void
  t: Dictionary
}) {
  const OPTIONS: { key: RelatedDisplaySize; label: string }[] = [
    { key: "sm", label: t.small },
    { key: "md", label: t.medium },
    { key: "lg", label: t.large }
  ]
  return (
    <div
      role="group"
      aria-label={t.relatedSizeGroupLabel}
      className="flex max-w-full shrink-0 items-center overflow-hidden rounded border border-neutral-700">
      {OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          aria-label={t.relatedSizeLabel(opt.label)}
          aria-pressed={value === opt.key}
          className={`px-1.5 py-1 text-[10px] transition focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500/70 ${
            value === opt.key
              ? "bg-neutral-700 text-neutral-100"
              : "text-neutral-500 hover:bg-neutral-800"
          }`}>
          {opt.label}
        </button>
      ))}
    </div>
  )
}

