import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import type { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { useMemo, useRef, useState } from "react"
import { plural } from "../../core/format"
import { isFinished } from "../../core/queue"
import { audioDirOf, videoDirOf } from "../../core/settings"
import { extractUrls, hideSchemes } from "../../core/urls"
import { ButtonRow, FocusButton, JobRow, ProgressBar, PromptInput, type ButtonItem } from "../components"
import { useJobs, useServices, useSettings } from "../context"
import { theme } from "../theme"
import { ErrorLine, useFocusEntry, type ScreenProps } from "./shared"

const QUALITIES = [
  { id: "max", label: "максимальное", height: null },
  { id: "1080", label: "1080p", height: 1080 },
  { id: "720", label: "720p", height: 720 },
  { id: "480", label: "480p", height: 480 },
  { id: "min", label: "минимальное (360p)", height: 360 },
] as const

/** Reads a text file as UTF-8, falling back to Windows-1251 for old Russian files. */
export function readTextFile(path: string): string {
  const bytes = readFileSync(path)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("windows-1251").decode(bytes)
  }
}

export function cleanPathInput(raw: string): string {
  const p = raw.trim().replace(/^["']+|["']+$/g, "")
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? homedir() + p.slice(1) : p
}

/** Focus zones in Tab order. The file field exists only while it is open. */
type Zone = "text" | "buttons" | "file" | "start"

export function BatchScreen(props: ScreenProps) {
  const services = useServices()
  const settings = useSettings()
  const allJobs = useJobs()
  const textRef = useRef<TextareaRenderable>(null)
  const rootRef = useRef<BoxRenderable>(null)
  const [text, setText] = useState("")
  const [inner, setInner] = useState<Zone>("text")
  const [buttonIndex, setButtonIndex] = useState(0)
  const [audio, setAudio] = useState(false)
  const [quality, setQuality] = useState(0)
  const [filePath, setFilePath] = useState("")
  const [fileOpen, setFileOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Jobs of the last started batch, shown with their progress. */
  const [runIds, setRunIds] = useState<number[]>([])
  const urls = useMemo(() => extractUrls(text), [text])

  const zones: Zone[] = fileOpen ? ["text", "buttons", "file", "start"] : ["text", "buttons", "start"]
  const latest = useRef({ inner, urls, zones, start: () => {} })
  latest.current = { inner, urls, zones, start: () => start() }

  function step(delta: 1 | -1): boolean {
    const { zones, inner } = latest.current
    const next = zones[zones.indexOf(inner) + delta]
    if (!next) return false
    setInner(next)
    return true
  }

  useBindings(
    () => ({
      targetRef: rootRef,
      priority: 10,
      bindings: [
        {
          key: "escape",
          desc: "назад",
          cmd: () => {
            const i = latest.current.inner
            if (i === "file") {
              setFileOpen(false)
              setInner("buttons")
            } else if (i !== "text") setInner("text")
            else return false
            setError(null)
          },
        },
        // Tab walks text → buttons → file field → start; past the last one it falls through to the app.
        { key: "tab", desc: "окно", cmd: () => step(1) },
        { key: "shift+tab", cmd: () => step(-1) },
        { key: "ctrl+s", desc: "начать", cmd: () => latest.current.start() },
      ],
    }),
    [],
  )

  useFocusEntry(props.entry, (edge) => setInner(edge === "first" ? "text" : "start"))

  const q = QUALITIES[quality] ?? QUALITIES[0]
  const buttons: ButtonItem[] = [
    { key: "format", label: audio ? `аудио · ${settings.audioFormat.toUpperCase()}` : `видео · ${settings.videoFormat.toUpperCase()}` },
    { key: "quality", label: audio ? "качество: лучшее" : `качество: ${q.label}`, disabled: audio },
    { key: "file", label: "из файла…" },
  ]

  function press(item: ButtonItem) {
    if (item.key === "format") setAudio((a) => !a)
    else if (item.key === "quality") setQuality((v) => (v + 1) % QUALITIES.length)
    else if (item.key === "file") {
      setError(null)
      setFileOpen(true)
      setInner("file")
    }
  }

  function start() {
    const list = latest.current.urls
    if (list.length === 0) {
      setError("не найдено ни одной ссылки")
      return
    }
    const dir = audio ? audioDirOf(settings) : videoDirOf(settings)
    const added = services.queue.add(
      list.map((url) => ({ url, kind: audio ? ("audio" as const) : ("video" as const), height: audio ? null : q.height, source: "batch" as const, dir })),
    )
    setRunIds(added.map((j) => j.id))
    services.toast(`в очереди: ${list.length} ${plural(list.length, "ссылка", "ссылки", "ссылок")}`, "ok")
    textRef.current?.setText("")
    setText("")
    setInner("text")
  }

  function loadFile(raw: string) {
    const path = cleanPathInput(raw)
    if (!path) {
      setFileOpen(false)
      setInner("buttons")
      return
    }
    if (!existsSync(path)) return setError(`файл не найден: ${path}`)
    if (!statSync(path).isFile()) return setError(`это не файл: ${path}`)
    let content: string
    try {
      content = readTextFile(path)
    } catch (e) {
      return setError(`не удалось прочитать файл: ${e instanceof Error ? e.message : e}`)
    }
    const found = extractUrls(content)
    if (found.length === 0) return setError("в файле нет ни одной ссылки")
    const current = textRef.current?.plainText.trimEnd() ?? ""
    const next = (current ? current + "\n" : "") + hideSchemes(found.join("\n"))
    textRef.current?.setText(next)
    setText(next)
    setError(null)
    setFilePath("")
    setFileOpen(false)
    setInner("start")
    services.toast(`из файла: ${found.length} ${plural(found.length, "ссылка", "ссылки", "ссылок")}`, "ok")
  }

  // Pasted links lose their scheme on screen, see hideSchemes().
  function onTextChange() {
    const area = textRef.current
    if (!area) return
    const raw = area.plainText
    if (/https?:\/\//i.test(raw)) {
      const cleaned = hideSchemes(raw)
      area.setText(cleaned)
      area.gotoBufferEnd()
      setText(cleaned)
    } else setText(raw)
  }

  const runJobs = allJobs.filter((j) => runIds.includes(j.id))
  const done = runJobs.filter((j) => j.status === "done").length
  const failed = runJobs.filter((j) => j.status === "failed").length
  const finished = runJobs.filter(isFinished).length
  const runProgress = runJobs.length
    ? runJobs.reduce((sum, j) => sum + (isFinished(j) ? 1 : j.status === "running" ? j.progress ?? 0 : 0), 0) / runJobs.length
    : 0
  const textHeight = runJobs.length ? Math.max(3, Math.min(6, props.height - 22)) : Math.max(4, Math.min(14, props.height - 14))
  const focusZone = (zone: Zone) => () => {
    props.onFocusRequest()
    setInner(zone)
  }

  return (
    <box ref={rootRef} flexDirection="column" flexGrow={1}>
      <text fg={theme.muted} flexShrink={0}>
        ссылки: вставь любой текст, ссылки найдутся сами
      </text>
      <box
        border
        borderStyle="single"
        borderColor={props.focused && inner === "text" ? theme.muted : theme.line}
        height={textHeight + 2}
        flexShrink={0}
        onMouseDown={focusZone("text")}
      >
        <textarea
          ref={textRef}
          focused={props.focused && inner === "text"}
          placeholder={"youtu.be/…\nsoundcloud.com/…\nили кусок переписки со ссылками"}
          placeholderColor={theme.faint}
          textColor={theme.text}
          focusedTextColor={theme.accent}
          cursorColor={theme.accent}
          wrapMode="char"
          flexGrow={1}
          onContentChange={onTextChange}
        />
      </box>
      <text fg={theme.faint} flexShrink={0}>
        найдено ссылок: <span fg={urls.length ? theme.accent : theme.faint}>{String(urls.length)}</span>
        {"  ·  tab — к кнопкам · ctrl+s — начать"}
      </text>
      <box marginTop={1} flexShrink={0} alignItems="center">
        <ButtonRow
          items={buttons}
          index={buttonIndex}
          onIndexChange={setButtonIndex}
          onPress={press}
          focused={props.focused && inner === "buttons"}
          onExitTop={() => setInner("text")}
          onExitBottom={() => setInner(fileOpen ? "file" : "start")}
          onFocusRequest={focusZone("buttons")}
        />
      </box>
      {fileOpen ? (
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <text fg={theme.muted}>путь до файла со ссылками (можно перетащить файл в окно)</text>
          <PromptInput
            value={filePath}
            onInput={setFilePath}
            onSubmit={loadFile}
            focused={props.focused && inner === "file"}
            placeholder="C:\\Users\\…\\links.txt"
            onMouseDown={focusZone("file")}
          />
        </box>
      ) : null}
      <box marginTop={1} flexShrink={0} alignItems="center">
        <FocusButton
          label="Скачать!"
          primary
          disabled={urls.length === 0}
          focused={props.focused && inner === "start"}
          onPress={start}
          onExitTop={() => setInner(fileOpen ? "file" : "buttons")}
          onFocusRequest={focusZone("start")}
        />
      </box>
      <ErrorLine text={error} />
      {runJobs.length ? (
        <box flexDirection="column" marginTop={1} flexGrow={1}>
          <box flexDirection="row" height={1} flexShrink={0}>
            <text wrapMode="none" flexShrink={0}>
              <span fg={theme.text}>{`пакет: готово ${done} из ${runJobs.length}`}</span>
              {failed ? <span fg={theme.error}>{` · ошибок ${failed}`}</span> : null}
              <span fg={theme.faint}>{finished === runJobs.length ? " · всё" : ""}</span>
            </text>
            <box flexGrow={1} paddingLeft={2}>
              <ProgressBar value={runProgress} width={Math.max(10, props.width - 40)} />
            </box>
          </box>
          <scrollbox flexGrow={1} marginTop={1}>
            {runJobs.map((job) => (
              <JobRow key={job.id} job={job} width={props.width - 2} />
            ))}
          </scrollbox>
        </box>
      ) : null}
    </box>
  )
}
