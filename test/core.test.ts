import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatBytes, formatDuration, plural, truncatePath } from "../src/core/format"
import { describeQualityDrop, downloadLabel, labelText, relevantWarnings, toMediaInfo } from "../src/core/media"
import { SettingsStore, migrateLegacy, normalizeSettings } from "../src/core/settings"
import { dayLabel, groupByDay, timeLabel, type HistoryEntry } from "../src/core/history"
import { INTRO_KINDS, createIntro, nextIntro } from "../src/core/intro"
import { leftoverCandidates, removeLeftovers } from "../src/core/cleanup"
import { extractUrls, hideSchemes, isSoundCloudUrl, isYoutubeUrl } from "../src/core/urls"
import { audioArgs, cleanError, downloadArgs, parseLine, splitArgs, videoFormatSelector } from "../src/core/ytdlp"

describe("extractUrls", () => {
  test("finds links inside messy text, trims punctuation, drops duplicates", () => {
    const text = `смотри https://youtu.be/abc), а ещё (www.example.com/x.
      @user: https://youtu.be/abc ещё раз — и https://x.com/a/status/1?s=20!`
    expect(extractUrls(text)).toEqual(["https://youtu.be/abc", "https://www.example.com/x", "https://x.com/a/status/1?s=20"])
  })

  test("splits links that a single-line field glued together", () => {
    expect(extractUrls("https://a.com/1https://b.com/2http://c.com")).toEqual([
      "https://a.com/1",
      "https://b.com/2",
      "http://c.com",
    ])
  })

  test("finds links without a scheme, but not paths or emails", () => {
    expect(extractUrls("youtu.be/abc и soundcloud.com/a/b, ещё x.com/u/status/1")).toEqual([
      "https://youtu.be/abc",
      "https://soundcloud.com/a/b",
      "https://x.com/u/status/1",
    ])
    expect(extractUrls("C:\Users\me\file.txt и me@mail.ru/x и a/b.com/c")).toEqual([])
  })

  test("hideSchemes keeps glued links apart", () => {
    expect(hideSchemes("https://youtu.be/1https://youtu.be/2 http://x.com/a")).toBe("youtu.be/1 youtu.be/2 x.com/a")
    expect(extractUrls(hideSchemes("https://youtu.be/1https://youtu.be/2"))).toEqual(["https://youtu.be/1", "https://youtu.be/2"])
  })

  test("recognizes platforms", () => {
    expect(isYoutubeUrl("https://www.youtube.com/watch?v=x")).toBe(true)
    expect(isYoutubeUrl("https://youtu.be/x")).toBe(true)
    expect(isYoutubeUrl("https://notyoutube.com/x")).toBe(false)
    expect(isSoundCloudUrl("https://soundcloud.com/a/b")).toBe(true)
    expect(isSoundCloudUrl("https://on.soundcloud.com/xyz")).toBe(true)
    expect(isSoundCloudUrl("https://youtu.be/x")).toBe(false)
  })
})

describe("format helpers", () => {
  test("bytes, durations and plurals", () => {
    expect(formatBytes(1536)).toBe("1.5 КБ")
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 ГБ")
    expect(formatDuration(75)).toBe("01:15")
    expect(formatDuration(3725)).toBe("1:02:05")
    expect(plural(1, "ссылка", "ссылки", "ссылок")).toBe("ссылка")
    expect(plural(3, "ссылка", "ссылки", "ссылок")).toBe("ссылки")
    expect(plural(11, "ссылка", "ссылки", "ссылок")).toBe("ссылок")
    expect(plural(22, "ссылка", "ссылки", "ссылок")).toBe("ссылки")
    expect(truncatePath("C:\\Users\\oxide\\Videos\\very\\deep\\folder", 20)).toHaveLength(20)
  })
})

describe("labels", () => {
  test("usual platforms", () => {
    expect(labelText(downloadLabel({ title: "Song", uploader: "Artist", extractor_key: "Youtube" }))).toBe(
      "[YouTube] Song — Artist",
    )
    expect(downloadLabel({ title: "T", uploader: "U", extractor_key: "SoundcloudPlaylist" }).platform).toBe("SoundCloud")
  })

  test("X posts with and without a caption", () => {
    const base = { extractor_key: "Twitter", uploader: "Some One", uploader_id: "@someone", id: "42" }
    expect(labelText(downloadLabel({ ...base, title: "hello world https://t.co/xyz" }))).toBe(
      "[X] hello world — @someone (42)",
    )
    expect(labelText(downloadLabel({ ...base, title: "https://t.co/xyz" }))).toBe("[X] видео от @someone (42)")
  })
})

