const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { test } = require("node:test")
const { JSDOM } = require("jsdom")
const ts = require("typescript")

const thread = (id, video = "current") => `
  <ytd-comment-thread-renderer>
    <div id="comment-container"><ytd-comment-view-model>
      <a id="author-text">Author</a>
      <div id="author-thumbnail"><img src="https://yt3.ggpht.com/avatar.jpg"></div>
      <span id="published-time-text"><a href="/watch?v=${video}&lc=${id}">1 day ago</a></span>
      <div id="content-text">Comment ${id}</div>
    </ytd-comment-view-model></div>
  </ytd-comment-thread-renderer>`
const continuation = '<ytd-continuation-item-renderer is-initial-load></ytd-continuation-item-renderer>'
const endNotice = '<yt-comment-filter-context-view-model>End of comments</yt-comment-filter-context-view-model>'
const section = (content, attrs = 'id="comments"') => `
  <ytd-comments ${attrs}><ytd-item-section-renderer>
    <div id="contents">${content}</div>
  </ytd-item-section-renderer></ytd-comments>`
const panel = (content, visibility = "HIDDEN") => `
  <ytd-engagement-panel-section-list-renderer
    target-id="engagement-panel-comments-section" visibility="ENGAGEMENT_PANEL_VISIBILITY_${visibility}">
    ${section(content, "engagement-panel")}
  </ytd-engagement-panel-section-list-renderer>`

// Execute the real content script and selectors, with only Chrome messaging and time replaced.
// No page scripts, network requests, or production-only testing hooks are used.
function setup(t, html, video = "current") {
  const dom = new JSDOM(`<ytd-watch-flexy video-id="${video}">
    <div id="movie_player"></div><div id="below">${html}</div>
  </ytd-watch-flexy>`, { url: `https://www.youtube.com/watch?v=${video}`, runScripts: "outside-only" })
  t.after(() => dom.window.close())
  const win = dom.window
  const context = dom.getInternalVMContext()
  const events = []
  const timers = new Map()
  let time = 1000
  let nextId = 1
  const schedule = (callback, delay = 0, interval = false) => {
    const id = nextId++
    timers.set(id, { callback, at: time + Number(delay), interval: interval ? Number(delay) : 0 })
    return id
  }
  win.setTimeout = (fn, delay) => schedule(fn, delay)
  win.setInterval = (fn, delay) => schedule(fn, delay, true)
  win.clearTimeout = win.clearInterval = (id) => timers.delete(id)
  win.Date.now = () => time
  win.chrome = { runtime: { onConnect: { addListener() {} } } }
  win.process = { env: { NODE_ENV: "test" } }
  // jsdom has no CSS.escape; the video ids used here are plain [A-Za-z0-9_-].
  win.CSS = { escape: (value) => String(value).replace(/[^A-Za-z0-9_-]/g, (c) => `\${c}`) }
  let handlers
  const messaging = {
    PORT_PLAYER: "player", STATUS_INTERVAL_MS: 250,
    registerHandlers(value) { handlers = value }
  }
  function load(relative, extra = "") {
    const filename = path.join(__dirname, "..", relative)
    const code = ts.transpileModule(readFileSync(filename, "utf8") + extra, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    const module = { exports: {} }
    const requireModule = (name) => {
      if (name === "~lib/selectors") return selectors
      if (name === "~lib/messaging") return messaging
      throw new Error(`Unexpected import: ${name}`)
    }
    new vm.Script(`(function(module, exports, require) {${code}\n})`, { filename })
      .runInContext(context)(module, module.exports, requireModule)
    return module.exports
  }
  const selectors = load("src/lib/selectors.ts")
  const { testing } = load("src/contents/youtube-main.ts", `
    export const testing = {
      start(port: chrome.runtime.Port) {
        ports.add(port)
        lastVideoId = getVideoId()
        watchComments(true, false)
      },
      state: () => commentPageState,
      bound: () => commentContainerEl,
      items: () => Array.from(commentItemCache.values()),
      loadMoreComments, commentsReachedEnd, commentsAreDefinitelyEmpty,
      findTopLevelCommentContinuation, stopWatchPageObservers, fetchRelated, nudgeIntoViewport,
      readVideoRating, readChannelState
    }
  `)
  const port = { postMessage: (event) => events.push(event) }
  async function advance(ms) {
    const until = time + ms
    await Promise.resolve() // Deliver pending MutationObserver records before moving time.
    for (let steps = 0; steps < 10000; steps++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) { time = until; await Promise.resolve(); return }
      const [id, timer] = next
      time = timer.at
      timers.delete(id)
      if (timer.interval) timers.set(id, { ...timer, at: time + timer.interval })
      timer.callback()
      await Promise.resolve()
    }
    throw new Error("Timer loop failed to settle")
  }
  return {
    win, doc: win.document, events, selectors, api: testing, advance, handlers,
    start: () => testing.start(port),
    navigate(id) {
      win.document.dispatchEvent(new win.Event("yt-navigate-start"))
      win.history.pushState(null, "", `/watch?v=${id}`)
      win.document.querySelector("ytd-watch-flexy").setAttribute("video-id", id)
      win.document.dispatchEvent(new win.Event("yt-navigate-finish"))
    }
  }
}

test("hidden previous-video comments do not mask the id-less panel or its initial continuation", async (t) => {
  const h = setup(t, section(thread("old", "previous") + endNotice, 'id="comments" hidden') + panel(continuation))
  h.start()
  const active = h.doc.querySelector("ytd-comments[engagement-panel]")
  assert.equal(h.api.bound(), active)
  assert.equal(h.api.findTopLevelCommentContinuation(), active.querySelector("ytd-continuation-item-renderer"))
  assert.equal(h.selectors.diagnoseDetail()["comments.thread"].n, 0, "diagnostics must not count hidden old comments")
  assert.equal(active.querySelector("ytd-continuation-item-renderer").style.position, "fixed")
  active.querySelector("#contents").insertAdjacentHTML("afterbegin", thread("new"))
  await h.advance(2500)
  assert.deepEqual(Array.from(h.api.items(), item => item.id), ["lc:new"])
  assert.notEqual(h.api.state().phase, "error")
  assert.equal(h.doc.querySelector("#comments").hasAttribute("hidden"), true)
})

test("a dormant panel does not replace the current inline comments, even offscreen or fullscreen", (t) => {
  const h = setup(t, panel(continuation) + section(thread("inline"), 'id="comments" style="content-visibility:hidden;position:absolute;top:100000px"'))
  assert.equal(h.selectors.findCommentSection("current"), h.doc.querySelector("#comments"))
})

test("still-attached old containers are replaced and paging resumes after done", async (t) => {
  const h = setup(t, section('<ytd-message-renderer>Comments are turned off.</ytd-message-renderer>'))
  h.start()
  assert.equal(h.api.state().phase, "done")
  const old = h.doc.querySelector("#comments")
  old.hidden = true
  h.doc.querySelector("#below").insertAdjacentHTML("beforeend", panel(continuation, "EXPANDED"))
  await h.advance(1100)
  const active = h.doc.querySelector("ytd-comments[engagement-panel]")
  assert.equal(h.api.bound(), active)
  assert.equal(h.doc.contains(old), true)
  active.querySelector("#contents").insertAdjacentHTML("afterbegin", thread("late"))
  await h.advance(2500)
  assert.deepEqual(Array.from(h.api.items(), item => item.id), ["lc:late"])
  assert.notEqual(h.api.state().phase, "done")
})

test("SPA navigation ignores the previous footer and recovers when a new section appears after timeout", async (t) => {
  const h = setup(t, section(thread("old", "previous") + endNotice + continuation), "previous")
  h.start()
  await h.advance(6000)
  assert.equal(h.api.state().phase, "done")
  h.navigate("current")
  await h.advance(20000)
  assert.notEqual(h.api.state().phase, "done", "stale footer must not terminate the current video's feed")
  assert.equal(h.api.items().length, 0)
  h.doc.querySelector("#below").insertAdjacentHTML("beforeend", section(continuation, 'id="replacement"'))
  await h.advance(1100)
  h.doc.querySelector("#replacement #contents").insertAdjacentHTML("afterbegin", thread("fresh"))
  await h.advance(2500)
  assert.deepEqual(Array.from(h.api.items(), item => item.id), ["lc:fresh"])
  assert.equal(h.api.state().phase, "idle")
})

test("old and new threads may coexist, but an old footer is not proof of completion", async (t) => {
  const h = setup(t, section(thread("old", "previous") + thread("new") + endNotice))
  const active = h.selectors.findCommentSection("current")
  assert.equal(active, h.doc.querySelector("#comments"))
  assert.equal(h.api.commentsReachedEnd(active), false)
  h.start()
  await h.advance(1000)
  assert.deepEqual(Array.from(h.api.items(), item => item.id), ["lc:new"])
})

test("post-comment initialization only targets the selected current section", async (t) => {
  const trigger = '<div id="simple-box"><button id="simplebox-placeholder">Add a comment</button></div>'
  const h = setup(t, section(trigger, 'id="comments" hidden') + panel(trigger, "EXPANDED"))
  let oldClicks = 0
  let currentClicks = 0
  h.doc.querySelector("#comments button").addEventListener("click", () => oldClicks++)
  h.doc.querySelector("ytd-comments[engagement-panel] button").addEventListener("click", () => currentClicks++)
  const pending = h.handlers.COMMENT_POST({ text: "test", videoId: "current" })
  await h.advance(1200)
  const result = await pending
  assert.equal(result.ok, false, "no editor or submit action is present in this fixture")
  assert.equal(oldClicks, 0)
  assert.equal(currentClicks, 1)
})

test("comments-off and a dead continuation remain done without an automatic retry loop", async (t) => {
  const h = setup(t, panel('<ytd-message-renderer>Comments are turned off.</ytd-message-renderer>' + continuation, "EXPANDED"))
  h.start()
  await h.advance(30000)
  assert.equal(h.api.state().phase, "done")
  assert.equal(h.api.state().hasMore, false)
  assert.equal(h.events.filter(e => e.type === "PAGE_STATE" && e.payload.kind === "comment").length, 2)
})

test("zero-comment counts remain a valid terminal state", async (t) => {
  const h = setup(t, section('<ytd-comments-header-renderer><span id="count">０ 件のコメント</span></ytd-comments-header-renderer>' + continuation))
  h.start()
  await h.advance(15000)
  assert.equal(h.api.state().phase, "done")
  assert.equal(h.api.state().loaded, 0)
})

test("a genuine end notice in an id-less section terminates paging despite a dead continuation", async (t) => {
  const h = setup(t, panel(thread("last") + endNotice + continuation, "EXPANDED"))
  h.start()
  await h.advance(30000)
  assert.equal(h.api.state().phase, "done")
  assert.equal(h.api.state().loaded, 1)
  assert.equal(h.events.some(e => e.type === "PAGE_STATE" && e.payload.phase === "error"), false)
})

test("reply continuations are never used to page the top-level comment list", (t) => {
  const h = setup(t, panel(`<ytd-comment-thread-renderer><div id="replies">${continuation}</div></ytd-comment-thread-renderer>`, "EXPANDED"))
  assert.equal(h.api.findTopLevelCommentContinuation(), null)
})

test("permalink-only updates can make a reused section current again", async (t) => {
  const h = setup(t, section(thread("reused", "previous") + continuation))
  h.start()
  assert.equal(h.api.bound(), null)
  h.doc.querySelector("#published-time-text a").setAttribute("href", "/watch?v=current&lc=reused")
  await h.advance(2500)
  assert.equal(h.api.bound(), h.doc.querySelector("#comments"))
  assert.deepEqual(Array.from(h.api.items(), item => item.id), ["lc:reused"])
})

