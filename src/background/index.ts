/**
 * src/background/index.ts — Service Worker
 * 責務は2つだけ:
 *   ① Popoutウィンドウの生成 / 前面化 / 位置記憶
 *   ② 「今どのタブを操作対象にするか」の解決と保持
 * ⚠ SWは約30秒で停止する。グローバル変数に状態を持たせないこと。
 */
import {
  registerHandlers,
  SESSION_KEYS,
  LOCAL_KEYS,
  DEFAULT_SETTINGS,
  type Settings
} from "~lib/messaging"

const POPOUT_PATH = "tabs/popout.html"
const DEFAULT_BOUNDS = { width: 460, height: 940, left: 100, top: 100 }
const YT_WATCH_PATTERN = "https://www.youtube.com/*"

type Bounds = { width: number; height: number; left: number; top: number }

// 永続状態ではなく、同一SWインスタンス内で同時発火した生成処理だけを束ねる。
// 正式なウィンドウIDはD-06どおりstorage.sessionを正とする。
let popoutOpenTask: Promise<number> | null = null

/* ---------- storage ヘルパ ---------- */
const sGet = async <T,>(k: string): Promise<T | null> =>
  ((await chrome.storage.session.get(k))[k] as T) ?? null
const sSet = (k: string, v: unknown) => chrome.storage.session.set({ [k]: v })
const sDel = (k: string) => chrome.storage.session.remove(k)

/* ---------- ① 対象タブの解決 ---------- */

async function isTabAlive(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return !!tab.url?.startsWith("https://www.youtube.com/")
  } catch {
    return false // 閉じられている
  }
}

/**
 * 保存済みタブを検証 → 死んでいればYouTubeタブを再探索。
 * 「アクティブなタブ」を優先し、なければ最初の1件。
 */
async function resolveTargetTab(): Promise<number | null> {
  const saved = await sGet<number>(SESSION_KEYS.targetTabId)
  if (saved !== null && (await isTabAlive(saved))) return saved

  const tabs = await chrome.tabs.query({ url: YT_WATCH_PATTERN })
  if (tabs.length === 0) {
    await sDel(SESSION_KEYS.targetTabId)
    return null
  }
  const picked = tabs.find((t) => t.active) ?? tabs[0]
  if (picked?.id === undefined) return null

  await sSet(SESSION_KEYS.targetTabId, picked.id)
  return picked.id
}

/* ---------- ② Popoutウィンドウ管理 ---------- */

async function loadSettings(): Promise<Settings> {
  const o = await chrome.storage.local.get(LOCAL_KEYS.settings)
  return { ...DEFAULT_SETTINGS, ...(o[LOCAL_KEYS.settings] as Partial<Settings> | undefined) }
}

async function loadBounds(): Promise<Bounds> {
  const o = await chrome.storage.local.get(LOCAL_KEYS.popoutBounds)
  return { ...DEFAULT_BOUNDS, ...(o[LOCAL_KEYS.popoutBounds] as Partial<Bounds> | undefined) }
}

/**
 * @param focus 既に開いている場合に前面化するか。
 *   自動オープン（動画を開くたび）で true にすると、動画を切り替えるたびに
 *   サブ画面へフォーカスが奪われて視聴の邪魔になるため false を渡す。
 */
async function openOrFocusPopoutOnce(focus: boolean): Promise<number> {
  const existing = await sGet<number>(SESSION_KEYS.popoutWindowId)
  if (existing !== null) {
    try {
      if (focus) await chrome.windows.update(existing, { focused: true })
      else await chrome.windows.get(existing) // 生存確認だけ行う
      return existing // 二重起動を防ぐ（Portの二重接続対策）
    } catch {
      await sDel(SESSION_KEYS.popoutWindowId) // 既に閉じられていた
    }
  }

  const bounds = await loadBounds()
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(POPOUT_PATH),
    type: "popup", // タブバーなしの独立ウィンドウ
    focused: focus,
    ...bounds
  })
  if (!win?.id) throw new Error("POPOUT_CREATE_FAILED")

  await sSet(SESSION_KEYS.popoutWindowId, win.id)
  return win.id
}

