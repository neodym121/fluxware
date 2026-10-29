import type { ScrollBoxRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { existsSync } from "node:fs"
import { basename } from "node:path"
import { useEffect, useRef, useState } from "react"
import { groupByDay, timeLabel, type HistoryEntry } from "../../core/history"
import { getLanguage, tr } from "../../core/i18n"
import { revealInFileManager } from "../../core/process"
import { isFinished, type Job } from "../../core/queue"
import { JobRow } from "../components"
import { useHistory, useJobs, useServices, useSettings } from "../context"
import { theme } from "../theme"
import type { ScreenProps } from "./shared"

type Row =
  | { kind: "header"; key: string; label: string }
  | { kind: "job"; key: string; job: Job }
  | { kind: "entry"; key: string; entry: HistoryEntry }

function EntryRow(props: { entry: HistoryEntry; selected: boolean }) {
  const { entry } = props
  return (
    <box flexDirection="row" height={1} flexShrink={0} backgroundColor={props.selected ? theme.selection : undefined}>
      <text wrapMode="none" flexGrow={1} flexShrink={1}>
        <span fg={theme.faint}>{`[${entry.platform}] `}</span>
        <span fg={props.selected ? theme.accent : theme.text}>{entry.title}</span>
        {entry.author ? <span fg={theme.muted}>{` — ${entry.author}`}</span> : null}
      </text>
      <text fg={theme.faint} flexShrink={0}>
        {"  " + timeLabel(new Date(entry.time))}
      </text>
    </box>
  )
}

export function HistoryScreen(props: ScreenProps) {
  const { queue, history, toast } = useServices()
  const settings = useSettings()
  const jobs = useJobs()
  const entries = useHistory()
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** Red line at the bottom, for a file that is gone from where it was saved. */
  const [missing, setMissing] = useState<string | null>(null)
  const missingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (missingTimer.current) clearTimeout(missingTimer.current)
  }, [])

  /** Shows the file where it was saved, or says that it is not there any more. */
  function openEntry(entry: HistoryEntry) {
    const file = entry.files.length === 1 ? entry.files[0] : null
    const gone = file ? !existsSync(file) : !existsSync(entry.dir)
    if (gone) {
      setMissing(file ? `${tr("файл не найден", "file not found")}: ${basename(file)}` : `${tr("папка не найдена", "folder not found")}: ${entry.dir}`)
      if (missingTimer.current) clearTimeout(missingTimer.current)
      missingTimer.current = setTimeout(() => setMissing(null), 6000)
      return
    }
    setMissing(null)
    revealInFileManager({ dir: entry.dir, file })
  }
  const openRef = useRef(openEntry)
  openRef.current = openEntry

  // On top: what is still running, waiting, or ended without a file this session.
  const current = jobs.filter((j) => j.status !== "done")
  const rows: Row[] = []
  if (current.length) {
    rows.push({ kind: "header", key: "h-now", label: tr("сейчас", "now") })
    for (const job of [...current].reverse()) rows.push({ kind: "job", key: `j${job.id}`, job })
  }
  for (const day of groupByDay(entries)) {
    rows.push({ kind: "header", key: `h-${day.key}`, label: day.label })
    for (const entry of day.entries) rows.push({ kind: "entry", key: `e${entry.id}`, entry })
  }
  const selectable = rows.filter((r) => r.kind !== "header")
  const found = selectable.findIndex((r) => r.key === selectedKey)
  const index = found === -1 ? 0 : found
  const selected = selectable[index]

  const latest = useRef({ selectable, index, selected })
  latest.current = { selectable, index, selected }

  useEffect(() => {
    if (selected) scrollRef.current?.scrollChildIntoView(`row-${selected.key}`)
  }, [selected?.key])

  function move(delta: number) {
    const { selectable, index } = latest.current
    const next = selectable[Math.min(selectable.length - 1, Math.max(0, index + delta))]
    if (next) setSelectedKey(next.key)
  }

  useBindings(
    () => ({
      targetRef: scrollRef,
      targetMode: "focus",
      priority: 20,
      bindings: [
        { key: "up", desc: tr("выбор", "select"), cmd: () => move(-1) },
        { key: "down", desc: tr("выбор", "select"), cmd: () => move(1) },
        { key: "k", cmd: () => move(-1) },
        { key: "j", cmd: () => move(1) },
        { key: "pageup", cmd: () => move(-10) },
        { key: "pagedown", cmd: () => move(10) },
        {
          key: "return",
          desc: tr("открыть папку", "open folder"),
          cmd: () => {
            const row = latest.current.selected
            if (row?.kind === "entry") openRef.current(row.entry)
            else if (row?.kind === "job") revealInFileManager({ dir: row.job.dir })
          },
        },
        {
          key: "delete",
          desc: tr("отменить/удалить", "cancel/remove"),
          cmd: () => {
            const row = latest.current.selected
            if (row?.kind === "entry") history.remove(row.entry.id)
            else if (row?.kind === "job") {
              if (isFinished(row.job)) queue.remove(row.job.id)
              else queue.cancel(row.job.id)
            }
          },
        },
        {
          key: "r, к",
          desc: tr("повторить", "retry"),
          cmd: () => {
            const row = latest.current.selected
            if (row?.kind === "job" && (row.job.status === "failed" || row.job.status === "canceled")) queue.retry(row.job.id)
            else if (row?.kind === "entry") {
              const e = row.entry
              queue.add([{ url: e.url, kind: e.kind, height: e.height, source: "download", dir: e.dir }])
              toast(`${tr("снова в очереди", "queued again")}: ${e.title}`, "ok")
            }
          },
        },
      ],
    }),
    [getLanguage()],
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      {!settings.history ? (
        <text fg={theme.faint} wrapMode="none">
          {tr(
            "история не сохраняется: включи её в настройках. сейчас видны только загрузки этого запуска",
            "history is not saved: turn it on in the settings. only downloads of this session are shown",
          )}
        </text>
      ) : null}
      <scrollbox
        ref={scrollRef}
        focused={props.focused}
        flexGrow={1}
        scrollbarOptions={{ trackOptions: { foregroundColor: theme.muted, backgroundColor: theme.track } }}
        onMouseDown={props.onFocusRequest}
      >
        {rows.length === 0 ? (
          <text fg={theme.faint} wrapMode="word">
            {tr(
              "история пуста. всё, что скачается в разделах «скачка» и «пакет», появится здесь с датой и временем.",
              "the history is empty. everything downloaded in the \"download\" and \"batch\" sections will appear here with the date and time.",
            )}
          </text>
        ) : (
          rows.map((row, i) => {
            if (row.kind === "header") {
              return (
                <text key={row.key} id={`row-${row.key}`} fg={theme.muted} marginTop={i === 0 ? 0 : 1} flexShrink={0}>
                  {row.label}
                </text>
              )
            }
            const isSelected = props.focused && row.key === selected?.key
            // A click on a finished download opens it where it was saved.
            const pick = () => {
              props.onFocusRequest()
              setSelectedKey(row.key)
              if (row.kind === "entry") openEntry(row.entry)
            }
            return (
              <box key={row.key} id={`row-${row.key}`} flexShrink={0} onMouseDown={pick}>
                {row.kind === "job" ? (
                  <JobRow job={row.job} width={props.width - 2} selected={isSelected} stacked />
                ) : (
                  <EntryRow entry={row.entry} selected={isSelected} />
                )}
              </box>
            )
          })
        )}
      </scrollbox>
      {missing ? (
        <text fg={theme.error} wrapMode="none" flexShrink={0}>
          {"✗ " + missing}
        </text>
      ) : null}
    </box>
  )
}
