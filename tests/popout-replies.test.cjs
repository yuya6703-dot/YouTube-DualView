const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { test } = require("node:test")
const { JSDOM } = require("jsdom")
const ts = require("typescript")

// React DOM decides at load time whether a DOM exists, so the document must be global before it loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "chrome-extension://test/tabs/popout.html"
})
for (const name of ["window", "document", "HTMLElement", "Node", "MouseEvent", "Event"]) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
}
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = require("react")
const { createRoot } = require("react-dom/client")
const { act } = require("react-dom/test-utils")

// Execute the real popout module and its own libraries. Only Chrome messaging, the DeepL client,
// CSS, icons and the drag-and-drop kit are replaced; the sub window's reply logic runs unchanged.
const sent = []
let respond = () => ({ ok: true, data: { items: [] } })
globalThis.chrome = {
  tabs: { sendMessage: async (tabId, envelope) => { sent.push({ tabId, ...envelope }); return respond(envelope) } }
}
const stubModule = () => new Proxy({}, {
  get: (_, name) => (name === "__esModule" || name === "default" ? undefined : (props) =>
    React.createElement("span", { "data-stub": String(name) }, props?.children))
})
const loaded = new Map()
function load(relative, extra = "") {
  const filename = path.join(__dirname, "..", relative)
  const code = ts.transpileModule(readFileSync(filename, "utf8") + extra, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const module = { exports: {} }
  const requireModule = (name) => {
    if (name === "react" || name === "react/jsx-runtime") return require(name)
    if (name.startsWith("~lib/")) {
      const file = `src/lib/${name.slice(5)}.ts`
      if (name === "~lib/deepl") return { translateText: async () => ({ ok: false, error: "stub" }) }
      if (name === "~lib/usePlayerPort") return { usePlayerPort() { throw new Error("not rendered") }, useSmoothTime() {} }
      if (!loaded.has(file)) loaded.set(file, load(file))
      return loaded.get(file)
    }
    if (name === "~style.css") return {}
    if (name === "lucide-react" || name.startsWith("@dnd-kit/")) return stubModule()
    throw new Error(`Unexpected import: ${name}`)
  }
  vm.runInThisContext(`(function(module, exports, require) {${code}\n})`, { filename })(module, module.exports, requireModule)
  return module.exports
}
const { DEFAULT_SETTINGS } = load("src/lib/messaging.ts")
const { getDictionary } = load("src/lib/i18n.ts")
const { testing } = load("src/tabs/popout.tsx", "\nexport const testing = { CommentRow, RelatedRow, PagingTail, VideoActions }\n")

const comment = (id, replyCount) => ({
  id, author: `Author ${id}`, avatarUrl: "", text: `Comment ${id}`,
  tokens: [{ t: "text", v: `Comment ${id}` }], ...(replyCount ? { replyCount } : {})
})
const reply = (id, parentId) => ({ ...comment(id), parentId })

async function render(t, item) {
  const container = document.body.appendChild(document.createElement("ul"))
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => {
    root.render(React.createElement(testing.CommentRow, {
      item, size: "md", tabId: 7, t: getDictionary("ja"), settings: DEFAULT_SETTINGS, replyAvatars: {}
    }))
  })
  const replyButton = () => [...container.querySelectorAll("button")].find((b) => /^返信 \d+件$/.test(b.textContent))
  const click = async (button) => {
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await new Promise((resolve) => setImmediate(resolve)) // let the messaging round trip settle
    })
  }
  return { container, replyButton, click, text: () => container.textContent }
}

test("a failed reply load keeps the reply button so one more click retries", async (t) => {
  const { container, replyButton, click, text } = await render(t, comment("c1", 3))
  assert.equal(replyButton()?.textContent, "返信 3件")

  respond = () => ({ ok: true, data: { items: [], reason: "timeout" } })
  await click(replyButton())
  assert.match(text(), /返信を取得できませんでした/)
  assert.match(text(), /\(timeout\)/)
  assert.equal(sent.filter((m) => m.action === "COMMENT_LOAD_REPLIES").length, 1)
  assert.equal(replyButton()?.textContent, "返信 3件", "the reply toggle must survive an empty result")

  respond = () => ({ ok: true, data: { items: ["r1", "r2", "r3"].map((id) => reply(id, "c1")) } })
  await click(replyButton())
  assert.equal(sent.filter((m) => m.action === "COMMENT_LOAD_REPLIES").length, 2, "a single click re-fetches")
  assert.deepEqual(sent.at(-1).payload, { commentId: "c1" })
  assert.equal(container.querySelectorAll("li").length, 4) // the comment and its three replies
  assert.doesNotMatch(text(), /返信を取得できませんでした/)
  assert.equal(replyButton()?.textContent, "返信 3件")
})