test("loading still times out with a retryable error if YouTube supplies no comments", async (t) => {
  const h = setup(t, panel(continuation, "EXPANDED"))
  h.start()
  await h.advance(18000)
  assert.equal(h.api.items().length, 0)
  assert.ok(h.events.some(e => e.type === "PAGE_STATE" && e.payload.kind === "comment" && e.payload.phase === "error"))
  assert.equal(h.api.state().hasMore, true)
})

// ---- 返信の読み込み（COMMENT_LOAD_REPLIES） ----

// 親コメント1件。返信は「N 件の返信」トグルの先にあり、クリック後に YouTube が非同期で
// #expanded-threads を挿入する（新スレッドUI: 返信も ytd-comment-thread-renderer に包まれる）。
const threadWithReplies = (id, replyCount) => `
  <ytd-comment-thread-renderer>
    <div id="comment-container"><ytd-comment-view-model>
      <a id="author-text">Author</a>
      <div id="author-thumbnail"><img src="https://yt3.ggpht.com/avatar.jpg"></div>
      <span id="published-time-text"><a href="/watch?v=current&lc=${id}">1 day ago</a></span>
      <div id="content-text">Comment ${id}</div>
    </ytd-comment-view-model></div>
    <div id="replies"><ytd-comment-replies-renderer>
      <div id="collapsed-threads"><div id="more-replies-sub-thread"><button>${replyCount} 件の返信</button></div></div>
    </ytd-comment-replies-renderer></div>
  </ytd-comment-thread-renderer>`
const wrappedReply = (id) => `
  <ytd-comment-thread-renderer>
    <div id="comment-container"><ytd-comment-view-model>
      <a id="author-text">Replier</a>
      <div id="author-thumbnail"><img src="https://yt3.ggpht.com/avatar.jpg"></div>
      <span id="published-time-text"><a href="/watch?v=current&lc=${id}">1 day ago</a></span>
      <div id="content-text">Reply ${id}</div>
    </ytd-comment-view-model></div>
    <div id="replies"></div>
  </ytd-comment-thread-renderer>`

// クリックから `delayMs` 後に返信が現れる YouTube を再現する。
function stubReplyLoading(h, delayMs, replies) {
  const button = h.doc.querySelector("#more-replies-sub-thread button")
  let clicks = 0
  button.addEventListener("click", () => {
    clicks += 1
    if (replies === null) return
    h.win.setTimeout(() => {
      h.doc.querySelector("ytd-comment-replies-renderer")
        .insertAdjacentHTML("beforeend", `<div id="expanded-threads">${replies}</div>`)
    }, delayMs)
  })
  return () => clicks
}

test("replies that YouTube renders 5 seconds after the toggle click are still returned", async (t) => {
  const h = setup(t, section(threadWithReplies("parent", 2)))
  h.start()
  const clicks = stubReplyLoading(h, 5000, wrappedReply("parent.r1") + wrappedReply("parent.r2"))
  const pending = h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" })
  await h.advance(9000)
  const result = await pending
  assert.equal(clicks(), 1, "the toggle is clicked exactly once")
  assert.deepEqual(Array.from(result.items, (item) => item.id), ["lc:parent.r1", "lc:parent.r2"])
  assert.deepEqual(Array.from(result.items, (item) => item.parentId), ["lc:parent", "lc:parent"])
})

test("already-expanded replies are returned without clicking the toggle again", async (t) => {
  const h = setup(t, section(threadWithReplies("parent", 1)))
  h.doc.querySelector("ytd-comment-replies-renderer")
    .insertAdjacentHTML("beforeend", `<div id="expanded-threads">${wrappedReply("parent.r1")}</div>`)
  h.start()
  const clicks = stubReplyLoading(h, 0, null)
  const pending = h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" })
  await h.advance(100)
  const result = await pending
  assert.equal(clicks(), 0, "an expanded thread must not be toggled (that would collapse it)")
  assert.deepEqual(Array.from(result.items, (item) => item.id), ["lc:parent.r1"])
})

test("an empty reply result carries a reason the sub window can show", async (t) => {
  const h = setup(t, section(threadWithReplies("parent", 3)))
  h.start()
  stubReplyLoading(h, 0, null) // YouTube never renders anything
  const pending = h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" })
  await h.advance(12000)
  const result = await pending
  assert.equal(result.items.length, 0)
  assert.equal(result.reason, "timeout")
  const missing = await h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:nope" })
  assert.equal(missing.reason, "not-found")
})

// 返信のアイコン。返信も遅延読み込みなので、応答時点では src が空のことが多い。
const wrappedReplyNoAvatar = (id) => wrappedReply(id).replace('<img src="https://yt3.ggpht.com/avatar.jpg">', "<img>")

test("reply avatars that fill after the response reach the sub window as REPLY_AVATAR, not as feed rows", async (t) => {
  const h = setup(t, section(threadWithReplies("parent", 2)))
  h.doc.querySelector("ytd-comment-replies-renderer").insertAdjacentHTML("beforeend",
    `<div id="expanded-threads">${wrappedReplyNoAvatar("parent.r1")}${wrappedReplyNoAvatar("parent.r2")}</div>`)
  h.start()
  const result = await h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" })
  assert.deepEqual(Array.from(result.items, (item) => item.avatarUrl), ["", ""], "avatars are empty at response time")

  // YouTube が後から src を入れる（遅延読み込みの完了）
  const imgs = h.doc.querySelectorAll("#expanded-threads #author-thumbnail img")
  imgs[0].setAttribute("src", "https://yt3.ggpht.com/r1.jpg")
  await h.advance(1000)

  const pushed = h.events.filter((ev) => ev.type === "REPLY_AVATAR").flatMap((ev) => Array.from(ev.payload.items))
  assert.deepEqual(pushed.map((item) => [item.id, item.parentId, item.avatarUrl]),
    [["lc:parent.r1", "lc:parent", "https://yt3.ggpht.com/r1.jpg"]])
  const leaked = h.events.filter((ev) => ev.type === "FEED_APPEND")
    .flatMap((ev) => Array.from(ev.payload.items, (item) => item.id))
    .filter((id) => id.startsWith("lc:parent."))
  assert.deepEqual(leaked, [], "reply avatars must never be delivered as top-level feed rows")

  // 再取得したときも、埋まったアイコンをそのまま返す
  const again = await h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" })
  assert.equal(Array.from(again.items).find((item) => item.id === "lc:parent.r1").avatarUrl, "https://yt3.ggpht.com/r1.jpg")
})

// 先読み（prefetch: true）は直列。並走すると continuation の nudge が祖先スタイルを取り合う。
function stubReplyLoadingFor(h, thread, delayMs, replies) {
  const button = thread.querySelector("#more-replies-sub-thread button")
  let clicks = 0
  button.addEventListener("click", () => {
    clicks += 1
    h.win.setTimeout(() => {
      thread.querySelector("ytd-comment-replies-renderer")
        .insertAdjacentHTML("beforeend", `<div id="expanded-threads">${replies}</div>`)
    }, delayMs)
  })
  return () => clicks
}

test("reply prefetches run one thread at a time, and a click shares an in-flight load", async (t) => {
  const h = setup(t, section(threadWithReplies("a", 1) + threadWithReplies("b", 1)))
  h.start()
  const [ta, tb] = h.doc.querySelectorAll("ytd-comment-thread-renderer")
  const clicksA = stubReplyLoadingFor(h, ta, 3000, wrappedReply("a.r1"))
  const clicksB = stubReplyLoadingFor(h, tb, 3000, wrappedReply("b.r1"))

  const pa = h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:a", prefetch: true })
  const pb = h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:b", prefetch: true })
  await h.advance(1000)
  assert.equal(clicksA(), 1, "the first prefetch starts immediately")
  assert.equal(clicksB(), 0, "the second prefetch waits for the first to finish")

  await h.advance(4000)
  assert.deepEqual(Array.from((await pa).items, (item) => item.id), ["lc:a.r1"])
  assert.equal(clicksB(), 1, "the second prefetch starts once the first is done")

  // 先読み中のスレッドをユーザーがクリック → 二重にトグルを押さず、同じ結果を待つ
  const click = h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:b" })
  await h.advance(4000)
  assert.deepEqual(Array.from((await click).items, (item) => item.id), ["lc:b.r1"])
  assert.deepEqual(Array.from((await pb).items, (item) => item.id), ["lc:b.r1"])
  assert.equal(clicksB(), 1, "a toggle is never clicked twice (that would collapse the thread)")
})

// アイコンの nudge はバッチ。1件ずつだと 20件で約6秒かかる。
test("empty avatars are nudged in one batch with separate tiles, then restored", async (t) => {
  const ids = ["a", "b", "c", "d", "e"]
  const many = ids.map((id) => thread(id).replace('<img src="https://yt3.ggpht.com/avatar.jpg">', "<img>")).join("")
  const h = setup(t, section(many))
  h.start()
  await h.advance(600) // emit(400ms debounce) → 最初の読み直し(150ms) → nudge 開始
  const hosts = [...h.doc.querySelectorAll("#author-thumbnail")]
  const fixed = hosts.filter((el) => el.style.position === "fixed")
  assert.equal(fixed.length, ids.length, "all hosts are placed in the viewport at the same time")
  assert.equal(new Set(fixed.map((el) => el.style.top)).size, ids.length, "each host gets its own tile")
  await h.advance(400)
  assert.equal(hosts.filter((el) => el.style.position === "fixed").length, 0, "styles are restored after the dwell")
})

// nudge の箱はメイン画面の右上に 24px で現れる。全画面視聴中は YouTube がアプリ全体を全画面に
// するため、この fixed の箱は映像の上に描かれてしまう（アイコン補完は最大12個が縦に並ぶ。
// ユーザー報告「コメントの読み込みしてる時にみんなのアイコンがメインの右上に表示される」「邪魔くさい」）。
// IntersectionObserver は opacity を見ない（交差は幾何だけで決まる）ので、透明でも読み込みは起きる。
test("the tiles placed in the viewport are transparent, so nothing paints over the video", async (t) => {
  const ids = ["a", "b"]
  const many = ids.map((id) => thread(id).replace('<img src="https://yt3.ggpht.com/avatar.jpg">', "<img>")).join("")
  const h = setup(t, section(many))
  h.start()
  await h.advance(600)
  const tiles = [...h.doc.querySelectorAll("#author-thumbnail")].filter((el) => el.style.position === "fixed")
  assert.equal(tiles.length, ids.length, "the avatars are placed in the viewport")
  for (const el of tiles) {
    assert.equal(el.style.getPropertyValue("opacity"), "0", "the avatar tile paints nothing")
    assert.equal(el.style.getPropertyPriority("opacity"), "important", "YouTube's own styles cannot make it visible again")
  }
  await h.advance(400) // アイコンの滞在が終わるのを待ってから、単体 nudge を同じ観点で見る
  // コメント欄そのものを起動する nudge も同じ箱を使う。こちらが見えると中身が映像を覆う
  const comments = h.doc.querySelector("ytd-comments#comments")
  h.api.nudgeIntoViewport(comments, () => {}, 300)
  assert.equal(comments.style.getPropertyValue("opacity"), "0", "the comment section's box paints nothing either")
  await h.advance(1000)
  assert.equal(comments.getAttribute("style") ?? "", "", "and the box leaves no inline style behind")
})

