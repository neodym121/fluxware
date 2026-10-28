import { stripAnsi } from "./format"
import { toMediaInfo, type MediaInfo, type YtInfo } from "./media"
import { captureOutput, runProcess } from "./process"
import type { AudioFormat, VideoFormat } from "./settings"
import { isYoutubeUrl } from "./urls"

export interface YtDlpCommand {
  command: string
  /** Arguments before yt-dlp's own, such as ["-m", "yt_dlp"] for Python. */
  prefix: string[]
  version: string
}

export interface Tools {
  ytdlp: YtDlpCommand | null
  ffmpeg: string | null
  /** JavaScript runtimes on PATH. yt-dlp solves YouTube's JS challenges with them. */
  jsRuntimes: string[]
}

type Which = (name: string) => string | null

/**
 * Finds yt-dlp: the executable on PATH first, then the Python module. The
 * Python version imported yt_dlp, so its users often have only the module.
 */
export async function detectTools(which: Which = (name) => Bun.which(name)): Promise<Tools> {
  const candidates: { command: string; prefix: string[] }[] = []
  const exe = which("yt-dlp")
  if (exe) candidates.push({ command: exe, prefix: [] })
  for (const python of ["python", "python3", "py"]) {
    const path = which(python)
    if (path) candidates.push({ command: path, prefix: ["-m", "yt_dlp"] })
  }

  let ytdlp: YtDlpCommand | null = null
  for (const candidate of candidates) {
    const version = await captureOutput(candidate.command, [...candidate.prefix, "--version"])
    if (version && /^\d{4}\.\d{2}\.\d{2}/.test(version)) {
      ytdlp = { ...candidate, version: version.split(/\s+/)[0] ?? version }
      break
    }
  }

  // deno is enabled by default; node has to be enabled explicitly.
  const jsRuntimes = ["deno", "node"].filter((name) => which(name))
  return { ytdlp, ffmpeg: which("ffmpeg"), jsRuntimes }
}

export async function ffmpegVersion(ffmpeg: string): Promise<string | null> {
  const out = await captureOutput(ffmpeg, ["-version"], 5000)
  const match = out?.match(/ffmpeg version (\S+)/)
  return match?.[1] ?? null
}

/**
 * Splits a command line into arguments. Quotes group words. A backslash
 * escapes only quotes and spaces, so Windows paths such as C:\Videos survive.
 */
export function splitArgs(input: string): { args: string[]; error: string | null } {
  const args: string[] = []
  let current = ""
  let inToken = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    const next = input[i + 1]
    if (ch === "\\" && next !== undefined && (next === '"' || next === "'" || next === " ") && quote !== "'") {
      current += next
      inToken = true
      i++
    } else if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) args.push(current)
      current = ""
      inToken = false
    } else {
      current += ch
      inToken = true
    }
  }
  if (quote) return { args: [], error: "не закрыта кавычка" }
  if (inToken) args.push(current)
  return { args, error: null }
}

export interface ArgsCheck {
  ok: boolean
  error: string | null
  /** Number of options found, counted by their leading dash. */
  optionCount: number
}

/**
 * Checks custom options by running yt-dlp without a URL. It parses and
 * validates every option first, then complains about the missing URL; any
 * other complaint is about the options.
 */
export async function checkCustomArgs(ytdlp: YtDlpCommand, raw: string): Promise<ArgsCheck> {
  const { args, error } = splitArgs(raw)
  if (error) return { ok: false, error, optionCount: 0 }
  const optionCount = args.filter((a) => a.startsWith("-")).length
  if (args.length === 0) return { ok: true, error: null, optionCount }

  const stderr: string[] = []
  await runProcess(ytdlp.command, [...ytdlp.prefix, "--ignore-config", ...args], {
    onStderrLine: (line) => stderr.push(stripAnsi(line)),
  })
  const message = stderr.map((l) => l.match(/error:\s*(.+)$/i)?.[1]).find(Boolean)
  if (!message || /must provide at least one URL/i.test(message)) return { ok: true, error: null, optionCount }
  return { ok: false, error: message, optionCount }
}

function commonArgs(jsRuntimes: readonly string[]): string[] {
  const args = ["--ignore-config", "--no-playlist"]
  for (const runtime of jsRuntimes) if (runtime !== "deno") args.push("--js-runtimes", runtime)
  return args
}

export interface InfoResult {
  info: MediaInfo | null
  error: string | null
  aborted: boolean
}

