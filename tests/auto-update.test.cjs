const assert = require("node:assert/strict")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { test } = require("node:test")
const { pathToFileURL } = require("node:url")
const { deflateRawSync } = require("node:zlib")

// The real updater module; only the network (GitHub) is replaced with an in-memory fake.
const load = () => import(pathToFileURL(path.join(__dirname, "..", "scripts", "auto-update.mjs")).href)

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")
const manifest = (version) => JSON.stringify({ manifest_version: 3, name: "DualView for YouTube", version })

/** A minimal zip writer: [name, content, method] with method 8 (deflate, as plasmo package writes) or 0 (stored). */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content, method = 8] of files) {
    const data = Buffer.from(content)
    const body = method === 8 ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function fakeGitHub({ tag, zip, digest = `sha256:${sha256(zip)}` }) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith("/releases/latest")) {
      return {
        ok: true, status: 200,
        json: async () => ({ tag_name: tag, assets: [{ name: "chrome-mv3-prod.zip", browser_download_url: "https://example.test/chrome-mv3-prod.zip", digest }] })
      }
    }
    return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) }
  }
  return { fetchImpl, downloads: () => calls.filter((url) => !url.endsWith("/releases/latest")).length }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualview-update-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The installed folder as { "relative/path": "content" }. */
function snapshot(dir) {
  const files = {}
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else files[path.relative(dir, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8")
    }
  }
  walk(dir)
  return files
}

function installBuild(target, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true })
    fs.writeFileSync(path.join(target, name), content)
  }
}

test("a newer release replaces the installed build in place, manifest.json last, and drops files it no longer has", async (t) => {
  const { update } = await load()
  const target = path.join(tempDir(t), "chrome-mv3-prod")
  installBuild(target, { "manifest.json": manifest("0.1.6"), "tabs/popout.html": "old popout", "old-only.js": "stale" })
  const zip = makeZip([
    ["manifest.json", manifest("0.1.7")],
    ["tabs/", ""],
    ["tabs/popout.html", "new popout"],
    ["youtube-main.js", "new content script", 0]
  ])
  const github = fakeGitHub({ tag: "v0.1.7", zip })

  const written = []
  const writeFileSync = fs.writeFileSync
  fs.writeFileSync = (file, ...rest) => { written.push(path.basename(String(file))); return writeFileSync(file, ...rest) }
  t.after(() => { fs.writeFileSync = writeFileSync })
  const result = await update({ target, fetchImpl: github.fetchImpl })
  fs.writeFileSync = writeFileSync

  assert.deepEqual(result, { status: "updated", installed: "0.1.6", latest: "0.1.7" })
  assert.deepEqual(snapshot(target), {
    "manifest.json": manifest("0.1.7"),
    "tabs/popout.html": "new popout",
    "youtube-main.js": "new content script"
  })
  assert.equal(written.at(-1), "manifest.json", "the browser only switches once every file it points to is in place")
})

test("nothing is downloaded when the same or a newer build is installed, so a local build is never downgraded", async (t) => {
  const { update } = await load()
  for (const installed of ["0.1.7", "0.2.0", "0.1.10"]) {
    const target = path.join(tempDir(t), "chrome-mv3-prod")
    installBuild(target, { "manifest.json": manifest(installed) })
    const github = fakeGitHub({ tag: "v0.1.7", zip: makeZip([["manifest.json", manifest("0.1.7")]]) })
    assert.equal((await update({ target, fetchImpl: github.fetchImpl })).status, "current", installed)
    assert.equal(github.downloads(), 0)
    assert.deepEqual(snapshot(target), { "manifest.json": manifest(installed) })
  }
})

test("an empty or missing folder gets the release", async (t) => {
  const { update } = await load()
  const target = path.join(tempDir(t), "chrome-mv3-prod")
  const github = fakeGitHub({ tag: "v0.1.7", zip: makeZip([["manifest.json", manifest("0.1.7")]]) })
  assert.deepEqual(await update({ target, fetchImpl: github.fetchImpl }), { status: "updated", installed: null, latest: "0.1.7" })
  assert.deepEqual(snapshot(target), { "manifest.json": manifest("0.1.7") })
})

test("broken or unexpected downloads are refused and leave the installed build untouched", async (t) => {
  const { update } = await load()
  const cases = {
    "checksum mismatch": { tag: "v0.1.7", zip: makeZip([["manifest.json", manifest("0.1.7")]]), digest: `sha256:${"0".repeat(64)}` },
    "path outside the folder": { tag: "v0.1.7", zip: makeZip([["manifest.json", manifest("0.1.7")], ["../outside.js", "x"]]) },
    "absolute path": { tag: "v0.1.7", zip: makeZip([["manifest.json", manifest("0.1.7")], ["C:/outside.js", "x"]]) },
    "zip of another version": { tag: "v0.1.8", zip: makeZip([["manifest.json", manifest("0.1.7")]]) }
  }
  for (const [label, release] of Object.entries(cases)) {
    const dir = tempDir(t)
    const target = path.join(dir, "chrome-mv3-prod")
    installBuild(target, { "manifest.json": manifest("0.1.6"), "youtube-main.js": "old" })
    await assert.rejects(update({ target, fetchImpl: fakeGitHub(release).fetchImpl }), Error, label)
    assert.deepEqual(snapshot(target), { "manifest.json": manifest("0.1.6"), "youtube-main.js": "old" }, label)
    assert.equal(fs.existsSync(path.join(dir, "outside.js")), false, label)
  }
})

// 展開の上限（maxOutputLength）を入れたことで、普通の中身まで弾かないことを確かめる。
// 空ファイルは申告サイズが0になるため、上限の扱いを間違えると真っ先に壊れる。
test("files of every size install, including empty ones, with the inflate cap in place", async (t) => {
  const { update } = await load()
  const target = path.join(tempDir(t), "chrome-mv3-prod")
  const files = [
    ["manifest.json", manifest("0.1.7")],
    ["empty.js", ""],
    ["tiny.js", "x"],
    ["big.js", "y".repeat(200_000)], // よく縮むので、圧縮後より展開後がずっと大きい
    ["stored.css", "body{}", 0]
  ]
  await update({ target, fetchImpl: fakeGitHub({ tag: "v0.1.7", zip: makeZip(files) }).fetchImpl })
  assert.deepEqual(snapshot(target), Object.fromEntries(files.map(([name, content]) => [name, content])))
})

test("versions compare by number, not by text", async () => {
  const { compareVersions, parseVersion } = await load()
  assert.deepEqual(parseVersion("v0.1.7"), [0, 1, 7])
  assert.equal(compareVersions(parseVersion("0.1.10"), parseVersion("0.1.9")), 1)
  assert.equal(compareVersions(parseVersion("0.1.7"), parseVersion("v0.1.7")), 0)
  assert.throws(() => parseVersion("latest"))
})

test("the sign-in launcher starts node minimized with both paths quoted and is read as UTF-8", async (t) => {
  const { installStartup } = await load()
  const startupDir = tempDir(t)
  const file = installStartup({
    startupDir,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    script: "C:\\Users\\me\\Desktop\\個人開発物\\100%\\youtube-dualview\\scripts\\auto-update.mjs"
  })
  assert.equal(path.basename(file), "DualView auto-update.cmd")
  assert.deepEqual(fs.readFileSync(file, "utf8").split("\r\n"), [
    "@echo off",
    "chcp 65001 >nul",
    'start "" /min "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\Desktop\\個人開発物\\100%%\\youtube-dualview\\scripts\\auto-update.mjs"',
    ""
  ])
})
