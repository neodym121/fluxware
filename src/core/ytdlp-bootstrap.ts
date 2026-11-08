import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { tr } from "./i18n"
import { captureOutput } from "./process"

const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases/latest/download"

/** Directory for files fluxware provides for itself, such as its own yt-dlp. */
export function managedBinDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "fluxware", "bin")
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "fluxware", "bin")
}

export function managedYtdlpPath(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
): string {
  return join(managedBinDir(env, platform, home), platform === "win32" ? "yt-dlp.exe" : "yt-dlp")
}

/** A musl loader means the glibc build of yt-dlp will not run. */
export function hasMuslLibc(exists: (path: string) => boolean = (path) => existsSync(path)): boolean {
  return exists("/lib/ld-musl-x86_64.so.1") || exists("/lib/ld-musl-aarch64.so.1")
}

/**
 * Release assets worth trying, best first. yt-dlp ships self-contained builds
 * that need no Python, which is the whole point of using them here.
 */
export function ytdlpAssets(
  platform = process.platform,
  arch = process.arch,
  musl = platform === "linux" && hasMuslLibc(),
): string[] {
  if (platform === "win32") return arch === "ia32" ? ["yt-dlp_x86.exe"] : ["yt-dlp.exe"]
  if (platform !== "linux") return []
  if (arch === "arm64") return musl ? ["yt-dlp_musllinux_aarch64"] : ["yt-dlp_linux_aarch64", "yt-dlp_musllinux_aarch64"]
  if (arch === "ia32" || arch === "arm") return []
  return musl ? ["yt-dlp_musllinux"] : ["yt-dlp_linux", "yt-dlp_musllinux"]
}

export interface InstallOptions {
  target: string
  assets?: string[]
  /** Called with progress text for the interface. */
  onStatus?: (message: string) => void
  fetchBytes?: (url: string, onProgress: (fraction: number | null) => void) => Promise<Uint8Array>
  /** Returns the version of a downloaded file, or null when it does not run. */
  verify?: (file: string) => Promise<string | null>
  timeoutMs?: number
}

export interface InstallResult {
  ok: boolean
  version: string | null
  error: string | null
}

async function fetchBytes(
  url: string,
  timeoutMs: number,
  onProgress: (fraction: number | null) => void,
): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get("content-length") ?? 0)
    if (!response.body) {
      const whole = new Uint8Array(await response.arrayBuffer())
      onProgress(1)
      return whole
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    let lastPercent = -1
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      received += value.length
      const percent = total ? Math.floor((received / total) * 100) : -1
      if (percent !== lastPercent) {
        lastPercent = percent
        onProgress(total ? received / total : null)
      }
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    onProgress(1)
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

async function verifyWithYtdlp(file: string): Promise<string | null> {
  const version = await captureOutput(file, ["--version"], 60000)
  return version && /^\d{4}\.\d{2}\.\d{2}/.test(version) ? (version.split(/\s+/)[0] ?? null) : null
}

/**
 * Downloads a standalone yt-dlp into `target` and checks that it runs, so a
 * wrong build (glibc on musl, wrong architecture) is retried with the next
 * asset instead of being left behind as a broken file.
 */
export async function installYtdlp(options: InstallOptions): Promise<InstallResult> {
  const assets = options.assets ?? ytdlpAssets()
  if (assets.length === 0) {
    return { ok: false, version: null, error: tr("для этой платформы нет готовой сборки yt-dlp", "no prebuilt yt-dlp for this platform") }
  }

  const fetchFile =
    options.fetchBytes ?? ((url: string, onProgress: (fraction: number | null) => void) => fetchBytes(url, options.timeoutMs ?? 180000, onProgress))
  const verify = options.verify ?? verifyWithYtdlp
  // Windows refuses to start a file without an executable extension.
  const temp = `${options.target}.download${process.platform === "win32" ? ".exe" : ""}`
  let error: string | null = null

  try {
    mkdirSync(dirname(options.target), { recursive: true })
  } catch (mkdirError) {
    return { ok: false, version: null, error: mkdirError instanceof Error ? mkdirError.message : String(mkdirError) }
  }

  for (const asset of assets) {
    const label = `${tr("скачиваю yt-dlp", "downloading yt-dlp")} (${asset})`
    options.onStatus?.(`${label}…`)
    try {
      const bytes = await fetchFile(`${RELEASES}/${asset}`, (fraction) => {
        if (fraction === null) return
        options.onStatus?.(`${label}… ${Math.round(fraction * 100)}%`)
      })
      writeFileSync(temp, bytes)
      chmodSync(temp, 0o755)
      const version = await verify(temp)
      if (!version) throw new Error(tr("скачанный файл не запускается", "the downloaded file does not run"))
      rmSync(options.target, { force: true })
      renameSync(temp, options.target)
      chmodSync(options.target, 0o755)
      return { ok: true, version, error: null }
    } catch (assetError) {
      error = assetError instanceof Error ? assetError.message : String(assetError)
      rmSync(temp, { force: true })
    }
  }

  return { ok: false, version: null, error }
}
