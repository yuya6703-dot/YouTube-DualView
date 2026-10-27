/**
 * tests/dist-smoke.cjs — 配布物そのものの動作確認。
 *   node tests/dist-smoke.cjs [展開済みのビルドフォルダ]   省略時は build/chrome-mv3-prod
 *
 * `pnpm test` の回帰テストはソースを実行するが、こちらは**ビルド済みの content script**を
 * そのまま jsdom で動かす。「開発環境で動く」と「配る物が動く」を分けて確かめるため
 * （PROJECT.md §6.6 のリリース手順）。以前はセッションごとに手で書き起こしていたが、
 * 書き起こしを忘れた回があった（v0.1.7）ので、リポジトリに置いて CI とリリースから走らせる。
 *
 * 確認する筋:
 *   A 段階的ハイドレーション（v74）… 非表示パネルを刺激せず、通常欄が出来たらそこから読み込む
 *   B 通常のページ                  … 従来どおりコメントがサブ画面へ流れる
 *   C 前の動画のDOMが残っている     … 従来どおりパネル経由で読み込みを起動する（2026-09-17の契約）
 *   D 動画の評価（v75）             … プレイヤー内のボタンではなく ytd-watch-metadata 側から読む
 */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { JSDOM } = require("jsdom")

const buildDir = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "build", "chrome-mv3-prod"))
const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, "manifest.json"), "utf8"))
const csFile = manifest.content_scripts.find((cs) => cs.matches.includes("https://www.youtube.com/*")).js[0]
const csCode = fs.readFileSync(path.join(buildDir, csFile), "utf8")

const thread = (id, video = "current") => `
  <ytd-comment-thread-renderer><div id="comment-container"><ytd-comment-view-model>
    <a id="author-text">Author ${id}</a>
    <div id="author-thumbnail"><img src="https://yt3.ggpht.com/${id}.jpg"></div>
    <span id="published-time-text"><a href="/watch?v=${video}&lc=${id}">1 day ago</a></span>
    <div id="content-text">Comment ${id}</div>
  </ytd-comment-view-model></div></ytd-comment-thread-renderer>`
const hiddenPanel = (contId) => `
  <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-comments-section"
    visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN">
    <ytd-comments><ytd-item-section-renderer><div id="contents">
      <ytd-continuation-item-renderer id="${contId}"></ytd-continuation-item-renderer>
    </div></ytd-item-section-renderer></ytd-comments>
  </ytd-engagement-panel-section-list-renderer>`
// 実ページは評価ボタンをプレイヤー内にも持ち、文書順ではそちらが先（2026-10-28 実DOMで確認）
const ratingArea = (likeText, liked) => `
  <div id="movie_player"><like-button-view-model><button aria-pressed="false"></button></like-button-view-model></div>
  <ytd-watch-metadata>
    <like-button-view-model><button aria-pressed="${liked}">${likeText}</button></like-button-view-model>
    <dislike-button-view-model><button aria-pressed="false"></button></dislike-button-view-model>
  </ytd-watch-metadata>`

