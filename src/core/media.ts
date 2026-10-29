import { stripAnsi } from "./format"
import { tr } from "./i18n"
import { isUrl } from "./urls"

/** The subset of a yt-dlp info dict that fluxware reads. */
export interface YtFormat {
  format_id?: string
  height?: number | null
  vcodec?: string | null
  acodec?: string | null
  ext?: string
}

export interface YtInfo {
  _type?: string
  id?: string
  title?: string
  fulltitle?: string
  uploader?: string
  artist?: string
  channel?: string
  uploader_id?: string
  duration?: number
  thumbnail?: string
  thumbnails?: { url?: string; width?: number; height?: number; preference?: number }[]
  extractor?: string
  extractor_key?: string
  webpage_url?: string
  height?: number | null
  formats?: YtFormat[]
  entries?: unknown[]
  playlist_count?: number
  playlist_title?: string
  playlist_index?: number
  n_entries?: number
  filesize?: number
  filesize_approx?: number
  /** Full path of the output file as yt-dlp prepared it. */
  _filename?: string
  filename?: string
}

export interface MediaInfo {
  url: string
  title: string
  uploader: string
  duration: number
  thumbnail: string | null
  platform: string
  isPlaylist: boolean
  entryCount: number
  /** Distinct video heights, ascending. Empty for audio-only sources. */
  heights: number[]
  maxHeight: number
  /** YouTube returned only the 360p fallback format with muxed audio. */
  fallbackOnly: boolean
  /** yt-dlp warnings that explain missing formats. */
  warnings: string[]
  raw: YtInfo
}

export const STANDARD_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320]

const PLATFORMS: [prefix: string, label: string][] = [
  ["youtube", "YouTube"],
  ["soundcloud", "SoundCloud"],
  ["tiktok", "TikTok"],
  ["instagram", "Instagram"],
  ["vimeo", "Vimeo"],
  ["facebook", "Facebook"],
  ["twitch", "Twitch"],
  ["twitter", "X"],
  ["reddit", "Reddit"],
  ["vk", "VK"],
  ["bandcamp", "Bandcamp"],
  ["generic", "Media"],
]

export function platformName(info: Pick<YtInfo, "extractor_key" | "extractor">): string {
  const raw = info.extractor_key || info.extractor || ""
  const key = raw.toLowerCase()
  for (const [prefix, label] of PLATFORMS) {
    if (key.startsWith(prefix)) return label
  }
  return raw || "Media"
}

export function isYoutubeInfo(info: Pick<YtInfo, "extractor_key" | "extractor">): boolean {
  return (info.extractor_key || info.extractor || "").toLowerCase().includes("youtube")
}

/**
 * Whether the formats include separate video-only streams. Every normal
 * YouTube quality is one (DASH/HLS). Without them YouTube returned only the
 * fallback format 18 with muxed audio.
 */
export function hasSeparateVideoStreams(formats: readonly YtFormat[]): boolean {
  return formats.some((f) => f.vcodec != null && f.vcodec !== "none" && f.acodec === "none")
}

const FORMAT_WARNING_KEYWORDS = ["format", "javascript", "po token", "sabr", "age-restricted"]

/** Keeps the yt-dlp warnings that explain missing formats. */
export function relevantWarnings(warnings: readonly string[], limit = 3): string[] {
  const result: string[] = []
  for (const warning of warnings) {
    const text = stripAnsi(warning).replace(/^WARNING:\s*/i, "").trim()
    const lower = text.toLowerCase()
    if (FORMAT_WARNING_KEYWORDS.some((k) => lower.includes(k)) && !result.includes(text)) result.push(text)
  }
  return result.slice(0, limit)
}

export function videoHeights(formats: readonly YtFormat[]): number[] {
  const heights = new Set<number>()
  for (const f of formats) {
    if (f.height && f.vcodec !== "none") heights.add(f.height)
  }
  return [...heights].sort((a, b) => a - b)
}

/** Picks a small 16:9 preview. YouTube's own default thumbnail has black bars. */
export function previewThumbnail(info: YtInfo): string | null {
  if (isYoutubeInfo(info) && info.id) return `https://i.ytimg.com/vi/${info.id}/mqdefault.jpg`
  const thumbs = (info.thumbnails ?? []).filter((t) => t.url && !/\.(svg)(\?|$)/i.test(t.url))
  const sized = thumbs.filter((t) => t.width && t.width >= 240 && t.width <= 800)
  return sized.at(-1)?.url ?? info.thumbnail ?? thumbs.at(-1)?.url ?? null
}

