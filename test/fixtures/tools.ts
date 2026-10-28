import { join } from "node:path"
import type { Tools } from "../../src/core/ytdlp"

const FAKE_YTDLP = join(import.meta.dir, "fake-ytdlp.ts")

/** Tools that point yt-dlp at the fake script, run by the current Bun. */
export function fakeTools(): Tools {
  return { ytdlp: { command: process.execPath, prefix: [FAKE_YTDLP], version: "2026.10.21" }, ffmpeg: "ffmpeg", jsRuntimes: [] }
}
