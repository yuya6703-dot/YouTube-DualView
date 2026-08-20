/**
 * src/lib/deepl.ts
 * ---------------------------------------------------------------
 * コメントの手動翻訳（DeepL API 無料枠）。
 * ★ サブ画面(Popout)から直接呼ぶ。SWは経由しない
 *   （D-05: SWの責務はウィンドウ管理とタブ解決の2つだけ、を守る）。
 * ★ 自動翻訳ではなく、ユーザーがコメントごとに「翻訳」を押した時だけ送信する。
 *   プライバシーポリシーもこの「手動・個別」の前提で書いてある。
 * ---------------------------------------------------------------
 */

// 無料キー（末尾が ":fx"）は api-free、有料キーは api.deepl.com。
// このアプリは無料枠のみを対象にする（options.tsxの案内文もそれ前提）。
const DEEPL_FREE_ENDPOINT = "https://api-free.deepl.com/v2/translate"

export interface TranslateResult {
  text: string
  detectedSourceLang: string
}

export type TranslateOutcome =
  | { ok: true; data: TranslateResult }
  | { ok: false; error: string }

/**
 * DeepL APIへ1件のテキストを送り、翻訳結果を受け取る。
 * ★ ここでの失敗はすべて呼び出し元へ文言として返す。黙って握りつぶさない
 *   （APIキー未設定・上限超過・ネットワーク断など、原因ごとに違うことが多いため）。
 */
export async function translateText(
  apiKey: string,
  text: string,
  targetLang: string
): Promise<TranslateOutcome> {
  const trimmedKey = apiKey.trim()
  if (!trimmedKey) return { ok: false, error: "NO_API_KEY" }
  if (!text.trim()) return { ok: false, error: "EMPTY_TEXT" }

  try {
    const res = await fetch(DEEPL_FREE_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `DeepL-Auth-Key ${trimmedKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: [text], target_lang: targetLang })
    })

    if (res.status === 403) return { ok: false, error: "INVALID_KEY" }
    if (res.status === 456) return { ok: false, error: "QUOTA_EXCEEDED" }
    if (!res.ok) return { ok: false, error: `HTTP_${res.status}` }

    const json = (await res.json()) as {
      translations?: { text: string; detected_source_language: string }[]
    }
    const first = json.translations?.[0]
    if (!first) return { ok: false, error: "EMPTY_RESPONSE" }

    return { ok: true, data: { text: first.text, detectedSourceLang: first.detected_source_language } }
  } catch {
    // fetch自体の失敗（オフライン、CORSブロック等）。実機で未検証のため、
    // 万一DeepLがCORSを許可していない環境があった場合もここに落ちて
    // 「通信エラー」の文言をユーザーに見せる（無反応にはしない）。
    return { ok: false, error: "NETWORK_ERROR" }
  }
}

// options.tsx のプルダウンで使う、よく使われるDeepLターゲット言語コード。
export const DEEPL_TARGET_LANGS = [
  "JA", "EN-US", "EN-GB", "ZH", "KO", "ES", "FR", "DE", "PT-BR", "RU", "IT"
] as const
export type DeeplTargetLang = (typeof DEEPL_TARGET_LANGS)[number]

export function isDeeplTargetLang(value: unknown): value is DeeplTargetLang {
  return typeof value === "string" && (DEEPL_TARGET_LANGS as readonly string[]).includes(value)
}