// 全画面では YouTube が #columns（コメント欄・関連動画欄の親。プレイヤーは #full-bleed-container 側）を
// display:none にする。nudge はこの祖先を描画に戻す必要があるが、場所を取る形で戻すと文書が
// スクロール可能になり、YouTube 側のレイアウト再計算（プレイヤーの寸法計算）を誘発する。
test("a display:none ancestor is rendered without taking space while its descendants are nudged", async (t) => {
  const ids = ["a", "b", "c"]
  const many = ids.map((id) => thread(id).replace('<img src="https://yt3.ggpht.com/avatar.jpg">', "<img>")).join("")
  const h = setup(t, `<div id="columns" style="display: none">${section(many)}</div>`)
  h.start()
  await h.advance(600)
  const columns = h.doc.querySelector("#columns")
  const hosts = [...h.doc.querySelectorAll("#author-thumbnail")]
  assert.equal(hosts.filter((el) => el.style.position === "fixed").length, ids.length, "targets are placed in the viewport")
  assert.equal(columns.style.getPropertyValue("display"), "block", "the hidden ancestor is rendered")
  assert.equal(columns.style.getPropertyValue("height"), "0px", "…but takes no space")
  assert.equal(columns.style.getPropertyValue("overflow-y"), "hidden", "…and its content does not extend the document")
  assert.equal(columns.style.getPropertyPriority("height"), "important")
  await h.advance(400)
  assert.equal(columns.style.getPropertyValue("display"), "none", "the original display is restored")
  assert.equal(columns.style.getPropertyValue("height"), "", "temporary sizing is removed")
  assert.equal(columns.style.getPropertyValue("overflow-y"), "", "temporary clipping is removed")
})

// 関連動画カードのメタ行。新DOM（yt-lockup-view-model）は「チャンネル名」「[目] 168万 • 5 か月前」の2行、
// 旧DOM（ytd-compact-video-renderer）は #metadata-line の中に inline-metadata-item が2つ（2026-09-20 実DOM）。
const lockupCard = (videoId, title, channel, metaRow) => `
  <yt-lockup-view-model>
    <a class="ytLockupMetadataViewModelTitle" href="/watch?v=${videoId}"><span>${title}</span></a>
    <yt-content-metadata-view-model>
      <div class="ytContentMetadataViewModelMetadataRow"><span class="ytContentMetadataViewModelMetadataText">${channel}<span class="ytIconWrapperHost"></span></span></div>
      ${metaRow}
    </yt-content-metadata-view-model>
  </yt-lockup-view-model>`
const lockupMetaRow = (views, published) => `
  <div class="ytContentMetadataViewModelMetadataRow">
    <span class="ytIconWrapperHost ytContentMetadataViewModelLeadingIcon"></span>
    ${views ? `<span class="ytContentMetadataViewModelMetadataText">${views}</span><span class="ytContentMetadataViewModelDelimiter">•</span>` : ""}
    <span class="ytContentMetadataViewModelMetadataText">${published}</span>
  </div>`
const compactCard = (videoId, title, channel, views, published) => `
  <ytd-compact-video-renderer>
    <a id="video-title" href="/watch?v=${videoId}">${title}</a>
    <ytd-channel-name><div id="text">${channel}</div></ytd-channel-name>
    <ytd-video-meta-block><div id="metadata-line">
      <span class="inline-metadata-item">${views}</span><span class="inline-metadata-item">${published}</span>
    </div></ytd-video-meta-block>
  </ytd-compact-video-renderer>`

test("related videos carry the view count and publish time from both DOM generations", async (t) => {
  const h = setup(t, `<div id="related"><ytd-watch-next-secondary-results-renderer><div id="items">
    ${lockupCard("aaaaaaaaaaa", "Title A", "Channel A", lockupMetaRow("168万", "5 か月前"))}
    ${lockupCard("ccccccccccc", "Title C", "Channel 2024", lockupMetaRow("", "2 年前に配信済み"))}
    ${lockupCard("ddddddddddd", "Title D", "Channel D", "")}
    ${lockupCard("eeeeeeeeeee", "Title E", "Channel E", lockupMetaRow("116万", "1 年前") + '<div class="ytContentMetadataViewModelMetadataRow"><span class="ytIconWrapperHost"></span>オートダビング版</div>')}
    ${lockupCard("fffffffffff", "Title F", "Channel F", lockupMetaRow("", "10 分後にプレミア公開"))}
    ${lockupCard("ggggggggggg", "Title G", "Channel G", lockupMetaRow("", "1.2K watching"))}
    ${compactCard("bbbbbbbbbbb", "Title B", "Channel B", "12万 回視聴", "1 年前")}
  </div></ytd-watch-next-secondary-results-renderer></div>`)
  h.start()
  const items = Array.from(h.api.fetchRelated(), ({ videoId, channelName, viewCount, publishedAt }) => ({ videoId, channelName, viewCount, publishedAt }))
  assert.deepEqual(items, [
    { videoId: "aaaaaaaaaaa", channelName: "Channel A", viewCount: "168万", publishedAt: "5 か月前" },
    { videoId: "ccccccccccc", channelName: "Channel 2024", viewCount: undefined, publishedAt: "2 年前に配信済み" },
    { videoId: "ddddddddddd", channelName: "Channel D", viewCount: undefined, publishedAt: undefined },
    { videoId: "eeeeeeeeeee", channelName: "Channel E", viewCount: "116万", publishedAt: "1 年前" }, // バッジ行付き
    { videoId: "fffffffffff", channelName: "Channel F", viewCount: undefined, publishedAt: "10 分後にプレミア公開" }, // 予定
    { videoId: "ggggggggggg", channelName: "Channel G", viewCount: "1.2K watching", publishedAt: undefined }, // ライブ
    { videoId: "bbbbbbbbbbb", channelName: "Channel B", viewCount: "12万 回視聴", publishedAt: "1 年前" }
  ])
})

// 広告カード。サムネイルと /watch?v= リンクは持つが、タイトル・チャンネル名は
// feed-ad-metadata-view-model の中にあって通常の候補では取れない（サブ画面では
// 「（タイトルを読み込んでいます…）」のまま永久に埋まらない。2026-09-20 実機のスクリーンショット）。
const adCard = (videoId, wrapInSlot) => {
  const card = `
    <yt-lockup-view-model>
      <a href="/watch?v=${videoId}"><img src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg"></a>
      <feed-ad-metadata-view-model><span class="ytFeedAdMetadataViewModelTitle">Sponsored video</span></feed-ad-metadata-view-model>
    </yt-lockup-view-model>`
  return wrapInSlot ? `<ytd-ad-slot-renderer>${card}</ytd-ad-slot-renderer>` : card
}

test("promoted video cards are left out of the related list", async (t) => {
  const h = setup(t, `<div id="related"><ytd-watch-next-secondary-results-renderer><div id="items">
    ${adCard("adadadadada", true)}
    ${lockupCard("aaaaaaaaaaa", "Title A", "Channel A", lockupMetaRow("168万", "5 か月前"))}
    ${adCard("adadadadadb", false)}
    ${compactCard("bbbbbbbbbbb", "Title B", "Channel B", "12万 回視聴", "1 年前")}
  </div></ytd-watch-next-secondary-results-renderer></div>`)
  h.start()
  assert.deepEqual(Array.from(h.api.fetchRelated(), (item) => item.videoId), ["aaaaaaaaaaa", "bbbbbbbbbbb"])
})

// コメントがオフの動画。実DOM（2026-09-20, 子ども向け動画）:
//   ytd-message-renderer > yt-formatted-string#message > span「コメントはオフになっています。」+ a「詳細」
// YouTube が出している理由の文言（リンクの「詳細」は除く）を、サブ画面が汎用文言の代わりに出す。
test("the reason YouTube shows for an empty comment list travels with the done state", async (t) => {
  const h = setup(t, section(`<ytd-message-renderer><div id="icon"></div>
    <yt-formatted-string id="message"><span>コメントはオフになっています。</span><a href="https://support.google.com/youtube/answer/9706180">詳細</a></yt-formatted-string>
    <yt-formatted-string id="submessage"></yt-formatted-string></ytd-message-renderer>`))
  h.start()
  const state = h.api.state()
  assert.equal(state.phase, "done")
  assert.equal(state.loaded, 0)
  assert.equal(state.message, "コメントはオフになっています。")
})

test("a zero comment count has no YouTube reason, so the sub window keeps its generic wording", async (t) => {
  const h = setup(t, section('<ytd-comments-header-renderer><span id="count">０ 件のコメント</span></ytd-comments-header-renderer>' + continuation))
  h.start()
  await h.advance(15000)
  assert.equal(h.api.state().phase, "done")
  assert.equal(h.api.state().message, undefined)
})

// ★ 2026-09-21「全画面で関連動画を再生すると一瞬コメント欄が映像を覆う」。
// 0件のコメント欄を fixed 24px の箱にして画面内へ置く nudge（A）の滞在中に、その箱の中の
// 要素（アイコン等）を対象にした nudge（B）が始まると、B が祖先の A の箱に見つけた
// overflow:hidden を「クリップ」として visible に剥がし、箱から中身が溢れて映像の上に出る。
// 復元順によっては A の一時スタイルが残留もする。実DOMで再現済み。
test("a nudge inside another nudge's target never lifts that target's clipping, and nothing is left behind", async (t) => {
  const h = setup(t, `<div id="wrap" style="display: none">${section(thread("c1").replace('<img src="https://yt3.ggpht.com/avatar.jpg">', "<img>"))}</div>`)
  const comments = h.doc.querySelector("ytd-comments#comments")
  const avatar = comments.querySelector("#author-thumbnail")
  const wrap = h.doc.querySelector("#wrap")
  const finished = []
  h.api.nudgeIntoViewport(comments, () => finished.push("A"), 300)
  await h.advance(50)
  h.api.nudgeIntoViewport(avatar, () => finished.push("B"), 700)
  // during the overlap: B is in the viewport, A's box still clips its content, the hidden wrapper still takes no space
  assert.equal(avatar.style.position, "fixed", "B is placed in the viewport")
  assert.equal(comments.style.position, "fixed")
  // jsdom does not expand the `overflow` shorthand into computed longhands
  const overflowY = (el) => h.win.getComputedStyle(el).overflowY || h.win.getComputedStyle(el).overflow
  assert.equal(overflowY(comments), "hidden", "A's 24px box keeps clipping its content while B runs inside it")
  assert.equal(overflowY(wrap), "hidden", "the hidden wrapper keeps its zero-height clip")
  await h.advance(1000)
  assert.deepEqual(finished, ["A", "B"])
  for (const el of [comments, avatar, wrap]) {
    assert.equal(el.getAttribute("style") ?? "", el === wrap ? "display: none;" : "", `${el.id || el.tagName} carries no leftover inline style`)
  }
})

// 再生ボタンは関連動画カードのアンカーを押す。新しい全画面UIではプレイヤー内のグリッド
// （.ytp-fullscreen-grid の videowall still）が #columns より文書順で前にあり、
// document 全体の先頭一致だとそちらを掴む（2026-09-21 実DOMで関連動画6件すべてが still に一致）。
// still のクリックはプレイヤー自身のエンドスクリーン用の遷移で、全画面グリッドの状態遷移を伴う。
// チャンネル登録ボタン。2026-11-05 実DOMで確認:
//   未登録   … ytd-subscribe-button-renderer に属性なし / 文言「チャンネル登録」
//   登録済み … `subscribed=""` が付く / 文言「登録済み」＋通知ベルのボタンが現れる
// 文言は言語で変わるので属性で判定する。ベルも button なので、押す対象は先頭の1つに限る。
const subscribeArea = ({ subscribed = false } = {}) => `
  <ytd-watch-metadata>
    <div id="owner"><ytd-video-owner-renderer>
      <a><yt-img-shadow id="avatar"><img src="https://yt3.ggpht.com/ch.jpg"></yt-img-shadow></a>
      <div id="upload-info">
      <ytd-channel-name id="channel-name"><a href="/@ch">Channel X</a></ytd-channel-name>
      <yt-formatted-string id="owner-sub-count">チャンネル登録者数 673万人</yt-formatted-string>
    </div></ytd-video-owner-renderer></div>
    <div id="subscribe-button"><ytd-subscribe-button-renderer ${subscribed ? 'subscribed=""' : ""}>
      <yt-smartimation><yt-button-shape>
        <button aria-label="Channel X ${subscribed ? "のチャンネル登録を解除" : "をチャンネル登録"}">${subscribed ? "登録済み" : "チャンネル登録"}</button>
      </yt-button-shape>
      <div id="notification-preference-toggle-button"><button aria-label="通知設定"></button></div>
      </yt-smartimation>
    </ytd-subscribe-button-renderer></div>
  </ytd-watch-metadata>`
