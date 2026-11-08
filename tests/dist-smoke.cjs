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
 *   E サブ画面（v78/v80/v84）       … ビルド済みの popout を起動し、開いた時点の表示・共有・チャンネル登録・サイドバーを見る
 *
 * ★ E を入れるまで、配布物の確認は content script だけだった。サブ画面側の変更
 *   （v76 の共有、v78 の分割・共有）は毎回その場限りのスクリプトで確かめており、
 *   リリース工程では守られていなかった。
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
  // 画面内へ置かれた瞬間の見た目を捕まえる。ここが透明でないと、全画面の映像の上に箱が描かれる
  let tileOpacity = null
  const observer = new h.win.MutationObserver(() => {
    if (continuation.style.position !== "fixed") return
    tileOpacity = continuation.style.getPropertyValue("opacity")
    observer.disconnect()
    continuation.querySelector("#ghost-comment-section").remove()
    inline.querySelector("#contents").insertAdjacentHTML("afterbegin", thread("c1") + thread("c2"))
  })
  observer.observe(continuation, { attributes: true, attributeFilter: ["style"] })

  await waitFor(() => feedIds(h.events).length >= 2)
  assert.deepEqual(feedIds(h.events), ["lc:c1", "lc:c2"], "A: メイン画面に触れずに最初のバッチがサブ画面へ届く")
  assert.equal(tileOpacity, "0", "A: 画面内へ置く箱は透明（映像の上に描かれない）")
  console.log("A 段階的ハイドレーション → パネル不介入・FEED_APPEND", JSON.stringify(feedIds(h.events)), "/ 箱の opacity:", tileOpacity)
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
  assert.ok(rating, "D: 評価が読める")
  assert.equal(rating.liked, true, "D: プレイヤー内ではなく metadata 側の aria-pressed を読む")
  assert.equal(rating.disliked, false)
  assert.equal(rating.likeCount, "362", "D: 件数も metadata 側のボタンから読む")

  // ★ 件数のロール表示（アニメーション）は桁ごとに 0-9 の数字列が並ぶ。これを件数として
  //   出すとサブ画面に「12345678901234567890…」が出る（2026-11-05 報告）。出さないこと。
  const reel = "1234567890".repeat(3).slice(0, 29)
  h.doc.querySelector("ytd-watch-metadata like-button-view-model button").textContent = reel + reel
  const rolling = (await h.ask("PLAYER_GET_STATUS", undefined))?.data?.rating
  assert.equal(rolling.likeCount, undefined, "D: ロール表示中は件数を出さない")
  console.log("D 動画の評価             →", JSON.stringify(rating), "/ ロール表示中の件数:", JSON.stringify(rolling.likeCount))
  h.win.close()
}

/**
 * E: ビルド済みのサブ画面を起動する。メイン画面から STATUS を1つ渡し、
 *    「開いた時点でどう見えるか」と「共有を押すと何が起きるか」を確認する。
 */
