/**
 * src/lib/selectors.ts
 * ---------------------------------------------------------------
 * YouTube の DOM は予告なく変わる。壊れたときに直す場所をここ1箇所に閉じ込める。
 * 各項目は「候補セレクタの配列」。上から順に試し、最初にヒットしたものを採用する。
 *
 * ⚠ 実機での検証必須:
 *   関連動画は ytd-compact-video-renderer → yt-lockup-view-model への
 *   移行期にあり、アカウント/A-Bテストによって出るものが変わる。
 *   着手前に必ず diagnose() を実行して現行DOMを確定させること。
 * ---------------------------------------------------------------
 */

export const SELECTORS = {
  player: {
    root: ["#movie_player"],
    video: ["#movie_player video.html5-main-video", "video.html5-main-video", "video.video-stream"],
    liveBadge: [".ytp-live-badge", ".ytp-live"]
  },

  meta: {
    title: ["#title h1 yt-formatted-string", "h1.ytd-watch-metadata", "h1.title yt-formatted-string"],
    channel: ["#owner #channel-name a", "ytd-channel-name#channel-name a", "#upload-info #channel-name a"]
  },

  related: {
    container: ["#related", "ytd-watch-next-secondary-results-renderer"],
    // #related 自体も未初期化のDOM世代で、右カラムの遅延生成を起動する親領域。
    activation: ["#related", "ytd-watch-flexy #secondary", "#secondary-inner"],
    continuation: [
      "#related ytd-continuation-item-renderer",
      "ytd-watch-next-secondary-results-renderer ytd-continuation-item-renderer",
      "#related yt-continuation-item-renderer"
    ],
    continuationButton: [
      "button#button:not([disabled])",
      "yt-button-shape button:not([disabled])",
      "tp-yt-paper-button#button:not([disabled])"
    ],
    item: ["yt-lockup-view-model", "ytd-compact-video-renderer"], // 新旧両対応
    link: ["a[href*='/watch?v=']"],
    // 2026-08-15 実機診断で確定（yt-lockup-view-model系）。旧候補は次のDOM移行に備えて残す。
    // ミックス/再生リストのカードは a.ytLockupMetadataViewModelTitle を持たないため、
    // h3配下のリンク → h3自体 の順にフォールバックする（2026-08-15 実機で3件取りこぼしを確認）
    title: [
      "a.ytLockupMetadataViewModelTitle",
      "a.yt-lockup-metadata-view-model__title",
      ".yt-lockup-metadata-view-model__title a",
      ".yt-lockup-metadata-view-model__title .yt-core-attributed-string",
      "h3.ytLockupMetadataViewModelHeadingReset a",
      "h3 [role='text']",
      "h3 yt-formatted-string",
      "h3 a",
      "h3",
      ".yt-lockup-metadata-view-model__title",
      "a#video-title",
      "yt-formatted-string#video-title",
      "#video-title",
      "span#video-title"
    ],
    channel: [
      // ★ document全体では ytd-channel-name が別要素に偽ヒットする（旧DOMの残骸）。
      //   新DOMでは related.item 配下に絞って初めて正しく1件だけ拾える。
      "yt-content-metadata-view-model .ytContentMetadataViewModelMetadataText",
      ".yt-content-metadata-view-model__metadata-row",
      "ytd-channel-name #text",
      "#channel-name #text"
    ],
    thumb: [
      "yt-thumbnail-view-model img.ytCoreImageHost",
      "ytd-thumbnail img#img",
      ".yt-lockup-view-model__content-image img",
      "img.ytCoreImageHost",
      "img.yt-core-image",
      "ytd-thumbnail img"
    ],
    thumbSource: ["picture source[srcset]", "source[srcset]"],
    duration: [
      ".ytThumbnailBottomOverlayViewModelBadgeContainer .ytBadgeShapeText",
      "badge-shape .badge-shape-wiz__text",
      "ytd-thumbnail-overlay-time-status-renderer #text",
      "#time-status #text"
    ]
  },

  comments: {
    section: ["ytd-comments#comments", "#comments"],
    // コメント要素自体がまだ生成されていないDOM世代で、遅延初期化を起動するための親領域。
    // ★ #primary-inner を単独候補に含めない。それは動画プレイヤーとコメント欄の共通の
    //   親であり、nudgeIntoViewport() で一時的に24x24pxへ縮めると、YouTube自身の
    //   プレイヤーが内部のResizeObserverでサイズを再計算し、真っ暗のまま戻らないことがある
    //   （2026-08-19 実機で確認）。必ず #below スコープに限定する。
    activation: [
      "ytd-watch-flexy #below",
      "#primary-inner #below"
    ],
    // 「続きを読み込む」の番人。これが画面内に入るとYouTubeが次のバッチを読み込む。
    // フルスクリーン中はページをスクロールできないため、この要素を直接操作して読み込みを促す
    continuation: [
      // ★ 返信スレッド用の continuation と区別する必要がある。
      //   ytd-continuation-item-renderer はページ内に複数存在し（コメント本体用/返信用）、
      //   返信用を掴むと「返信の続き」が読み込まれてコメント本体は増えない。
      //   コメント本体用は ytd-item-section-renderer > #contents の直下にある。
      "ytd-comments#comments ytd-item-section-renderer > #contents > ytd-continuation-item-renderer",
      "ytd-comments#comments > ytd-item-section-renderer ytd-continuation-item-renderer",
      "ytd-comments#comments ytd-continuation-item-renderer",
      "ytd-comments#comments #continuations",
      "#comments ytd-continuation-item-renderer"
    ],
    continuationButton: [
      "button#button:not([disabled])",
      "yt-button-shape button:not([disabled])",
      "tp-yt-paper-button#button:not([disabled])"
    ],
    emptyMessage: [
      "ytd-comments ytd-message-renderer",
      "ytd-comments#comments ytd-item-section-renderer #message"
    ],
    count: ["ytd-comments-header-renderer #count", "#comments #count"],
    thread: ["ytd-comment-thread-renderer"],
    author: ["#author-text span", "#author-text"],
    avatar: ["#author-thumbnail img", "#img"],
    body: ["#content-text"],
    published: ["#published-time-text a", "#published-time-text"],
    // 実機確認済み（2026-08-19）
    likeButton: [
      "#like-button button",
      "ytd-comment-engagement-bar #like-button button",
      "#toolbar #like-button button"
    ],
    // 返信を開く「N件の返信」ボタン。
    // ★ 2026-08-19の実機確認で判明: YouTubeは新しいスレッド表示UI（yt-sub-thread、
    //   `#collapsed-threads`/`#expanded-threads`）に切り替わっており、旧UIの
    //   `#expander`配下の`#more-replies`は`hidden`属性付きでDOM上に残るだけの
    //   非対話要素になっていた（クリックしても何も起きない）。実際に押せるボタンは
    //   `#collapsed-threads`側の`#more-replies-sub-thread`。旧UIがA/Bテストで
    //   残っている場合に備えて旧候補もフォールバックとして残す。
    replyToggle: [
      "#replies #collapsed-threads #more-replies-sub-thread button",
      "#replies #more-replies button",
      "ytd-comment-replies-renderer #more-replies button",
      "#replies tp-yt-paper-button#more-replies"
    ],
    replyCountText: [
      "#replies #collapsed-threads #more-replies-sub-thread",
      "#replies #more-replies",
      "ytd-comment-replies-renderer #more-replies"
    ],
    // 展開後、返信欄の中に並ぶ個々のコメント（トップレベルの thread とは別の入れ子構造）
    replyItem: ["ytd-comment-replies-renderer ytd-comment-view-model", "#replies ytd-comment-view-model"],
    // 展開ボタンを押した直後に現れる、返信本体のプレースホルダ（ghost cards）。
    // related動画/コメント本体と同じくIntersectionObserverで遅延読み込みされるため、
    // nudgeIntoViewport()で刺激する対象として使う。
    repliesContinuation: [
      "ytd-continuation-item-renderer.replies-continuation",
      "#expanded-threads ytd-continuation-item-renderer",
      "#replies ytd-continuation-item-renderer"
    ],
    // 実機確認済み（2026-08-19）。新規コメント投稿欄。返信欄（is-reply属性つき）と
    // 内部構造は同一なので、入力欄・投稿ボタンのセレクタは両方で共用する。
    // ★ ページ読み込み直後はプレースホルダ(ytd-comment-simplebox-renderer)だけが存在し、
    //   commentBoxTrigger をクリックして初めて本物のytd-commentboxがDOMに生成される
    //   （返信欄と同じ「クリックして初めて生成される」パターン）。
    commentBoxTrigger: [
      "#simple-box #simplebox-placeholder",
      "ytd-comment-simplebox-renderer #simplebox-placeholder"
    ],
    commentBox: ["ytd-commentbox:not([is-reply])"],
    // 見た目はyt-formatted-stringだが実体はその内側のcontenteditableなdiv。
    // yt-formatted-string自体はcontenteditable属性を持たない（実機確認で判明）。
    commentBoxEditable: ["#contenteditable-textarea #contenteditable-root"],
    commentBoxSubmit: ["#submit-button button"],
    // ★ #cancel-button は同名のidが添付ファイル用ダイアログ内にも複数存在し衝突するため、
    //   このIDは使わない（このボタンはこの拡張では使用しない想定）。
    // コメント本文下の「返信」トリガー（「N件の返信」トグルとは別物）。
    // like/dislikeボタンと構造が同一でidも無いため、aria-labelで区別する。
    // ★ 日本語UI前提（このプロジェクトはD-01により個人利用限定）。
    replyButton: [
      "#toolbar button[aria-label='返信']",
      "ytd-comment-engagement-bar button[aria-label='返信']"
    ],
    // 「返信」トリガーを押すと現れる返信用commentbox
    replyCommentBox: ["ytd-commentbox[is-reply]"]
  },

  // ライブチャットは現在の対象外。将来再開する場合の診断候補として残す
  liveChat: {
    frame: ["iframe#chatframe", "iframe.ytd-live-chat-frame"],
    itemList: ["#items.yt-live-chat-item-list-renderer", "yt-live-chat-item-list-renderer #items"],
    message: [
      "yt-live-chat-text-message-renderer",
      "yt-live-chat-paid-message-renderer",
      "yt-live-chat-membership-item-renderer"
    ],
    author: ["#author-name"],
    avatar: ["#author-photo img", "#img"],
    body: ["#message"],
    superChatAmount: ["#purchase-amount", "#purchase-amount-chip"]
  }
} as const