async function openOrFocusPopout(focus = true): Promise<number> {
  const pending = popoutOpenTask
  if (pending !== null) {
    const windowId = await pending
    // 先行呼び出しが自動起動（focus=false）でも、後続の手動操作は前面化する。
    if (focus) await chrome.windows.update(windowId, { focused: true })
    return windowId
  }

  const task = openOrFocusPopoutOnce(focus)
  popoutOpenTask = task
  try {
    return await task
  } finally {
    if (popoutOpenTask === task) popoutOpenTask = null
  }
}

/* ---------- 起動トリガ ---------- */

// default_popup を宣言していないので onClicked が発火する
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id !== undefined && tab.url?.startsWith("https://www.youtube.com/")) {
    await sSet(SESSION_KEYS.targetTabId, tab.id) // クリック元を対象に確定
  }
  await openOrFocusPopout()
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "open-popout") return
  if (tab.id !== undefined && tab.url?.startsWith("https://www.youtube.com/")) {
    await sSet(SESSION_KEYS.targetTabId, tab.id)
  }
  await openOrFocusPopout()
})

/* ---------- ライフサイクル同期 ---------- */

chrome.windows.onRemoved.addListener(async (windowId) => {
  if ((await sGet<number>(SESSION_KEYS.popoutWindowId)) === windowId) {
    await sDel(SESSION_KEYS.popoutWindowId)
  }
})

// マルチモニターでの配置を記憶（ドラッグし直す手間をなくす）
chrome.windows.onBoundsChanged.addListener(async (win) => {
  if ((await sGet<number>(SESSION_KEYS.popoutWindowId)) !== win.id) return
  if (win.state !== "normal") return
  const { width, height, left, top } = win
  if (width && height && left !== undefined && top !== undefined) {
    await chrome.storage.local.set({
      [LOCAL_KEYS.popoutBounds]: { width, height, left, top }
    })
  }
})

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await sGet<number>(SESSION_KEYS.targetTabId)) !== tabId) return
  await sDel(SESSION_KEYS.targetTabId)

  // ④ YouTubeタブが1つも残っていなければサブ画面を閉じる。
  //    ★ 閉じたタブ以外にYouTubeタブが残っている場合は閉じない
  //      （複数タブで見ている最中に片方を閉じただけ、というケースを潰さないため）
  const { autoClosePopout } = await loadSettings()
  if (!autoClosePopout) return

  const remaining = await chrome.tabs.query({ url: YT_WATCH_PATTERN })
  if (remaining.length > 0) return

  const popoutId = await sGet<number>(SESSION_KEYS.popoutWindowId)
  if (popoutId === null) return
  try {
    await chrome.windows.remove(popoutId)
  } catch {
    // 既に閉じられている
  }
  await sDel(SESSION_KEYS.popoutWindowId)
})

/**
 * ⑤ YouTubeの動画ページを開いたら自動でサブ画面を開く。
 *
 * ★ changeInfo.url があるとき（＝URLが実際に変わった瞬間）だけ反応させる。
 *   tabs.onUpdated はロード進捗などで何度も発火するため、
 *   無条件に処理するとウィンドウ生成を何度も試みることになる。
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url
  if (!url?.startsWith("https://www.youtube.com/watch")) return
  if (!tab.active) return

  // バックグラウンドウィンドウ内の「そのウィンドウではactiveなタブ」に
  // targetを奪われないよう、最後にフォーカスされたウィンドウ所属かも確認する。
  try {
    const lastFocusedWindow = await chrome.windows.getLastFocused()
    if (lastFocusedWindow.id !== tab.windowId) return
  } catch {
    return
  }

  // 自動起動をOFFにしていても、既存Popoutの操作対象は現在の視聴タブに追従させる。
  await sSet(SESSION_KEYS.targetTabId, tabId)
  const { autoOpenPopout } = await loadSettings()
  if (!autoOpenPopout) return

  await openOrFocusPopout(false) // 既に開いていれば前面化しない（視聴の邪魔をしない）
})

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(LOCAL_KEYS.settings)
  if (!cur[LOCAL_KEYS.settings]) {
    await chrome.storage.local.set({ [LOCAL_KEYS.settings]: DEFAULT_SETTINGS })
  }
})

/* ---------- メッセージハンドラ ---------- */

registerHandlers({
  OPEN_POPOUT: async () => ({ windowId: await openOrFocusPopout() }),
  GET_TARGET_TAB: async () => ({ tabId: await resolveTargetTab() }),
  SET_TARGET_TAB: async ({ tabId }) => {
    await sSet(SESSION_KEYS.targetTabId, tabId)
    return { ok: true as const }
  }
})