describe("quality checks", () => {
  const formats = [
    { height: 360, vcodec: "avc1", acodec: "mp4a" },
    { height: 1080, vcodec: "avc1", acodec: "none" },
  ]

  test("warns when a lower height came out", () => {
    const lines = describeQualityDrop({ extractor_key: "Vimeo", height: 360, formats }, null, [], "mp4")
    expect(lines?.[0]).toBe("скачано в 360p, хотя доступно 1080p")
  })

  test("respects the requested limit", () => {
    expect(describeQualityDrop({ extractor_key: "Vimeo", height: 360, formats }, 480, [], "mp4")).toBeNull()
  })

  test("explains YouTube's fallback-only answer with yt-dlp warnings", () => {
    const lines = describeQualityDrop(
      { extractor_key: "Youtube", height: 360, formats: [{ height: 360, vcodec: "avc1", acodec: "mp4a" }] },
      null,
      ["WARNING: [youtube] x: Some formats may be missing", "WARNING: unrelated"],
      "mp4",
    )
    expect(lines?.[0]).toContain("запасной формат (360p")
    expect(lines?.[1]).toBe("yt-dlp: [youtube] x: Some formats may be missing")
  })

  test("relevant warnings keep only format problems", () => {
    expect(relevantWarnings(["WARNING: PO Token required", "WARNING: cookies", "WARNING: PO Token required"])).toEqual([
      "PO Token required",
    ])
  })

  test("media info lists heights and the fallback flag", () => {
    const info = toMediaInfo("u", { id: "x", title: "t", extractor_key: "Youtube", formats }, [])
    expect(info.heights).toEqual([360, 1080])
    expect(info.maxHeight).toBe(1080)
    expect(info.fallbackOnly).toBe(false)
    expect(info.thumbnail).toBe("https://i.ytimg.com/vi/x/mqdefault.jpg")
  })
})

describe("yt-dlp arguments", () => {
  test("splitArgs keeps Windows paths and quoted groups", () => {
    expect(splitArgs(`--limit-rate 5M -o "C:\\My Videos\\%(title)s.%(ext)s" --cookies C:\\c.txt`).args).toEqual([
      "--limit-rate",
      "5M",
      "-o",
      "C:\\My Videos\\%(title)s.%(ext)s",
      "--cookies",
      "C:\\c.txt",
    ])
    expect(splitArgs(`--x 'a b' c\\ d`).args).toEqual(["--x", "a b", "c d"])
    expect(splitArgs(`--x "open`).error).not.toBeNull()
  })

  test("video selectors prefer the container and cap the height", () => {
    expect(videoFormatSelector("mp4", 720)).toBe("bv[height<=720][ext=mp4]+ba[ext=m4a]/bv[height<=720][ext=mp4]+ba/b[height<=720][ext=mp4]/b[height<=720]/b")
    expect(videoFormatSelector("mkv", null)).toBe("bv+ba/b")
    expect(videoFormatSelector("webm", null)).toBe("bv[ext=webm]+ba[ext=webm]/bv[ext=webm]+ba/b[ext=webm]/b")
  })

  test("audio keeps YouTube's Opus stream and crops the cover", () => {
    const yt = audioArgs("opus", "https://youtu.be/x")
    expect(yt).toContain("ba[ext=webm][acodec=opus]/ba[acodec=opus]/ba/b")
    expect(yt[yt.indexOf("--audio-quality") + 1]).toBe("0")
    expect(yt.join(" ")).toContain("crop=")
    const other = audioArgs("opus", "https://soundcloud.com/a/b")
    expect(other[other.indexOf("--audio-quality") + 1]).toBe("192K")
  })

  test("custom args come last before the URL, so they win", () => {
    const args = downloadArgs(
      { url: "https://youtu.be/x", kind: "video", height: null, dir: "C:\\V", videoFormat: "mp4", audioFormat: "opus" },
      { jsRuntimes: ["deno", "node"], customArgs: ["-o", "x.%(ext)s"] },
    )
    expect(args.slice(-4)).toEqual(["-o", "x.%(ext)s", "--", "https://youtu.be/x"])
    expect(args).toContain("--no-playlist")
    expect(args.filter((a) => a === "--js-runtimes")).toHaveLength(1)
    expect(args[args.indexOf("-P") + 1]).toBe("C:\\V")
  })
})

