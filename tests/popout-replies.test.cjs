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
const { testing } = load("src/tabs/popout.tsx", "\nexport const testing = { CommentRow }\n")

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