export type SelectorGroup = keyof typeof SELECTORS

/* ============================================================
 * リゾルバ
 * ========================================================== */

/** 候補を上から試し、最初に見つかった1件を返す */
export function q<T extends Element = HTMLElement>(
  candidates: readonly string[],
  root: ParentNode = document
): T | null {
  for (const sel of candidates) {
    const el = root.querySelector<T>(sel)
    if (el) return el
  }
  return null
}

/** 候補を上から試し、最初にヒットしたセレクタの全件を返す（混在させない） */
export function qa<T extends Element = HTMLElement>(
  candidates: readonly string[],
  root: ParentNode = document
): T[] {
  for (const sel of candidates) {
    const list = root.querySelectorAll<T>(sel)
    if (list.length > 0) return Array.from(list)
  }
  return []
}

/** textContent を安全に取り出す（改行・全角空白を正規化） */
export function text(
  candidates: readonly string[],
  root: ParentNode = document
): string {
  return (q(candidates, root)?.textContent ?? "").replace(/\s+/g, " ").trim()
}

/**
 * "12:34" や "1:02:03" のような動画時間表示を秒数に変換する。
 * ライブ配信中は "LIVE" 等の非数値が来るため、パースできなければ 0 を返す。
 */
export function parseClockDuration(s: string): number {
  const parts = s.trim().split(":")
  if (parts.length === 0 || parts.some((p) => p === "" || Number.isNaN(Number(p)))) return 0
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0)
}

