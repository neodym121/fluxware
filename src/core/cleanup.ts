import { readdir, stat, unlink } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"

const THUMBNAIL_EXTS = [".jpg", ".jpeg", ".webp", ".png", ".image"]
const MEDIA_EXTS = [".mp4", ".webm", ".mkv", ".mov", ".m4a", ".opus", ".ogg", ".mp3", ".flac", ".wav"]

/**
 * Names a canceled yt-dlp run can leave behind: each stream file with its
 * .part, .ytdl and -Frag pieces, and around the output name the cover,
 * converted or merged files, and their .temp versions.
 */
export async function leftoverCandidates(streams: Iterable<string>, outputs: Iterable<string>): Promise<string[]> {
  const candidates = new Set<string>()
  const fragments: { dir: string; prefix: string }[] = []
  for (const file of streams) {
    candidates.add(file)
    candidates.add(`${file}.part`)
    candidates.add(`${file}.ytdl`)
    fragments.push({ dir: dirname(file), prefix: `${basename(file)}.part-Frag` })
  }
  for (const output of outputs) {
    const base = output.slice(0, output.length - extname(output).length)
    for (const ext of [...THUMBNAIL_EXTS, ...MEDIA_EXTS]) {
      candidates.add(base + ext)
      candidates.add(`${base}.temp${ext}`)
      candidates.add(`${base}${ext}.part`)
    }
    candidates.add(`${output}.part`)
    candidates.add(`${output}.ytdl`)
  }
  for (const { dir, prefix } of fragments) {
    try {
      for (const name of await readdir(dir)) if (name.startsWith(prefix)) candidates.add(join(dir, name))
    } catch {
      // The folder may not exist yet.
    }
  }
  return [...candidates]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Deletes the candidates that this run created: a file older than `since`
 * was there before, for example the same video downloaded earlier, and stays.
 * Windows keeps a killed process's files locked for a moment, so each delete
 * is retried a few times.
 */
export async function removeLeftovers(paths: readonly string[], since: number, attempts = 8): Promise<string[]> {
  const removed: string[] = []
  for (const path of paths) {
    let created: number
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      created = info.birthtimeMs || info.ctimeMs
    } catch {
      continue
    }
    if (created < since - 2000) continue
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await unlink(path)
        removed.push(path)
        break
      } catch {
        await sleep(150)
      }
    }
  }
  return removed
}