describe("parseLine", () => {
  test("progress, post-processing, files and errors", () => {
    expect(parseLine("FLUXPROG downloading|512|1024|NA|100.5|3|NA|NA|none|opus")).toMatchObject({
      type: "progress",
      downloaded: 512,
      total: 1024,
      speed: 100.5,
      eta: 3,
      stream: "audio",
    })
    expect(parseLine("FLUXPROG downloading|10|NA|2000|NA|NA|2|10|avc1|none")).toMatchObject({ total: 2000, fragmentIndex: 2, stream: "video" })
    expect(parseLine("FLUXPP started|Merger")).toEqual({ type: "postprocess", status: "started", name: "Merger" })
    expect(parseLine('FLUXFILE "C:\\\\Videos\\\\a.mp4"')).toEqual({ type: "file", path: "C:\\Videos\\a.mp4" })
    expect(parseLine("ERROR: [youtube] abc: Video unavailable")).toEqual({ type: "error", message: "Video unavailable" })
    expect(parseLine('{"id":"x","title":"t"}')).toMatchObject({ type: "info", info: { id: "x" } })
  })

  test("cleanError strips the extractor prefix", () => {
    expect(cleanError("\x1b[0;31mERROR:\x1b[0m [generic] Unsupported URL: x")).toBe("Unsupported URL: x")
  })
})

describe("settings", () => {
  test("normalize fills defaults and clamps", () => {
    const s = normalizeSettings({ videoFormat: "avi", concurrency: 99, videoDir: "  " })
    expect(s.videoFormat).toBe("mp4")
    expect(s.concurrency).toBe(4)
    expect(s.videoDir).toBeNull()
  })

  test("the Python version's single folder becomes two", () => {
    const s = migrateLegacy({
      video_format: "webm",
      audio_format: "mp3",
      custom_download_path: "D:\\Media",
      custom_ytdlp_args: "--limit-rate 5M",
    })
    expect(s.videoFormat).toBe("webm")
    expect(s.audioFormat).toBe("mp3")
    expect(s.videoDir).toBe(join("D:\\Media", "video"))
    expect(s.audioDir).toBe(join("D:\\Media", "audio"))
    expect(s.ytdlpArgs).toBe("--limit-rate 5M")
  })

  test("store migrates once, saves, and notifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "fluxware-test-"))
    const legacy = join(dir, "legacy.json")
    const path = join(dir, "config.json")
    writeFileSync(legacy, JSON.stringify({ video_format: "webm", custom_download_path: null }))
    const store = new SettingsStore(path, legacy)
    expect(store.migrated).toBe(true)
    expect(store.get().videoFormat).toBe("webm")
    let calls = 0
    store.subscribe(() => calls++)
    store.update({ audioDir: join(dir, "music") })
    expect(calls).toBe(1)
    expect(JSON.parse(readFileSync(path, "utf8")).audioDir).toBe(join(dir, "music"))
    const again = new SettingsStore(path, legacy)
    expect(again.migrated).toBe(false)
    expect(again.get().audioDir).toBe(join(dir, "music"))
  })
})

describe("history", () => {
  const entry = (id: string, time: Date): HistoryEntry => ({
    id,
    time: time.toISOString(),
    url: "u",
    kind: "video",
    height: null,
    format: "mp4",
    platform: "YouTube",
    title: id,
    author: null,
    files: [],
    dir: "d",
  })

  test("groups by local day, newest first, with Russian labels", () => {
    const now = new Date(2026, 9, 28, 23, 0)
    const days = groupByDay(
      [
        entry("old", new Date(2025, 11, 31, 10, 5)),
        entry("today-early", new Date(2026, 9, 28, 9, 7)),
        entry("yesterday", new Date(2026, 9, 27, 18, 30)),
        entry("today-late", new Date(2026, 9, 28, 22, 41)),
      ],
      now,
    )
    expect(days.map((d) => d.label)).toEqual(["сегодня · 28 октября", "вчера · 27 октября", "31 декабря 2025"])
    expect(days[0]!.entries.map((e) => e.id)).toEqual(["today-late", "today-early"])
    expect(timeLabel(new Date(2026, 9, 28, 9, 7))).toBe("09:07")
    expect(dayLabel(new Date(2026, 4, 9), now)).toBe("9 мая")
  })
})