export async function fetchInfo(
  ytdlp: YtDlpCommand,
  url: string,
  opts: { jsRuntimes: readonly string[]; customArgs: readonly string[]; signal?: AbortSignal },
): Promise<InfoResult> {
  const stdout: string[] = []
  const warnings: string[] = []
  let error: string | null = null
  const result = await runProcess(
    ytdlp.command,
    [...ytdlp.prefix, ...commonArgs(opts.jsRuntimes), "--flat-playlist", "-J", ...opts.customArgs, "--", url],
    {
      signal: opts.signal,
      onStdoutLine: (line) => stdout.push(line),
      onStderrLine: (raw) => {
        const line = stripAnsi(raw)
        if (line.startsWith("WARNING:")) warnings.push(line)
        else if (line.startsWith("ERROR:")) error = cleanError(line)
      },
    },
  )
  if (result.aborted) return { info: null, error: null, aborted: true }

  const json = stdout.find((line) => line.startsWith("{"))
  if (result.code !== 0 || !json) {
    return { info: null, error: error ?? "yt-dlp не вернул информацию", aborted: false }
  }
  try {
    return { info: toMediaInfo(url, JSON.parse(json) as YtInfo, warnings), error: null, aborted: false }
  } catch {
    return { info: null, error: "не удалось разобрать ответ yt-dlp", aborted: false }
  }
}

/** "ERROR: [youtube] abc: Video unavailable" → "Video unavailable". */
export function cleanError(line: string): string {
  return stripAnsi(line)
    .replace(/^ERROR:\s*/, "")
    .replace(/^\[[^\]]+\]\s*(?:[\w-]+:\s+)?/, "")
    .trim()
}

// The square crop runs inside ffmpeg while yt-dlp converts the cover to JPEG,
// before EmbedThumbnail writes it into the file. YouTube previews are 16:9.
const SQUARE_COVER_PPA =
  "ThumbnailsConvertor+ffmpeg_o:-c:v mjpeg -qmin 1 -qscale:v 1 -vf crop=\"'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'\""

export const PROGRESS_PREFIX = "FLUXPROG "
export const POSTPROCESS_PREFIX = "FLUXPP "
export const FILE_PREFIX = "FLUXFILE "

const REPORTING_ARGS = [
  "-j",
  "--no-simulate",
  "--newline",
  "--progress",
  "--progress-template",
  `download:${PROGRESS_PREFIX}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.vcodec)s|%(info.acodec)s|%(progress.filename)j`,
  "--progress-template",
  `postprocess:${POSTPROCESS_PREFIX}%(progress.status)s|%(progress.postprocessor)s`,
  "--print",
  `after_move:${FILE_PREFIX}%(filepath)j`,
]

/**
 * Prefers separate tracks in the chosen container, then any single file
 * under the height cap. The last resort ignores the cap, and the quality
 * check reports it afterwards.
 */
export function videoFormatSelector(format: VideoFormat, height: number | null): string {
  const h = height ? `[height<=${height}]` : ""
  const parts =
    format === "mkv"
      ? [`bv${h}+ba`, `b${h}`, "b"]
      : [`bv${h}[ext=${format}]+ba[ext=${format === "mp4" ? "m4a" : "webm"}]`, `bv${h}[ext=${format}]+ba`, `b${h}[ext=${format}]`, `b${h}`, "b"]
  return [...new Set(parts)].join("/")
}

export function audioArgs(format: AudioFormat, url: string): string[] {
  const youtube = isYoutubeUrl(url)
  let selector: string
  let quality: string
  switch (format) {
    case "opus":
      // YouTube serves Opus natively: ExtractAudio only changes the container.
      selector = youtube ? "ba[ext=webm][acodec=opus]/ba[acodec=opus]/ba/b" : "ba/b"
      quality = youtube ? "0" : "192K"
      break
    case "m4a":
      selector = "ba[ext=m4a]/ba/b"
      quality = youtube ? "0" : "192K"
      break
    case "mp3":
      selector = "ba/b"
      quality = "192K"
      break
  }
  return [
    "-f", selector,
    "-x", "--audio-format", format, "--audio-quality", quality,
    "--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg",
    "--ppa", SQUARE_COVER_PPA,
  ]
}

export interface DownloadSpec {
  url: string
  kind: "video" | "audio"
  height: number | null
  dir: string
  videoFormat: VideoFormat
  audioFormat: AudioFormat
}

