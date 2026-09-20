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
      findTopLevelCommentContinuation, stopWatchPageObservers
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
  const pending = h.handlers.COMMENT_POST({ text: "test" })
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
