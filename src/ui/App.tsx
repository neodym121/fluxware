import type { BoxRenderable } from "@opentui/core"
import { useActiveKeys, useBindings } from "@opentui/keymap/react"
import { useBlur, useFocus, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState, type RefObject } from "react"
import { formatSpeed, truncate } from "../core/format"
import { count, tr } from "../core/i18n"
import { useJobs, useServices, useSettings, useSpinner, type Toast } from "./context"
import { AboutScreen, ffmpegInstallHint, ytdlpInstallHint } from "./screens/AboutScreen"
import { BatchScreen } from "./screens/BatchScreen"
import { DownloadScreen } from "./screens/DownloadScreen"
import { HistoryScreen } from "./screens/HistoryScreen"
import { SettingsScreen } from "./screens/SettingsScreen"
import type { FocusEntry, ScreenProps } from "./screens/shared"
import { theme } from "./theme"

export const SECTION_IDS = ["download", "batch", "history", "settings", "about"] as const

export type SectionId = (typeof SECTION_IDS)[number]

function sectionLabel(id: SectionId): string {
  switch (id) {
    case "download":
      return tr("скачка", "download")
    case "batch":
      return tr("пакет", "batch")
    case "history":
      return tr("история", "history")
    case "settings":
      return tr("настройки", "settings")
    case "about":
      return tr("о программе", "about")
  }
}

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
        {`${tr("готово", "done")} ${s.done}`}
        {s.failed ? <span fg={theme.error}>{` · ${tr("ошибок", "errors")} ${s.failed}`}</span> : null}
      </text>
    )
  }
  const pct = s.overall != null ? ` · ${Math.floor(s.overall * 100)}%` : ""
  const speed = s.speed ? ` · ${formatSpeed(s.speed)}` : ""
  return (
    <text wrapMode="none" flexShrink={0}>
      <span fg={theme.accent}>{frame + " "}</span>
      <span fg={theme.text}>{`${s.running} ${count(s.running, ["загрузка", "загрузки", "загрузок"], ["download", "downloads"])}`}</span>
      <span fg={theme.muted}>{(s.queued ? ` · ${tr("ждут", "waiting")} ${s.queued}` : "") + speed + pct}</span>
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
  if (tools === null) return <span fg={theme.faint}>{tr("проверяю yt-dlp…", "checking yt-dlp…")}</span>
  return tools.ytdlp ? <span fg={theme.faint}>{`yt-dlp ${tools.ytdlp.version}`}</span> : <span fg={theme.error}>{tr("yt-dlp не найден", "yt-dlp not found")}</span>
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
  const { language } = useSettings()
  const close = useRef(props.onClose)
  close.current = props.onClose
  useBindings(
    () => ({
      priority: 100,
      bindings: [
        { key: "return", desc: tr("понятно", "got it"), cmd: () => close.current() },
        { key: "escape", cmd: () => close.current() },
      ],
    }),
    [language],
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
        {tr("enter — понятно", "enter — got it")}
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
      {SECTION_IDS.map((id) => {
        const label = sectionLabel(id)
        const selected = id === props.section
        const badge = id === "history" && active ? ` ${spinner}${active}` : ""
        // Same "current" step as buttons: brighter than a selected row, darker than focus.
        const bg = selected ? (props.focused ? theme.accent : theme.line) : undefined
        const fg = selected ? (props.focused ? "#000000" : theme.accent) : theme.muted
        return (
          <box
            key={id}
            height={1}
            flexGrow={1}
            flexBasis={0}
            justifyContent="center"
            flexDirection="row"
            backgroundColor={bg}
            onMouseDown={() => props.onPick(id)}
          >
            <text fg={fg} wrapMode="none">
              {selected ? <b>{label + badge}</b> : label + badge}
            </text>
          </box>
        )
      })}
    </box>
  )
}