const subscribeButton = (h) => h.doc.querySelector("ytd-subscribe-button-renderer button")

test("the channel subscription state is read from the subscribe button's own attribute", (t) => {
  const h = setup(t, subscribeArea())
  assert.deepEqual(plain(h.api.readChannelState()), { subscribed: false })

  h.doc.querySelector("ytd-subscribe-button-renderer").setAttribute("subscribed", "")
  assert.deepEqual(plain(h.api.readChannelState()), { subscribed: true })

  // SPA遷移直後に残っている前の動画のボタンは、今の動画のものとして扱わない
  h.doc.querySelector("ytd-watch-flexy").setAttribute("video-id", "previous")
  assert.equal(h.api.readChannelState(), null)
})

test("the channel icon and subscriber count travel with the status", async (t) => {
  const h = setup(t, subscribeArea())
  const status = await h.handlers.PLAYER_GET_STATUS(undefined)
  assert.equal(status.channelName, "Channel X")
  assert.equal(status.channelSubscribers, "チャンネル登録者数 673万人",
    "YouTube の表示文言のまま渡す（言語ごとの言い回しを作らない）")
  assert.match(status.channelAvatarUrl, /ch\.jpg$/)
})

test("subscribing clicks the main window's button and reports whether YouTube applied it", async (t) => {
  const h = setup(t, subscribeArea())
  const host = h.doc.querySelector("ytd-subscribe-button-renderer")
  // YouTube の契約: ログイン中なら押した少し後に subscribed が付く
  subscribeButton(h).addEventListener("click", () => h.win.setTimeout(() => host.setAttribute("subscribed", ""), 50))
  h.start()
  const pending = h.handlers.CHANNEL_SUBSCRIBE(undefined)
  await h.advance(1200)
  assert.deepEqual(plain(await pending), { channel: { subscribed: true }, applied: true })
  const status = h.events.filter((e) => e.type === "STATUS").at(-1)
  assert.equal(status.payload.channel.subscribed, true, "the new state is pushed even while the video is paused")
})

// ★ 登録済みのボタンを押すと、YouTube は「登録を解除」を含むメニューを開く。
//   サブ画面からの登録要求で、解除の入口を誤って開かないこと。
test("an already-subscribed channel is never clicked", async (t) => {
  const h = setup(t, subscribeArea({ subscribed: true }))
  let clicks = 0
  subscribeButton(h).addEventListener("click", () => clicks++)
  const pending = h.handlers.CHANNEL_SUBSCRIBE(undefined)
  await h.advance(1200)
  assert.deepEqual(plain(await pending), { channel: { subscribed: true }, applied: false })
  assert.equal(clicks, 0, "the unsubscribe menu is never opened from the sub window")
})

test("a subscription YouTube does not apply (logged out) is reported as not applied", async (t) => {
  const h = setup(t, subscribeArea())
  let clicks = 0
  subscribeButton(h).addEventListener("click", () => clicks++) // ログイン案内を出すだけで状態は変えない
  const pending = h.handlers.CHANNEL_SUBSCRIBE(undefined)
  await h.advance(1200)
  assert.deepEqual(plain(await pending), { channel: { subscribed: false }, applied: false })
  assert.equal(clicks, 1, "the button is pressed exactly once")
})

test("playing a related video clicks its card in the related list, not the player's videowall still", async (t) => {
  const h = setup(t, `<div id="related"><ytd-watch-next-secondary-results-renderer><div id="items">
    ${lockupCard("aaaaaaaaaaa", "Title A", "Channel A", lockupMetaRow("168万", "5 か月前"))}
  </div></ytd-watch-next-secondary-results-renderer></div>`)
  h.doc.querySelector("#movie_player").innerHTML =
    '<div class="ytp-fullscreen-grid"><a class="ytp-modern-videowall-still" href="/watch?v=aaaaaaaaaaa&list=RDaaaaaaaaaaa"></a></div>'
  const clicked = []
  for (const a of h.doc.querySelectorAll("a[href]")) {
    a.addEventListener("click", (e) => { e.preventDefault(); clicked.push(a.closest("#movie_player") ? "still" : "card") })
  }
  h.handlers.NAVIGATE_TO_VIDEO({ videoId: "aaaaaaaaaaa" })
  assert.deepEqual(clicked, ["card"])
})

test("without a related card the player's still is still not clicked; YouTube's router is asked instead", async (t) => {
  const h = setup(t, "")
  h.doc.querySelector("#movie_player").innerHTML =
    '<div class="ytp-fullscreen-grid"><a class="ytp-modern-videowall-still" href="/watch?v=aaaaaaaaaaa"></a></div>'
  const app = h.doc.body.appendChild(h.doc.createElement("ytd-app"))
  const still = h.doc.querySelector("a.ytp-modern-videowall-still")
  let stillClicks = 0
  still.addEventListener("click", (e) => { e.preventDefault(); stillClicks++ })
  const routed = []
  app.addEventListener("yt-navigate", (e) => routed.push(e.detail?.endpoint?.watchEndpoint?.videoId))
  h.handlers.NAVIGATE_TO_VIDEO({ videoId: "aaaaaaaaaaa" })
  assert.equal(stillClicks, 0)
  assert.deepEqual(routed, ["aaaaaaaaaaa"])
})

// ★ 2026-10-15「コメントの自動読み込みがされない。メイン画面でコメントを見ないとサブに表示されない」。
// YouTube が watch ページを骨組み(skeleton)＋段階的ハイドレーションに変えた。実DOMで確認した事実
// （2026-10-15、ブラウザペイン・スクロールなし）:
//   1. 最初はコメント欄も #below も存在しない（ytd-watch-flexy すら後から生成される）
//   2. 少し後に #below と ytd-comments#comments が現れるが、コメント欄は [hidden] の中にあり空
//   3. さらに後に hidden が外れ、#contents に ytd-continuation-item-renderer が入る。その中身は
//      新要素 yt-ghost-comments（スケルトンのカード）
//   4. この continuation を画面内へ置くと YouTube は最初のバッチを読み込む（実ページで 0件→6件 を確認）。
//      スクロールしない限り、それ以外では永久に読み込まれない
//   5. パネル側（engagement-panel-comments-section の ytd-comments。id なし）は最初から存在し、
//      独自の continuation を持つ。通常欄が [hidden] の間、findCommentSection はこちらへ
//      フォールバックしてしまう
// ここでは 4 を「YouTubeの契約」としてモデル化する（通常欄の continuation が画面内に入ったときだけ
// 読み込む）。拡張が別の要素を刺激した場合や、continuation が現れる前に諦めた場合は何も起きない
// ＝報告どおり「メイン画面でコメントを開くまでサブに出ない」になる。
const lateHydratingWatchPage = (h) => {
  const flexy = h.doc.querySelector("ytd-watch-flexy")
  const inline = () => h.doc.querySelector("ytd-comments#comments")
  return {
    // 実ページと同じく、パネル側のコメント欄は最初から存在する
    panel() {
      flexy.insertAdjacentHTML("beforeend", `
        <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-comments-section"
          visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN">
          <ytd-comments><ytd-item-section-renderer><div id="contents">
            <ytd-continuation-item-renderer id="panel-continuation"></ytd-continuation-item-renderer>
          </div></ytd-item-section-renderer></ytd-comments>
        </ytd-engagement-panel-section-list-renderer>`)
    },
    shell() { // #below とコメント欄は出るが、まだ [hidden] の中で空
      const below = h.doc.createElement("div")
      below.id = "below"
      below.innerHTML = '<div hidden><ytd-comments id="comments"></ytd-comments></div>'
      flexy.appendChild(below)
    },
    hydrate() { // hidden が外れ、ghost 入りの continuation が入る。以後が「読み込める」状態
      inline().parentElement.removeAttribute("hidden")
      inline().innerHTML = `<ytd-item-section-renderer id="sections"><div id="contents">
        <ytd-continuation-item-renderer><div id="ghost-comment-section"><yt-ghost-comments></yt-ghost-comments></div></ytd-continuation-item-renderer>
      </div></ytd-item-section-renderer>`
      // YouTube の契約: 通常欄の continuation が画面内に置かれたときだけ最初のバッチを入れる
      const continuation = inline().querySelector("ytd-continuation-item-renderer")
      const observer = new h.win.MutationObserver(() => {
        if (continuation.style.position !== "fixed") return
        observer.disconnect()
        continuation.querySelector("#ghost-comment-section")?.remove()
        inline().querySelector("#contents").insertAdjacentHTML("afterbegin", thread("c1") + thread("c2"))
      })
      observer.observe(continuation, { attributes: true, attributeFilter: ["style"] })
      return continuation
    }
  }
}

test("comments load by themselves on a watch page that hydrates in stages", async (t) => {
  const h = setup(t, "")
  h.doc.querySelector("#below").remove() // 骨組みだけ。刺激できる要素はまだ無い
  const page = lateHydratingWatchPage(h)
  page.panel()
  h.start()

  await h.advance(7000)
  page.shell()
  await h.advance(7000)
  page.hydrate()

  // メイン画面には触れない。拡張が自力で最初のバッチまで到達しなければならない
  for (let i = 0; i < 40 && h.api.items().length === 0; i++) await h.advance(500)
  assert.deepEqual(Array.from(h.api.items(), (item) => item.id), ["lc:c1", "lc:c2"],
    "the first batch reaches the sub window without touching the main window")
  assert.notEqual(h.api.state().phase, "error")
})

test("the hidden comments panel is not mistaken for the real section while the page is still hydrating", async (t) => {
  const h = setup(t, "")
  h.doc.querySelector("#below").remove()
  const page = lateHydratingWatchPage(h)
  page.panel()
  h.start()
  await h.advance(7000)
  page.shell()
  await h.advance(3000)
  // この時点で通常欄は [hidden]。パネルを掴んで、その continuation を刺激してはならない
  assert.equal(h.doc.querySelector("#panel-continuation").style.position, "",
    "the hidden panel's continuation is never placed in the viewport")
})

// 動画の評価ボタン（segmented-like-dislike-button-view-model 世代）。押下状態は aria-pressed、件数はボタン内の文言。
const ratingButtons = ({ liked = false, disliked = false, count = "1.2万" } = {}) => `
  <ytd-watch-metadata><div id="top-level-buttons-computed"><segmented-like-dislike-button-view-model>
    <like-button-view-model><toggle-button-view-model><button-view-model>
      <button aria-pressed="${liked}"><div class="yt-spec-button-shape-next__icon"></div>
        <div class="yt-spec-button-shape-next__button-text-content">${count}</div></button>
    </button-view-model></toggle-button-view-model></like-button-view-model>
    <dislike-button-view-model><toggle-button-view-model><button-view-model>
      <button aria-pressed="${disliked}"></button>
    </button-view-model></toggle-button-view-model></dislike-button-view-model>
  </segmented-like-dislike-button-view-model></div></ytd-watch-metadata>`
