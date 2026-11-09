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
    channel: ["#owner #channel-name a", "ytd-channel-name#channel-name a", "#upload-info #channel-name a"],
    // 動画の高評価/低評価。押下状態は aria-pressed、件数はボタン内の表示文言。
    // ★ ytd-watch-metadata に絞る。新しい全画面UIはプレイヤー内にも評価ボタンを持つことがあり、
    //   絞らないと文書順でそちらが先に一致し得る（findVideoAnchor の still と同じ罠）。
    //   2026-10-28 実DOMで確認: 絞らない `like-button-view-model button` の先頭一致は実際に
    //   プレイヤー内のボタンだった（文書順は player → metadata）。metadata 側のボタンは
    //   aria-pressed を持ち、高評価はボタン内に件数（例「362」）、低評価は数字を持たない。
    //   壊れていたらセレクタ診断の meta.likeButton / meta.dislikeButton に出る。
    likeButton: [
      "ytd-watch-metadata like-button-view-model button",
      "ytd-watch-metadata #segmented-like-button button",
      "#top-level-buttons-computed like-button-view-model button"
    ],
    dislikeButton: [
      "ytd-watch-metadata dislike-button-view-model button",
      "ytd-watch-metadata #segmented-dislike-button button",
      "#top-level-buttons-computed dislike-button-view-model button"
    ],
    // チャンネルのアイコンと登録者数。登録者数は YouTube の表示文言のまま使う
    //   （"チャンネル登録者数 673万人" / "673K subscribers"）。2026-11-05 実DOMで確認。
    channelAvatar: [
      "ytd-watch-metadata #owner yt-img-shadow#avatar img",
      "ytd-watch-metadata #owner ytd-video-owner-renderer img",
      "#owner #avatar img"
    ],
    channelSubscribers: [
      "ytd-watch-metadata #owner #owner-sub-count",
      "#owner yt-formatted-string#owner-sub-count"
    ],
    // 高評価の件数が入る要素。ボタン全体ではなくここを読む（ボタンには件数以外も入る）。
    likeCount: [
      ".ytSpecButtonShapeNextButtonTextContent",
      ".yt-spec-button-shape-next__button-text-content"
    ],
    // チャンネル登録ボタンの入れ物。登録済みかどうかはこの要素の `subscribed` 属性で分かる。
    // ★ 2026-11-05 実DOMで確認: 未登録は属性なし・文言「チャンネル登録」、
    //   登録済みは `subscribed` が付き・文言「登録済み」＋通知ベルのボタンが現れる。
    //   文言は言語で変わるので属性で判定する。評価ボタンと同じく ytd-watch-metadata に絞る。
    subscribeHost: [
      "ytd-watch-metadata #subscribe-button ytd-subscribe-button-renderer",
      "ytd-watch-metadata ytd-subscribe-button-renderer",
      "#owner ytd-subscribe-button-renderer"
    ],
    // ★ 入れ物の中には通知ベルのボタンもあるが、文書順で登録ボタンが先（実DOMで確認）。
    //   先頭一致で登録ボタンを取る。
    subscribeButton: [
      "ytd-watch-metadata #subscribe-button ytd-subscribe-button-renderer button",
      "ytd-watch-metadata ytd-subscribe-button-renderer button",
      "#owner ytd-subscribe-button-renderer button"
    ],
    // 登録済みのボタンを押すと開くメニュー。
    // ★ 2026-11-10 実測（登録済みのチャンネル）: 押して初めて
    //   `ytd-popup-container > tp-yt-iron-dropdown > ytd-menu-popup-renderer >
    //   tp-yt-paper-listbox#items` が作られ、`ytd-menu-service-item-renderer` が4つ並ぶ:
    //   「すべて」「カスタマイズされた通知のみ」「なし」「登録解除」。
    // ★ **区切りもグループも無く4つとも同じリストの兄弟**で、`aria-selected` は
    //   通知側で一貫しない（「すべて」が true なのに、実際の選択中は「カスタマイズ」の
    //   `is-selected`）。文言は言語で変わるので見ない。つまり登録解除は
    //   **位置（最後の項目）でしか見分けられない**。危うさは呼び出し側で埋める
    //   （自分のクリックで開いたメニューだけを読む／選択中の通知設定は押さない／
    //   最後に subscribed 属性が消えたかで成否を判定する）。
    // ★ 2026-11-10 実測: ytd-popup-container は**メニューもダイアログも使い回す**。
    //   閉じても要素はDOMに残り続ける（キャンセル後も ytd-menu-popup-renderer と
    //   yt-confirm-dialog-renderer がそのまま残り、死んだ #confirm-button まで持っている）。
    //   そのため「要素があるか」で判断してはいけない。**いま開いているか**で引く。
    //   開閉の印は `aria-hidden`（閉="true" / 開=属性なし）。実測で、閉じた確認ダイアログは
    //   aria-hidden="true"・矩形0、同時に開いていた共有ダイアログは属性なし・矩形1だった。
    //   `opened` 属性は開いていても付かず、checkVisibility() はアニメーション中に揺れるので
    //   どちらも使わない。
    subscribeMenu: [
      "ytd-popup-container tp-yt-iron-dropdown:not([aria-hidden='true']) ytd-menu-popup-renderer",
      "ytd-popup-container tp-yt-iron-dropdown:not([aria-hidden='true'])"
    ],
    subscribeMenuItem: [
      "tp-yt-paper-listbox#items > ytd-menu-service-item-renderer",
      "#items > ytd-menu-service-item-renderer",
      "ytd-menu-service-item-renderer"
    ],
    // 解除の確認ダイアログ。★ **実機未確認**（確認まで進めるとユーザーのアカウントで
    //   実際に解除が走るため測っていない）。出る世代と出ない世代の両方を扱えるよう、
    //   「出たら押す」「出なければ属性の変化を待つ」の両対応にしてある。
    // ★ 閉じた残骸を掴まないよう、必ず「開いている tp-yt-paper-dialog の中」に限定する。
    //   v0.1.22 はここを `yt-confirm-dialog-renderer` だけで引いていたため、前回の残骸の
    //   死んだ確認ボタンを押して「押した」ことにしてしまい、本物のダイアログが放置された
    //   （ユーザー報告「自動的にはいを選んでほしい」の原因）。
    confirmDialog: [
      "ytd-popup-container tp-yt-paper-dialog:not([aria-hidden='true']) yt-confirm-dialog-renderer",
      "ytd-popup-container tp-yt-paper-dialog:not([aria-hidden='true'])"
    ],
    confirmDialogConfirm: ["#confirm-button button", "#confirm-button", "yt-button-shape#confirm-button button"]
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
    // カードのメタ行。新DOMは行が2つ（1行目チャンネル名、2行目「[目のアイコン] 168万 • 5 か月前」）、
    // 旧DOMは #metadata-line の中に inline-metadata-item が2つ（"12万 回視聴" "1 年前"）。
    // 2026-09-20 実DOMで確認。行の中のテキスト片は metaText で取る。
    metaRow: [
      ".ytContentMetadataViewModelMetadataRow",
      ".yt-content-metadata-view-model__metadata-row",
      "#metadata-line"
    ],
    metaText: [
      ".ytContentMetadataViewModelMetadataText",
      ".yt-content-metadata-view-model__metadata-text",
      "span.inline-metadata-item",
      ":scope > span"
    ],
    duration: [
      ".ytThumbnailBottomOverlayViewModelBadgeContainer .ytBadgeShapeText",
      "badge-shape .badge-shape-wiz__text",
      "ytd-thumbnail-overlay-time-status-renderer #text",
      "#time-status #text"
    ]
  },

  comments: {
    // 通常欄と engagement panel の両方に存在する。利用時は findCommentSection() で選ぶ。
    section: ["ytd-comments", "#comments"],
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
      "ytd-comments ytd-item-section-renderer > #contents > ytd-continuation-item-renderer",
      "ytd-comments > ytd-item-section-renderer ytd-continuation-item-renderer",
      "ytd-comments ytd-continuation-item-renderer",
      "ytd-comments #continuations",
      "#comments ytd-continuation-item-renderer"
    ],
    continuationButton: [
      "button#button:not([disabled])",
      "yt-button-shape button:not([disabled])",
      "tp-yt-paper-button#button:not([disabled])"
    ],
    // コメント欄が0件で確定するときのメッセージ。
    // ★ 2026-09-17 実機確認（チャンネルがコメントをオフにした動画）:
    //   `#contents > ytd-message-renderer > yt-formatted-string#message`「コメントはオフになっています。」
    //   第1候補で一致し、commentsAreDefinitelyEmpty() が即 done にする。
    //   終端メッセージ（endOfList）とは別要素なので混同しないこと。
    emptyMessage: [
      "ytd-comments ytd-message-renderer",
      "ytd-comments ytd-item-section-renderer #message"
    ],
    // コメント一覧の終端メッセージ（「[人気順] が選択されているので、注目のコメントが表示されます」）。
    // ★ 2026-09-17 実機確認: `#contents` の直下、最後の thread の**直後**に
    //   `yt-comment-filter-context-view-model` として描画される（`ytd-message-renderer` ではないため
    //   emptyMessage では拾えない）。このとき continuation 要素
    //   （`ytd-continuation-item-renderer[is-initial-load]`）は高さ0・ボタン無しの死骸として残るので、
    //   continuation の有無だけでは終端を判定できない。文言は言語依存なので見ない。
    endOfList: [
      "ytd-comments ytd-item-section-renderer > #contents > yt-comment-filter-context-view-model",
      "ytd-comments yt-comment-filter-context-view-model"
    ],
    count: ["ytd-comments-header-renderer #count", "#comments #count"],
    thread: ["ytd-comment-thread-renderer"],
    author: ["#author-text span", "#author-text"],
    avatar: ["#author-thumbnail img", "#img"],
    body: ["#content-text"],
    published: ["#published-time-text a", "#published-time-text"],
    // 「@channel さんによって固定されています」の帯。実機確認済み（2026-08-19）。
    // ★ 新世代は ytw- 接頭辞（ytd- ではない）。世代差に振り回されないよう
    //   安定したid #pinned-comment-badge を先頭に置き、レンダラー名は保険として残す。
    //   文言はYouTube側のものをそのまま使う（自前で組み立てると多言語で破綻するため）。
    pinnedBadge: [
      "#pinned-comment-badge",
      "ytw-pinned-comment-badge-renderer",
      "ytd-pinned-comment-badge-renderer"
    ],
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
    // ★ 2026-08-19 実機のDOM属性を確認して言語非依存のセレクタに変更した。
    //   ツールバー内の4種のボタンは属性の持ち方で機械的に見分けられる:
    //   いいね/よくない → aria-pressedを持つ。ハート(#creator-heart-button内) → 固有の親idを持つ。
    //   「返信」だけが aria-pressed を持たず、ハートの子でもないボタン。
    //   （title属性の値=表示言語での文言 自体は見ないので、YouTubeの表示言語に依存しない）
    //   旧: aria-label='返信' の文字列一致は日本語UI前提だったため、フォールバックとして残す。
    replyButton: [
      "#toolbar button[title]:not([aria-pressed]):not(#creator-heart-button button)",
      "ytd-comment-engagement-bar button[title]:not([aria-pressed]):not(#creator-heart-button button)",
      "#toolbar button[aria-label='返信']",
      "ytd-comment-engagement-bar button[aria-label='返信']"
    ],
    // 「返信」トリガーを押すと現れる返信用commentbox
    replyCommentBox: ["ytd-commentbox[is-reply]"]
  },

  /**
   * 左のサイドバー（YouTubeの呼称は guide）。サブ画面に同じものを並べるために読む。
   *
   * ★ 2026-11-05 実測（watchページ）: `ytd-guide-renderer` は**最初はDOMに存在しない**。
   *   ハンバーガー（`#guide-button`）を一度押してドロワーを開いて初めて組み立てられ、
   *   以後は閉じてもDOMに残り、SPA遷移をまたいで生き続ける。だから起動は1ページにつき1回でよい。
   *   初回は renderer が約650ms、全30項目が約750ms、チャンネルのアイコンが約960msで揃った。
   *   ページ読み込み直後はボタンの処理がまだ結び付いておらず、押しても開かないことがある。
   * ★ 項目のアイコンは `<svg viewBox="0 0 24 24">` の中に `<path d>` が1本だけ。
   *   チャンネルの項目はアイコンを持たず `yt-img-shadow img#img` にアイコン画像が入る。
   *   どちらも持たない項目（「ショート」等）があるので、両方とも無いことを異常としない。
   */
  // コメントの並び替え（人気順／新しい順）。
  // ★ 2026-11-09 実測: ytd-comments-header-renderer > #title > #additional-section >
  //   span#sort-menu > yt-dropdown-menu > tp-yt-paper-menu-button。
  //   選択肢は**メニューを開かなくても既にDOMにある**（tp-yt-paper-listbox の中の
  //   `<a aria-selected>`）。そのまま click() すると切り替わり、ドロップダウンは
  //   非表示のまま（offsetParent が null）なので**メイン画面には何も出ない**。
  //   サイドバー(v84)のような「見えないように開く」細工は要らない。
  // ★ 現在どれが選ばれているかは `aria-selected` で分かる。文言は見ない（言語非依存）。
  // ★ ラベルは `#item-with-badge .item`、説明は `#subtitle`
  //   （「注目のコメントを表示」「スパムである可能性があるコメントを含む…」）。
  commentSort: {
    root: ["yt-sort-filter-sub-menu-renderer", "#sort-menu"],
    option: ["tp-yt-paper-listbox a[aria-selected]", "a[aria-selected]"],
    optionLabel: ["#item-with-badge .item", ".item"],
    optionHint: ["#subtitle"]
  },
  guide: {
    root: ["ytd-guide-renderer"],
    drawer: ["tp-yt-app-drawer#guide"],
    toggleButton: ["#guide-button button", "#guide-button"],
    section: ["ytd-guide-section-renderer"],
    sectionTitle: ["#guide-section-title"],
    entry: ["ytd-guide-entry-renderer"],
    // ★ 「ショート」の項目は href を持たない（Polymer側のハンドラだけで遷移する）。
    //   だからサブ画面からの遷移はURLを組み立てず、この要素を押して YouTube 自身に遷移させる。
    entryLink: ["a#endpoint", "a"],
    entryTitle: [".title", "yt-formatted-string.title"],
    entryIconPath: [".guide-icon svg path", "yt-icon svg path"],
    entryAvatar: ["yt-img-shadow img#img", "img#img"],
    // 「もっと見る / 折りたたむ」の入れ物。`expanded` 属性が開閉の状態を持ち、
    // 隠れているチャンネルは展開するまでDOMに存在しない（2026-11-05 実測: 7件 → 103件）。
    collapsible: ["ytd-guide-collapsible-entry-renderer"]
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

/**
 * 現在の動画のコメント欄を選ぶ。SPA遷移後も非表示の旧 #comments が残り、
 * 別の ytd-comments（idのないパネル側）が読み込み先になる場合がある。
 * 画面外・全画面中でも取得するので、座標やサイズを可否判定に使わない。
 */
/**
 * 段階的ハイドレーション中の「空の器」か。
 * ★ YouTubeは2026-10頃から watch ページを骨組み(skeleton)から段階的に組み立てるようになり、
 *   通常のコメント欄は最初 `[hidden]` の空要素として現れ、数秒後に中身
 *   （yt-ghost-comments 入りの continuation → 実際のコメント）が入って hidden が外れる
 *   （2026-10-15 実DOMで確認）。この「まだ出来ていないだけの欄」を、
 *   前の動画のコメントが残った旧DOMや「コメントはオフになっています。」の欄と区別する。
 *   中身が何も無いときだけ placeholder とみなす。
 */
function isHydrationPlaceholder(section: Element): boolean {
  return section.querySelector(HYDRATION_PLACEHOLDER_CONTENT) === null
}

/** placeholder でない（＝中身がある）と判断する要素。スレッド本体と0件メッセージ。 */
const HYDRATION_PLACEHOLDER_CONTENT = "ytd-comment-thread-renderer, ytd-message-renderer"

export function findCommentSection(
  videoId: string | null,
  root: ParentNode = document
): HTMLElement | null {
  let panelFallback: HTMLElement | null = null
  // 通常欄が「まだ出来ていない」だけなら、未展開パネルで代用せずに待つ（下の return を参照）。
  let awaitingHydration = false
  for (const section of root.querySelectorAll<HTMLElement>(SELECTORS.comments.section.join(","))) {
    // #comments が ytd-comments の内側にある世代でも、二重に候補へ数えない。
    const owner = section.closest("ytd-comments")
    if (owner && owner !== section) continue
    if (section.closest("[hidden]")) {
      if (
        !section.closest("ytd-engagement-panel-section-list-renderer") &&
        isHydrationPlaceholder(section)
      ) {
        awaitingHydration = true
      }
      continue
    }
    const watch = section.closest("ytd-watch-flexy")
    const ownerVideoId = watch?.getAttribute("video-id")
    if (videoId && ownerVideoId && ownerVideoId !== videoId) continue

    // ナビゲーション完了イベントより古いコメントDOMの撤去が遅れることがある。
    // 混在期間は新動画のリンクが1件でもあれば採用し、各行は呼び出し側で濾過する。
    let hasOtherVideo = false
    let hasCurrentVideo = false
    if (videoId) {
      for (const link of section.querySelectorAll("#published-time-text a[href], a#published-time-text[href]")) {
        try {
          const linkedId = new URL(link.getAttribute("href")!, "https://www.youtube.com").searchParams.get("v")
          if (linkedId === videoId) { hasCurrentVideo = true; break }
          if (linkedId) hasOtherVideo = true
        } catch { /* URLのない世代・未完成DOMは既存の行単位の判定へ委ねる。 */ }
      }
    }
    if (hasOtherVideo && !hasCurrentVideo) continue

    // 未展開パネルは通常欄より後回し。ただし通常欄が旧DOMだけなら、こちらの
    // 初期continuationを使って読み込みを起動できる（IDが無くても対象にする）。
    if (section.closest('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"]')) {
      panelFallback ??= section
      continue
    }
    return section
  }
  // ★ 通常欄がハイドレーション待ちの空の器として存在する間は、未展開パネルを返さない。
  //   返すと、呼び出し側がパネルの continuation を画面内へ置いて読み込みを起動してしまい、
  //   YouTubeは**非表示のパネルの中へ**コメントを入れる。実DOMで確認（2026-10-15）:
  //   パネル側9件・通常欄0件、通常欄の continuation と ghost は消費されて消える。
  //   サブ画面は通常欄から読むため、読み込んだはずのコメントが永久に届かなくなる
  //   （報告「メイン画面でコメントを見ないとサブに表示されない」の原因）。
  //   null を返して待てば、通常欄が出来た時点でそちらを掴んで起動できる。
  //   前の動画のコメントが残っている旧DOMや0件メッセージの欄は placeholder ではないので、
  //   従来どおりパネルで読み込みを起動できる。
  if (awaitingHydration) return null
  return panelFallback
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
/**
 * コメント中のリンクを、実際に開いてよい絶対URLへ正規化する。
 *
 * ★ YouTubeは外部リンクを `https://www.youtube.com/redirect?...&q=<実URL>` で包む。
 *   そのまま開くと踏み台ページを経由するので、実URLを取り出す。
 * ★ http/https 以外（javascript: や data: 等）は必ず捨てる。コメント本文は
 *   第三者が書いた内容であり、そのままリンクにするとサブ画面が攻撃面になる。
 */
function resolveCommentLinkHref(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw, location.href)
    const host = url.hostname.toLowerCase()
    const isYouTube =
      host === "youtube.com" || host === "www.youtube.com" || host.endsWith(".youtube.com")
    if (isYouTube && url.pathname === "/redirect") {
      const q = url.searchParams.get("q")
      if (q) {
        const target = new URL(q, location.href)
        if (target.protocol === "http:" || target.protocol === "https:") return target.href
      }
    }
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

/** "83s" / "83" / "1h2m3s" 形式（YouTubeのtパラメータ）を秒数へ変換する。 */
function parseYouTubeTimeParam(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw)
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!match || (!match[1] && !match[2] && !match[3])) return null
  const [, h, m, s] = match
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)
}

