import { tr } from "./i18n"

const UNITS_RU = ["Б", "КБ", "МБ", "ГБ", "ТБ"]
const UNITS_EN = ["B", "KB", "MB", "GB", "TB"]

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—"
  const units = tr("ru", "en") === "ru" ? UNITS_RU : UNITS_EN
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ""
  return `${formatBytes(bytesPerSecond)}${tr("/с", "/s")}`
}

/** 75 → "01:15", 3725 → "1:02:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "--:--"
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max))
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

/** Shortens a path from the middle so both the drive and the last folder stay visible. */
export function truncatePath(path: string, max: number): string {
  if (path.length <= max) return path
  const keepEnd = Math.ceil((max - 1) * 0.6)
  const keepStart = max - 1 - keepEnd
  return path.slice(0, keepStart) + "…" + path.slice(path.length - keepEnd)
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}