// CS が jsdom 側の realm で作ったオブジェクトは、プロトタイプが違うため deepStrictEqual で一致しない
const plain = (value) => JSON.parse(JSON.stringify(value))
const ratingButton = (h, kind) => h.doc.querySelector(`ytd-watch-metadata ${kind}-button-view-model button`)
// YouTube の契約: ログイン中なら押した少し後に切り替わり、高評価と低評価は排他。未ログインなら何も変わらない。
const youtubeRatesOnClick = (h) => {
  const [like, dislike] = [ratingButton(h, "like"), ratingButton(h, "dislike")]
  const toggle = (button, other) => button.addEventListener("click", () => h.win.setTimeout(() => {
    const on = button.getAttribute("aria-pressed") !== "true"
    button.setAttribute("aria-pressed", String(on))
    if (on) other.setAttribute("aria-pressed", "false")
  }, 50))
  toggle(like, dislike)
  toggle(dislike, like)
}

test("the video rating is read from the watch metadata, not the player's own buttons", (t) => {
  const h = setup(t, ratingButtons({ liked: true }))
  // 新しい全画面UIのプレイヤー内ボタンを模した偽物。文書順ではこちらが先
  h.doc.querySelector("#movie_player").innerHTML =
    '<like-button-view-model><button aria-pressed="false">999</button></like-button-view-model>'
  assert.deepEqual(plain(h.api.readVideoRating()), { liked: true, disliked: false, likeCount: "1.2万" })

  // 件数を非公開にした動画は数字の無い文言になる。件数として扱わない
  h.doc.querySelector(".yt-spec-button-shape-next__button-text-content").textContent = "高く評価"
  assert.deepEqual(plain(h.api.readVideoRating()), { liked: true, disliked: false })

  // SPA遷移直後に残っている前の動画のボタンは、今の動画の評価として扱わない
  h.doc.querySelector("ytd-watch-flexy").setAttribute("video-id", "previous")
  assert.equal(h.api.readVideoRating(), null)
})

// ★ 件数はロール表示（アニメーション）で、桁ごとに 0-9 の数字列が並ぶ。ボタン全体の文字を
//   そのまま件数にすると、これがサブ画面に出る。2026-11-05 に実際に出た報告:
//   いいね84（2桁）の動画で「12345678901234567890123456789 12345678901234567890123456789」。
test("the rolling animation's digit strips are never shown as the like count", (t) => {
  const reel = "12345678901234567890123456789"
  const h = setup(t, ratingButtons({ count: `<span>${reel}</span><span>${reel}</span>` }))
  assert.deepEqual(plain(h.api.readVideoRating()), { liked: false, disliked: false },
    "no count at all is better than the animation's scratch digits")

  // 落ち着けば本来の件数になる
  h.doc.querySelector(".yt-spec-button-shape-next__button-text-content").textContent = "84"
  assert.deepEqual(plain(h.api.readVideoRating()), { liked: false, disliked: false, likeCount: "84" })
})

test("rating from the sub window clicks the main window's button and reports whether YouTube applied it", async (t) => {
  const h = setup(t, ratingButtons())
  youtubeRatesOnClick(h)
  h.start()
  const rate = async (action) => {
    const pending = h.handlers.VIDEO_RATE({ action })
    await h.advance(1200)
    return pending
  }

  assert.deepEqual(plain(await rate("like")), { rating: { liked: true, disliked: false, likeCount: "1.2万" }, applied: true })
  const status = h.events.filter((e) => e.type === "STATUS").at(-1)
  assert.equal(status.payload.rating.liked, true, "the new state is pushed even while the video is paused")

  assert.deepEqual(plain((await rate("dislike")).rating), { liked: false, disliked: true, likeCount: "1.2万" })
  assert.deepEqual(plain((await rate("dislike")).rating), { liked: false, disliked: false, likeCount: "1.2万" }, "a second press removes it")
})

test("a rating YouTube does not apply (logged out) is reported as not applied", async (t) => {
  const h = setup(t, ratingButtons())
  let clicks = 0
  ratingButton(h, "like").addEventListener("click", () => clicks++) // ログイン案内を出すだけで状態は変えない
  const pending = h.handlers.VIDEO_RATE({ action: "like" })
  await h.advance(1200)
  assert.deepEqual(plain(await pending), { rating: { liked: false, disliked: false, likeCount: "1.2万" }, applied: false })
  assert.equal(clicks, 1, "the button is pressed exactly once")
})

test("a rating changed on the main window while paused reaches the sub window within a second", async (t) => {
  const h = setup(t, ratingButtons())
  h.start()
  const ratings = () => h.events.filter((e) => e.type === "STATUS").map((e) => e.payload.rating.liked)
  await h.advance(1000)
  assert.deepEqual(ratings(), [false])
  ratingButton(h, "like").setAttribute("aria-pressed", "true")
  await h.advance(1000)
  assert.deepEqual(ratings(), [false, true])
  await h.advance(3000)
  assert.deepEqual(ratings(), [false, true], "nothing more is sent while the rating stays the same")
})


/* ---- サイドバー（YouTubeの呼称は guide） ---------------------------------
 * 2026-11-05 実機で確かめた形に合わせたつくりもの:
 *   - watch ページには最初 ytd-guide-renderer が無く、ドロワーを開いて初めて組み立てられる
 *   - 組み立ては押してから約650ms
 *   - 「ショート」は href を持たない
 *   - 「もっと見る」で隠れているチャンネルは、展開するまでDOMに存在しない
 * ------------------------------------------------------------------------ */

const HOME_PATH = "m11.485 2.143-8 4.8-2 1.2a1 1 0 001.03 1.714L3 9.567V20Z"
const CHEVRON_PATH = "M12 15.4 6.6 10l1.4-1.4 4 4 4-4 1.4 1.4Z"

const guideEntry = (title, { href, icon, avatar, id } = {}) => `
  <ytd-guide-entry-renderer${id ? ` id="${id}"` : ""}>
    <a id="endpoint"${href ? ` href="${href}"` : ""}>
      <tp-yt-paper-item>
        <yt-icon class="guide-icon">${icon ? `<svg viewBox="0 0 24 24"><path d="${icon}"></path></svg>` : ""}</yt-icon>
        <yt-img-shadow><img id="img"${avatar ? ` src="${avatar}"` : ""}></yt-img-shadow>
        <yt-formatted-string class="title">${title}</yt-formatted-string>
      </tp-yt-paper-item>
    </a>
  </ytd-guide-entry-renderer>`

const guideMarkup = () => `
  <ytd-guide-renderer>
    <ytd-guide-section-renderer><h3></h3><div id="items">
      ${guideEntry("ホーム", { href: "/", icon: HOME_PATH })}
      ${guideEntry("ショート", { icon: CHEVRON_PATH })}
    </div></ytd-guide-section-renderer>
    <ytd-guide-section-renderer><h3></h3><div id="items">
      ${guideEntry("登録チャンネル", { href: "/feed/subscriptions", icon: CHEVRON_PATH })}
      ${guideEntry("すみれのBGM", { href: "/@sumire", avatar: "https://yt3.ggpht.com/a.jpg" })}
      <ytd-guide-collapsible-entry-renderer>
        ${guideEntry("もっと見る", { id: "expander-item", icon: CHEVRON_PATH })}
        <div id="expanded">
          <div id="expandable-items"></div>
          ${guideEntry("折りたたむ", { id: "collapser-item", icon: CHEVRON_PATH })}
        </div>
      </ytd-guide-collapsible-entry-renderer>
    </div></ytd-guide-section-renderer>
    <ytd-guide-section-renderer><h3 id="guide-section-title">探索</h3><div id="items">
      ${guideEntry("音楽", { href: "/channel/UC-9", icon: CHEVRON_PATH })}
    </div></ytd-guide-section-renderer>
  </ytd-guide-renderer>`

const DRAWER_STYLE = "transition-duration: 200ms; touch-action: pan-y;"
const guideShell = (opened = "", content = "") => `
  <div id="guide-button"><button></button></div>
  <tp-yt-app-drawer id="guide" style="${DRAWER_STYLE}"${opened}>
    <div id="scrim"></div><div id="contentContainer">${content}</div>
  </tp-yt-app-drawer>`

/** メイン画面のYouTubeの振る舞い。開閉と、初回に開いたときの組み立てを再現する */
function youtubeBuildsGuideOnOpen(h) {
  const drawer = h.doc.querySelector("tp-yt-app-drawer#guide")
  const button = h.doc.querySelector("#guide-button button")
  const openedWith = []
  button.addEventListener("click", () => {
    if (drawer.hasAttribute("opened")) { drawer.removeAttribute("opened"); return }
    drawer.setAttribute("opened", "")
    openedWith.push(drawer.getAttribute("style")) // 開いた瞬間、画面にどう見えていたか
    h.win.setTimeout(() => {
      if (!h.doc.querySelector("ytd-guide-renderer")) {
        drawer.querySelector("#contentContainer").innerHTML = guideMarkup()
      }
    }, 650)
  })
  return { drawer, button, openedWith }
}

/** 「もっと見る」を押したときの展開。隠れていたチャンネルはここで初めてDOMへ入る */
function youtubeExpandsOnClick(h) {
  const collapsible = h.doc.querySelector("ytd-guide-collapsible-entry-renderer")
  collapsible.querySelector("#expander-item a").addEventListener("click", () => {
    collapsible.setAttribute("expanded", "")
    collapsible.querySelector("#expandable-items").innerHTML =
      guideEntry("うしし", { href: "/@usiusisi", avatar: "https://yt3.ggpht.com/b.jpg" })
  })
}

/**
 * 押された項目を記録する。★ あわせて既定の遷移を止める。本物のYouTubeはSPAとして自前で
 * 遷移するが、jsdom は <a href> の既定動作を「未実装の画面遷移」として扱い、後から
 * 実タイマーで例外を投げて実行を止めてしまう（このファイルは偽のタイマーで時間を進めている）。
 */
const guideClickLog = (h) => {
  const clicks = []
  h.doc.addEventListener("click", (event) => {
    const entry = event.target.closest?.("ytd-guide-entry-renderer")
    if (entry) clicks.push(entry.textContent.trim())
    event.preventDefault()
  })
  return clicks
}

/**
 * 偽の時間を少しずつ進めながら、処理が終わるのを待つ。
 * ★ 一度に大きく進めても終わらない。advance() は1回の待ちにつきマイクロタスクを1周しか
 *   回さないため、await が何段も続く処理（サイドバーの組み立て）は途中で取り残され、
 *   次に advance() を呼ぶまで先へ進まない。
 */
async function settle(h, promise, slices = 20, ms = 500) {
  let result
  let done = false
  promise.then((value) => { result = value; done = true })
  for (let i = 0; i < slices && !done; i++) await h.advance(ms)
  assert.ok(done, "処理が終わらなかった")
  return result
}

const fetchGuide = (h) => settle(h, h.handlers.DOM_FETCH_GUIDE())
const activate = (h, entry) =>
  settle(h, h.handlers.GUIDE_ACTIVATE({ id: entry.id, title: entry.title, href: entry.href }))
const titlesOf = (guide) =>
  // plain() を通すのは、Content Script 側の配列が jsdom のレルムで作られていて
  // deepEqual が「中身は同じだが別の Array」として落ちるため（このファイルの他の検査と同じ理由）
  plain(guide.sections.map((section) => section.entries.map((entry) => entry.title)))