/** ビルド済み content script を jsdom のページで動かし、サブ画面の代わりに Port を1本つなぐ。 */
function boot(innerHtml, { withPlayer = true } = {}) {
  const dom = new JSDOM(`<ytd-app><ytd-watch-flexy video-id="current">
    ${withPlayer ? '<div id="movie_player"></div>' : ""}${innerHtml}
  </ytd-watch-flexy></ytd-app>`, {
    url: "https://www.youtube.com/watch?v=current", runScripts: "outside-only", pretendToBeVisual: true
  })
  const win = dom.window
  win.CSS = { escape: (value) => String(value).replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`) } // jsdom には無い
  let onConnect = null
  let onMessage = null
  win.chrome = {
    runtime: {
      id: "smoke",
      onConnect: { addListener: (fn) => { onConnect = fn } },
      onMessage: { addListener: (fn) => { onMessage = fn } },
      sendMessage: async () => undefined
    },
    tabs: { sendMessage: async () => undefined }
  }
  new vm.Script(csCode, { filename: csFile }).runInContext(dom.getInternalVMContext())
  assert.ok(onConnect && onMessage, "配布物の content script が Port とメッセージの受け口を登録する")
  const events = []
  onConnect({
    name: "yt-dualview:player",
    postMessage: (event) => events.push(event),
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} }
  })
  return { win, doc: win.document, events, ask: (action, payload) => new Promise((r) => onMessage({ action, payload }, {}, r)) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const feedIds = (events) => events.filter((e) => e.type === "FEED_APPEND").flatMap((e) => e.payload.items).map((i) => i.id)
/** 条件が満たされるまで待つ（最大 limit ミリ秒）。満たされなければそのまま進み、呼び出し側が assert する。 */
async function waitFor(check, limit = 15000) {
  for (let waited = 0; waited < limit; waited += 100) {
    if (check()) return true
    await sleep(100)
  }
  return false
}

async function stagedHydration() {
  const h = boot(hiddenPanel("panel-a"))
  await sleep(1200)
  // 通常欄が [hidden] の空の器として現れる段階
  const below = h.doc.createElement("div")
  below.id = "below"
  below.innerHTML = '<div hidden><ytd-comments id="comments"></ytd-comments></div>'
  h.doc.querySelector("ytd-watch-flexy").appendChild(below)

  let panelStimulated = false
  for (let i = 0; i < 25; i++) {
    if (h.doc.querySelector("#panel-a").style.position === "fixed") panelStimulated = true
    await sleep(100)
  }
  assert.equal(panelStimulated, false, "A: 準備中に非表示パネルを刺激しない（刺激するとパネル側へ読み込まれて届かない）")

  // hidden が外れ、ghost 入りの continuation が入る段階
  const inline = h.doc.querySelector("ytd-comments#comments")
  inline.parentElement.removeAttribute("hidden")
  inline.innerHTML = `<ytd-item-section-renderer id="sections"><div id="contents">
    <ytd-continuation-item-renderer><div id="ghost-comment-section"><yt-ghost-comments></yt-ghost-comments></div></ytd-continuation-item-renderer>
  </div></ytd-item-section-renderer>`
  // YouTube の契約: この continuation が画面内に入ったときだけ最初のバッチを入れる
  const continuation = inline.querySelector("ytd-continuation-item-renderer")
  const observer = new h.win.MutationObserver(() => {
    if (continuation.style.position !== "fixed") return
    observer.disconnect()
    continuation.querySelector("#ghost-comment-section").remove()
    inline.querySelector("#contents").insertAdjacentHTML("afterbegin", thread("c1") + thread("c2"))
  })
  observer.observe(continuation, { attributes: true, attributeFilter: ["style"] })

  await waitFor(() => feedIds(h.events).length >= 2)
  assert.deepEqual(feedIds(h.events), ["lc:c1", "lc:c2"], "A: メイン画面に触れずに最初のバッチがサブ画面へ届く")
  console.log("A 段階的ハイドレーション → パネル不介入・FEED_APPEND", JSON.stringify(feedIds(h.events)))
  h.win.close()
}

async function normalPage() {
  const h = boot(`<div id="below"><ytd-comments id="comments"><ytd-item-section-renderer><div id="contents">
    ${thread("c1")}${thread("c2")}<ytd-continuation-item-renderer></ytd-continuation-item-renderer>
  </div></ytd-item-section-renderer></ytd-comments>${hiddenPanel("panel-b")}</div>`)
  await waitFor(() => feedIds(h.events).length >= 2)
  assert.deepEqual(feedIds(h.events), ["lc:c1", "lc:c2"], "B: 通常のページでコメントが流れる")
  assert.equal(h.doc.querySelector("#panel-b").style.position ?? "", "", "B: 通常欄が使えるときはパネルを使わない")
  console.log("B 通常のページ           → FEED_APPEND", JSON.stringify(feedIds(h.events)))
  h.win.close()
}

async function stalePreviousVideo() {
  const h = boot(`<div id="below"><div hidden><ytd-comments id="comments"><ytd-item-section-renderer><div id="contents">
    ${thread("old", "previous")}
  </div></ytd-item-section-renderer></ytd-comments></div>${hiddenPanel("panel-c")}</div>`)
  const stimulated = await waitFor(() => h.doc.querySelector("#panel-c").style.position === "fixed", 8000)
  assert.equal(stimulated, true, "C: 前の動画のDOMが残っているときはパネルで読み込みを起動する")
  assert.deepEqual(feedIds(h.events), [], "C: 前の動画のコメントは配信しない")
  console.log("C 前の動画のDOMが残る     → パネルで起動・古いコメントは流さない")
  h.win.close()
}

async function videoRating() {
  const h = boot(`<div id="below"></div>${ratingArea("362", "true")}`, { withPlayer: false })
  const status = await h.ask("PLAYER_GET_STATUS", undefined)
  const rating = status?.data?.rating
  console.log("D 動画の評価             →", JSON.stringify(rating))
  assert.ok(rating, "D: 評価が読める")
  assert.equal(rating.liked, true, "D: プレイヤー内ではなく metadata 側の aria-pressed を読む")
  assert.equal(rating.disliked, false)
  assert.equal(rating.likeCount, "362", "D: 件数も metadata 側のボタンから読む")
  h.win.close()
}

;(async () => {
  console.log(`配布物: v${manifest.version} / ${csFile}`)
  await stagedHydration()
  await normalPage()
  await stalePreviousVideo()
  await videoRating()
  console.log("DIST SMOKE OK")
  process.exit(0)
})().catch((error) => {
  console.error("DIST SMOKE FAILED:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
