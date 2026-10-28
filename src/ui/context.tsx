import type { HostClipboardService } from "@opentui/core"
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import type { HistoryEntry, HistoryStore } from "../core/history"
import type { IntroKind } from "../core/intro"
import type { DownloadQueue, Job } from "../core/queue"
import type { Settings, SettingsStore } from "../core/settings"
import type { Tools } from "../core/ytdlp"
import { extractUrls } from "../core/urls"

export type ToastKind = "ok" | "info" | "warn" | "error"

export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

export interface AppServices {
  settings: SettingsStore
  queue: DownloadQueue
  history: HistoryStore
  /** null while detection runs at startup. */
  tools: Tools | null
  /** Logo animation of this launch, or null for a still logo. */
  intro: IntroKind | null
  /** Moves to the next logo animation, for a click on the logo. */
  nextIntro: () => IntroKind
  clipboard: HostClipboardService | null
  toast: (text: string, kind?: ToastKind) => void
  /** Ends the application: kills downloads and restores the terminal. */
  quit: () => void
}

const ServicesContext = createContext<AppServices | null>(null)

export function ServicesProvider({ value, children }: { value: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext)
  if (!services) throw new Error("useServices outside ServicesProvider")
  return services
}

export function useSettings(): Settings {
  const { settings } = useServices()
  return useSyncExternalStore(settings.subscribe, settings.get)
}

export function useJobs(): readonly Job[] {
  const { queue } = useServices()
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot)
}

export function useHistory(): readonly HistoryEntry[] {
  const { history } = useServices()
  return useSyncExternalStore(history.subscribe, history.getSnapshot)
}

export function useToasts() {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nextId = useRef(1)
  const show = useCallback((text: string, kind: ToastKind = "info") => {
    if (timer.current) clearTimeout(timer.current)
    setToast({ id: nextId.current++, kind, text })
    timer.current = setTimeout(() => setToast(null), kind === "error" ? 6000 : 3500)
  }, [])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  return { toast, show }
}

const SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]

export function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 90)
    return () => clearInterval(timer)
  }, [active])
  return SPINNER[frame] as string
}

/** Reads the first link from the host clipboard, or null. */
export async function clipboardUrl(clipboard: HostClipboardService | null): Promise<string | null> {
  if (!clipboard) return null
  try {
    const result = await clipboard.read({ preferredTypes: ["text/plain"] })
    if (result.status !== "read") return null
    return extractUrls(new TextDecoder().decode(result.representation.bytes))[0] ?? null
  } catch {
    return null
  }
}

/**
 * Peeks at the clipboard whenever `active` turns on, so a screen can offer
 * the copied link before the user pastes anything.
 */
export function useClipboardUrl(active: boolean): string | null {
  const { clipboard } = useServices()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    void clipboardUrl(clipboard).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [active, clipboard])
  return url
}