/**
 * コメント中のリンクが「今見ている動画の特定時刻」を指しているかを判定する。
 * ★ 動画IDが現在のページと一致する場合だけタイムスタンプ扱いにする。
 *   別動画へのリンクはメインの再生位置を飛ばす対象にならないため、通常のリンクとして扱う。
 */
function parseCommentTimestampHref(raw: string): number | null {
  try {
    const url = new URL(raw, location.href)
    const host = url.hostname.toLowerCase()
    const isYouTube =
      host === "youtube.com" || host === "www.youtube.com" || host.endsWith(".youtube.com")
    if (!isYouTube || url.pathname !== "/watch") return null
    const videoId = url.searchParams.get("v")
    const currentVideoId = new URLSearchParams(location.search).get("v")
    if (!videoId || !currentVideoId || videoId !== currentVideoId) return null
    const tParam = url.searchParams.get("t")
    if (tParam) return parseYouTubeTimeParam(tParam)
    const hashMatch = url.hash.match(/t=(\d+)/)
    return hashMatch ? Number(hashMatch[1]) : null
  } catch {
    return null
  }
}

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
    } else if (node instanceof HTMLAnchorElement) {
      // ★ <a> は平坦化せずリンク/タイムスタンプとして残す。中身を展開してしまうと
      //   href が失われ、省略表示されたテキストしか手元に残らない
      //   （＝正しいURLや秒数を復元できない）。
      const rawHref = node.getAttribute("href")
      const v = node.textContent ?? ""
      const seconds = rawHref ? parseCommentTimestampHref(rawHref) : null
      if (seconds !== null && v) {
        tokens.push({ t: "timestamp", seconds, v })
      } else {
        const href = resolveCommentLinkHref(rawHref)
        if (href && v) tokens.push({ t: "link", href, v })
        else tokens.push(...toTokens(node))
      }
    } else if (node instanceof Element) {
      tokens.push(...toTokens(node)) // <span> のネストを平坦化
    }
  })
  return tokens
}