export function downloadArgs(spec: DownloadSpec, opts: { jsRuntimes: readonly string[]; customArgs: readonly string[] }): string[] {
  const media =
    spec.kind === "audio"
      ? audioArgs(spec.audioFormat, spec.url)
      : ["-f", videoFormatSelector(spec.videoFormat, spec.height), "--merge-output-format", spec.videoFormat]
  return [
    ...commonArgs(opts.jsRuntimes),
    ...REPORTING_ARGS,
    "-P", spec.dir,
    "-o", "%(title)s.%(ext)s",
    ...media,
    ...opts.customArgs,
    "--",
    spec.url,
  ]
}

export type YtEvent =
  | { type: "info"; info: YtInfo }
  | {
      type: "progress"
      status: string
      downloaded: number | null
      total: number | null
      speed: number | null
      eta: number | null
      fragmentIndex: number | null
      fragmentCount: number | null
      stream: "video" | "audio" | "both" | null
      /** The file this stream downloads into; its .part sits next to it. */
      file: string | null
    }
  | { type: "postprocess"; status: string; name: string }
  | { type: "file"; path: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string }
  | { type: "other"; line: string }

function num(value: string | undefined): number | null {
  if (value === undefined || value === "NA" || value === "None" || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function streamOf(vcodec: string | undefined, acodec: string | undefined): "video" | "audio" | "both" | null {
  const hasVideo = !!vcodec && vcodec !== "none" && vcodec !== "NA"
  const hasAudio = !!acodec && acodec !== "none" && acodec !== "NA"
  if (hasVideo && hasAudio) return "both"
  if (hasVideo) return "video"
  if (hasAudio) return "audio"
  return null
}

/** Parses one line of yt-dlp output produced with the reporting arguments. */
export function parseLine(raw: string): YtEvent {
  const line = stripAnsi(raw)
  if (line.startsWith("{")) {
    try {
      return { type: "info", info: JSON.parse(line) as YtInfo }
    } catch {
      return { type: "other", line }
    }
  }
  if (line.startsWith(PROGRESS_PREFIX)) {
    const fields = line.slice(PROGRESS_PREFIX.length).split("|")
    const [status = "", downloaded, total, estimate, speed, eta, fragIndex, fragCount, vcodec, acodec] = fields
    // The file name is last and JSON-encoded, so a "|" inside it cannot shift the fields.
    let file: string | null = null
    try {
      const parsed = JSON.parse(fields.slice(10).join("|"))
      if (typeof parsed === "string" && parsed) file = parsed
    } catch {
      file = null
    }
    return {
      type: "progress",
      status,
      downloaded: num(downloaded),
      total: num(total) ?? num(estimate),
      speed: num(speed),
      eta: num(eta),
      fragmentIndex: num(fragIndex),
      fragmentCount: num(fragCount),
      stream: streamOf(vcodec, acodec),
      file,
    }
  }
  if (line.startsWith(POSTPROCESS_PREFIX)) {
    const [status = "", name = ""] = line.slice(POSTPROCESS_PREFIX.length).split("|")
    return { type: "postprocess", status, name }
  }
  if (line.startsWith(FILE_PREFIX)) {
    try {
      return { type: "file", path: JSON.parse(line.slice(FILE_PREFIX.length)) as string }
    } catch {
      return { type: "file", path: line.slice(FILE_PREFIX.length).trim() }
    }
  }
  if (line.startsWith("WARNING:")) return { type: "warning", message: line.replace(/^WARNING:\s*/, "") }
  if (line.startsWith("ERROR:")) return { type: "error", message: cleanError(line) }
  return { type: "other", line }
}

const POSTPROCESSOR_NAMES: Record<string, string> = {
  Merger: "склейка дорожек",
  ExtractAudio: "извлечение звука",
  ThumbnailsConvertor: "обложка",
  EmbedThumbnail: "вшивание обложки",
  Metadata: "метаданные",
  FFmpegMetadata: "метаданные",
  VideoConvertor: "конвертация",
  VideoRemuxer: "перепаковка",
  MoveFiles: "перенос файла",
  FixupM3u8: "исправление потока",
  FixupM4a: "исправление контейнера",
  FixupDuplicateMoov: "исправление контейнера",
  FixupTimestamp: "исправление таймингов",
}

export function postprocessorLabel(name: string): string {
  return POSTPROCESSOR_NAMES[name] ?? name
}