test("loaded replies still toggle without another fetch", async (t) => {
  const { container, replyButton, click } = await render(t, comment("c2", 2))
  respond = () => ({ ok: true, data: { items: ["r1", "r2"].map((id) => reply(id, "c2")) } })
  await click(replyButton())
  assert.equal(container.querySelectorAll("li").length, 3)
  const before = sent.length
  await click(replyButton())
  assert.equal(container.querySelectorAll("li").length, 1, "second click collapses")
  await click(replyButton())
  assert.equal(container.querySelectorAll("li").length, 3, "third click re-opens from memory")
  assert.equal(sent.length, before, "no further messages for open/close")
})

test("comments without replies never show a reply button", async (t) => {
  const { replyButton } = await render(t, comment("c3"))
  assert.equal(replyButton(), undefined)
})

test("the publish time is rendered next to the author for comments and replies", async (t) => {
  const { container, replyButton, click } = await render(t, { ...comment("c4", 1), publishedAt: "1 年前" })
  const header = container.querySelector("p")
  assert.match(header.textContent, /^Author c4\s*1 年前$/)
  respond = () => ({ ok: true, data: { items: [{ ...reply("r1", "c4"), publishedAt: "3 週間前（編集済み）" }] } })
  await click(replyButton())
  assert.match(container.textContent, /Replier r1|Author r1/)
  assert.ok([...container.querySelectorAll("p")].some((p) => /^Author r1\s*3 週間前（編集済み）$/.test(p.textContent)),
    "the reply row shows its own publish time")
})

async function renderRelated(t, item) {
  const container = document.body.appendChild(document.createElement("ul"))
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => {
    root.render(React.createElement(testing.RelatedRow, {
      item, size: "md", onPlay() {}, onQueue() {}, t: getDictionary("ja")
    }))
  })
  return container
}

test("related rows show the view count and publish time under the channel name", async (t) => {
  const base = { id: "v1", videoId: "aaaaaaaaaaa", title: "Title A", channelName: "Channel A", thumbnailUrl: "", duration: 754 }
  // flex の gap は textContent に出ないので、行は span 単位で読む（アイコンのスタブは空文字）
  const lines = (container) => [...container.querySelectorAll("p")].map((p) =>
    (p.querySelectorAll("span").length ? [...p.querySelectorAll("span")].map((s) => s.textContent.trim()).filter(Boolean) : [p.textContent.trim()]).join(" "))
  const full = await renderRelated(t, { ...base, viewCount: "168万", publishedAt: "5 か月前" })
  assert.deepEqual(lines(full), ["Title A", "Channel A", "168万 • 5 か月前"])

  const timeOnly = await renderRelated(t, { ...base, publishedAt: "2 年前に配信済み" })
  assert.deepEqual(lines(timeOnly), ["Title A", "Channel A", "2 年前に配信済み"])

  const none = await renderRelated(t, base)
  assert.deepEqual([...none.querySelectorAll("p")].map((p) => p.textContent.trim()), ["Title A", "Channel A"])
})

async function renderTail(t, page, itemCount) {
  const container = document.body.appendChild(document.createElement("ul"))
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => {
    root.render(React.createElement(testing.PagingTail, {
      page, itemCount, label: "コメント", t: getDictionary("ja"), onRetry() {}, sentinelRef: React.createRef()
    }))
  })
  return container.textContent.trim()
}

test("an empty comment list shows YouTube's own reason when there is one", async (t) => {
  const done = { kind: "comment", phase: "done", loaded: 0, hasMore: false }
  assert.equal(await renderTail(t, { ...done, message: "コメントはオフになっています。" }, 0), "コメントはオフになっています。")
  assert.equal(await renderTail(t, done, 0), "取得できるコメントはありません")
  assert.equal(await renderTail(t, { ...done, loaded: 3, message: "コメントはオフになっています。" }, 3),
    "コメントを最後まで読み込みました（3件）", "a reason never replaces the count once comments exist")
})

const copiedToClipboard = []
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (value) => { copiedToClipboard.push(value) } }, configurable: true
})

async function renderActions(t, props) {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  const draw = (overrides = {}) => act(async () => {
    root.render(React.createElement(testing.VideoActions, {
      videoId: "aaaaaaaaaaa", rating: null, live: false, currentTime: 83.6, tabId: 7, t: getDictionary("ja"),
      ...props, ...overrides
    }))
  })
  await draw()
  const button = (label) => [...container.querySelectorAll("button")]
    .find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label)
  const press = async (element) => {
    await act(async () => {
      element.click()
      await new Promise((resolve) => setImmediate(resolve))
    })
  }
  const input = (type = "text") => container.querySelector(`input[type=${type}]`)
  return { container, draw, button, press, input }
}

