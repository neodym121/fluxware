#!/usr/bin/env bun
import { createCliRenderer, createHostClipboard, type HostClipboardService } from "@opentui/core"
import { registerBaseLayoutFallback, registerCommaBindings } from "@opentui/keymap/addons/opentui"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { useEffect, useMemo, useState } from "react"
import { dirname, join } from "node:path"
import { HistoryStore, entryFromJob, historyPath } from "./core/history"
import { nextIntro } from "./core/intro"
import { killAllChildren } from "./core/process"
import { DownloadQueue } from "./core/queue"
import { SettingsStore } from "./core/settings"
import { detectTools, type Tools } from "./core/ytdlp"
import { App } from "./ui/App"
import { ServicesProvider, useToasts, type AppServices } from "./ui/context"

const settings = new SettingsStore()
let tools: Tools | null = null
const queue = new DownloadQueue({ getTools: () => tools, getSettings: settings.get })
const history = new HistoryStore(historyPath(settings.path), () => settings.get().history)
queue.onFinished((job) => {
  if (job.status === "done") history.add(entryFromJob(job))
})
// The logo animations take turns from one launch to the next.
const introState = join(dirname(settings.path), "state.json")
const intro = nextIntro(introState)
// A click on the logo moves the same rotation on, ignoring FLUXWARE_INTRO.
const advanceIntro = () => nextIntro(introState, {}) ?? "flicker"

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  autoFocus: false,
  targetFps: 30,
})
renderer.setTerminalTitle("fluxware")

const keymap = createDefaultOpenTuiKeymap(renderer)
registerCommaBindings(keymap)
// With the Kitty keyboard protocol, letter shortcuts also work in a Russian layout.
registerBaseLayoutFallback(keymap)

let clipboard: HostClipboardService | null = null
try {
  clipboard = createHostClipboard()
} catch {
  clipboard = null
}

let exiting = false
async function shutdown(code = 0): Promise<never> {
  if (!exiting) {
    exiting = true
    queue.cancelAll()
    // Give canceled downloads a moment to delete their partial files.
    await queue.whenIdle(4000)
    killAllChildren()
    try {
      await clipboard?.dispose()
    } catch {
      // The clipboard is optional; never block exit on it.
    }
    renderer.destroy()
    try {
      await renderer.closed
    } catch {
      // Restoration is best effort.
    }
    process.stdout.write("\x1b[38;5;244m пака((((\x1b[0m\n")
  }
  process.exit(code)
}

// Signals (SIGTERM, a closed window) destroy the renderer without our help.
renderer.once("destroy", () => {
  killAllChildren()
  if (!exiting) void shutdown()
})

function Root() {
  const { toast, show } = useToasts()
  const [detected, setDetected] = useState<Tools | null>(null)

  useEffect(() => {
    void detectTools().then((found) => {
      tools = found
      setDetected(found)
    })
    if (settings.loadError) show(settings.loadError, "error")
    else if (settings.migrated) show("настройки перенесены из Python-версии fluxware", "ok")
  }, [show])

  const services = useMemo<AppServices>(
    () => ({ settings, queue, history, tools: detected, intro, nextIntro: advanceIntro, clipboard, toast: show, quit: () => void shutdown() }),
    [detected, show],
  )

  return (
    <ServicesProvider value={services}>
      <App toast={toast} />
    </ServicesProvider>
  )
}

createRoot(renderer).render(
  <KeymapProvider keymap={keymap}>
    <Root />
  </KeymapProvider>,
)