test("the sidebar is built by opening the main window's drawer out of sight, then put back as it was", async (t) => {
  const h = setup(t, guideShell())
  const youtube = youtubeBuildsGuideOnOpen(h)
  assert.ok(!h.doc.querySelector("ytd-guide-renderer"), "watchページには最初サイドバーが無い")

  const guide = await fetchGuide(h)

  assert.equal(youtube.openedWith.length, 1, "ドロワーは1回だけ開く")
  assert.match(youtube.openedWith[0], /opacity: 0/, "開いている間は透明にする")
  assert.match(youtube.openedWith[0], /pointer-events: none/, "開いている間は操作も受けない")
  assert.equal(youtube.drawer.hasAttribute("opened"), false, "読み終えたら閉じる")
  assert.equal(youtube.drawer.style.opacity, "", "こちらで当てた透明化は残さない")
  assert.equal(youtube.drawer.style.getPropertyValue("pointer-events"), "")
  // YouTube自身が持っている inline style は壊さない（ドロワーは transition-duration を持つ）。
  // touch-action は jsdom が実装していないプロパティなので、ここでは見られない。
  assert.equal(youtube.drawer.style.getPropertyValue("transition-duration"), "200ms")

  assert.equal(guide.available, true)
  assert.deepEqual(titlesOf(guide), [
    ["ホーム", "ショート"],
    ["登録チャンネル", "すみれのBGM", "もっと見る"], // 「折りたたむ」は畳んでいる間は出さない
    ["音楽"]
  ])
  assert.deepEqual(plain(guide.sections.map((section) => section.title)), ["", "", "探索"])
  const home = guide.sections[0].entries[0]
  assert.deepEqual(
    { href: home.href, iconPath: home.iconPath, avatarUrl: home.avatarUrl },
    { href: "/", iconPath: HOME_PATH, avatarUrl: "" }
  )
  const channel = guide.sections[1].entries[1]
  assert.deepEqual(
    { href: channel.href, iconPath: channel.iconPath, avatarUrl: channel.avatarUrl },
    { href: "/@sumire", iconPath: "", avatarUrl: "https://yt3.ggpht.com/a.jpg" }
  )
})

test("a drawer the user opened themselves is read without touching it", async (t) => {
  const h = setup(t, guideShell(" opened", guideMarkup()))
  const youtube = youtubeBuildsGuideOnOpen(h)

  const guide = await fetchGuide(h)

  assert.deepEqual(youtube.openedWith, [], "開いているものを押し直さない（押すと閉じてしまう）")
  assert.equal(youtube.drawer.hasAttribute("opened"), true, "利用者が開いたものは開いたまま")
  assert.equal(youtube.drawer.getAttribute("style"), DRAWER_STYLE, "スタイルにも触れない")
  assert.equal(titlesOf(guide)[0][0], "ホーム")
})

test("a sidebar entry is pressed on the main window instead of being turned into a URL", async (t) => {
  const h = setup(t, guideShell(" opened", guideMarkup()))
  const guide = await fetchGuide(h)
  const clicks = guideClickLog(h)
  const shorts = guide.sections[0].entries[1]
  assert.deepEqual({ title: shorts.title, href: shorts.href }, { title: "ショート", href: "" },
    "hrefを持たない項目がある。URLを組み立てる方式では押せない")

  assert.equal((await activate(h, shorts)).ok, true)

  assert.deepEqual(clicks, ["ショート"], "メイン画面の同じ項目を1回だけ押す")
  assert.equal(h.win.location.pathname, "/watch", "こちらでURLを組み立てて飛ばしたりしない")
})

test("an entry is found again by its link when the main window's list has shifted", async (t) => {
  const h = setup(t, guideShell(" opened", guideMarkup()))
  const guide = await fetchGuide(h)
  const home = guide.sections[0].entries[0]

  // 読んだ後にYouTube側が項目を増やし、位置がずれた状態にする
  h.doc.querySelector("ytd-guide-section-renderer #items")
    .insertAdjacentHTML("afterbegin", guideEntry("新着", { href: "/feed/new", icon: CHEVRON_PATH }))
  const clicks = guideClickLog(h)

  assert.equal((await activate(h, home)).ok, true)

  assert.deepEqual(clicks, ["ホーム"], "位置ではなくリンク先で引き直す")
})

test("an entry remembered from before a reload rebuilds the sidebar before pressing it", async (t) => {
  const h = setup(t, guideShell()) // 読み込み直後のメイン画面。サイドバーはまだDOMに無い
  const youtube = youtubeBuildsGuideOnOpen(h)
  const clicks = guideClickLog(h)

  // サブ画面は前のページで読んだ内容をそのまま持っている
  const result = await activate(h, { id: "s0:e0", title: "ホーム", href: "/" })

  assert.equal(result.ok, true)
  assert.equal(youtube.openedWith.length, 1, "組み立て直してから押す")
  assert.deepEqual(clicks, ["ホーム"])
})

test("channels hidden behind the main window's 'show more' arrive only once it is expanded", async (t) => {
  const h = setup(t, guideShell(" opened", guideMarkup()))
  youtubeExpandsOnClick(h)
  const guide = await fetchGuide(h)
  const expander = guide.sections[1].entries.at(-1)
  assert.equal(expander.title, "もっと見る")

  const expanded = (await activate(h, expander)).guide

  assert.deepEqual(titlesOf(expanded)[1], ["登録チャンネル", "すみれのBGM", "うしし", "折りたたむ"],
    "展開後は隠れていたチャンネルと「折りたたむ」に入れ替わる")
})

test("an icon is carried over only when it really is path data", async (t) => {
  const h = setup(t, guideShell(" opened", `
    <ytd-guide-renderer><ytd-guide-section-renderer><h3></h3><div id="items">
      ${guideEntry("正しい", { href: "/ok", icon: HOME_PATH })}
      ${guideEntry("細工", { href: "/ng", icon: "url(javascript:alert(1))" })}
    </div></ytd-guide-section-renderer></ytd-guide-renderer>`))

  const guide = await fetchGuide(h)

  assert.deepEqual(plain(guide.sections[0].entries.map((entry) => entry.iconPath)), [HOME_PATH, ""],
    "パスデータとして妥当な文字以外は持ち出さない")
})

// ---- 返信への返信（v85） ----
//
// ★ 2026-11-08 実測（watchページ・「14 件の返信」のスレッド）: 返信は1件ずつ
//   `yt-sub-thread > div > ytd-comment-thread-renderer` に包まれ、その中の `#replies` に
//   「返信への返信」がぶら下がる。14件のうち直下は5件で、残り9件はその5件の内側にいた。
//   この入れ子は**親が展開されている間しかDOMに無い**。メイン画面を読み込み直すと
//   返信のview-modelは0件に戻る（実測）。一方サブ画面は返信の行を持ち続けるため、
//   そこで「返信 3件」を押すと not-found になり、何度押しても直らなかった
//   （ユーザー報告「返信が表示されない」）。
const subReply = (id, replyCount) => `
  <yt-sub-thread><div>
    <ytd-comment-thread-renderer>
      <div id="comment-container"><ytd-comment-view-model>
        <a id="author-text">Replier</a>
        <div id="author-thumbnail"><img src="https://yt3.ggpht.com/avatar.jpg"></div>
        <span id="published-time-text"><a href="/watch?v=current&lc=${id}">1 day ago</a></span>
        <div id="content-text">Reply ${id}</div>
      </ytd-comment-view-model></div>
      <div id="replies"><ytd-comment-replies-renderer>${replyCount
        ? `<div id="collapsed-threads"><div id="more-replies-sub-thread"><button>${replyCount} 件の返信</button></div></div>`
        : ""}</ytd-comment-replies-renderer></div>
    </ytd-comment-thread-renderer>
  </div></yt-sub-thread>`

// idごとに「その返信の中身」を持つYouTubeを再現する。トグルを押すと delayMs 後に中身が現れ、
// 現れた返信のトグルもその場で効くようになる（本物と同じく入れ子は後から生える）。
function stubThreads(h, tree, delayMs = 400) {
  const wired = new WeakSet()
  const order = []
  const idOf = (thread) => {
    const link = thread.querySelector(":scope > #comment-container a[href*='lc=']")
    return new URL(link.getAttribute("href"), "https://www.youtube.com").searchParams.get("lc")
  }
  const wireAll = () => {
    for (const button of h.doc.querySelectorAll("#more-replies-sub-thread button")) {
      if (wired.has(button)) continue
      wired.add(button)
      const owner = button.closest("ytd-comment-thread-renderer")
      const id = idOf(owner)
      button.addEventListener("click", () => {
        order.push(id)
        const html = tree[id]
        if (!html) return
        h.win.setTimeout(() => {
          owner.querySelector(":scope > #replies > ytd-comment-replies-renderer")
            .insertAdjacentHTML("beforeend", `<div id="expanded-threads">${html}</div>`)
          wireAll()
        }, delayMs)
      })
    }
  }
  wireAll()
  return order
}