test("the rating buttons mirror the main window and never flip on their own when YouTube does not apply a press", async (t) => {
  const { container, button, press } = await renderActions(t, { rating: { liked: true, disliked: false, likeCount: "1.2万" } })
  assert.equal(button("高評価を取り消す")?.getAttribute("aria-pressed"), "true")
  assert.equal(button("高評価を取り消す").textContent.trim(), "1.2万")
  assert.equal(button("低く評価")?.getAttribute("aria-pressed"), "false")

  respond = () => ({ ok: true, data: { rating: { liked: true, disliked: false, likeCount: "1.2万" }, applied: false } })
  await press(button("低く評価"))
  assert.deepEqual(sent.at(-1), { tabId: 7, action: "VIDEO_RATE", payload: { action: "dislike" } })
  assert.match(container.textContent, /評価を反映できませんでした/)
  assert.equal(button("低く評価")?.getAttribute("aria-pressed"), "false", "no optimistic toggle")
})

test("without rating buttons on the main window only sharing is offered", async (t) => {
  const { container, button } = await renderActions(t, { rating: null })
  assert.equal(container.querySelector("[role=group]"), null)
  assert.ok(button("共有"))
})

test("share copies a youtu.be link, optionally starting where the video was when share was opened", async (t) => {
  const { container, draw, button, press, input } = await renderActions(t, {})
  await press(button("共有"))
  assert.equal(input().value, "https://youtu.be/aaaaaaaaaaa")
  assert.match(container.textContent, /開始位置 1:23/)

  await draw({ currentTime: 200 }) // 再生が進んでも、開いた時点の位置のまま
  assert.match(container.textContent, /開始位置 1:23/)
  await press(container.querySelector("input[type=checkbox]"))
  assert.equal(input().value, "https://youtu.be/aaaaaaaaaaa?t=83")

  await press(button("コピー"))
  assert.equal(copiedToClipboard.at(-1), "https://youtu.be/aaaaaaaaaaa?t=83")
  assert.ok(button("コピーしました"))
})

test("pressing share copies the link there and then", async (t) => {
  const { button, press } = await renderActions(t, {})
  const copies = copiedToClipboard.length // この配列はテスト間で共有される
  await press(button("共有"))
  assert.deepEqual(copiedToClipboard.slice(copies), ["https://youtu.be/aaaaaaaaaaa"],
    "the link is on the clipboard without a second press")
  assert.ok(button("コピーしました"), "and the sub window says so")
})

// 共有欄を「開始位置つき」で閉じてから開き直したとき、開いた時点の再生位置でコピーすること。
// 開始位置は開くたびに取り直すが、その値は次の描画まで state に入らないので、
// コピーするURLを描画済みの値から組み立てると前回の位置のままになる。
test("reopening share copies the position it was reopened at, not the one from last time", async (t) => {
  const { button, press, input, draw } = await renderActions(t, {})
  const copies = copiedToClipboard.length
  await press(button("共有"))
  await press(input("checkbox"))
  assert.deepEqual(copiedToClipboard.slice(copies), ["https://youtu.be/aaaaaaaaaaa"],
    "ticking the box alone does not copy again")
  await press(button("共有")) // 閉じる
  await draw({ currentTime: 200 })
  await press(button("共有")) // 開き直す
  assert.equal(input().value, "https://youtu.be/aaaaaaaaaaa?t=200")
  assert.deepEqual(copiedToClipboard.slice(copies + 1), ["https://youtu.be/aaaaaaaaaaa?t=200"])
})

test("live streams are shared without a start position", async (t) => {
  const { container, button, press, input } = await renderActions(t, { live: true })
  await press(button("共有"))
  assert.equal(container.querySelector("input[type=checkbox]"), null)
  assert.equal(input().value, "https://youtu.be/aaaaaaaaaaa")
})

test("split view and fullscreen comments show the title inline next to the buttons", async (t) => {
  const { container, button } = await renderActions(t, {
    inlineTitle: "サンプル動画", rating: { liked: false, disliked: false, likeCount: "1.2万" }
  })
  const row = container.querySelector("div > div")
  assert.equal(row.querySelector("p")?.textContent, "サンプル動画")
  assert.ok(row.contains(button("高く評価")) && row.contains(button("共有")), "the title shares one row with the buttons")
})
