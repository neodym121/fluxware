import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Job, JobKind } from "./queue"
import { configPath } from "./settings"

/** One finished download, one JSON line in the history log. */
export interface HistoryEntry {
  id: string
  /** ISO time when the download finished. */
  time: string
  url: string
  kind: JobKind
  height: number | null
  format: string
  platform: string
  title: string
  author: string | null
  files: string[]
  dir: string
}

export function historyPath(config = configPath()): string {
  return join(dirname(config), "history.jsonl")
}

export function entryFromJob(job: Job, now = new Date()): HistoryEntry {
  return {
    id: `${now.getTime().toString(36)}-${job.id}`,
    time: now.toISOString(),
    url: job.url,
    kind: job.kind,
    height: job.height,
    format: job.kind === "audio" ? job.audioFormat : job.videoFormat,
    platform: job.label?.platform ?? (job.kind === "audio" ? "аудио" : "видео"),
    title: job.label?.title ?? job.url,
    author: job.label?.author ?? null,
    files: job.files,
    dir: job.dir,
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === "string" && typeof v.time === "string" && typeof v.url === "string" && typeof v.title === "string"
}

/**
 * The download history. Entries always live in memory for the session; they
 * reach the log file only while logging is on in the settings.
 */
export class HistoryStore {
  private entries: HistoryEntry[] = []
  private persisted = new Set<string>()
  private listeners = new Set<() => void>()

  constructor(
    readonly path: string,
    private readonly logging: () => boolean,
  ) {
    if (!existsSync(path)) return
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (isEntry(entry)) {
            this.entries.push({ ...entry, files: Array.isArray(entry.files) ? entry.files : [] })
            this.persisted.add(entry.id)
          }
        } catch {
          // A torn last line after a crash; skip it.
        }
      }
    } catch {
      // Unreadable log: start empty, keep the file as it is.
    }
  }

  /** Oldest first. */
  getSnapshot = (): readonly HistoryEntry[] => this.entries

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  add(entry: HistoryEntry): void {
    this.entries = [...this.entries, entry]
    if (this.logging()) {
      try {
        mkdirSync(dirname(this.path), { recursive: true })
        appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8")
        this.persisted.add(entry.id)
      } catch {
        // The entry stays in memory for this session.
      }
    }
    this.emit()
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.persisted.delete(id)) {
      try {
        const kept = this.entries.filter((e) => this.persisted.has(e.id))
        writeFileSync(this.path, kept.map((e) => JSON.stringify(e) + "\n").join(""), "utf8")
      } catch {
        // Removal still applies on screen.
      }
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function dayLabel(date: Date, now = new Date()): string {
  const base = `${date.getDate()} ${MONTHS[date.getMonth()]}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayKey(date) === dayKey(now)) return `сегодня · ${base}`
  if (dayKey(date) === dayKey(yesterday)) return `вчера · ${base}`
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`
}

export function timeLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export interface HistoryDay {
  key: string
  label: string
  /** Newest first. */
  entries: HistoryEntry[]
}

/** Groups entries by local day, newest day and newest entry first. */
export function groupByDay(entries: readonly HistoryEntry[], now = new Date()): HistoryDay[] {
  const days = new Map<string, HistoryDay>()
  const sorted = [...entries].sort((a, b) => b.time.localeCompare(a.time))
  for (const entry of sorted) {
    const date = new Date(entry.time)
    const key = dayKey(date)
    let day = days.get(key)
    if (!day) {
      day = { key, label: dayLabel(date, now), entries: [] }
      days.set(key, day)
    }
    day.entries.push(entry)
  }
  return [...days.values()]
}
