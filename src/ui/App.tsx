import type { BoxRenderable } from "@opentui/core"
import { useActiveKeys, useBindings } from "@opentui/keymap/react"
import { useBlur, useFocus, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState, type RefObject } from "react"
import { formatSpeed, plural, truncate } from "../core/format"
import { useJobs, useServices, useSpinner, type Toast } from "./context"
import { AboutScreen, YTDLP_INSTALL_HINT, ffmpegInstallHint } from "./screens/AboutScreen"
import { BatchScreen } from "./screens/BatchScreen"
import { DownloadScreen } from "./screens/DownloadScreen"
import { HistoryScreen } from "./screens/HistoryScreen"
import { SettingsScreen } from "./screens/SettingsScreen"
import type { FocusEntry, ScreenProps } from "./screens/shared"
import { theme } from "./theme"

export const SECTIONS = [
  { id: "download", label: "скачка" },
  { id: "batch", label: "пакет" },
  { id: "history", label: "история" },
  { id: "settings", label: "настройки" },
  { id: "about", label: "о программе" },
] as const

export type SectionId = (typeof SECTIONS)[number]["id"]

function Screen(props: ScreenProps & { section: SectionId }) {
  const { section, ...rest } = props
  switch (section) {
    case "download":
      return <DownloadScreen {...rest} />
    case "batch":
      return <BatchScreen {...rest} />
    case "history":
      return <HistoryScreen {...rest} />
    case "settings":
      return <SettingsScreen {...rest} />
    case "about":
      return <AboutScreen {...rest} />
  }
}

const KEY_LABELS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  return: "enter",
  enter: "enter",
  escape: "esc",
  delete: "del",
  backspace: "⌫",
  pageup: "pgup",
  pagedown: "pgdn",
}

/** Built from the keymap: it lists whatever keys work right now. */
function KeyHints() {
  const keys = useActiveKeys({ includeMetadata: true })
  const groups = new Map<string, string[]>()
  for (const key of keys) {
    const desc = key.bindingAttrs?.desc
    if (typeof desc !== "string") continue
    // Cyrillic twins of letter shortcuts (к for r) only add noise here.
    if (/^[а-яё]$/i.test(key.display)) continue
    const label = KEY_LABELS[key.display] ?? key.display
    const list = groups.get(desc) ?? []
    if (!list.includes(label)) list.push(label)
    groups.set(desc, list)
  }
  return (
    <text wrapMode="none" flexGrow={1} flexShrink={1}>
      {[...groups.entries()].map(([desc, labels], i) => (
        <span key={desc}>
          <span fg={theme.text}>{(i ? "   " : "") + labels.join("/")}</span>
          <span fg={theme.faint}>{" " + desc}</span>
        </span>
      ))}
    </text>
  )
}

function QueueStatus() {
  const { queue } = useServices()
  useJobs()
  const s = queue.summary()
  const frame = useSpinner(s.running > 0)
  if (s.running === 0 && s.queued === 0) {
    if (s.done === 0 && s.failed === 0) return null
    return (
      <text fg={theme.faint} wrapMode="none" flexShrink={0}>
        {`готово ${s.done}`}
        {s.failed ? <span fg={theme.error}>{` · ошибок ${s.failed}`}</span> : null}
      </text>
    )
  }
  const pct = s.overall != null ? ` · ${Math.floor(s.overall * 100)}%` : ""
  const speed = s.speed ? ` · ${formatSpeed(s.speed)}` : ""
  return (
    <text wrapMode="none" flexShrink={0}>
      <span fg={theme.accent}>{frame + " "}</span>
      <span fg={theme.text}>{`${s.running} ${plural(s.running, "загрузка", "загрузки", "загрузок")}`}</span>
      <span fg={theme.muted}>{(s.queued ? ` · ждут ${s.queued}` : "") + speed + pct}</span>
    </text>
  )
}

function ToastLine(props: { toast: Toast; width: number }) {
  const color = { ok: theme.accent, info: theme.text, warn: theme.warn, error: theme.error }[props.toast.kind]
  const glyph = { ok: "✓", info: "·", warn: "!", error: "✗" }[props.toast.kind]
  return (
    <text fg={color} wrapMode="none" flexShrink={0}>
      {truncate(`${glyph} ${props.toast.text}`, props.width)}
    </text>
  )
}

function ToolVersions() {
  const { tools } = useServices()
  if (tools === null) return <span fg={theme.faint}>проверяю yt-dlp…</span>
  return tools.ytdlp ? <span fg={theme.faint}>{`yt-dlp ${tools.ytdlp.version}`}</span> : <span fg={theme.error}>yt-dlp не найден</span>
}

/**
 * Bottom of the window: the logo on the left; on the right, tool versions
 * above the live key hints and the queue status (or a toast).
 */
