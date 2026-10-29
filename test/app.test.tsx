import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostClipboardService } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { registerCommaBindings } from "@opentui/keymap/addons/opentui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { act } from "react"
import { HistoryStore, entryFromJob } from "../src/core/history"
import { DownloadQueue } from "../src/core/queue"
import { SettingsStore } from "../src/core/settings"
import type { Tools } from "../src/core/ytdlp"
import { App, type SectionId } from "../src/ui/App"
import { ServicesProvider, type AppServices, type Toast } from "../src/ui/context"
import { fakeTools } from "./fixtures/tools"

let setup: TestRendererSetup | null = null

// The logo intro is random; frames in these tests use the static logo.
process.env.FLUXWARE_INTRO = "none"

afterEach(() => {
  setup?.renderer.destroy()
  setup = null
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

/** Host clipboard stand-in that always holds `text`. */
function fakeClipboard(text: string): HostClipboardService {
  return {
    maxWriteBytes: 1024,
    read: async () => ({ status: "read", representation: { mimeType: "text/plain", bytes: new TextEncoder().encode(text) } }),
    writeText: async () => ({ status: "written" }) as never,
    clear: async () => ({ status: "cleared" }) as never,
    dispose: async () => {},
  }
}

async function mount(
  options: { tools?: Tools | null; section?: SectionId; width?: number; height?: number; clipboardText?: string } = {},
) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const dir = mkdtempSync(join(tmpdir(), "fluxware-ui-"))
  const settings = new SettingsStore(join(dir, "config.json"), null)
  settings.update({ videoDir: join(dir, "video"), audioDir: join(dir, "audio"), thumbnails: false, language: "ru" })
  const tools = options.tools === undefined ? fakeTools() : options.tools
  const queue = new DownloadQueue({ getTools: () => tools, getSettings: settings.get, mkdir: () => {}, throttleMs: 5 })
  const historyFile = join(dir, "history.jsonl")
  const history = new HistoryStore(historyFile, () => settings.get().history)
  queue.onFinished((job) => {
    if (job.status === "done") history.add(entryFromJob(job))
  })
  const toasts: Toast[] = []
  const services: AppServices = {
    settings,
    queue,
    history,
    tools,
    intro: null,
    nextIntro: () => "drop",
    clipboard: options.clipboardText ? fakeClipboard(options.clipboardText) : null,
    toast: (text, kind = "info") => toasts.push({ id: toasts.length, text, kind }),
    quit: () => {},
  }
  setup = await createTestRenderer({ width: options.width ?? 110, height: options.height ?? 30, autoFocus: false })
  const keymap = createDefaultOpenTuiKeymap(setup.renderer)
  registerCommaBindings(keymap)
  const root = createRoot(setup.renderer)
  act(() => {
    root.render(
      <KeymapProvider keymap={keymap}>
        <ServicesProvider value={services}>
          <App toast={null} initialSection={options.section} />
        </ServicesProvider>
      </KeymapProvider>,
    )
  })
  await settle()
  return { setup, services, queue, toasts, settings, history, historyFile }
}

async function settle() {
  await act(async () => {
    await setup!.flush()
  })
  await setup!.renderOnce()
}

async function press(fn: (s: TestRendererSetup) => void | Promise<void>) {
  await act(async () => {
    await fn(setup!)
  })
  await settle()
}

/** A lone ESC needs a pause, or the parser reads it as Alt plus the next key. */
async function pressEscape() {
  await press((s) => s.mockInput.pressEscape())
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80))
  })
  await settle()
}

async function waitForText(text: string, tries = 60): Promise<string> {
  for (let i = 0; i < tries; i++) {
    await settle()
    const frame = setup!.captureCharFrame()
    if (frame.includes(text)) return frame
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
  }
  throw new Error(`"${text}" never appeared:\n${setup!.captureCharFrame()}`)
}

