import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type VideoFormat = "mp4" | "webm" | "mkv"
export type AudioFormat = "opus" | "mp3" | "m4a"

export const VIDEO_FORMATS: readonly VideoFormat[] = ["mp4", "webm", "mkv"]
export const AUDIO_FORMATS: readonly AudioFormat[] = ["opus", "mp3", "m4a"]
export const MAX_CONCURRENCY = 4

export interface Settings {
  videoFormat: VideoFormat
  audioFormat: AudioFormat
  /** null means the default folder (~/Videos). */
  videoDir: string | null
  /** null means the default folder (~/Music). */
  audioDir: string | null
  /** Extra yt-dlp options, command-line style. They override fluxware's own. */
  ytdlpArgs: string
  /** How many downloads run at the same time. */
  concurrency: number
  /** Show cover previews (Kitty, Sixel, or block graphics). */
  thumbnails: boolean
  /** Write finished downloads to the history log. */
  history: boolean
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  videoFormat: "mp4",
  audioFormat: "opus",
  videoDir: null,
  audioDir: null,
  ytdlpArgs: "",
  concurrency: 1,
  thumbnails: true,
  history: true,
}

export function configPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "fluxware", "config.json")
  if (platform === "darwin") return join(home, "Library", "Application Support", "fluxware", "config.json")
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "fluxware", "config.json")
}

/** Settings file of the Python version of fluxware. */
export function legacyConfigPath(home = homedir()): string {
  return join(home, ".fluxware_config.json")
}

export function defaultVideoDir(home = homedir()): string {
  return join(home, "Videos")
}

export function defaultAudioDir(home = homedir()): string {
  return join(home, "Music")
}

export function videoDirOf(settings: Settings, home = homedir()): string {
  return settings.videoDir ?? defaultVideoDir(home)
}

export function audioDirOf(settings: Settings, home = homedir()): string {
  return settings.audioDir ?? defaultAudioDir(home)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function dirOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** Fills missing or invalid fields with defaults. */
export function normalizeSettings(raw: unknown): Settings {
  const r = isRecord(raw) ? raw : {}
  const concurrency = typeof r.concurrency === "number" ? Math.round(r.concurrency) : DEFAULT_SETTINGS.concurrency
  return {
    videoFormat: pick(r.videoFormat, VIDEO_FORMATS, DEFAULT_SETTINGS.videoFormat),
    audioFormat: pick(r.audioFormat, AUDIO_FORMATS, DEFAULT_SETTINGS.audioFormat),
    videoDir: dirOrNull(r.videoDir),
    audioDir: dirOrNull(r.audioDir),
    ytdlpArgs: typeof r.ytdlpArgs === "string" ? r.ytdlpArgs : DEFAULT_SETTINGS.ytdlpArgs,
    concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, concurrency || 1)),
    thumbnails: typeof r.thumbnails === "boolean" ? r.thumbnails : DEFAULT_SETTINGS.thumbnails,
    history: typeof r.history === "boolean" ? r.history : DEFAULT_SETTINGS.history,
  }
}

/**
 * Converts the Python version's settings. Its single download folder held
 * "video" and "audio" subfolders; they become the two separate folders.
 */
export function migrateLegacy(raw: unknown): Settings {
  const r = isRecord(raw) ? raw : {}
  const base = dirOrNull(r.custom_download_path)
  return normalizeSettings({
    videoFormat: r.video_format,
    audioFormat: r.audio_format,
    videoDir: base ? join(base, "video") : null,
    audioDir: base ? join(base, "audio") : null,
    ytdlpArgs: r.custom_ytdlp_args,
  })
}

type Listener = () => void

export class SettingsStore {
  private settings: Settings
  private listeners = new Set<Listener>()
  /** Set when the file existed but could not be read. */
  readonly loadError: string | null = null
  /** True when settings were carried over from the Python version. */
  readonly migrated: boolean = false

  constructor(
    readonly path: string = configPath(),
    legacyPath: string | null = legacyConfigPath(),
  ) {
    let settings: Settings = { ...DEFAULT_SETTINGS }
    if (existsSync(path)) {
      try {
        settings = normalizeSettings(JSON.parse(readFileSync(path, "utf8")))
      } catch (error) {
        this.loadError = `не удалось прочитать настройки: ${error instanceof Error ? error.message : String(error)}`
      }
    } else if (legacyPath && existsSync(legacyPath)) {
      try {
        settings = migrateLegacy(JSON.parse(readFileSync(legacyPath, "utf8")))
        this.migrated = true
      } catch {
        // A broken legacy file is not worth an error: start from defaults.
      }
    }
    this.settings = settings
    if (this.migrated) this.save()
  }

  get = (): Settings => this.settings

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(patch: Partial<Settings>): void {
    this.settings = normalizeSettings({ ...this.settings, ...patch })
    this.save()
    for (const listener of this.listeners) listener()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.settings, null, 2) + "\n", "utf8")
      renameSync(tmp, this.path)
    } catch {
      // Settings stay in memory for this session even if the disk is read-only.
    }
  }
}
