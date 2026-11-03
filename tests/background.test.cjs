const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { test } = require("node:test")
const ts = require("typescript")

// Service Worker をそのまま実行し、chrome だけ差し替える。
// 背景スクリプトは起動時にリスナーを登録するだけなので、登録されたものを捕まえて呼ぶ。
function load(relative, requireModule) {
  const filename = path.join(__dirname, "..", relative)
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function(module, exports, require) {${code}\n})`, { filename })(module, module.exports, requireModule)
  return module.exports
}

/** 背景スクリプトを1回読み込み、リスナーと chrome.windows の呼び出し履歴を返す */
function boot({ local = {}, windowId = 100 } = {}) {
  const listeners = new Map()
  const on = (name) => ({ addListener: (fn) => listeners.set(name, fn), removeListener() {} })
  const session = {}
  const calls = []
  const pick = (store, keys) => Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])
  )
  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: on("message"),
      onInstalled: on("installed")
    },
    action: { onClicked: on("action") },
    commands: { onCommand: on("command") },
    storage: {
      session: {
        get: async (k) => pick(session, k),
        set: async (o) => { Object.assign(session, o) },
        remove: async (k) => { delete session[k] }
      },
      local: {
        get: async (k) => pick(local, k),
        set: async (o) => { Object.assign(local, o) }
      }
    },
    tabs: {
      get: async (id) => ({ id, url: "https://www.youtube.com/watch?v=x" }),
      query: async () => [{ id: 7, active: true, url: "https://www.youtube.com/watch?v=x" }],
      onRemoved: on("tabRemoved"),
      onUpdated: on("tabUpdated")
    },
    windows: {
      create: async (options) => { calls.push({ fn: "create", options }); return { id: windowId } },
      update: async (id, options) => { calls.push({ fn: "update", id, options }); return { id } },
      get: async (id) => ({ id }),
      getLastFocused: async () => ({ id: 1 }),
      onRemoved: on("windowRemoved"),
      onBoundsChanged: on("bounds")
    }
  }
  const requireModule = (name) => {
    if (name === "~lib/messaging") return load("src/lib/messaging.ts", requireModule)
    throw new Error(`Unexpected import: ${name}`)
  }
  load("src/background/index.ts", requireModule)
  return { listeners, calls, local, session }
}

const watchTab = { tabId: 9, changeInfo: { url: "https://www.youtube.com/watch?v=x" }, tab: { active: true, windowId: 1 } }

// サブ画面は 460x940 で開いていたため「半端にしか表示されない」（2026-11-03 の要望）。
// state は create で left/top/width/height と併用できないので、記憶した位置で作ってから最大化する。
test("the sub window opens filling the screen, not at a corner of it", async (t) => {
  const { listeners, calls } = boot()
  await listeners.get("tabUpdated")(watchTab.tabId, watchTab.changeInfo, watchTab.tab)

  const create = calls.find((c) => c.fn === "create")
  assert.ok(create, "the sub window is created")
  assert.equal(create.options.type, "popup")
  const maximize = calls.find((c) => c.fn === "update" && c.options.state)
  assert.ok(maximize, "it is then maximized")
  assert.equal(maximize.id, 100, "the window that was just created")
  assert.equal(maximize.options.state, "maximized", "maximized, not fullscreen: the title bar stays")
  assert.ok(calls.indexOf(create) < calls.indexOf(maximize), "created first, then maximized")
})

// 最大化は「作った位置を含むディスプレイ」で起きる。記憶した位置はサブモニタを指すので、
// 位置を渡さずに作ると主モニタで最大化され、視聴中の動画を覆ってしまう。
test("it is created at the remembered position so it maximizes on that monitor", async (t) => {
  const { listeners, calls } = boot({ local: { popoutBounds: { width: 500, height: 900, left: -1720, top: 40 } } })
  await listeners.get("tabUpdated")(watchTab.tabId, watchTab.changeInfo, watchTab.tab)

  const create = calls.find((c) => c.fn === "create")
  assert.equal(create.options.left, -1720, "the sub monitor's position is kept")
  assert.equal(create.options.top, 40)
})

// 最大化すると onBoundsChanged が発火する。ここで最大化後の寸法を記憶してしまうと、
// ユーザーが元に戻したときの大きさが失われる。
test("maximizing does not overwrite the remembered window size", async (t) => {
  const bounds = { width: 500, height: 900, left: -1720, top: 40 }
  const { listeners, local } = boot({ local: { popoutBounds: { ...bounds } } })
  await listeners.get("tabUpdated")(watchTab.tabId, watchTab.changeInfo, watchTab.tab)

  await listeners.get("bounds")({ id: 100, state: "maximized", width: 1920, height: 1080, left: -1920, top: 0 })
  assert.deepEqual(local.popoutBounds, bounds, "the maximized size is not remembered")

  await listeners.get("bounds")({ id: 100, state: "normal", width: 640, height: 800, left: -1700, top: 60 })
  assert.deepEqual(local.popoutBounds, { width: 640, height: 800, left: -1700, top: 60 },
    "a size the user chose themselves is remembered")
})
