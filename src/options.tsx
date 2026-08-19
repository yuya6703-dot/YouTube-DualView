/**
 * src/options.tsx → build後 options.html
 * 拡張アイコンを右クリック→「オプション」、または brave://extensions のカードの
 * 「詳細」→「拡張機能のオプション」から開ける独立ページ。
 * Plasmoの規約でこのファイルを置くだけで manifest の options_page に自動登録される
 * （src/popup.tsx を置くと default_popup が自動登録されるのと同じ仕組み。D-03参照）。
 */
import { useEffect, useState } from "react"
import {
  DEFAULT_RELATED_DISPLAY_SIZE,
  DEFAULT_SETTINGS,
  LOCAL_KEYS,
  isRelatedDisplaySize,
  type RelatedDisplaySize,
  type Settings
} from "~lib/messaging"
import "~style.css"

type CommentFontSize = "sm" | "md" | "lg"

const SPEED_STEP_OPTIONS = [0.05, 0.1, 0.25, 0.5] as const

export default function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [commentFontSize, setCommentFontSize] = useState<CommentFontSize>("sm")
  const [relatedDisplaySize, setRelatedDisplaySize] = useState<RelatedDisplaySize>(
    DEFAULT_RELATED_DISPLAY_SIZE
  )
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    chrome.storage.local
      .get([LOCAL_KEYS.settings, LOCAL_KEYS.commentFontSize, LOCAL_KEYS.relatedDisplaySize])
      .then((r) => {
        if (!alive) return
        // 保存済みSettingsが古いバージョン由来で項目が足りない場合に備え、既定値にマージする
        setSettings({ ...DEFAULT_SETTINGS, ...(r[LOCAL_KEYS.settings] as Partial<Settings> | undefined) })
        const fs = r[LOCAL_KEYS.commentFontSize]
        if (fs === "sm" || fs === "md" || fs === "lg") setCommentFontSize(fs)
        const relatedSize = r[LOCAL_KEYS.relatedDisplaySize]
        if (isRelatedDisplaySize(relatedSize)) setRelatedDisplaySize(relatedSize)
        setLoaded(true)
      })

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== "local") return
      const fontChange = changes[LOCAL_KEYS.commentFontSize]
      if (fontChange) {
        const value = fontChange.newValue
        if (value === "sm" || value === "md" || value === "lg") setCommentFontSize(value)
      }
      const relatedChange = changes[LOCAL_KEYS.relatedDisplaySize]
      if (relatedChange) {
        setRelatedDisplaySize(
          isRelatedDisplaySize(relatedChange.newValue)
            ? relatedChange.newValue
            : DEFAULT_RELATED_DISPLAY_SIZE
        )
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(handleStorageChange)
    }
  }, [])

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    void chrome.storage.local.set({ [LOCAL_KEYS.settings]: next }).then(flashSaved)
  }

  const updateCommentFontSize = (size: CommentFontSize) => {
    setCommentFontSize(size)
    void chrome.storage.local.set({ [LOCAL_KEYS.commentFontSize]: size }).then(flashSaved)
  }

  const updateRelatedDisplaySize = (size: RelatedDisplaySize) => {
    setRelatedDisplaySize(size)
    void chrome.storage.local.set({ [LOCAL_KEYS.relatedDisplaySize]: size }).then(flashSaved)
  }

  const flashSaved = () => {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  const resetToDefaults = () => {
    setSettings(DEFAULT_SETTINGS)
    setCommentFontSize("sm")
    setRelatedDisplaySize(DEFAULT_RELATED_DISPLAY_SIZE)
    void chrome.storage.local
      .set({
        [LOCAL_KEYS.settings]: DEFAULT_SETTINGS,
        [LOCAL_KEYS.commentFontSize]: "sm",
        [LOCAL_KEYS.relatedDisplaySize]: DEFAULT_RELATED_DISPLAY_SIZE
      })
      .then(flashSaved)
  }

  if (!loaded) return null // ちらつき防止。読み込みは一瞬なのでスピナーは出さない

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100 antialiased">
      <div className="mx-auto max-w-xl px-6 py-10">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">YouTube DualView 設定</h1>
            <p className="mt-1 text-xs text-neutral-500">変更は自動的に保存されます</p>
          </div>
          {saved && (
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
              保存しました
            </span>
          )}
        </header>

        {/* 再生 */}
        <Section title="再生">
          <Field label="初期音量" hint="サブ画面を新規に開いたときの初期値（今後の機能で使用）">
            <div className="flex items-center gap-3">
              <input
                type="range" min={0} max={100}
                value={settings.defaultVolume}
                onChange={(e) => update({ defaultVolume: Number(e.target.value) })}
                className="flex-1 accent-red-600"
              />
              <span className="w-9 text-right text-xs tabular-nums text-neutral-400">
                {settings.defaultVolume}
              </span>
            </div>
          </Field>

          <Field label="速度の刻み幅" hint="サブ画面の速度＋／－ボタンを押したときの増減量">
            <div className="flex gap-2">
              {SPEED_STEP_OPTIONS.map((step) => (
                <button
                  key={step}
                  onClick={() => update({ speedStep: step })}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition ${
                    settings.speedStep === step
                      ? "bg-red-600 text-white"
                      : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                  }`}>
                  {step.toFixed(2)}
                </button>
              ))}
            </div>
          </Field>
        </Section>

        {/* サブ画面の開閉 */}
        <Section title="サブ画面の開閉">
          <Field
            label="YouTubeを開いたら自動でサブ画面を開く"
            hint="動画ページを開いたときに自動で起動します。既に開いている場合は前面化しません（視聴の邪魔をしないため）">
            <Toggle checked={settings.autoOpenPopout} onChange={(v) => update({ autoOpenPopout: v })} />
          </Field>

          <Field
            label="YouTubeタブを閉じたらサブ画面も閉じる"
            hint="他にYouTubeタブが残っている場合は閉じません">
            <Toggle checked={settings.autoClosePopout} onChange={(v) => update({ autoClosePopout: v })} />
          </Field>
        </Section>

        {/* 自動再生 */}
        <Section title="自動再生">
          <Field label="キューの自動連続再生" hint="動画が終わったら「次に再生」キューの先頭を自動的に再生します">
            <Toggle checked={settings.autoPlayNext} onChange={(v) => update({ autoPlayNext: v })} />
          </Field>
        </Section>

        <Section title="関連動画">
          <Field
            label="表示サイズ"
            hint="サムネイル、タイトル、チャンネル名、行間をまとめて変更します">
            <div
              role="group"
              aria-label="関連動画の表示サイズ"
              className="flex w-fit items-center overflow-hidden rounded border border-neutral-700">
              {(["sm", "md", "lg"] as const).map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => updateRelatedDisplaySize(size)}
                  aria-pressed={relatedDisplaySize === size}
                  className={`px-3 py-1.5 text-xs transition focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500/70 ${
                    relatedDisplaySize === size
                      ? "bg-neutral-700 text-neutral-100"
                      : "text-neutral-500 hover:bg-neutral-800"
                  }`}>
                  {{ sm: "小", md: "中", lg: "大" }[size]}
                </button>
              ))}
            </div>
          </Field>
        </Section>

        {/* コメント / 将来のストリーミングフィード */}
        <Section title="コメント">
          <Field
            label="ストリーミング最大保持件数"
            hint="通常コメントは最後まで閲覧できるよう全件保持します。この上限は将来のライブチャットなど流れ続ける表示にだけ適用します">
            <input
              type="number" min={20} max={2000} step={10}
              value={settings.feedMaxRows}
              onChange={(e) => update({ feedMaxRows: clamp(Number(e.target.value), 20, 2000) })}
              className="w-24 rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-sm tabular-nums"
            />
          </Field>

          <Field label="文字サイズ" hint="サブ画面のコメント欄と同じ設定です">
            <div className="flex items-center overflow-hidden rounded border border-neutral-700 w-fit">
              {(["sm", "md", "lg"] as const).map((size) => (
                <button
                  key={size}
                  onClick={() => updateCommentFontSize(size)}
                  className={`px-3 py-1.5 text-xs transition ${
                    commentFontSize === size
                      ? "bg-neutral-700 text-neutral-100"
                      : "text-neutral-500 hover:bg-neutral-800"
                  }`}>
                  {{ sm: "小", md: "中", lg: "大" }[size]}
                </button>
              ))}
            </div>
          </Field>
        </Section>

        <button
          onClick={resetToDefaults}
          className="mt-4 text-xs text-neutral-500 underline decoration-neutral-700 underline-offset-2 hover:text-neutral-300">
          既定値に戻す
        </button>
      </div>
    </div>
  )
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      <div className="space-y-5 rounded-lg border border-neutral-800 bg-neutral-800/40 p-5">
        {children}
      </div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="text-sm text-neutral-200">{label}</label>
      </div>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">{hint}</p>}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition ${checked ? "bg-red-600" : "bg-neutral-700"}`}>
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  )
}