// messaging.ts の RichToken と同型（循環 import を避けるためローカル定義）
type RichTokenLocal =
  | { t: "text"; v: string }
  | { t: "emoji"; url: string; alt: string }
  | { t: "link"; href: string; v: string }
  | { t: "timestamp"; seconds: number; v: string }

/* ============================================================
 * 生存確認（セレクタが壊れたときの一次切り分け）
 * ========================================================== */

/**
 * 全セレクタについて「今のページで1件でも取れるか」を返す。
 * false が並んだグループが、YouTube側の変更で壊れた箇所。
 */
export function diagnose(root: ParentNode = document): Record<string, boolean> {
  return Object.fromEntries(Object.entries(diagnoseDetail(root)).map(([key, value]) => [key, value.ok]))
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
  const commentSection = findCommentSection(new URLSearchParams(location.search).get("v"), root)
  for (const [group, entries] of Object.entries(SELECTORS)) {
    for (const [key, candidates] of Object.entries(entries as Record<string, readonly string[]>)) {
      // 実際に使っている欄だけを診断する。旧欄の大量のコメントが正常に見えると、
      // 現在の欄が未初期化でも「取得成功」と報告されて切り分けができなくなる。
      if (group === "comments" && key === "section") {
        const sel = candidates.find((candidate) => commentSection?.matches(candidate)) ?? null
        result[`${group}.${key}`] = { ok: sel !== null, sel, n: sel ? 1 : 0 }
        continue
      }
      const scope = group === "comments" && key !== "activation" ? commentSection : root
      let sel: string | null = null
      for (const c of candidates) {
        if (scope?.querySelector(c)) { sel = c; break }
      }
      result[`${group}.${key}`] = {
        ok: sel !== null,
        sel,
        n: sel && scope ? scope.querySelectorAll(sel).length : 0
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
 * 関連動画欄の広告カードを見分ける印。SELECTORS に入れないのは、広告の無いページで
 * 診断が「×」を出して壊れたように見えるため（診断は SELECTORS の全キーを列挙する）。
 * - inside:   カードの中にあれば広告（feed-ad-metadata-view-model は 2026-08 から実機で確認。
 *             プロモーション動画は /watch?v= リンクとサムネイルを持つが、タイトル・チャンネル名は
 *             この要素の中にあり通常の候補では取れない）
 * - ancestor: カードがこの中に包まれていれば広告
 */
export const RELATED_AD_MARKERS = {
  inside: ["feed-ad-metadata-view-model", "ad-badge-view-model", ".ytAdBadge"],
  ancestor: ["ytd-ad-slot-renderer", "ytd-promoted-video-renderer", "ytd-compact-promoted-video-renderer", "ytd-in-feed-ad-layout-renderer"]
} as const

/** 関連動画カードが広告かどうか */
export function isRelatedAdCard(el: Element): boolean {
  return RELATED_AD_MARKERS.inside.some((sel) => el.querySelector(sel) !== null) ||
    RELATED_AD_MARKERS.ancestor.some((sel) => el.closest(sel) !== null)
}

/**
 * 壊れた箇所を直すための現物サンプル。診断と一緒に持ち帰る。
 *
 * ★ related.item は先頭が広告カード(feed-ad-metadata-view-model)であることが多く、
 *   通常の動画カードと構造が異なる。広告でない最初の1件を選んで採取する。
 */
export function sampleOutlines(root: ParentNode = document): Record<string, string> {
  const relItems = qa(SELECTORS.related.item, root)
  const relItem = relItems.find((el) => !isRelatedAdCard(el)) ?? relItems[0] ?? null
  const commentSection = findCommentSection(new URLSearchParams(location.search).get("v"), root)
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
export const DIAGNOSE_VERSION = 91

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