test("a reply that has replies of its own reports how many, and hands them over when asked", async (t) => {
  const h = setup(t, section(threadWithReplies("parent", 3)))
  h.start()
  stubThreads(h, {
    parent: subReply("parent.r1", 1) + subReply("parent.r2"),
    "parent.r1": subReply("parent.r1.r1")
  })

  const first = await settle(h, h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" }))
  assert.deepEqual(Array.from(first.items, (item) => item.id), ["lc:parent.r1", "lc:parent.r2"])
  assert.deepEqual(Array.from(first.items, (item) => item.replyCount), [1, undefined],
    "入れ子の返信を持つ行だけが件数を持つ")

  const nested = await settle(h, h.handlers.COMMENT_LOAD_REPLIES({
    commentId: "lc:parent.r1", ancestors: ["lc:parent"]
  }))
  assert.deepEqual(Array.from(nested.items, (item) => item.id), ["lc:parent.r1.r1"])
  assert.deepEqual(Array.from(nested.items, (item) => item.parentId), ["lc:parent.r1"])
})

test("a nested reply is brought back by re-opening its parent after the main window is rebuilt", async (t) => {
  const tree = {
    parent: subReply("parent.r1", 1) + subReply("parent.r2"),
    "parent.r1": subReply("parent.r1.r1")
  }
  const h = setup(t, section(threadWithReplies("parent", 3)))
  h.start()
  stubThreads(h, tree)
  await settle(h, h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" }))

  // メイン画面が作り直される（読み込み直し・SPAの再描画・YouTubeによるスレッド要素の作り直し）。
  // サブ画面はこのとき返信の行を持ったままなので、押されるのは「もうDOMに無いid」になる。
  h.doc.querySelector("ytd-comments #contents").innerHTML = threadWithReplies("parent", 3)
  stubThreads(h, tree)
  assert.equal(h.doc.querySelectorAll("ytd-comment-replies-renderer ytd-comment-view-model").length, 0,
    "作り直したメイン画面に返信は1件も残っていない")

  // 親の並びが無いと、以前と同じく詰む（これが報告された状態）
  const blind = await settle(h, h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent.r1" }))
  assert.equal(blind.items.length, 0)
  assert.equal(blind.reason, "not-found")

  // 親の並びを添えると、外側から開き直して呼び戻す
  const revived = await settle(h, h.handlers.COMMENT_LOAD_REPLIES({
    commentId: "lc:parent.r1", ancestors: ["lc:parent"]
  }))
  assert.equal(revived.reason, undefined)
  assert.deepEqual(Array.from(revived.items, (item) => item.id), ["lc:parent.r1.r1"])
})

test("a reply two levels down re-opens every parent, outermost first", async (t) => {
  const tree = {
    parent: subReply("parent.r1", 1),
    "parent.r1": subReply("parent.r1.r1", 1),
    "parent.r1.r1": subReply("parent.r1.r1.r1")
  }
  const h = setup(t, section(threadWithReplies("parent", 3)))
  h.start()
  const order = stubThreads(h, tree)

  const result = await settle(h, h.handlers.COMMENT_LOAD_REPLIES({
    commentId: "lc:parent.r1.r1", ancestors: ["lc:parent", "lc:parent.r1"]
  }))
  assert.deepEqual(Array.from(result.items, (item) => item.id), ["lc:parent.r1.r1.r1"])
  assert.deepEqual(order, ["parent", "parent.r1", "parent.r1.r1"],
    "外側から順に開く。内側から押しても親がまだ無いので開けない")
})

test("re-opening a parent never clicks a toggle twice (that would collapse the thread)", async (t) => {
  const tree = { parent: subReply("parent.r1", 1), "parent.r1": subReply("parent.r1.r1") }
  const h = setup(t, section(threadWithReplies("parent", 3)))
  h.start()
  const order = stubThreads(h, tree)

  // サブ画面は行が見えた順に先読みする。親と子が続けて来ても、親のトグルは一度しか押さない。
  const parent = h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent", prefetch: true })
  const child = h.handlers.COMMENT_LOAD_REPLIES({
    commentId: "lc:parent.r1", ancestors: ["lc:parent"], prefetch: true
  })
  assert.deepEqual(Array.from((await settle(h, parent)).items, (item) => item.id), ["lc:parent.r1"])
  assert.deepEqual(Array.from((await settle(h, child)).items, (item) => item.id), ["lc:parent.r1.r1"])
  assert.deepEqual(order, ["parent", "parent.r1"])
})

// ---- 件数を出さない返信と、押さないと来ない返信（v86） ----

/** 入れ子の返信のトグルは「返信を表示」で数字を持たない（2026-11-08 実測）。 */
const withoutReplyCount = (html) =>
  html.replace(/<button>\d+ 件の返信<\/button>/, "<button>返信を表示</button>")

test("a reply whose toggle shows no number still offers a way in", async (t) => {
  const h = setup(t, section(threadWithReplies("parent", 3)))
  h.start()
  stubThreads(h, {
    parent: withoutReplyCount(subReply("parent.r1", 1)) + subReply("parent.r2"),
    "parent.r1": subReply("parent.r1.r1")
  })

  const first = await settle(h, h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" }))
  const r1 = Array.from(first.items).find((item) => item.id === "lc:parent.r1")
  const r2 = Array.from(first.items).find((item) => item.id === "lc:parent.r2")
  assert.equal(r1.replyCount, undefined, "YouTubeが数字を出していないので件数は分からない")
  assert.equal(r1.hasReplies, true, "それでも『返信はある』ことは伝える")
  assert.equal(r2.hasReplies, undefined, "返信を持たない行には何も立てない")

  // そして実際に開ける（件数が無いだけで、中身は普通に取れる）
  const nested = await settle(h, h.handlers.COMMENT_LOAD_REPLIES({
    commentId: "lc:parent.r1", ancestors: ["lc:parent"]
  }))
  assert.deepEqual(Array.from(nested.items, (item) => item.id), ["lc:parent.r1.r1"])
})

// ★ 2026-11-08 実測: 入れ子の返信の continuation は
//   `ytd-continuation-item-renderer.replies-continuation` の中の「他の返信を表示」ボタンで、
//   **交差させるだけでは読み込まれない**（8秒 viewport に入れても0件のまま、1回押した瞬間に現れた）。
const repliesContinuation = `
  <ytd-continuation-item-renderer class="replies-continuation">
    <div id="button"><ytd-button-renderer><yt-button-shape>
      <button>他の返信を表示</button>
    </yt-button-shape></ytd-button-renderer></div>
  </ytd-continuation-item-renderer>`

test("replies that only arrive when the continuation button is pressed are still loaded", async (t) => {
  const h = setup(t, section(threadWithReplies("parent", 2)))
  h.start()
  const thread = h.doc.querySelector("ytd-comment-thread-renderer")
  let continuationClicks = 0

  // トグルを押すと continuation だけが現れる。返信はそのボタンを押すまで来ない。
  thread.querySelector("#more-replies-sub-thread button").addEventListener("click", () => {
    h.win.setTimeout(() => {
      thread.querySelector(":scope > #replies > ytd-comment-replies-renderer")
        .insertAdjacentHTML("beforeend", `<div id="expanded-threads">${repliesContinuation}</div>`)
      thread.querySelector(".replies-continuation button").addEventListener("click", () => {
        continuationClicks += 1
        h.win.setTimeout(() => {
          thread.querySelector("#expanded-threads").insertAdjacentHTML("beforeend", subReply("parent.r1"))
          thread.querySelector(".replies-continuation").remove()
        }, 300)
      })
    }, 300)
  })

  const result = await settle(h, h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" }))
  assert.equal(continuationClicks, 1, "continuation のボタンはちょうど一度だけ押す")
  assert.deepEqual(Array.from(result.items, (item) => item.id), ["lc:parent.r1"])
})

test("a nested thread's own toggle is used, never an outer thread's", async (t) => {
  // ★ CSSの子孫結合子はルートの外側の祖先にも一致する。入れ子のスレッドをルートに
  //   `#replies #collapsed-threads #more-replies-sub-thread` を引くと、親側のトグルを
  //   拾い得る。拾ってしまうと「親のトグルを押して親を畳む」事故になる。
  const h = setup(t, section(threadWithReplies("parent", 3)))
  h.start()
  const order = stubThreads(h, {
    parent: withoutReplyCount(subReply("parent.r1", 1)),
    "parent.r1": subReply("parent.r1.r1")
  })
  await settle(h, h.handlers.COMMENT_LOAD_REPLIES({ commentId: "lc:parent" }))
  await settle(h, h.handlers.COMMENT_LOAD_REPLIES({
    commentId: "lc:parent.r1", ancestors: ["lc:parent"]
  }))
  assert.deepEqual(order, ["parent", "parent.r1"], "押したのは各スレッド自身のトグルだけ")
})

// ---- 下書きの投稿先の取り違え（v87） ----
//
// ★ COMMENT_POST は本文しか運んでおらず、CS側は「いま開いている動画」へ投稿していた。
//   下書きを書いたあとに動画が変わる経路（サブ画面から関連動画を選ぶ・キューの自動送り・
//   メイン画面側の自動再生）は普通に起きるため、前の動画あての文章が別の動画へ
//   公開投稿され得た。公開・取り消し不能な操作なので、必ず突き合わせる。
test("a comment written for another video is never posted into the one now on screen", async (t) => {
  const trigger = '<div id="simple-box"><button id="simplebox-placeholder">Add a comment</button></div>'
  const h = setup(t, section(trigger))
  let placeholderClicks = 0
  h.doc.querySelector("#simplebox-placeholder").addEventListener("click", () => placeholderClicks++)

  const result = await settle(h, h.handlers.COMMENT_POST({ text: "video A へのコメント", videoId: "other" }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, "video-changed")
  assert.equal(placeholderClicks, 0, "投稿欄にはいっさい触れない（開きかけもしない）")
})

test("a comment written for the video on screen still goes through the normal path", async (t) => {
  const trigger = '<div id="simple-box"><button id="simplebox-placeholder">Add a comment</button></div>'
  const h = setup(t, section(trigger))
  let placeholderClicks = 0
  h.doc.querySelector("#simplebox-placeholder").addEventListener("click", () => placeholderClicks++)

  const result = await settle(h, h.handlers.COMMENT_POST({ text: "いまの動画へ", videoId: "current" }))
  // この fixture には本物の入力欄が無いので投稿自体は失敗するが、
  // 取り違えではないので通常の経路（投稿欄を開きにいく）までは進む。
  assert.equal(result.reason, undefined, "動画が一致していれば video-changed にはしない")
  assert.equal(placeholderClicks, 1, "通常どおり投稿欄を開きにいく")
})

// ---- 件数の読み取り（v88） ----
//
// ★ 一番やってはいけないのは undefined ではなく**誤った数**を返すこと。
//   以前は日本語の万/億しか知らず、英語UIの "1.2K" を Math.round(1.2) = 1 として
//   そのまま表示していた。1200件のいいねが「1」と出ると、ユーザーはそれを信じてしまう。
const threadWithLike = (id, label) => `
  <ytd-comment-thread-renderer>
    <div id="comment-container"><ytd-comment-view-model>
      <a id="author-text">Author</a>
      <div id="author-thumbnail"><img src="https://yt3.ggpht.com/avatar.jpg"></div>
      <span id="published-time-text"><a href="/watch?v=current&lc=${id}">1 day ago</a></span>
      <div id="content-text">Comment ${id}</div>
      <div id="like-button"><button aria-label="${label}"></button></div>
    </ytd-comment-view-model></div>
  </ytd-comment-thread-renderer>`

test("comment like counts are read correctly whatever language YouTube is showing", async (t) => {
  const cases = [
    ["高く評価 1,234 件", 1234],            // 日本語・桁区切り
    ["1.2万 人が高く評価しました", 12000],   // 日本語・万
    ["3.4億", 340000000],                   // 日本語・億
    ["1.2K", 1200],                         // 英語・K（以前は 1 になっていた）
    ["3.4M", 3400000],                      // 英語・M（以前は 3）
    ["1.1B", 1100000000],                   // 英語・B（以前は 1）
    ["1.234", 1234],                        // 独・西・伊の桁区切り（以前は 1）
    ["1 Bewertung", 1],                     // 「B」は倍率ではない（10億にしない）
    ["1m ago", 1]                           // 小文字の m は倍率ではない（100万にしない）
  ]
  const html = cases.map(([label], i) => threadWithLike(`c${i}`, label)).join("")
  const h = setup(t, section(html))
  h.start()
  await h.advance(1200)
  const items = Array.from(h.api.items())
  assert.equal(items.length, cases.length)
  cases.forEach(([label, want], i) => {
    assert.equal(items[i].likeCount, want, `${JSON.stringify(label)} は ${want} と読む`)
  })
})

test("an unreadable count is left unknown rather than shown as a wrong number", async (t) => {
  const h = setup(t, section(threadWithLike("c0", "高く評価") + threadWithLike("c1", "")))
  h.start()
  await h.advance(1200)
  for (const item of h.api.items()) {
    assert.equal(item.likeCount, undefined, "数字が無いなら件数不明（表示側が — を出す）")
  }
})

test("a reply count written in English is read as the real number", async (t) => {
  const h = setup(t, section(threadWithReplies("parent", 2).replace("2 件の返信", "1.2K replies")))
  h.start()
  await h.advance(1200)
  assert.equal(Array.from(h.api.items())[0].replyCount, 1200)
})

// ---- コメントの並び替え（v89） ----
//
// ★ 2026-11-09 実測: 選択肢はメニューを開かなくても DOM にあり（tp-yt-paper-listbox の
//   <a aria-selected>）、直接 click() で切り替わる。ドロップダウンは非表示のままなので
//   メイン画面には何も出ない。現在値は aria-selected で分かる（文言は見ない）。
const SORT_LABELS = ["人気順", "新しい順"]
const SORT_HINTS = ["注目のコメントを表示", "最近のコメントを表示します"]
const sortMenu = (selectedIndex = 0) => `
  <ytd-comments-header-renderer><div id="title"><div id="additional-section">
    <span id="sort-menu"><yt-sort-filter-sub-menu-renderer><yt-dropdown-menu>
      <tp-yt-paper-menu-button><tp-yt-paper-listbox id="menu">
        ${SORT_LABELS.map((label, i) => `
        <a aria-selected="${i === selectedIndex}"><tp-yt-paper-item><tp-yt-paper-item-body>
          <div id="item-with-badge"><div class="item">${label}</div></div>
          <div id="subtitle">${SORT_HINTS[i]}</div>
        </tp-yt-paper-item-body></tp-yt-paper-item></a>`).join("")}
      </tp-yt-paper-listbox></tp-yt-paper-menu-button>
    </yt-dropdown-menu></yt-sort-filter-sub-menu-renderer></span>
  </div></div></ytd-comments-header-renderer>`

// 実測どおり、ヘッダーは #contents の兄弟（#header の中）に置く
const sectionWithSort = (threads, selectedIndex = 0) => `
  <ytd-comments id="comments"><ytd-item-section-renderer>
    <div id="header">${sortMenu(selectedIndex)}</div>
    <div id="contents">${threads}</div>
  </ytd-item-section-renderer></ytd-comments>`

const sortOptions = (h) => [...h.doc.querySelectorAll("tp-yt-paper-listbox a[aria-selected]")]

test("the sub window is told which sort options YouTube offers and which one is active", async (t) => {
  const h = setup(t, sectionWithSort(thread("a") + thread("b")))
  h.start()
  await h.advance(1200)
  const sort = await settle(h, h.handlers.DOM_FETCH_COMMENT_SORT())
  assert.equal(sort.available, true)
  assert.deepEqual(Array.from(sort.options, (o) => o.label), SORT_LABELS, "YouTubeの文言をそのまま運ぶ")
  assert.deepEqual(Array.from(sort.options, (o) => o.selected), [true, false], "選択はaria-selected由来")
  assert.deepEqual(Array.from(sort.options, (o) => o.hint), SORT_HINTS, "説明も添える")
})

test("no sort control is reported when YouTube does not offer one", async (t) => {
  const h = setup(t, section(thread("a")))
  h.start()
  await h.advance(1200)
  const sort = await settle(h, h.handlers.DOM_FETCH_COMMENT_SORT())
  assert.equal(sort.available, false)
  assert.equal(sort.options.length, 0)
})

// ★ 並び替えると YouTube は ytd-comment-thread-renderer を**使い回して中身だけ書き換える**
//   （2026-11-09 実測: 旧要素20件がDOMに残り、idも18件が重複）。既読集合を抱えたままだと
//   入れ替わった並びを「既に見た」として捨ててしまうので、feed を作り直す必要がある。
test("switching the sort rebuilds the feed, so the new order actually reaches the sub window", async (t) => {
  const h = setup(t, sectionWithSort(thread("a") + thread("b")))
  h.start()
  await h.advance(1200)
  assert.deepEqual(Array.from(h.api.items(), (i) => i.id), ["lc:a", "lc:b"])

  // YouTube を再現: 押すと aria-selected が入れ替わり、既存要素の中身が書き換わる（順序が逆に）
  const [popular, newest] = sortOptions(h)
  newest.addEventListener("click", () => {
    popular.setAttribute("aria-selected", "false")
    newest.setAttribute("aria-selected", "true")
    const contents = h.doc.querySelector("ytd-comments #contents")
    contents.innerHTML = thread("b") + thread("a") // 同じidを逆順で（要素は作り直されるが id は重複）
  })

  const before = h.events.length
  const res = await settle(h, h.handlers.COMMENT_SORT_SELECT({ id: "o1", label: "新しい順" }))
  assert.equal(res.ok, true)
  assert.deepEqual(Array.from(res.sort.options, (o) => o.selected), [false, true], "選択が移る")

  const after = h.events.slice(before)
  assert.ok(after.some((e) => e.type === "FEED_RESET" && e.payload.kind === "comment"),
    "サブ画面の一覧を作り直させる")

  await h.advance(2000)
  assert.deepEqual(Array.from(h.api.items(), (i) => i.id), ["lc:b", "lc:a"],
    "既読集合を抱えたままだとここが古い順序のままになる")
})

test("choosing the sort that is already active does not touch YouTube's menu", async (t) => {
  const h = setup(t, sectionWithSort(thread("a")))
  h.start()
  await h.advance(1200)
  let clicks = 0
  for (const a of sortOptions(h)) a.addEventListener("click", () => clicks++)
  const res = await settle(h, h.handlers.COMMENT_SORT_SELECT({ id: "o0", label: "人気順" }))
  assert.equal(res.ok, true)
  assert.equal(clicks, 0, "既にその並びなら押さない（押すと無駄に読み直しが走る）")
})

test("a sort option that moved is found again by its label", async (t) => {
  const h = setup(t, sectionWithSort(thread("a")))
  h.start()
  await h.advance(1200)
  const pressed = []
  for (const a of sortOptions(h)) {
    a.addEventListener("click", () => {
      pressed.push((a.querySelector("#item-with-badge .item")?.textContent ?? "").trim())
      for (const b of sortOptions(h)) b.setAttribute("aria-selected", String(b === a))
    })
  }
  // 位置は o0 と言われているが、その位置にあるのは「人気順」。求めているのは「新しい順」
  const res = await settle(h, h.handlers.COMMENT_SORT_SELECT({ id: "o0", label: "新しい順" }))
  assert.equal(res.ok, true)
  assert.deepEqual(pressed, ["新しい順"], "位置がズレていても文言で引き直す")
})

// ---- チャンネル登録の解除（v90） ----
//
// ★ 2026-11-10 実測: 登録済みのボタンを押すと ytd-popup-container の中に
//   tp-yt-paper-listbox#items が作られ、ytd-menu-service-item-renderer が4つ並ぶ
//   （すべて / カスタマイズされた通知のみ / なし / 登録解除）。区切りもグループも無く、
//   aria-selected は通知側で一貫しない。文言は言語依存。よって**最後の項目**でしか
//   見分けられないため、危うさは呼び出し側の3つの仕掛けで埋めている。
/** 既存の subscribeArea（実機に忠実）に、メニューの置き場所だけ足す。 */
const subscribePage = (subscribed) =>
  subscribeArea({ subscribed }) + "<ytd-popup-container></ytd-popup-container>"

const unsubscribeMenu = (extraLast = "") => `
  <tp-yt-iron-dropdown><ytd-menu-popup-renderer>
    <tp-yt-paper-listbox id="items">
      <ytd-menu-service-item-renderer aria-selected="true">すべて</ytd-menu-service-item-renderer>
      <ytd-menu-service-item-renderer aria-selected="false" is-selected>カスタマイズされた通知のみ</ytd-menu-service-item-renderer>
      <ytd-menu-service-item-renderer aria-selected="false">なし</ytd-menu-service-item-renderer>
      <ytd-menu-service-item-renderer aria-selected="false">登録解除</ytd-menu-service-item-renderer>
      ${extraLast}
    </tp-yt-paper-listbox>
  </ytd-menu-popup-renderer></tp-yt-iron-dropdown>`

/** 登録済みのボタンを押すとメニューが開く YouTube を再現する。 */
function stubSubscribeMenu(h, { onUnsubscribe, extraLast = "" } = {}) {
  const host = h.doc.querySelector("ytd-subscribe-button-renderer")
  const popup = h.doc.querySelector("ytd-popup-container")
  const pressed = []
  host.querySelector("button").addEventListener("click", () => {
    popup.innerHTML = unsubscribeMenu(extraLast)
    for (const item of popup.querySelectorAll("ytd-menu-service-item-renderer")) {
      item.addEventListener("click", () => {
        pressed.push(item.textContent.trim())
        if (item.textContent.trim() === "登録解除") onUnsubscribe?.(host, popup)
      })
    }
  })
  return pressed
}

test("unsubscribing presses YouTube's own menu item and reports the result", async (t) => {
  const h = setup(t, subscribePage(true))
  h.start()
  // ダイアログを出さない世代: その場で subscribed が外れる
  const pressed = stubSubscribeMenu(h, { onUnsubscribe: (host) => host.removeAttribute("subscribed") })
  const res = await settle(h, h.handlers.CHANNEL_UNSUBSCRIBE())
  assert.equal(res.applied, true)
  assert.equal(res.channel.subscribed, false)
  assert.deepEqual(pressed, ["登録解除"], "押したのは最後の項目だけ（通知設定には触れない）")
})

// ★ 確認ダイアログが出る世代（実機未確認のため、出る側・出ない側の両方を検査で固定する）
test("a confirmation dialog, if YouTube shows one, is confirmed and the result verified", async (t) => {
  const h = setup(t, subscribePage(true))
  h.start()
  const popup = h.doc.querySelector("ytd-popup-container")
  stubSubscribeMenu(h, {
    onUnsubscribe: (host) => {
      popup.insertAdjacentHTML("beforeend", `
        <yt-confirm-dialog-renderer>
          <div id="cancel-button"><button>キャンセル</button></div>
          <div id="confirm-button"><button>登録解除</button></div>
        </yt-confirm-dialog-renderer>`)
      popup.querySelector("#confirm-button button").addEventListener("click", () => {
        host.removeAttribute("subscribed")
      })
    }
  })
  const res = await settle(h, h.handlers.CHANNEL_UNSUBSCRIBE())
  assert.equal(res.applied, true, "ダイアログが出たら押して、最後は属性で成否を見る")
  assert.equal(res.channel.subscribed, false)
})

test("a channel that is not subscribed is never touched by the unsubscribe request", async (t) => {
  const h = setup(t, subscribePage(false))
  h.start()
  const pressed = stubSubscribeMenu(h)
  const res = await settle(h, h.handlers.CHANNEL_UNSUBSCRIBE())
  assert.equal(res.applied, false)
  assert.deepEqual(pressed, [], "解除の要求が登録の入口になってはいけない")
})

// ★ 位置頼みの危うさを埋める仕掛け。最後が「選択中の通知設定」なら押さない。
test("the last menu item is left alone when it is the active notification setting", async (t) => {
  const h = setup(t, subscribePage(true))
  h.start()
  const pressed = stubSubscribeMenu(h, {
    extraLast: '<ytd-menu-service-item-renderer aria-selected="false" is-selected>別の通知設定</ytd-menu-service-item-renderer>'
  })
  const res = await settle(h, h.handlers.CHANNEL_UNSUBSCRIBE())
  assert.equal(res.applied, false)
  assert.deepEqual(pressed, [], "見覚えのない並びなら何も押さない")
  assert.equal(h.doc.querySelector("ytd-subscribe-button-renderer").hasAttribute("subscribed"), true)
})

test("an unsubscribe that does not take effect is reported as not applied", async (t) => {
  const h = setup(t, subscribePage(true))
  h.start()
  // 押しても YouTube が何もしない（未ログイン等）
  const pressed = stubSubscribeMenu(h)
  const res = await settle(h, h.handlers.CHANNEL_UNSUBSCRIBE())
  assert.equal(res.applied, false, "属性が変わらなければ成功にしない")
  assert.equal(res.channel.subscribed, true)
  assert.deepEqual(pressed, ["登録解除"])
})

// ★ メイン画面は全画面視聴中のことがある。失敗してメニューを開いたままにすると映像を覆う。
test("a failed unsubscribe closes whatever it opened", async (t) => {
  const h = setup(t, subscribePage(true))
  h.start()
  let escapes = 0
  h.doc.addEventListener("keydown", (e) => { if (e.key === "Escape") escapes++ })
  stubSubscribeMenu(h)
  await settle(h, h.handlers.CHANNEL_UNSUBSCRIBE())
  assert.ok(escapes > 0, "開いたメニューを閉じる")
})

test("subscribing still refuses to touch an already-subscribed channel", async (t) => {
  const h = setup(t, subscribePage(true))
  h.start()
  const pressed = stubSubscribeMenu(h)
  const res = await settle(h, h.handlers.CHANNEL_SUBSCRIBE())
  assert.equal(res.applied, false)
  assert.deepEqual(pressed, [], "登録の要求は解除の入口にならない（v80 からの性質）")
})