describe("logo intro", () => {
  const PIXELS = [13, 10, 12]
  // A fixed sequence, so the flicker schedule is the same on every run.
  const seeded = () => {
    let x = 7
    return () => ((x = (x * 48271) % 2147483647) / 2147483647)
  }

  test("every animation starts unlit or out of place and ends white in place", () => {
    for (const kind of INTRO_KINDS) {
      const intro = createIntro(kind, PIXELS, seeded())
      const first = intro.frame(0)
      expect(first.levels.every((l) => l === 0) || first.lift === 1 || first.drawn.every((d) => d === 0)).toBe(true)
      const last = intro.frame(intro.duration)
      expect(last.levels).toEqual([1, 1, 1])
      expect(last.lift).toBe(0)
      last.drawn.forEach((d, i) => expect(d).toBeGreaterThanOrEqual(PIXELS[i]!))
    }
  })

  test("the tube flickers: some letter goes dark again after it first lit", () => {
    const intro = createIntro("flicker", PIXELS, seeded())
    const lit = new Set<number>()
    let flickered = false
    for (let t = 0; t < intro.duration; t += 10) {
      intro.frame(t).levels.forEach((level, i) => {
        if (level >= 0.5) lit.add(i)
        else if (lit.has(i) && level < 0.2) flickered = true
      })
    }
    expect(flickered).toBe(true)
  })

  test("the contour draws each letter pixel by pixel, F before L before X", () => {
    const intro = createIntro("contour", PIXELS)
    const mid = intro.frame(500).drawn
    expect(mid[0]!).toBeGreaterThan(mid[1]!)
    expect(mid[1]!).toBeGreaterThanOrEqual(mid[2]!)
    expect(mid[0]!).toBeLessThan(PIXELS[0]!)
  })

  test("the drop slides down, then blinks", () => {
    const intro = createIntro("drop", PIXELS)
    expect(intro.frame(950).lift).toBeCloseTo(0.5, 1)
    const levels = Array.from({ length: 40 }, (_, i) => intro.frame(1900 + i * 20).levels[0])
    expect(levels).toContain(0)
    expect(levels.at(-1)).toBe(1)
  })

  test("animations take turns from launch to launch", () => {
    const state = join(mkdtempSync(join(tmpdir(), "fluxware-intro-")), "state.json")
    const seen = Array.from({ length: 4 }, () => nextIntro(state, {}))
    expect(seen).toEqual(["flicker", "contour", "drop", "flicker"])
    expect(nextIntro(state, { FLUXWARE_INTRO: "none" })).toBeNull()
    expect(nextIntro(state, { FLUXWARE_INTRO: "drop" })).toBe("drop")
  })
})

describe("cleanup after cancel", () => {
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "fluxware-clean-"))
    const stream = join(dir, "Клип.f137.mp4")
    const output = join(dir, "Клип.mp4")
    for (const name of ["Клип.f137.mp4.part", "Клип.f137.mp4.ytdl", "Клип.f137.mp4.part-Frag3.part", "Клип.jpg", "Другое.mp4"]) {
      writeFileSync(join(dir, name), "x")
    }
    return { dir, stream, output }
  }

  test("removes the parts and the cover of this run, and nothing else", async () => {
    const { dir, stream, output } = scratch()
    const removed = await removeLeftovers(await leftoverCandidates([stream], [output]), 0)
    expect(removed).toHaveLength(4)
    expect(readdirSync(dir)).toEqual(["Другое.mp4"])
  })

  test("keeps files that were there before the download started", async () => {
    const { dir, stream, output } = scratch()
    await removeLeftovers(await leftoverCandidates([stream], [output]), Date.now() + 60_000)
    expect(readdirSync(dir)).toHaveLength(5)
  })

  test("progress lines carry the stream file", () => {
    // The name is JSON, so its backslashes arrive doubled and a "|" in it does not split fields.
    const line = `FLUXPROG downloading|1|2|NA|NA|NA|NA|NA|avc1|none|${JSON.stringify("C:\\V\\a|b.mp4")}`
    expect(parseLine(line)).toMatchObject({ type: "progress", file: "C:\\V\\a|b.mp4" })
  })
})