export function App(props: { toast: Toast | null; initialSection?: SectionId }) {
  const services = useServices()
  // The tab labels and key hints are built from the language, so a change re-renders them.
  const { language } = useSettings()
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
      services.toast(
        tr(`идут загрузки (${active}): нажми ещё раз, чтобы прервать их и выйти`, `downloads in progress (${active}): press again to cancel them and quit`),
        "warn",
      )
      return
    }
    services.quit()
  }
  const quitRef = useRef(requestQuit)
  quitRef.current = requestQuit

  function moveSection(delta: number) {
    const i = SECTION_IDS.indexOf(latest.current.section)
    const next = SECTION_IDS[(i + delta + SECTION_IDS.length) % SECTION_IDS.length]
    if (next) setSection(next)
  }

  function enterContent(edge: FocusEntry["edge"]) {
    setEntry((e) => ({ seq: e.seq + 1, edge }))
    setArea("content")
  }

  useBindings(() => ({ bindings: [{ key: "ctrl+c", desc: tr("выход", "quit"), cmd: () => quitRef.current() }] }), [language])

  useBindings(
    () => ({
      targetRef: navRef,
      targetMode: "focus",
      priority: 10,
      bindings: [
        { key: "left", desc: tr("раздел", "section"), cmd: () => moveSection(-1) },
        { key: "right", desc: tr("раздел", "section"), cmd: () => moveSection(1) },
        { key: "h", cmd: () => moveSection(-1) },
        { key: "l", cmd: () => moveSection(1) },
        { key: "return", desc: tr("открыть", "open"), cmd: () => enterContent("first") },
        { key: "down", cmd: () => enterContent("first") },
        { key: "tab", desc: tr("окно", "pane"), cmd: () => enterContent("first") },
        { key: "shift+tab", cmd: () => enterContent("last") },
        ...SECTION_IDS.map((id, i) => ({
          key: String(i + 1),
          cmd: () => {
            setSection(id)
            enterContent("first")
          },
        })),
        { key: "q, й", desc: tr("выход", "quit"), cmd: () => quitRef.current() },
      ],
    }),
    [language],
  )

  // Screens handle Tab inside themselves first and fall through here at their edges.
  useBindings(
    () => ({
      targetRef: contentRef,
      bindings: [
        { key: "escape", desc: tr("к разделам", "to sections"), cmd: () => setArea("nav") },
        { key: "tab", desc: tr("окно", "pane"), cmd: () => setArea("nav") },
        { key: "shift+tab", cmd: () => setArea("nav") },
      ],
    }),
    [language],
  )

  // Startup notice about missing tools, once detection finishes.
  useEffect(() => {
    const tools = services.tools
    if (!tools || noticeShown.current) return
    noticeShown.current = true
    const lines: string[] = []
    if (!tools.ytdlp) lines.push(
        tr("yt-dlp не найден: без него fluxware ничего не скачает.", "yt-dlp not found: fluxware cannot download anything without it."),
        `${tr("установка", "install")}: ${ytdlpInstallHint()}`,
      )
    if (!tools.ffmpeg)
      lines.push(
        tr(
          "ffmpeg не найден в PATH: не будут работать склейка видео и звука, извлечение аудио и обложки.",
          "ffmpeg not found in PATH: merging video and audio, audio extraction and covers will not work.",
        ),
        `${tr("установка", "install")}: ${ffmpegInstallHint()}`,
      )
    if (lines.length) setNotice({ title: tools.ytdlp ? tr("не хватает ffmpeg", "ffmpeg is missing") : tr("не хватает yt-dlp", "yt-dlp is missing"), lines })
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
        if (pct >= 0) renderer.setProgramStatus({ state: "working", app: "fluxware", progress: pct, message: `${s.running + s.queued} ${tr("в работе", "in progress")}` })
      } catch {
        // The terminal may be gone during shutdown.
      }
    }
    const offJobs = queue.subscribe(update)
    const offIdle = queue.onIdle((stats) => {
      const message =
        `${tr("готово", "done")} ${stats.done}` +
        (stats.failed ? `, ${tr("ошибок", "errors")} ${stats.failed}` : "") +
        (stats.canceled ? `, ${tr("отменено", "canceled")} ${stats.canceled}` : "")
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
        {SECTION_IDS.map((id) => (
          <box key={id} visible={id === section} flexGrow={1} flexDirection="column">
            <Screen
              section={id}
              focused={contentFocused && id === section}
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