export function toMediaInfo(url: string, raw: YtInfo, warnings: readonly string[]): MediaInfo {
  const formats = raw.formats ?? []
  const heights = videoHeights(formats)
  const isPlaylist = raw._type === "playlist" || raw._type === "multi_video"
  return {
    url,
    title: raw.title || raw.fulltitle || tr("Без названия", "Untitled"),
    uploader: raw.uploader || raw.artist || raw.channel || "Unknown",
    duration: raw.duration ?? 0,
    thumbnail: previewThumbnail(raw),
    platform: platformName(raw),
    isPlaylist,
    entryCount: raw.playlist_count ?? raw.entries?.length ?? 0,
    heights,
    maxHeight: heights.at(-1) ?? 0,
    fallbackOnly: isYoutubeInfo(raw) && formats.length > 0 && !hasSeparateVideoStreams(formats),
    warnings: relevantWarnings(warnings),
    raw,
  }
}

/**
 * Checks whether a finished video came out worse than it could. Returns the
 * lines of a warning, or null. The Python version once fell back to "/best"
 * silently and gave format 18 (360p) instead of 1080p without a word.
 */
export function describeQualityDrop(
  info: YtInfo | null | undefined,
  resolution: number | null,
  ytdlpWarnings: readonly string[],
  videoFormat: string,
): string[] | null {
  if (!info || info._type === "playlist" || info._type === "multi_video") return null
  const formats = info.formats ?? []
  const got = info.height ?? null
  const heights = formats
    .filter((f) => f.height && f.vcodec != null && f.vcodec !== "none" && (!resolution || f.height <= resolution))
    .map((f) => f.height as number)
  const expected = heights.length ? Math.max(...heights) : 0

  const lines: string[] = []
  if (isYoutubeInfo(info) && formats.length > 0 && !hasSeparateVideoStreams(formats)) {
    lines.push(
      tr(
        `YouTube отдал только запасной формат (${got ?? "?"}p со встроенным звуком): нормальных качеств в ответе не было`,
        `YouTube returned only a fallback format (${got ?? "?"}p with built-in audio): no regular qualities in the response`,
      ),
    )
    for (const w of relevantWarnings(ytdlpWarnings)) lines.push(`yt-dlp: ${w}`)
    lines.push(
      tr(
        'обычно это временно: попробуй позже или обнови yt-dlp (pip install -U "yt-dlp[default]")',
        'this is usually temporary: try later or update yt-dlp (pip install -U "yt-dlp[default]")',
      ),
    )
  } else if (got && expected && got < expected) {
    lines.push(tr(`скачано в ${got}p, хотя доступно ${expected}p`, `downloaded at ${got}p although ${expected}p is available`))
    lines.push(
      tr(
        `в формате ${videoFormat.toUpperCase()} лучше не нашлось: попробуй другой формат видео в настройках`,
        `nothing better in ${videoFormat.toUpperCase()}: try another video format in the settings`,
      ),
    )
  }
  return lines.length ? lines : null
}

export interface DownloadLabel {
  platform: string
  title: string
  author: string | null
}

const TCO_LINK_RE = /https?:\/\/t\.co\/\S+/gi

/**
 * History label of a download:
 * - usual case:            [YouTube] Title — Channel
 * - X post without text:   [X] видео от @handle (id)
 * - X post with text:      [X] Text — @handle (id)
 */
export function downloadLabel(info: YtInfo): DownloadLabel {
  const title = (info.title || tr("Без названия", "Untitled")).trim()
  const uploader = (info.uploader || info.artist || info.channel || "Unknown").trim()
  const extractor = (info.extractor_key || info.extractor || "").toLowerCase()

  if (extractor.includes("twitter")) {
    const handle = (info.uploader_id || "").replace(/^@/, "").trim() || uploader.toLowerCase().replace(/\s+/g, "")
    // yt-dlp puts the post text into the title. Without its t.co media link
    // nothing may be left, which means a post without a caption.
    const caption = title.replace(TCO_LINK_RE, "").replace(/\s+/g, " ").trim()
    const name = `@${handle} (${String(info.id ?? "").trim()})`
    if (caption && !isUrl(caption)) return { platform: "X", title: caption, author: name }
    return { platform: "X", title: tr(`видео от ${name}`, `video by ${name}`), author: null }
  }

  return { platform: platformName(info), title, author: uploader }
}

export function labelText(label: DownloadLabel): string {
  return `[${label.platform}] ${label.title}${label.author ? ` — ${label.author}` : ""}`
}