/**
 * 要素の中身を RichToken[] に分解する。
 * ★ innerHTML を返さないこと。他人の投稿文字列を拡張機能側で解釈させない。
 */
export function toTokens(el: Element | null): RichTokenLocal[] {
  if (!el) return []
  const tokens: RichTokenLocal[] = []
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const v = node.textContent ?? ""
      if (v) tokens.push({ t: "text", v })
    } else if (node instanceof HTMLImageElement) {
      // カスタム絵文字/メンバー絵文字は img で表現される
      tokens.push({ t: "emoji", url: node.src, alt: node.alt || "emoji" })
    } else if (node instanceof Element) {
      tokens.push(...toTokens(node)) // <a> や <span> のネストを平坦化
    }
  })
  return tokens
}

// messaging.ts の RichToken と同型（循環 import を避けるためローカル定義）
type RichTokenLocal =
  | { t: "text"; v: string }
  | { t: "emoji"; url: string; alt: string }

/* ============================================================
 * 生存確認（セレクタが壊れたときの一次切り分け）
 * ========================================================== */

/**
 * 全セレクタについて「今のページで1件でも取れるか」を返す。
 * false が並んだグループが、YouTube側の変更で壊れた箇所。
 */
export function diagnose(root: ParentNode = document): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const [group, entries] of Object.entries(SELECTORS)) {
    for (const [key, candidates] of Object.entries(entries as Record<string, readonly string[]>)) {
      result[`${group}.${key}`] = q(candidates, root) !== null
    }
  }
  return result
}

