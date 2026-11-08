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
const { testing } = load("src/tabs/popout.tsx", "\nexport const testing = { CommentRow, RelatedRow, PagingTail, VideoActions, GuidePanel }\n")

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
  assert.deepEqual(sent.at(-1).payload, { commentId: "c1", ancestors: [] })
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
      channelName: "", channelAvatarUrl: "", channelSubscribers: "", channel: null,
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
  // 共有も2つのボタンを1つの group にまとめているので、評価の group だけを見る
  assert.ok(!button("高く評価") && !button("低く評価"), "no rating buttons")
  assert.ok(button("共有"))
})

// 共有は「押したらコピー」だけ。クリップボードに入っているものを読ませる欄は出さない
// （2026-11-03 の要望「コピペしてるならわざわざ表示しなくてもいい」）。
test("share copies the link and shows no box to read it back from", async (t) => {
  const { container, button, press } = await renderActions(t, {})
  const copies = copiedToClipboard.length // この配列はテスト間で共有される
  await press(button("共有"))
  assert.deepEqual(copiedToClipboard.slice(copies), ["https://youtu.be/aaaaaaaaaaa"])
  assert.ok(button("コピーしました"), "the button itself confirms the copy")
  assert.ok(!container.querySelector("input"), "nothing puts the URL back on screen")
})

// 開始位置つきのリンクは隣のボタンで取る。★押した時点の再生位置で組み立てること。
// 描画済みの値から作ると、ボタンが現れた時点の位置のままになる。
test("the position button shares from wherever the video is now", async (t) => {
  const { button, press, draw } = await renderActions(t, {})
  const copies = copiedToClipboard.length
  await press(button("この位置から共有（1:23）"))
  assert.deepEqual(copiedToClipboard.slice(copies), ["https://youtu.be/aaaaaaaaaaa?t=83"])

  await draw({ currentTime: 200 })
  await press(button("この位置から共有（3:20）"))
  assert.deepEqual(copiedToClipboard.slice(copies + 1), ["https://youtu.be/aaaaaaaaaaa?t=200"],
    "it follows the playhead instead of a position captured earlier")
})

// 「コピーしました」は2秒で消える。2秒以内にもう一度コピーすると、前回のタイマーが残っていれば
// 今回の表示を途中で消してしまう（1.9秒後に押すと0.1秒で消える）。押すたびに2秒を取り直すこと。
// 共有は2つのボタンがあり連続で押せるので、この経路は普通に踏む。
test("copying again restarts the two seconds instead of being cut short by the last one", async (t) => {
  // 2秒のリセットタイマーだけを捕まえる。実タイマーはそのまま動かし、clearTimeout も尊重する
  const pending = new Map()
  const realSet = window.setTimeout
  const realClear = window.clearTimeout
  window.setTimeout = (fn, ms, ...rest) => {
    const id = realSet(fn, ms, ...rest)
    if (ms === 2000) pending.set(id, fn)
    return id
  }
  window.clearTimeout = (id) => { pending.delete(id); return realClear(id) }
  t.after(() => { window.setTimeout = realSet; window.clearTimeout = realClear })

  const { button, press } = await renderActions(t, {})
  // コピー後はボタンの文字が「コピーしました」に変わるので、変わらない aria-label で押す
  const shareButton = () => button("共有リンクをコピー")
  await press(shareButton())
  const [firstId] = [...pending.keys()]
  assert.ok(firstId !== undefined, "the first copy schedules the reset")

  await press(shareButton()) // 1回目の2秒が切れる前にもう一度
  assert.ok(button("コピーしました"))

  // 1回目のタイマーが切れる瞬間。取り消されていれば何も起きない
  if (pending.has(firstId)) await act(async () => { pending.get(firstId)() })
  assert.ok(button("コピーしました"), "the second copy keeps its confirmation")
})

test("live streams offer no position to share from", async (t) => {
  const { button, press } = await renderActions(t, { live: true })
  const copies = copiedToClipboard.length
  await press(button("共有"))
  assert.deepEqual(copiedToClipboard.slice(copies), ["https://youtu.be/aaaaaaaaaaa"])
  assert.ok(!button("この位置から共有（1:23）"), "a live stream has no meaningful position")
})

// 分割表示（v78で既定）にはチャンネル名が出ていなかった。アイコン・登録者数・登録ボタンと
// あわせて、YouTube本体と同じ「チャンネルの行」としてここに出す
test("the channel icon, name and subscriber count are offered with the subscribe button", async (t) => {
  const { container, button } = await renderActions(t, {
    inlineTitle: "サンプル動画", channelName: "Channel X",
    channelAvatarUrl: "https://yt3.ggpht.com/ch.jpg",
    channelSubscribers: "チャンネル登録者数 673万人", channel: { subscribed: false }
  })
  assert.match(container.textContent, /Channel X/)
  assert.match(container.textContent, /チャンネル登録者数 673万人/)
  assert.equal(container.querySelector("img")?.getAttribute("src"), "https://yt3.ggpht.com/ch.jpg")
  assert.ok(button("チャンネル登録"))
})

test("pressing subscribe asks the main window to subscribe", async (t) => {
  respond = () => ({ ok: true, data: { channel: { subscribed: true }, applied: true } })
  const { button, press } = await renderActions(t, { channelName: "Channel X", channel: { subscribed: false } })
  await press(button("チャンネル登録"))
  assert.deepEqual(sent.at(-1), { tabId: 7, action: "CHANNEL_SUBSCRIBE", payload: undefined })
})