function BottomBar(props: { compact: boolean; toast: Toast | null; width: number }) {
  const statusWidth = Math.max(20, props.width < 100 ? props.width - 2 : Math.floor(props.width / 2))
  // The gap keeps cut-off key hints from running into the status.
  const status = (
    <box flexShrink={0} paddingLeft={2} flexDirection="row">
      {props.toast ? <ToastLine toast={props.toast} width={statusWidth} /> : <QueueStatus />}
    </box>
  )
  const hints = props.toast && props.width < 100 ? null : <KeyHints />
  if (props.compact) {
    return (
      <box height={1} flexDirection="row" paddingX={1} flexShrink={0}>
        {hints}
        {status}
      </box>
    )
  }
  return (
    <box height={2} flexDirection="row" paddingX={1} flexShrink={0}>
      <ascii-font text="FLUXWARE" font="tiny" color={theme.accent} selectable={false} flexShrink={0} />
      <box flexGrow={1} flexDirection="column" paddingLeft={2}>
        <box height={1} flexDirection="row">
          <text fg={theme.muted} wrapMode="none" flexGrow={1}>
            universal media downloader
          </text>
          <text wrapMode="none" flexShrink={0}>
            <ToolVersions />
          </text>
        </box>
        <box height={1} flexDirection="row">
          {hints}
          {status}
        </box>
      </box>
    </box>
  )
}

/** A centered message over everything, closed with enter or esc. */
function Notice(props: { title: string; lines: string[]; onClose: () => void; width: number; height: number }) {
  const close = useRef(props.onClose)
  close.current = props.onClose
  useBindings(
    () => ({
      priority: 100,
      bindings: [
        { key: "return", desc: "понятно", cmd: () => close.current() },
        { key: "escape", cmd: () => close.current() },
      ],
    }),
    [],
  )
  const width = Math.min(72, props.width - 4)
  return (
    <box
      position="absolute"
      left={Math.max(0, Math.floor((props.width - width) / 2))}
      top={Math.max(0, Math.floor(props.height / 2) - 5)}
      width={width}
      zIndex={50}
      border
      borderStyle="single"
      borderColor={theme.accent}
      title={` ${props.title} `}
      titleColor={theme.accent}
      backgroundColor="#0C0C0C"
      paddingX={1}
      flexDirection="column"
    >
      {props.lines.map((line, i) => (
        <text key={i} fg={i === 0 ? theme.text : theme.muted} wrapMode="word">
          {line}
        </text>
      ))}
      <text fg={theme.faint} marginTop={1}>
        enter — понятно
      </text>
    </box>
  )
}

/** Section tabs in a row: a window of its own that Tab moves focus to. */
function TabBar(props: { section: SectionId; focused: boolean; onPick: (id: SectionId) => void; navRef: RefObject<BoxRenderable | null> }) {
  const jobs = useJobs()
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length
  const spinner = useSpinner(active > 0)
  return (
    <box
      ref={props.navRef}
      focusable
      focused={props.focused}
      height={3}
      flexShrink={0}
      border
      borderStyle="single"
      borderColor={props.focused ? theme.accent : theme.line}
      focusedBorderColor={theme.accent}
      flexDirection="row"
    >
      {SECTIONS.map((s) => {
        const selected = s.id === props.section
        const badge = s.id === "history" && active ? ` ${spinner}${active}` : ""
        const bg = selected ? (props.focused ? theme.accent : theme.selection) : undefined
        const fg = selected ? (props.focused ? "#000000" : theme.accent) : theme.muted
        return (
          <box
            key={s.id}
            height={1}
            flexGrow={1}
            flexBasis={0}
            justifyContent="center"
            flexDirection="row"
            backgroundColor={bg}
            onMouseDown={() => props.onPick(s.id)}
          >
            <text fg={fg} wrapMode="none">
              {selected ? <b>{s.label + badge}</b> : s.label + badge}
            </text>
          </box>
        )
      })}
    </box>
  )
}

