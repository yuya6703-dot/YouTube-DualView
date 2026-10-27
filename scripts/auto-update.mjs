/**
 * scripts/auto-update.mjs — 手元で読み込んでいる拡張機能を、GitHub の最新の Release に自動で更新する。
 *   node scripts/auto-update.mjs            更新があれば build/chrome-mv3-prod に入れる
 *   node scripts/auto-update.mjs --install  上に加えて、Windows のサインイン時に自動で実行されるよう登録する
 * 読み込むフォルダが変わらないので、拡張機能の ID と保存済みの設定はそのまま。
 * ブラウザは開き直したときに新しいファイルを読み込む。
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { inflateRawSync } from "node:zlib"

const REPO = "yuya6703-dot/YouTube-DualView"
const ASSET = "chrome-mv3-prod.zip"
const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT), "..")
const USER_AGENT = "dualview-auto-update"
const STARTUP_FILE = "DualView auto-update.cmd"

export function parseVersion(text) {
  const parts = String(text).replace(/^v/, "").split(".").map(Number)
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`バージョンを読めません: ${text}`)
  }
  return parts
}

export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

function readInstalledVersion(target) {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8")).version ?? null
  } catch {
    return null // 未インストール、または壊れている。どちらも入れ直す
  }
}

/** zip を { name, data } の一覧にする。plasmo package が作る通常の zip（無圧縮か deflate）だけを扱う。 */
export function unzip(buffer) {
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) throw new Error("zip ではありません")
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const entries = []
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("zip の目次が壊れています")
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const local = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
    if (name.endsWith("/")) continue
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip の中身が壊れています: ${name}`)
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const raw = buffer.subarray(start, start + compressedSize)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`対応していない圧縮形式です（${method}）: ${name}`)
    if (data.length !== size) throw new Error(`zip の中身の大きさが合いません: ${name}`)
    entries.push({ name, data })
  }
  return entries
}

/** zip 内の名前を展開先のパスにする。フォルダの外を指す名前（../ や絶対パス）は拒む。 */
function entryPath(target, name) {
  const segments = name.split("/")
  if (segments.some((s) => s === "" || s === "." || s === ".." || /[\\:]/.test(s))) {
    throw new Error(`zip に不正なパスがあります: ${name}`)
  }
  return path.join(target, ...segments)
}

function listFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(full))
    else files.push(full)
  }
  return files
}

function removeEmptyDirs(dir, root) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name), root)
  }
  if (dir !== root && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
}

/**
 * 新しいファイルを書いてから、無くなったファイルを消す。
 * ★ manifest.json は最後に書く。ブラウザが途中で読み込んでも、参照先のファイルが揃ってから切り替わる。
 * ★ 書き始める前に全部のパスを検査する。不正な zip で途中まで書き換わった状態を作らない。
 */
function installFiles(entries, target) {
  const planned = entries
    .map(({ name, data }) => ({ name, data, file: entryPath(target, name) }))
    .sort((a, b) => Number(a.name === "manifest.json") - Number(b.name === "manifest.json"))
  fs.mkdirSync(target, { recursive: true })
  for (const { file, data } of planned) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
  }
  // Windows のファイル名は大文字小文字を区別しないので、比べるときもそれに合わせる
  const key = (file) => (process.platform === "win32" ? file.toLowerCase() : file)
  const keep = new Set(planned.map(({ file }) => key(file)))
  for (const file of listFiles(target)) if (!keep.has(key(file))) fs.rmSync(file)
  removeEmptyDirs(target, target)
}

async function fetchOk(fetchImpl, url, what, headers = {}) {
  // サインイン時に裏で動くので、通信が固まっても待ち続けない
  const response = await fetchImpl(url, {
    headers: { "user-agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(60_000)
  })
  if (!response.ok) throw new Error(`${what}を取得できません（HTTP ${response.status}）`)
  return response
}

/** 最新の Release が入っている版より新しければ、target に入れる。 */
export async function update({ target, fetchImpl = fetch }) {
  const installed = readInstalledVersion(target)
  const release = await (await fetchOk(
    fetchImpl, `https://api.github.com/repos/${REPO}/releases/latest`, "最新の Release",
    { accept: "application/vnd.github+json" }
  )).json()
  const latest = String(release.tag_name ?? "").replace(/^v/, "")
  const latestParts = parseVersion(latest)
  // ★ 手元でビルドした同じか新しい版は上書きしない（古いものだけを入れ替える）
  if (installed && compareVersions(parseVersion(installed), latestParts) >= 0) {
    return { status: "current", installed, latest }
  }

  const asset = (release.assets ?? []).find((a) => a.name === ASSET)
  if (!asset) throw new Error(`v${latest} の Release に ${ASSET} がありません`)
  const zip = Buffer.from(await (await fetchOk(fetchImpl, asset.browser_download_url, ASSET)).arrayBuffer())
  const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")
  if (digest && createHash("sha256").update(zip).digest("hex") !== digest[1]) {
    throw new Error("ダウンロードした zip が壊れています（SHA-256 が Release の記載と一致しません）")
  }

  const entries = unzip(zip)
  const manifest = entries.find((e) => e.name === "manifest.json")
  const zipVersion = manifest ? JSON.parse(manifest.data.toString("utf8")).version : null
  if (zipVersion !== latest) throw new Error(`zip の中身が v${latest} ではありません（${zipVersion ?? "manifest.json が無い"}）`)
  installFiles(entries, target)
  return { status: "updated", installed, latest }
}