describe("App", () => {
  test("first screen: tabs on top, centered field with Enter!, logo and versions below", async () => {
    await mount()
    const frame = setup!.captureCharFrame()
    if (process.env.SHOW_FRAMES) console.log(frame)
    const lines = frame.split("\n")
    expect(lines[1]).toContain("скачка")
    expect(lines[1]).toContain("о программе")
    expect(lines[1]).not.toContain("аудио")
    expect(lines[1]).not.toContain("soundcloud")
    // Tabs spread over the whole width.
    expect(lines[1]!.indexOf("о программе")).toBeGreaterThan(80)
    expect(frame).toContain("вставь ссылку")
    expect(frame).toContain("Enter!")
    expect(frame).not.toContain("в этой сессии")
    const bottom = lines.slice(-3).join("\n")
    expect(bottom).toContain("universal media downloader")
    expect(bottom).toContain("yt-dlp 2026.10.21")
    expect(bottom).not.toContain("ffmpeg")
  })

  test("download: no full link while loading, esc hint on its own line", async () => {
    await mount()
    await press((s) => s.mockInput.pasteBracketedText("https://youtu.be/slow"))
    await press((s) => s.mockInput.pressEnter())
    const frame = setup!.captureCharFrame()
    if (process.env.SHOW_FRAMES) console.log(frame)
    expect(frame).not.toContain("https://")
    const lines = frame.split("\n")
    const loading = lines.findIndex((l) => l.includes("получаю информацию…"))
    expect(loading).toBeGreaterThan(0)
    expect(lines[loading]).not.toContain("youtu.be")
    expect(lines[loading + 1]).toContain("esc — отмена")
    await waitForText("Тестовое видео")
  })

  test("download: highest quality first, progress stays on the card", async () => {
    const { queue } = await mount()
    await press((s) => s.mockInput.typeText("https://youtu.be/ok"))
    expect(setup!.captureCharFrame()).not.toContain("https://")
    await press((s) => s.mockInput.pressEnter())
    const frame = await waitForText("Тестовое видео")
    if (process.env.SHOW_FRAMES) console.log(frame)
    expect(frame).not.toContain("максимальное качество")
    expect(frame).not.toContain("OPUS")
    expect(frame).not.toContain("видео →")
    const options = frame.split("\n").filter((l) => /▌|\b\d{3,4}p\b|только звук/.test(l))
    expect(options[0]).toContain("1080p")
    expect(frame).toContain("только звук")
    await press((s) => s.mockInput.pressEnter())
    expect(queue.getSnapshot()[0]).toMatchObject({ url: "https://youtu.be/ok", height: 1080, kind: "video", source: "download" })
    const done = await waitForText("✓ готово")
    if (process.env.SHOW_FRAMES) console.log(done)
    expect(done).toContain("Тестовое видео")
  })

  test("download: the copied link waits in the field, enter puts it in, enter again confirms", async () => {
    await mount({ clipboardText: "смотри https://youtu.be/clip123" })
    await waitForText("youtu.be/clip123")
    let frame = setup!.captureCharFrame()
    expect(frame).not.toContain("из буфера")
    await press((s) => s.mockInput.pressEnter())
    frame = setup!.captureCharFrame()
    expect(frame).not.toContain("получаю информацию")
    expect(frame).not.toContain("Тестовое видео")
    await press((s) => s.mockInput.pressEnter())
    frame = await waitForText("Тестовое видео")
    if (process.env.SHOW_FRAMES) console.log(frame)
    expect(frame).not.toContain("разрешени")
  })

  test("download: cancel button under the bar, status on the right", async () => {
    const { queue } = await mount()
    await press((s) => s.mockInput.typeText("https://youtu.be/longdl"))
    await press((s) => s.mockInput.pressEnter())
    await waitForText("Тестовое видео")
    await press((s) => s.mockInput.pressEnter())
    const frame = await waitForText("КБ/с")
    if (process.env.SHOW_FRAMES) console.log(frame)
    const lines = frame.split("\n")
    const row = lines.find((l) => l.includes("отмена"))
    expect(row).toBeDefined()
    expect(row!.indexOf("отмена")).toBeLessThan(row!.indexOf("КБ/с"))
    expect(row).not.toContain("видео")
    // Focus moved to the button on its own.
    expect(row).toContain("› отмена ‹")
    // The white block is as wide as the word, not the whole line.
    const buttonSpan = setup!
      .captureSpans()
      .lines.flatMap((l) => l.spans)
      .find((span) => span.text.includes("отмена"))
    expect(buttonSpan?.text.trim()).toBe("› отмена ‹")
    await press((s) => s.mockInput.pressEnter())
    await waitForText("– отменено")
    expect(queue.getSnapshot()[0]?.status).toBe("canceled")
  })

  test("download: SoundCloud shows the card and starts at once", async () => {
    const { queue } = await mount()
    await press((s) => s.mockInput.typeText("https://soundcloud.com/artist/track"))
    await press((s) => s.mockInput.pressEnter())
    const frame = await waitForText("Трек")
    if (process.env.SHOW_FRAMES) console.log(frame)
    expect(frame).not.toContain("скачать аудио")
    expect(frame).not.toContain("1080p")
    expect(queue.getSnapshot()[0]).toMatchObject({ kind: "audio", url: "https://soundcloud.com/artist/track" })
  })

  test("download: the quality list keeps focus until esc", async () => {
    await mount()
    await press((s) => s.mockInput.typeText("https://youtu.be/ok"))
    await press((s) => s.mockInput.pressEnter())
    await waitForText("Тестовое видео")
    await press((s) => s.mockInput.pressArrow("up"))
    await press((s) => s.mockInput.pressArrow("up"))
    expect(setup!.captureCharFrame()).toContain("enter выбрать")
    await press((s) => s.mockInput.pressTab())
    await press((s) => s.mockInput.pressTab({ shift: true }))
    expect(setup!.captureCharFrame()).toContain("enter выбрать")
    expect(setup!.captureCharFrame()).not.toContain("←/→ раздел")
    await pressEscape()
    const frame = setup!.captureCharFrame()
    expect(frame).not.toContain("enter выбрать")
    expect(frame).toContain("Тестовое видео")
    // Typing now goes to the field again.
    await press((s) => s.mockInput.typeText("x"))
    expect(setup!.captureCharFrame()).toContain("youtu.be/okx")
  })

  test("download: big FLX logo above the field", async () => {
    await mount()
    const frame = setup!.captureCharFrame()
    const lines = frame.split("\n")
    const logo = lines.findIndex((l) => l.includes("█▀▀▀▀  █      ▀▄  ▄▀"))
    const field = lines.findIndex((l) => l.includes("вставь ссылку"))
    expect(logo).toBeGreaterThan(0)
    // Three rows of pixel letters, one empty row, then the field.
    expect(lines[logo + 1]).toContain("█▀▀▀   █        ██")
    expect(lines[logo + 2]).toContain("█      █▄▄▄▄  ▄▀  ▀▄")
    expect(field).toBe(logo + 4)
  })

  test("download: a click on the logo plays the next animation", async () => {
    // The stub in mount() answers "drop".
    await mount()
    const lines = setup!.captureCharFrame().split("\n")
    const y = lines.findIndex((l) => l.includes("█▀▀▀▀  █"))
    const x = lines[y]!.indexOf("█▀▀▀▀")
    await press((s) => s.mockMouse.click(x + 2, y + 1))
    // The drop starts above its place, so the logo row is empty for a moment.
    expect(setup!.captureCharFrame().split("\n")[y]).not.toContain("█▀▀▀▀")
  })

  test("download: the quality list is a carousel", async () => {
    await mount()
    await press((s) => s.mockInput.typeText("https://youtu.be/ok"))
    await press((s) => s.mockInput.pressEnter())
    await waitForText("Тестовое видео")
    const selected = () => setup!.captureCharFrame().split("\n").find((l) => l.includes("▌"))
    expect(selected()).toContain("1080p")
    await press((s) => s.mockInput.pressArrow("up"))
    expect(selected()).toContain("только звук")
    await press((s) => s.mockInput.pressArrow("down"))
    expect(selected()).toContain("1080p")
  })

  test("download: cancel removes the partial files", async () => {
    const { queue, settings } = await mount()
    await press((s) => s.mockInput.typeText("https://youtu.be/longdl"))
    await press((s) => s.mockInput.pressEnter())
    await waitForText("Тестовое видео")
    await press((s) => s.mockInput.pressEnter())
    await waitForText("КБ/с")
    const dir = settings.get().videoDir!
    expect(readdirSync(dir).sort()).toEqual(["Тестовое видео.f137.mp4.part", "Тестовое видео.jpg"])
    await press((s) => s.mockInput.pressEnter())
    await waitForText("– отменено")
    expect(queue.getSnapshot()[0]?.status).toBe("canceled")
    expect(readdirSync(dir)).toEqual([])
  })

  test("download: several links at once, all as audio", async () => {
    const { queue } = await mount()
    await press((s) => s.mockInput.pasteBracketedText("https://youtu.be/1 https://youtu.be/2"))
    await press((s) => s.mockInput.pressEnter())
    const frame = await waitForText("все как аудио")
    if (process.env.SHOW_FRAMES) console.log(frame)
    await press((s) => s.mockInput.pressArrow("down"))
    await press((s) => s.mockInput.pressEnter())
    expect(queue.getSnapshot().map((j) => [j.url, j.kind])).toEqual([
      ["https://youtu.be/1", "audio"],
      ["https://youtu.be/2", "audio"],
    ])
  })

  test("tab moves between windows, arrows move between sections", async () => {
    await mount()
    await press((s) => s.mockInput.pressTab())
    expect(setup!.captureCharFrame()).toContain("←/→ раздел")
    await press((s) => s.mockInput.pressArrow("right"))
    let frame = setup!.captureCharFrame()
    expect(frame).toContain("ссылки: вставь любой текст")
    await press((s) => s.mockInput.pressTab())
    await press((s) => s.mockInput.pasteBracketedText("https://youtu.be/9"))
    expect(setup!.captureCharFrame()).toContain("найдено ссылок: 1")
    await press((s) => s.mockInput.pressTab())
    frame = setup!.captureCharFrame()
    if (process.env.SHOW_FRAMES) console.log(frame)
    expect(frame).toContain("←/→ кнопка")
    await press((s) => s.mockInput.pressTab())
    expect(setup!.captureCharFrame()).toContain("enter нажать")
    expect(setup!.captureCharFrame()).toContain("› Скачать! ‹")
    await press((s) => s.mockInput.pressTab())
    expect(setup!.captureCharFrame()).toContain("←/→ раздел")
  })

  test("escape walks back to the tabs, digits jump", async () => {
    await mount()
    await pressEscape()
    expect(setup!.captureCharFrame()).toContain("enter открыть")
    await press((s) => s.mockInput.typeText("4"))
    const frame = setup!.captureCharFrame()
    if (process.env.SHOW_FRAMES) console.log(frame)
    expect(frame).toContain("формат видео")
    expect(frame).toContain("папка для видео")
    expect(frame).toContain("папка для аудио")
  })

  test("settings: video and audio folders change separately", async () => {
    const { settings } = await mount({ section: "settings" })
    const target = join(tmpdir(), `fluxware-audio-${Date.now()}`)
    await press((s) => s.mockInput.pressArrow("down"))
    await press((s) => s.mockInput.pressArrow("down"))
    await press((s) => s.mockInput.pressArrow("down"))
    await press((s) => s.mockInput.pressEnter())
    await settle()
    await press((s) => s.mockInput.typeText(target))
    await press((s) => s.mockInput.pressEnter())
    const frame = setup!.captureCharFrame()
    if (process.env.SHOW_FRAMES) console.log(frame)
    expect(frame).toContain("enter — создать")
    expect(frame).not.toContain("файл настроек")
    expect(frame).not.toContain("открыть в проводнике")
    await press((s) => s.mockInput.pressEnter())
    expect(settings.get().audioDir).toBe(target)
    expect(settings.get().videoDir).not.toBe(target)
  })

  test("settings: the language switch changes the whole interface and is saved", async () => {
    const { settings, setup: s } = await mount({ section: "settings" })
    for (let i = 0; i < 8; i++) await press((x) => x.mockInput.pressArrow("down"))
    expect(s.captureCharFrame()).toContain("Русский")
    await press((x) => x.mockInput.pressArrow("right"))
    const frame = s.captureCharFrame()
    expect(settings.get().language).toBe("en")
    expect(frame).toContain("video format")
    expect(frame).toContain("English")
    const tabs = frame.split("\n")[1]!
    expect(tabs).toContain("download")
    expect(tabs).toContain("about")
    expect(tabs).not.toContain("скачка")
    expect(frame).toContain("interface language.")
    await press((x) => x.mockInput.pressArrow("left"))
    expect(settings.get().language).toBe("ru")
    expect(s.captureCharFrame().split("\n")[1]).toContain("скачка")
  })

  test("batch: pasted text becomes queued links", async () => {
    const { queue } = await mount({ section: "batch" })
    await press((s) => s.mockInput.pasteBracketedText("вот https://youtu.be/1 и https://youtu.be/2, ещё https://youtu.be/1"))
    const frame = await waitForText("найдено ссылок: 2")
    if (process.env.SHOW_FRAMES) console.log(frame)
    await press((s) => s.mockInput.pressKey("s", { ctrl: true }))
    expect(queue.getSnapshot().map((j) => j.url)).toEqual(["https://youtu.be/1", "https://youtu.be/2"])
    const progress = await waitForText("пакет: готово 2 из 2")
    if (process.env.SHOW_FRAMES) console.log(progress)
  })

  test("history: finished downloads by date with time on the right, kept in the log", async () => {
    const { queue, historyFile } = await mount({ section: "history" })
    queue.add([{ url: "https://youtu.be/ok", kind: "video", source: "download", dir: "d" }])
    queue.add([{ url: "https://youtu.be/fail", kind: "audio", source: "download", dir: "d" }])
    await waitForText("Video unavailable")
    const frame = await waitForText("сегодня")
    if (process.env.SHOW_FRAMES) console.log(frame)
    const lines = frame.split("\n")
    const row = lines.find((l) => l.includes("Тестовое видео"))
    expect(row).toMatch(/\d{2}:\d{2}\s*│$/)
    const failed = lines.findIndex((l) => l.includes("youtu.be/fail"))
    expect(lines[failed]).not.toContain("ошибка")
    expect(lines[failed + 1]).toContain("ошибка: Video unavailable")
    expect(frame).toContain("сейчас")
    expect(frame).not.toContain("max · mp4")
    // The file was never written to disk here, so opening it reports that it is gone.
    const before = setup!.captureCharFrame()
    expect(before).not.toContain("файл не найден")
    await press((s) => s.mockInput.pressArrow("down"))
    await press((s) => s.mockInput.pressEnter())
    const missing = setup!.captureCharFrame()
    if (process.env.SHOW_FRAMES) console.log(missing)
    // The red line sits at the very bottom of the window, right above its border.
    const rows = missing.split("\n")
    const at = rows.findIndex((l) => l.includes("✗ файл не найден: Тестовое видео.mp4"))
    expect(at).toBeGreaterThan(0)
    expect(rows[at + 1]).toStartWith("└")
    const log = await Bun.file(historyFile).text()
    expect(log.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(log).title).toBe("Тестовое видео")
  })

  test("history: logging can be turned off", async () => {
    const { queue, settings, historyFile } = await mount({ section: "history" })
    settings.update({ history: false })
    queue.add([{ url: "https://youtu.be/ok", kind: "video", source: "download", dir: "d" }])
    await waitForText("Тестовое видео")
    expect(setup!.captureCharFrame()).toContain("история не сохраняется")
    expect(await Bun.file(historyFile).exists()).toBe(false)
  })

  test("missing yt-dlp opens a notice", async () => {
    await mount({ tools: { ytdlp: null, ffmpeg: null, jsRuntimes: [] } })
    const frame = setup!.captureCharFrame()
    if (process.env.SHOW_FRAMES) console.log(frame)
    expect(frame).toContain("не хватает yt-dlp")
    await press((s) => s.mockInput.pressEnter())
    expect(setup!.captureCharFrame()).not.toContain("не хватает yt-dlp")
  })
})