export function App(props: { toast: Toast | null; initialSection?: SectionId }) {
  const services = useServices()
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [section, setSection] = useState<SectionId>(props.initialSection ?? "download")
  const [area, setArea] = useState<"nav" | "content">("content")
  const [entry, setEntry] = useState<FocusEntry>({ seq: 0, edge: "first" })
  const [notice, setNotice] = useState<{ title: string; lines: string[] } | null>(null)
  const noticeShown = useRef(false)
  const navRef = useRef<BoxRenderable>(null)
  const contentRef = useRef<BoxRenderable>(null)
  const quitArmedAt = useRef(0)
  const terminalFocused = useRef(true)

  const latest = useRef({ section })
  latest.current = { section }

  function requestQuit() {
    const active = services.queue.activeCount
    if (active > 0 && Date.now() - quitArmedAt.current > 3000) {
      quitArmedAt.current = Date.now()
      services.toast(`идут загрузки (${active}): нажми ещё раз, чтобы прервать их и выйти`, "warn")
      return
    }
    services.quit()
  }
  const quitRef = useRef(requestQuit)
  quitRef.current = requestQuit

  function moveSection(delta: number) {
    const i = SECTIONS.findIndex((s) => s.id === latest.current.section)
    const next = SECTIONS[(i + delta + SECTIONS.length) % SECTIONS.length]
    if (next) setSection(next.id)
  }

  function enterContent(edge: FocusEntry["edge"]) {
    setEntry((e) => ({ seq: e.seq + 1, edge }))
    setArea("content")
  }

  useBindings(() => ({ bindings: [{ key: "ctrl+c", desc: "выход", cmd: () => quitRef.current() }] }), [])

  useBindings(
    () => ({
      targetRef: navRef,
      targetMode: "focus",
      priority: 10,
      bindings: [
        { key: "left", desc: "раздел", cmd: () => moveSection(-1) },
        { key: "right", desc: "раздел", cmd: () => moveSection(1) },
        { key: "h", cmd: () => moveSection(-1) },
        { key: "l", cmd: () => moveSection(1) },
        { key: "return", desc: "открыть", cmd: () => enterContent("first") },
        { key: "down", cmd: () => enterContent("first") },
        { key: "tab", desc: "окно", cmd: () => enterContent("first") },
        { key: "shift+tab", cmd: () => enterContent("last") },
        ...SECTIONS.map((s, i) => ({
          key: String(i + 1),
          cmd: () => {
            setSection(s.id)
            enterContent("first")
          },
        })),
        { key: "q, й", desc: "выход", cmd: () => quitRef.current() },
      ],
    }),
    [],
  )

  // Screens handle Tab inside themselves first and fall through here at their edges.
  useBindings(
    () => ({
      targetRef: contentRef,
      bindings: [
        { key: "escape", desc: "к разделам", cmd: () => setArea("nav") },
        { key: "tab", desc: "окно", cmd: () => setArea("nav") },
        { key: "shift+tab", cmd: () => setArea("nav") },
      ],
    }),
    [],
  )

  // Startup notice about missing tools, once detection finishes.
  useEffect(() => {
    const tools = services.tools
    if (!tools || noticeShown.current) return
    noticeShown.current = true
    const lines: string[] = []
    if (!tools.ytdlp) lines.push("yt-dlp не найден: без него fluxware ничего не скачает.", `установка: ${YTDLP_INSTALL_HINT}`)
    if (!tools.ffmpeg)
      lines.push(
        "ffmpeg не найден в PATH: не будут работать склейка видео и звука, извлечение аудио и обложки.",
        `установка: ${ffmpegInstallHint()}`,
      )
    if (lines.length) setNotice({ title: tools.ytdlp ? "не хватает ffmpeg" : "не хватает yt-dlp", lines })
  }, [services.tools])

  useFocus(() => (terminalFocused.current = true))
  useBlur(() => (terminalFocused.current = false))

  // Terminal title, OSC 7501 program status, and a notification after a run.
  useEffect(() => {
    const { queue } = services
    let lastPct = -1
    const update = () => {
      const s = queue.summary()
      const pct = s.overall == null ? -1 : Math.floor(s.overall * 100)
      if (pct === lastPct) return
      lastPct = pct
      try {
        renderer.setTerminalTitle(pct >= 0 ? `fluxware · ${pct}%` : "fluxware")
        if (pct >= 0) renderer.setProgramStatus({ state: "working", app: "fluxware", progress: pct, message: `${s.running + s.queued} в работе` })
      } catch {
        // The terminal may be gone during shutdown.
      }
    }
    const offJobs = queue.subscribe(update)
    const offIdle = queue.onIdle((stats) => {
      const message =
        `готово ${stats.done}` + (stats.failed ? `, ошибок ${stats.failed}` : "") + (stats.canceled ? `, отменено ${stats.canceled}` : "")
      try {
        renderer.setProgramStatus({ state: stats.failed && !stats.done ? "error" : "done", app: "fluxware", message })
        if (!terminalFocused.current || stats.done + stats.failed > 1) renderer.triggerNotification(message, "fluxware")
      } catch {
        // Same as above.
      }
    })
    update()
    return () => {
      offJobs()
      offIdle()
    }
  }, [renderer, services])

  const compact = height < 20
  const contentWidth = Math.max(20, width - 4)
  const contentHeight = Math.max(6, height - 3 - (compact ? 1 : 2) - 2)
  const navFocused = area === "nav" && !notice
  const contentFocused = area === "content" && !notice
  const focusContent = () => setArea("content")

  return (
    <box flexDirection="column" width={width} height={height}>
      <TabBar
        section={section}
        focused={navFocused}
        navRef={navRef}
        onPick={(id) => {
          setSection(id)
          setArea("content")
        }}
      />
      <box
        ref={contentRef}
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={contentFocused ? theme.accent : theme.line}
        paddingX={1}
        onMouseDown={focusContent}
      >
        {/* Every screen stays mounted, so a half-typed link survives a trip to another section. */}
        {SECTIONS.map((s) => (
          <box key={s.id} visible={s.id === section} flexGrow={1} flexDirection="column">
            <Screen
              section={s.id}
              focused={contentFocused && s.id === section}
              width={contentWidth}
              height={contentHeight}
              onFocusRequest={focusContent}
              entry={entry}
            />
          </box>
        ))}
      </box>
      <BottomBar compact={compact} toast={props.toast} width={width} />
      {notice ? <Notice title={notice.title} lines={notice.lines} onClose={() => setNotice(null)} width={width} height={height} /> : null}
    </box>
  )
}