/**
 * diagnose() の詳細版。true/false だけでなく
 *   sel: 候補配列のうち「実際にヒットしたセレクタ」
 *   n  : そのセレクタで取れた件数
 * まで返す。
 *
 * ★ related.item のように新旧2系統を候補に持つ項目で、
 *   どちらの世代のDOMが配信されているかを1回で確定させるために必要。
 *   （YouTubeはA/Bテストでアカウントごとに構造が違う ─ PROJECT.md D-18）
 */
export function diagnoseDetail(root: ParentNode = document): DiagnoseDetail {
  const result: DiagnoseDetail = {}
  for (const [group, entries] of Object.entries(SELECTORS)) {
    for (const [key, candidates] of Object.entries(entries as Record<string, readonly string[]>)) {
      let sel: string | null = null
      for (const c of candidates) {
        if (root.querySelector(c)) { sel = c; break }
      }
      result[`${group}.${key}`] = {
        ok: sel !== null,
        sel,
        n: sel ? root.querySelectorAll(sel).length : 0
      }
    }
  }
  return result
}

/** diagnoseDetail() の戻り値。messaging.ts が再エクスポートして型のSSoTに載せる */
export type DiagnoseDetail = Record<string, { ok: boolean; sel: string | null; n: number }>

/**
 * 要素の「骨格」だけを文字列化する。タグ名 / id / class のみで、
 * ★ テキスト内容・属性値は一切含めない（他人の投稿を持ち出さないため。D-15と同じ思想）。
 *
 * YouTubeがDOMを作り替えたとき、新しいクラス名を知る唯一の手段になる。
 */
export function outline(el: Element | null, maxDepth = 4, maxChildren = 4): string {
  if (!el) return ""
  const walk = (e: Element, d: number): string[] => {
    const id = e.id ? `#${e.id}` : ""
    const cls =
      typeof e.className === "string" && e.className.trim()
        ? "." + e.className.trim().split(/\s+/).slice(0, 3).join(".")
        : ""
    const line = `${"  ".repeat(d)}${e.tagName.toLowerCase()}${id}${cls}`
    if (d >= maxDepth) return [line]
    const kids = Array.from(e.children).slice(0, maxChildren)
    const more = e.children.length > maxChildren ? [`${"  ".repeat(d + 1)}… 他 ${e.children.length - maxChildren} 件`] : []
    return [line, ...kids.flatMap((c) => walk(c, d + 1)), ...more]
  }
  return walk(el, 0).join("\n").slice(0, 4000)
}

/**
 * 壊れた箇所を直すための現物サンプル。診断と一緒に持ち帰る。
 *
 * ★ related.item は先頭が広告カード(feed-ad-metadata-view-model)であることが多く、
 *   通常の動画カードと構造が異なる。広告でない最初の1件を選んで採取する。
 */
export function sampleOutlines(root: ParentNode = document): Record<string, string> {
  const relItems = qa(SELECTORS.related.item, root)
  const relItem = relItems.find((el) => !el.querySelector("feed-ad-metadata-view-model")) ?? relItems[0] ?? null
  const commentSection = q(SELECTORS.comments.section, root)
  return {
    "related.item": outline(relItem, 8, 8),
    "comments.section": outline(commentSection, 5)
  }
}

/**
 * 診断レポート全体。checks=生死判定 / samples=直すための現物DOM骨格
 *
 * ★ v を必ず載せること。開発中は「YouTubeタブが古いCSのまま」という状態が頻発し、
 *   それに気づかないまま古い結果を新しい結果だと思い込む事故が起きる。
 *   バージョンを画面に出せば一目で判別できる。
 */
export const DIAGNOSE_VERSION = 33

export type DiagnoseReport = {
  v: number
  checks: DiagnoseDetail
  samples: Record<string, string>
}

/** 開発ビルドでのみ window に生やす。DevTools で __ytdv.diagnose() を叩ける */
export function exposeDevHelpers(): void {
  if (process.env.NODE_ENV !== "development") return
  // @ts-expect-error 開発用の意図的なグローバル汚染
  window.__ytdv = { SELECTORS, q, qa, diagnose, table: () => console.table(diagnose()) }
}
