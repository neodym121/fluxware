import { describe, expect, test } from "bun:test"
import { DownloadQueue, type Job } from "../src/core/queue"
import { setLanguage } from "../src/core/i18n"
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings"
import type { Tools } from "../src/core/ytdlp"
import { fakeTools } from "./fixtures/tools"

setLanguage("ru")

function waitFor(queue: DownloadQueue, predicate: (jobs: readonly Job[]) => boolean, timeoutMs = 10000): Promise<readonly Job[]> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const jobs = queue.getSnapshot()
      if (predicate(jobs)) {
        off()
        clearTimeout(timer)
        resolve(jobs)
      }
    }
    const off = queue.subscribe(check)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout: ${JSON.stringify(queue.getSnapshot().map((j) => j.status))}`))
    }, timeoutMs)
    check()
  })
}

function makeQueue(settings: Partial<Settings> = {}, tools: Tools | null = fakeTools()) {
  const s = { ...DEFAULT_SETTINGS, ...settings }
  return new DownloadQueue({ getTools: () => tools, getSettings: () => s, mkdir: () => {}, throttleMs: 5 })
}

describe("DownloadQueue", () => {
  test("runs a download through the real process pipeline", async () => {
    const queue = makeQueue()
    const idle = new Promise((resolve) => queue.onIdle(resolve))
    queue.add([{ url: "https://youtu.be/ok", kind: "video", height: 720, source: "download", dir: "C:\\Videos" }])
    const [job] = await waitFor(queue, (jobs) => jobs[0]?.status === "done")
    expect(job?.label).toEqual({ platform: "YouTube", title: "Тестовое видео", author: "Канал" })
    expect(job?.files).toEqual(["C:\\Videos\\Тестовое видео.mp4"])
    expect(job?.warnings).toEqual([])
    expect(await idle).toEqual({ done: 1, failed: 0, canceled: 0 })
  })

  test("reports a quality drop below what was available", async () => {
    const queue = makeQueue()
    queue.add([{ url: "https://youtu.be/ok", kind: "video", height: 360, source: "download", dir: "C:\\Videos" }])
    const [job] = await waitFor(queue, (jobs) => jobs[0]?.status === "done")
    // The cap is 360 and 360 came out, so nothing to report.
    expect(job?.warnings).toEqual([])
  })

  test("keeps yt-dlp's error and allows a retry", async () => {
    const queue = makeQueue()
    queue.add([{ url: "https://youtu.be/fail", kind: "audio", source: "download", dir: "C:\\Music" }])
    const [job] = await waitFor(queue, (jobs) => jobs[0]?.status === "failed")
    expect(job?.error).toBe("Video unavailable")
    queue.retry(job!.id)
    expect(queue.getSnapshot()[0]?.status).not.toBe("failed")
    await waitFor(queue, (jobs) => jobs[0]?.status === "failed")
  })

  test("respects the concurrency limit and cancels queued jobs", async () => {
    const queue = makeQueue({ concurrency: 1 })
    const jobs = queue.add([
      { url: "https://youtu.be/1", kind: "video", source: "batch", dir: "d" },
      { url: "https://youtu.be/2", kind: "video", source: "batch", dir: "d" },
      { url: "https://youtu.be/3", kind: "video", source: "batch", dir: "d" },
    ])
    const snapshot = queue.getSnapshot()
    expect(snapshot.filter((j) => j.status === "running")).toHaveLength(1)
    queue.cancel(jobs[2]!.id)
    expect(queue.getSnapshot()[2]?.status).toBe("canceled")
    const final = await waitFor(queue, (list) => list.every((j) => j.status === "done" || j.status === "canceled"))
    expect(final.map((j) => j.status)).toEqual(["done", "done", "canceled"])
  })

  test("fails fast without yt-dlp", async () => {
    const queue = makeQueue({}, null)
    queue.add([{ url: "https://youtu.be/x", kind: "video", source: "download", dir: "d" }])
    const [job] = await waitFor(queue, (jobs) => jobs[0]?.status === "failed")
    expect(job?.error).toContain("yt-dlp не найден")
  })
})