async function subWindow() {
  const popoutHtml = fs.readFileSync(path.join(buildDir, "tabs", "popout.html"), "utf8")
  const popoutFile = /<script src="\/(tabs\/popout\.[^"]+\.js)"/.exec(popoutHtml)[1]
  const copied = []
  const resetTimers = new Map()
  const toMainWindow = []
  // メイン画面のサイドバー。中身の作り方は comments-loading.test.cjs の検査と同じ形
  const smokeGuide = {
    available: true,
    sections: [{
      title: "探索",
      entries: [
        { id: "s0:e0", title: "ホーム", href: "/", avatarUrl: "", iconPath: "M12 4 3 12h2v8h5v-6h4v6h5v-8h2z" },
        { id: "s0:e1", title: "ショート", href: "", avatarUrl: "", iconPath: "" }
      ]
    }]
  }
  let toSubWindow = null
  // COMMENT_LOAD_REPLIES にどう答えるか。入れ子の返信を試すため途中で差し替える
  let replyAnswer = { items: [] }
  const noop = () => {}
  const dom = new JSDOM(popoutHtml.replace(/<script[^>]*><\/script>/, ""), {
    url: "chrome-extension://smoke/tabs/popout.html", runScripts: "outside-only", pretendToBeVisual: true,
    beforeParse(window) {
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
      // 「コピーしました」を消す2秒のタイマーだけを捕まえる。実タイマーはそのまま動かし、
      // clearTimeout も尊重するので、連続コピーの扱いを時間に依存せず確かめられる
      const realSet = window.setTimeout
      const realClear = window.clearTimeout
      window.setTimeout = (fn, ms, ...rest) => {
        const id = realSet(fn, ms, ...rest)
        if (ms === 2000) resetTimers.set(id, fn)
        return id
      }
      window.clearTimeout = (id) => { resetTimers.delete(id); return realClear(id) }
      Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: async (text) => { copied.push(text) } }, configurable: true
      })
      window.chrome = {
        runtime: {
          id: "smoke", lastError: undefined,
          onMessage: { addListener: noop, removeListener: noop },
          sendMessage: async (env) =>
            env.action === "GET_TARGET_TAB" ? { ok: true, data: { tabId: 7 } } : { ok: true, data: {} },
          getURL: (p) => `chrome-extension://smoke/${p}`
        },
        storage: {
          local: { get: async () => ({}), set: async () => {} },
          sync: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener: noop, removeListener: noop }
        },
        tabs: {
          connect: () => ({
            name: "yt-dualview:player",
            onMessage: { addListener: (fn) => { toSubWindow = fn }, removeListener: noop },
            onDisconnect: { addListener: noop, removeListener: noop },
            postMessage: noop, disconnect: noop
          }),
          sendMessage: async (_tabId, env) => {
            toMainWindow.push(env)
            if (env.action === "DOM_FETCH_GUIDE") return { ok: true, data: smokeGuide }
            if (env.action === "GUIDE_ACTIVATE") return { ok: true, data: { ok: true, guide: smokeGuide } }
            if (env.action === "COMMENT_LOAD_REPLIES") return { ok: true, data: replyAnswer }
            if (env.action === "COMMENT_POST") return { ok: true, data: { ok: true } }
            return { ok: true, data: {} }
          },
          create: async () => ({})
        }
      }
    }
  })
  const win = dom.window
  new vm.Script(fs.readFileSync(path.join(buildDir, popoutFile), "utf8"), { filename: popoutFile })
    .runInContext(dom.getInternalVMContext())
  const doc = win.document
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const button = (label) => [...doc.querySelectorAll("button")]
    .find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label)

  for (let i = 0; i < 50 && !toSubWindow; i++) await wait(100)
  assert.ok(toSubWindow, "E: サブ画面がメイン画面のPortへ繋ぐ")
  toSubWindow({ type: "STATUS", payload: {
    videoId: "aaaaaaaaaaa", title: "Video", channelName: "Channel X", rating: null,
    channel: { subscribed: false },
    channelAvatarUrl: "https://yt3.ggpht.com/ch.jpg", channelSubscribers: "チャンネル登録者数 673万人",
    currentTime: 83, duration: 300, volume: 50, muted: false, playbackRate: 1,
    paused: true, ended: false, kind: "video", sampledAt: Date.now()
  } })
  await wait(500)

  // 開いた時点で関連動画とコメントが半々（v78）
  const panes = [...doc.querySelectorAll("section")]
  const sized = panes.filter((p) => /flex-basis/.test(p.getAttribute("style") ?? ""))
  assert.equal(panes.length, 2, "E: 開いた時点で関連動画とコメントが並ぶ")
  assert.equal(sized.length, 1, "E: 関連動画側が比率を持つ")
  assert.match(sized[0].getAttribute("style"), /flex-basis: 50%/, "E: 既定は半々")

  // チャンネルの行（v80/v82）。アイコン・名前・登録者数・登録ボタンと、評価・共有が1列に並ぶ
  assert.ok(doc.body.textContent.includes("Channel X"), "E: チャンネル名が出る")
  assert.ok(doc.body.textContent.includes("チャンネル登録者数 673万人"), "E: 登録者数が出る")
  assert.ok([...doc.querySelectorAll("img")].some((i) => i.getAttribute("src") === "https://yt3.ggpht.com/ch.jpg"),
    "E: チャンネルアイコンが出る")
  const subscribeButton = button("チャンネル登録")
  assert.ok(subscribeButton, "E: 登録ボタンが出る")
  const ownerRow = subscribeButton.parentElement
  assert.ok(ownerRow.contains(button("共有リンクをコピー")), "E: 共有が同じ列にある")

  // 操作対象のタブIDは出さない（2026-11-05 の要望）。このスモークの対象タブは 7 番
  assert.ok(!/#\d/.test(doc.body.textContent), "E: 内部のタブ番号を表に出さない")

  // 共有は押したらコピー。URLの欄は出さない（v78）
  const share = button("共有リンクをコピー")
  assert.ok(share, "E: 共有ボタンがある")
  share.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(300)
  assert.deepEqual(copied, ["https://youtu.be/aaaaaaaaaaa"], "E: 押した時点でコピーされる")
  assert.ok(doc.body.textContent.includes("コピーしました"), "E: コピーしたことが分かる")
  assert.ok(![...doc.querySelectorAll("input")].some((i) => (i.value ?? "").startsWith("https://youtu.be/")),
    "E: URL を読ませる欄は出さない")

  // 開始位置つきは隣のボタン。押した時点の再生位置で作る
  const fromHere = button("この位置から共有（1:23）")
  assert.ok(fromHere, "E: 現在位置のボタンが隣にある")
  fromHere.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(300)
  assert.deepEqual(copied.slice(1), ["https://youtu.be/aaaaaaaaaaa?t=83"], "E: その位置からのリンクになる")

  // 2秒以内にもう一度コピーしたとき、前回のタイマーが今回の表示を消さないこと
  const [firstTimer] = [...resetTimers.keys()]
  assert.ok(firstTimer !== undefined, "E: コピーするとリセットのタイマーが張られる")
  share.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(200)
  if (resetTimers.has(firstTimer)) resetTimers.get(firstTimer)()
  await wait(100)
  assert.ok(doc.body.textContent.includes("コピーしました"),
    "E: 連続でコピーしても、前回のタイマーに表示を消されない")

  // メイン画面のサイドバーをそのまま並べる（2026-11-05 の要望）。既定は閉じている
  assert.ok(!doc.body.textContent.includes("ホーム"), "E: サイドバーは既定で出さない")
  const sidebarToggle = button("サイドバーを表示")
  assert.ok(sidebarToggle, "E: サイドバーの開閉はヘッダーの左端にある")
  sidebarToggle.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(400)
  assert.ok(toMainWindow.some((env) => env.action === "DOM_FETCH_GUIDE"), "E: 開いたときに取りに行く")
  const sidebar = doc.querySelector("aside")
  assert.ok(sidebar, "E: サイドバーが出る")
  assert.ok(sidebar.textContent.includes("ホーム") && sidebar.textContent.includes("探索"),
    "E: メイン画面の項目と見出しがそのまま並ぶ")
  assert.ok(sidebar.querySelector("svg path"), "E: YouTubeのアイコンのパスデータで描く")
  assert.ok(!sidebar.querySelector("a"), "E: サブ画面側にリンクは作らない")
  const homeRow = [...sidebar.querySelectorAll("button")].find((b) => b.textContent.trim() === "ホーム")
  homeRow.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(300)
  const activate = toMainWindow.find((env) => env.action === "GUIDE_ACTIVATE")
  // JSON を挟むのは、サブ画面側のオブジェクトが jsdom のレルムで作られていて
  // deepEqual が「中身は同じだが別の Object」として落ちるため
  assert.deepEqual(JSON.parse(JSON.stringify(activate?.payload ?? null)),
    { id: "s0:e0", title: "ホーム", href: "/" },
    "E: 押すとメイン画面の同じ項目を押させる")

  // 返信への返信（v85）。返信の行も自分の返信を開け、そのとき「開くべき親」を一緒に送る。
  // ★ 返信はメイン画面で親が開いている間しかDOMに無い。メイン画面が作り直されると消えるので、
  //   親の並びが無いとCS側は二度と見つけられない（ユーザー報告「返信が表示されない」）。
  const feedItem = (id, extra = {}) => ({
    id, author: "Author " + id, avatarUrl: "", text: "Comment " + id,
    tokens: [{ t: "text", v: "Comment " + id }], ...extra
  })
  toSubWindow({ type: "FEED_APPEND", payload: { kind: "comment", items: [feedItem("c1", { replyCount: 1 })] } })
  await wait(400)
  const replyButtons = () => [...doc.querySelectorAll("button")].filter((b) => /^返信 \d+件$/.test(b.textContent))
  assert.equal(replyButtons().length, 1, "E: コメントに返信のトグルが出る")

  replyAnswer = { items: [feedItem("c1.r1", { parentId: "c1", replyCount: 2 })] }
  replyButtons()[0].dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(400)
  const top = toMainWindow.filter((env) => env.action === "COMMENT_LOAD_REPLIES").at(-1)
  assert.deepEqual(JSON.parse(JSON.stringify(top?.payload ?? null)), { commentId: "c1", ancestors: [] },
    "E: トップレベルのコメントには親がいない")

  // 件数が読めない返信（YouTubeのトグルが「返信を表示」で数字を持たない）でも開ける（v86）
  toSubWindow({ type: "FEED_APPEND", payload: { kind: "comment", items: [feedItem("c2", { hasReplies: true })] } })
  await wait(400)
  const showReplies = [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === "返信を表示")
  assert.ok(showReplies, "E: 件数が読めなくても返信を開くボタンを出す")

  const nestedButton = replyButtons().find((b) => b.textContent === "返信 2件")
  assert.ok(nestedButton, "E: 返信の行にも、その返信を開くトグルが出る")
  replyAnswer = { items: [feedItem("c1.r1.a", { parentId: "c1.r1" }), feedItem("c1.r1.b", { parentId: "c1.r1" })] }
  nestedButton.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(400)
  const nested = toMainWindow.filter((env) => env.action === "COMMENT_LOAD_REPLIES").at(-1)
  assert.deepEqual(JSON.parse(JSON.stringify(nested?.payload ?? null)),
    { commentId: "c1.r1", ancestors: ["c1"] },
    "E: 返信の返信は、外側の親から順に添えて頼む")
  assert.ok(doc.body.textContent.includes("Comment c1.r1.a"), "E: 返信への返信が並ぶ")

  // 下書きの投稿先の取り違え（v87）。公開・取り消し不能な操作なので、配布物でも必ず見る。
  // ★ 下書きを書いたあとに動画が変わっても、黙って「いまの動画」へ投稿してはいけない。
  const composer = doc.querySelector("textarea[placeholder='コメントを追加']")
  assert.ok(composer, "E: コメントの投稿欄がある")
  const typeInto = (el, text) => {
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value").set
    setValue.call(el, text)
    el.dispatchEvent(new win.Event("input", { bubbles: true }))
  }
  typeInto(composer, "動画Aへ書いた下書き")
  await wait(300)
  const postButton = () => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === "投稿")
  assert.ok(postButton(), "E: 本文を入れると投稿ボタンが出る")

  // メイン画面の動画が変わる（関連動画の選択・キューの自動送り・自動再生のいずれでも起きる）
  toSubWindow({ type: "VIDEO_CHANGED", payload: { videoId: "bbbbbbbbbbb", kind: "video" } })
  toSubWindow({ type: "STATUS", payload: {
    videoId: "bbbbbbbbbbb", title: "Video B", channelName: "Channel Y", rating: null,
    channel: { subscribed: false }, channelAvatarUrl: "", channelSubscribers: "",
    currentTime: 0, duration: 100, volume: 50, muted: false, playbackRate: 1,
    paused: true, ended: false, kind: "video", sampledAt: Date.now()
  } })
  await wait(500)

  const postsBefore = toMainWindow.filter((env) => env.action === "COMMENT_POST").length
  postButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(400)
  assert.equal(toMainWindow.filter((env) => env.action === "COMMENT_POST").length, postsBefore,
    "E: 動画が変わったあとの一度目は投稿しない")
  assert.ok(doc.body.textContent.includes("動画が変わりました"), "E: 取り違えをユーザーに知らせる")
  assert.ok(doc.querySelector("textarea[placeholder='コメントを追加']").value.includes("動画Aへ書いた下書き"),
    "E: 書いた文章は消さない")

  // 知らせたうえで、もう一度押したら「いまの動画」へ投稿する
  postButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  await wait(400)
  const posted = toMainWindow.filter((env) => env.action === "COMMENT_POST").at(-1)
  assert.deepEqual(JSON.parse(JSON.stringify(posted?.payload ?? null)),
    { text: "動画Aへ書いた下書き", videoId: "bbbbbbbbbbb" },
    "E: 二度目は、いまの動画を明示して投稿する")

  console.log("E サブ画面               →", JSON.stringify(panes.map((p) => p.querySelector("p")?.textContent.trim())),
    "/ 共有:", JSON.stringify(copied.slice(0, 2)), "/ 連続コピーの表示: 維持 / チャンネル名と登録ボタン: あり / サイドバー: 再現 / 返信の返信: 親を添えて要求 / 件数不明の返信: 開ける / 下書きの投稿先: 取り違えない")
  win.close()
}

;(async () => {
  console.log(`配布物: v${manifest.version} / ${csFile}`)
  await stagedHydration()
  await normalPage()
  await stalePreviousVideo()
  await videoRating()
  await subWindow()
  console.log("DIST SMOKE OK")
  process.exit(0)
})().catch((error) => {
  console.error("DIST SMOKE FAILED:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