// 登録済みのボタンを押すと YouTube は解除メニューを開く。サブ画面からは押させない
test("an already-subscribed channel shows the state without offering a press", async (t) => {
  const { button, press } = await renderActions(t, { channelName: "Channel X", channel: { subscribed: true } })
  const subscribed = button("登録済み")
  assert.ok(subscribed, "the state is shown")
  assert.equal(subscribed.disabled, true, "but it cannot be pressed")
  const before = sent.length
  await press(subscribed)
  assert.equal(sent.length, before, "nothing is sent to the main window")
})

test("without a subscribe button on the main window the sub window offers none", async (t) => {
  const { button } = await renderActions(t, { channelName: "Channel X", channel: null })
  assert.ok(!button("チャンネル登録") && !button("登録済み"))
})

// 分割・全画面にはタイトル欄が無いので、1行目にタイトルを出す。操作は2行目に1列でまとめる
// （要望「評価ボタンと共有ボタンの配置を同じ列に配置しなおしてほしい」）。
test("split view and fullscreen comments show the title above one row of actions", async (t) => {
  const { container, button } = await renderActions(t, {
    inlineTitle: "サンプル動画", rating: { liked: false, disliked: false, likeCount: "1.2万" },
    channelName: "Channel X", channel: { subscribed: false }
  })
  assert.equal(container.querySelector("p")?.textContent, "サンプル動画", "the title comes first")

  const row = button("チャンネル登録").parentElement
  assert.ok(row.contains(button("高く評価")), "the rating buttons sit on the channel's row")
  assert.ok(row.contains(button("共有")), "and so does share")
  assert.ok(!row.contains(container.querySelector("p")), "the title is not in that row any more")
})

/* ---- サイドバー（メイン画面のものをそのまま並べる） ---- */

const GUIDE_HOME_PATH = "m11.485 2.143-8 4.8-2 1.2a1 1 0 001.03 1.714L3 9.567V20Z"
const guideState = {
  available: true,
  sections: [
    {
      title: "",
      entries: [
        { id: "s0:e0", title: "ホーム", href: "/", avatarUrl: "", iconPath: GUIDE_HOME_PATH },
        { id: "s0:e1", title: "ショート", href: "", avatarUrl: "", iconPath: "" }
      ]
    },
    {
      title: "探索",
      entries: [
        { id: "s1:e0", title: "すみれのBGM", href: "/@sumire", avatarUrl: "https://yt3.ggpht.com/a.jpg", iconPath: "" }
      ]
    }
  ]
}

async function renderGuide(t, props = {}) {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  const activated = []
  await act(async () => {
    root.render(React.createElement(testing.GuidePanel, {
      guide: guideState, loading: false, error: null, disabled: false,
      onActivate: (entry) => activated.push(entry), onRefresh: () => {}, t: getDictionary("ja"),
      ...props
    }))
  })
  const row = (title) => [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === title)
  return { container, activated, row, text: () => container.textContent }
}

test("the sub window's sidebar shows the main window's own entries, icons and channel pictures", async (t) => {
  const { container, row, text } = await renderGuide(t)

  assert.ok(row("ホーム") && row("ショート") && row("すみれのBGM"), "項目がそのまま並ぶ")
  assert.match(text(), /探索/, "見出しもYouTubeの文言のまま出す")
  assert.equal(container.querySelector("svg path").getAttribute("d"), GUIDE_HOME_PATH,
    "アイコンはYouTubeのパスデータを自前のsvgに渡して描く")
  const avatar = container.querySelector("img")
  assert.equal(avatar.getAttribute("src"), "https://yt3.ggpht.com/a.jpg")
  assert.equal(avatar.getAttribute("referrerpolicy"), "no-referrer")
  assert.ok(!container.querySelector("a"), "サブ画面側にリンクは作らない（遷移はメイン画面に任せる）")
})

test("pressing a sidebar entry hands the whole entry back so the main window can find it again", async (t) => {
  const { row, activated } = await renderGuide(t)

  await act(async () => {
    row("ショート").dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })

  assert.deepEqual(activated, [{ id: "s0:e1", title: "ショート", href: "", avatarUrl: "", iconPath: "" }],
    "hrefが無い項目でも、位置と表示名で引き直せるよう丸ごと渡す")
})

test("a sidebar that could not be read says so instead of showing nothing", async (t) => {
  const { text } = await renderGuide(t, { guide: { available: false, sections: [] } })
  assert.match(text(), /サイドバーを取得できませんでした/)
})

// 返信の行も自分の返信を開ける。そのとき「ここへ辿り着くまでに開く親」を一緒に送る。
// ★ メイン画面が作り直されると返信はDOMから消えるため、これが無いとCS側は二度と
//   見つけられず not-found のままになる（2026-11-08 ユーザー報告「返信が表示されない」）。
test("a reply row asks for its own replies with the chain of parents", async (t) => {
  const { container, click } = await render(t, comment("c5", 1))
  const replyButtons = () => [...container.querySelectorAll("button")]
    .filter((b) => /^返信 \d+件$/.test(b.textContent))

  respond = () => ({ ok: true, data: { items: [{ ...reply("r1", "c5"), replyCount: 2 }] } })
  await click(replyButtons()[0])
  assert.deepEqual(sent.at(-1).payload, { commentId: "c5", ancestors: [] },
    "トップレベルのコメントには親がいない")

  respond = () => ({ ok: true, data: { items: [reply("r1.a", "r1"), reply("r1.b", "r1")] } })
  const nested = replyButtons().find((b) => b.textContent === "返信 2件")
  assert.ok(nested, "入れ子の返信にもトグルが出る")
  await click(nested)
  assert.deepEqual(sent.at(-1).payload, { commentId: "r1", ancestors: ["c5"] },
    "返信の返信は、外側の親から順に添えて頼む")
  assert.equal(container.querySelectorAll("li").length, 4, "コメント＋返信＋その返信2件")
})