/** サインイン時に実行されるよう、スタートアップに起動用の .cmd を置く（Windows 専用）。 */
export function installStartup({ startupDir, nodePath = process.execPath, script = SCRIPT }) {
  // .cmd の中では % が変数展開の記号になるので、パスに含まれていたら %% にする
  const quote = (p) => `"${p.replace(/%/g, "%%")}"`
  const file = path.join(startupDir, STARTUP_FILE)
  fs.mkdirSync(startupDir, { recursive: true })
  // chcp 65001: パスに日本語が入っていても、次の行を UTF-8 として読ませる
  fs.writeFileSync(file, ["@echo off", "chcp 65001 >nul", `start "" /min ${quote(nodePath)} ${quote(script)}`, ""].join("\r\n"))
  return file
}

/** 同時に2つ走らないようにする（サインイン時の自動実行と手動の実行が重なったとき）。古い残骸は10分で無視する。 */
function acquireLock(file) {
  try {
    fs.closeSync(fs.openSync(file, "wx"))
    return true
  } catch {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < 10 * 60 * 1000) return false
      fs.rmSync(file)
      fs.closeSync(fs.openSync(file, "wx"))
      return true
    } catch {
      return false
    }
  }
}

async function main(args) {
  const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "DualView")
  fs.mkdirSync(logDir, { recursive: true })
  const say = (message) => {
    console.log(message)
    fs.appendFileSync(path.join(logDir, "auto-update.log"), `${new Date().toISOString()} ${message}\n`)
  }
  const lock = path.join(logDir, "auto-update.lock")
  if (!acquireLock(lock)) {
    say("別の更新が実行中のため、今回は何もしません")
    return 0
  }
  try {
    if (args.includes("--install")) {
      if (process.platform !== "win32" || !process.env.APPDATA) throw new Error("自動更新の登録は Windows でだけ使えます")
      const startupDir = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
      say(`サインイン時の自動更新を登録しました: ${installStartup({ startupDir })}`)
    }
    const result = await update({ target: path.join(ROOT, "build", "chrome-mv3-prod") })
    say(result.status === "updated"
      ? `v${result.latest} を入れました（以前: ${result.installed ? `v${result.installed}` : "なし"}）`
      : `最新です（v${result.installed}）`)
    return 0
  } catch (error) {
    say(`更新できませんでした: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    fs.rmSync(lock, { force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SCRIPT.toLowerCase()) {
  process.exitCode = await main(process.argv.slice(2))
}
