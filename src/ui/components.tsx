import type { BoxRenderable, InputRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { useRenderer } from "@opentui/react"
import { useEffect, useRef, type ReactNode } from "react"
import { basename } from "node:path"
import { formatDuration, formatSpeed, truncate } from "../core/format"
import { count, getLanguage, tr } from "../core/i18n"
import { hideSchemes, shortUrl } from "../core/urls"
import type { Job } from "../core/queue"
import { useSpinner } from "./context"
import { theme } from "./theme"

/** One labelled line: dim label, normal value. */
export function Field(props: { label: string; width?: number; children?: ReactNode; color?: string }) {
  return (
    <box flexDirection="row" height={1}>
      <text fg={theme.faint} width={props.width ?? 10} flexShrink={0}>
        {props.label}
      </text>
      <text fg={props.color ?? theme.text} wrapMode="none" flexShrink={1}>
        {props.children}
      </text>
    </box>
  )
}

export interface MenuItem {
  key: string
  label: string
  value?: string
  /** Shown in gray after the value, for example "←/→". */
  hint?: string
  disabled?: boolean
}

export interface MenuProps {
  items: readonly MenuItem[]
  index: number
  onIndexChange: (index: number) => void
  onActivate: (item: MenuItem, index: number) => void
  focused: boolean
  /** Left/Right on an item; return false to ignore. */
  onCycle?: (item: MenuItem, direction: 1 | -1) => boolean
  /** Up on the first item, usually moves focus to a field above. */
  onExitTop?: () => void
  /** Up on the first item goes to the last one, and down on the last to the first. */
  wrap?: boolean
  labelWidth?: number
  onFocusRequest?: () => void
}

/**
 * Vertical list driven by a local keymap layer: the bindings exist only
 * while this box has focus, and the footer shows them from the keymap.
 */
export function Menu(props: MenuProps) {
  const ref = useRef<BoxRenderable>(null)
  const latest = useRef(props)
  latest.current = props

  useBindings(
    () => ({
      targetRef: ref,
      targetMode: "focus",
      priority: 20,
      bindings: [
        { key: "up", desc: tr("выбор", "select"), cmd: () => move(-1) },
        { key: "down", desc: tr("выбор", "select"), cmd: () => move(1) },
        { key: "k", cmd: () => move(-1) },
        { key: "j", cmd: () => move(1) },
        { key: "home", cmd: () => jump(0) },
        { key: "end", cmd: () => jump(latest.current.items.length - 1) },
        { key: "return", desc: tr("выбрать", "choose"), cmd: () => activate() },
        { key: "space", cmd: () => activate() },
        { key: "left", cmd: () => cycle(-1) },
        { key: "right", cmd: () => cycle(1) },
      ],
    }),
    [getLanguage()],
  )

  function move(delta: number): boolean | void {
    const p = latest.current
    if (p.items.length === 0) return
    if (delta < 0 && p.index === 0 && p.onExitTop) {
      p.onExitTop()
      return
    }
    if (p.wrap) {
      p.onIndexChange((((p.index + delta) % p.items.length) + p.items.length) % p.items.length)
      return
    }
    const next = Math.min(p.items.length - 1, Math.max(0, p.index + delta))
    p.onIndexChange(next)
  }

  function jump(index: number) {
    const p = latest.current
    if (p.items.length) p.onIndexChange(Math.max(0, index))
  }

  function activate() {
    const p = latest.current
    const item = p.items[p.index]
    if (item && !item.disabled) p.onActivate(item, p.index)
  }

  function cycle(direction: 1 | -1): boolean {
    const p = latest.current
    const item = p.items[p.index]
    if (!item || item.disabled || !p.onCycle) return false
    return p.onCycle(item, direction)
  }

  const labelWidth = props.labelWidth ?? Math.max(...props.items.map((i) => i.label.length), 0) + 3
  return (
    <box ref={ref} focusable focused={props.focused} flexDirection="column" flexShrink={0}>
      {props.items.map((item, i) => {
        const selected = i === props.index
        const active = selected && props.focused
        const fg = item.disabled ? theme.faint : selected ? theme.accent : theme.text
        return (
          <box
            key={item.key}
            flexDirection="row"
            height={1}
            backgroundColor={active ? theme.selection : undefined}
            onMouseDown={() => {
              props.onFocusRequest?.()
              if (i === latest.current.index) activate()
              else latest.current.onIndexChange(i)
            }}
          >
            <text fg={active ? theme.accent : selected ? theme.muted : theme.selection} width={2} flexShrink={0}>
              {selected ? "▌" : " "}
            </text>
            <text fg={fg} width={labelWidth} flexShrink={0} wrapMode="none">
              {active ? <b>{item.label}</b> : item.label}
            </text>
            {item.value !== undefined ? (
              <text fg={item.disabled ? theme.faint : selected ? theme.accent : theme.muted} wrapMode="none" flexShrink={1}>
                {item.value}
              </text>
            ) : null}
            {item.hint && active ? (
              <text fg={theme.faint} wrapMode="none" flexShrink={0}>
                {"  " + item.hint}
              </text>
            ) : null}
          </box>
        )
      })}
    </box>
  )
}

/** One-line text field with a prompt glyph, the main way to paste links. */
export function PromptInput(props: {
  value: string
  onInput: (value: string) => void
  onSubmit: (value: string) => void
  focused: boolean
  placeholder?: string
  onMouseDown?: () => void
  /** Select the prefilled text on focus, so typing or pasting replaces it. */
  selectOnFocus?: boolean
  /** No fill of its own, for a field inside a bordered box. */
  bare?: boolean
}) {
  const ref = useRef<InputRenderable>(null)
  const renderer = useRenderer()
  useEffect(() => {
    if (!props.focused || !props.selectOnFocus) return
    // A new field has no width until its first layout, and selecting text in
    // a zero-width view selects nothing; wait one laid-out frame.
    let handle = renderer.requestAnimationFrame(() => {
      handle = renderer.requestAnimationFrame(() => ref.current?.selectAll())
    })
    return () => renderer.cancelAnimationFrame(handle)
  }, [props.focused, props.selectOnFocus, renderer])
  const fill = props.bare ? "transparent" : theme.field
  const focusedFill = props.bare ? "transparent" : theme.fieldFocused
  return (
    <box flexDirection="row" height={1} backgroundColor={props.focused ? focusedFill : fill} onMouseDown={props.onMouseDown}>
      <text fg={props.focused ? theme.accent : theme.faint} width={2} flexShrink={0}>
        {"›"}
      </text>
      <input
        ref={ref}
        value={props.value}
        onInput={props.onInput}
        // The prop type merges Textarea's SubmitEvent handler with Input's value
        // handler; InputRenderable only ever emits its "enter" event with the text.
        onSubmit={(value: unknown) => props.onSubmit(typeof value === "string" ? value : props.value)}
        focused={props.focused}
        placeholder={props.placeholder}
        placeholderColor={theme.faint}
        textColor={theme.text}
        focusedTextColor={theme.accent}
        backgroundColor={fill}
        focusedBackgroundColor={focusedFill}
        cursorColor={theme.accent}
        flexGrow={1}
      />
    </box>
  )
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

/** Smooth bar: whole cells plus an eighth-block for the remainder. */
export function ProgressBar(props: { value: number | null; width: number; dim?: boolean }) {
  const width = Math.max(1, props.width)
  if (props.value == null) {
    return <text fg={theme.track}>{"─".repeat(width)}</text>
  }
  const exact = Math.min(1, Math.max(0, props.value)) * width
  const full = Math.floor(exact)
  const part = EIGHTHS[Math.floor((exact - full) * 8)] ?? ""
  const rest = Math.max(0, width - full - (part ? 1 : 0))
  return (
    <text>
      <span fg={props.dim ? theme.muted : theme.accent} bg={theme.track}>
        {"█".repeat(full) + part}
      </span>
      <span fg={theme.track} bg={theme.track}>
        {" ".repeat(rest)}
      </span>
    </text>
  )
}

export function Spinner(props: { text: string }) {
  const frame = useSpinner(true)
  return (
    <text>
      <span fg={theme.accent}>{frame}</span>
      <span fg={theme.muted}>{" " + props.text}</span>
    </text>
  )
}

export function jobTitle(job: Job): { platform: string; title: string; author: string | null } {
  if (job.label) return job.label
  return { platform: job.kind === "audio" ? tr("аудио", "audio") : tr("видео", "video"), title: shortUrl(job.url, 80), author: null }
}

/** Right-hand status text of a job, without the bar. */
export function jobStatusText(job: Job): string {
  switch (job.status) {
    case "queued":
      return tr("в очереди", "queued")
    case "canceled":
      return tr("отменено", "canceled")
    case "failed":
      return tr("ошибка", "error")
    case "done":
      return job.files.length > 1
        ? `${tr("готово", "done")} · ${job.files.length} ${count(job.files.length, ["файл", "файла", "файлов"], ["file", "files"])}`
        : tr("готово", "done")
    case "running": {
      const item = job.item ? `${job.item.index}/${job.item.count} · ` : ""
      if (job.phase === "processing") return item + (job.postprocessor ?? tr("обработка", "processing"))
      if (job.phase === "starting" || job.progress == null) return item + tr("подготовка", "preparing")
      const pct = `${Math.floor((job.progress ?? 0) * 100)}%`
      const speed = formatSpeed(job.speed)
      const eta = job.eta != null && job.eta > 0 ? formatDuration(job.eta) : ""
      return [item + pct, speed, eta].filter(Boolean).join(" · ")
    }
  }
}

function statusColor(job: Job): string {
  if (job.status === "failed") return theme.error
  if (job.status === "done") return job.warnings.length ? theme.warn : theme.accent
  return job.status === "running" ? theme.text : theme.faint
}

/**
 * Bar and status of one job, for the card on the download screen: the bar
 * takes the whole first line, the second holds `left` (a cancel button) and
 * the status on the right.
 */
export function JobProgress(props: { job: Job; width: number; left?: ReactNode }) {
  const { job } = props
  if (job.status === "failed") {
    return (
      <text fg={theme.error} wrapMode="word">
        {"✗ " + hideSchemes(job.error ?? tr("ошибка", "error"))}
      </text>
    )
  }
  if (job.status === "canceled") return <text fg={theme.muted}>{"– " + tr("отменено", "canceled")}</text>
  if (job.status === "done") {
    const file = job.files.at(-1)
    return (
      <box flexDirection="column" flexShrink={0}>
        <text wrapMode="none">
          <span fg={theme.accent}>{"✓ " + tr("готово", "done")}</span>
          <span fg={theme.muted}>
            {job.files.length > 1
              ? ` · ${job.files.length} ${count(job.files.length, ["файл", "файла", "файлов"], ["file", "files"])}`
              : file ? ` · ${truncate(basename(file), props.width - 10)}` : ""}
          </span>
        </text>
        {job.warnings.map((w, i) => (
          <text key={i} fg={i === 0 ? theme.warn : theme.faint} wrapMode="word">
            {(i === 0 ? "! " : "  ") + w}
          </text>
        ))}
      </box>
    )
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      <ProgressBar value={job.status === "queued" ? null : job.phase === "processing" ? 1 : job.progress} width={props.width} dim={job.phase === "processing"} />
      <box flexDirection="row" height={1} marginTop={1} flexShrink={0}>
        {/* flex-start keeps a button in `left` as wide as its label. */}
        <box flexGrow={1} alignItems="flex-start">
          {props.left}
        </box>
        <text fg={statusColor(job)} wrapMode="none" flexShrink={0}>
          {jobStatusText(job)}
        </text>
      </box>
    </box>
  )
}

/**
 * A job as a list row: title on the left, bar and status on the right, or,
 * with `stacked`, the status on its own line under the title.
 */
export function JobRow(props: { job: Job; width: number; selected?: boolean; stacked?: boolean }) {
  const { job } = props
  const t = jobTitle(job)
  const running = job.status === "running"
  const status = job.status === "failed" ? `${tr("ошибка", "error")}: ${hideSchemes(job.error ?? "")}` : jobStatusText(job)
  const statusWidth = props.stacked ? props.width : Math.min(Math.max(12, Math.floor(props.width * 0.45)), job.status === "failed" ? 60 : 34)
  const barWidth = running && props.width >= 70 ? (props.stacked ? 24 : 12) : 0
  const title = (
    <text wrapMode="none" flexGrow={1} flexShrink={1}>
      <span fg={theme.faint}>{`[${t.platform}] `}</span>
      <span fg={props.selected || running ? theme.accent : theme.text}>{t.title}</span>
      {t.author ? <span fg={theme.muted}>{` — ${t.author}`}</span> : null}
    </text>
  )
  const bar = barWidth ? (
    <box flexShrink={0} paddingLeft={2}>
      <ProgressBar value={job.phase === "processing" ? 1 : job.progress} width={barWidth} dim={job.phase === "processing"} />
    </box>
  ) : null
  const statusText = (
    <text fg={statusColor(job)} wrapMode="none" flexShrink={0}>
      {(props.stacked ? "" : "  ") + truncate(status, statusWidth)}
    </text>
  )
  if (props.stacked) {
    return (
      <box flexDirection="column" flexShrink={0} backgroundColor={props.selected ? theme.selection : undefined}>
        <box flexDirection="row" height={1}>
          {title}
          {bar}
        </box>
        <box flexDirection="row" height={1}>
          {statusText}
        </box>
      </box>
    )
  }
  return (
    <box flexDirection="row" height={1} flexShrink={0} backgroundColor={props.selected ? theme.selection : undefined}>
      {title}
      {bar}
      {statusText}
    </box>
  )
}

/**
 * A button as a block of color. Primary buttons are white like the accent;
 * the others are gray and turn white when the keyboard is on them.
 */
export function Button(props: {
  label: string
  primary?: boolean
  /** Keyboard focus is on this button. */
  focused?: boolean
  /** Selected in a row that has no focus right now. */
  current?: boolean
  disabled?: boolean
  onPress?: () => void
}) {
  let bg: string = theme.selection
  let fg: string = theme.text
  if (props.primary) {
    bg = props.disabled ? theme.faint : theme.accent
    fg = "#000000"
  } else if (props.focused) {
    bg = theme.accent
    fg = "#000000"
  } else if (props.current) {
    bg = theme.line
    fg = theme.accent
  }
  if (props.disabled && !props.primary) fg = theme.faint
  // A primary button is white anyway, so arrows show where the keyboard is.
  const label = props.primary && props.focused ? `› ${props.label} ‹` : ` ${props.label} `
  return (
    <box height={1} flexShrink={0} backgroundColor={bg} onMouseDown={() => !props.disabled && props.onPress?.()}>
      <text fg={fg} wrapMode="none">
        {props.focused || props.primary ? <b>{label}</b> : label}
      </text>
    </box>
  )
}

/** One button that is a focus zone of its own: enter or space presses it. */
export function FocusButton(props: {
  label: string
  primary?: boolean
  disabled?: boolean
  focused: boolean
  onPress: () => void
  onExitTop?: () => void
  onFocusRequest?: () => void
}) {
  const ref = useRef<BoxRenderable>(null)
  const latest = useRef(props)
  latest.current = props
  useBindings(
    () => ({
      targetRef: ref,
      targetMode: "focus",
      priority: 20,
      bindings: [
        { key: "return", desc: tr("нажать", "press"), cmd: () => (latest.current.disabled ? false : latest.current.onPress()) },
        { key: "space", cmd: () => (latest.current.disabled ? false : latest.current.onPress()) },
        { key: "up", cmd: () => (latest.current.onExitTop ? latest.current.onExitTop() : false) },
      ],
    }),
    [getLanguage()],
  )
  return (
    <box ref={ref} focusable focused={props.focused} flexShrink={0}>
      <Button
        label={props.label}
        primary={props.primary}
        disabled={props.disabled}
        focused={props.focused}
        onPress={() => {
          props.onFocusRequest?.()
          props.onPress()
        }}
      />
    </box>
  )
}

export interface ButtonItem {
  key: string
  label: string
  disabled?: boolean
}

/** A row of buttons: ←/→ choose, enter or space presses, ↑/↓ leave the row. */
export function ButtonRow(props: {
  items: readonly ButtonItem[]
  index: number
  onIndexChange: (index: number) => void
  onPress: (item: ButtonItem) => void
  focused: boolean
  onExitTop?: () => void
  onExitBottom?: () => void
  onFocusRequest?: () => void
}) {
  const ref = useRef<BoxRenderable>(null)
  const latest = useRef(props)
  latest.current = props

  function move(delta: number) {
    const p = latest.current
    p.onIndexChange(Math.min(p.items.length - 1, Math.max(0, p.index + delta)))
  }
  function press(): boolean | void {
    const p = latest.current
    const item = p.items[p.index]
    if (!item || item.disabled) return false
    p.onPress(item)
  }

  useBindings(
    () => ({
      targetRef: ref,
      targetMode: "focus",
      priority: 20,
      bindings: [
        { key: "left", desc: tr("кнопка", "button"), cmd: () => move(-1) },
        { key: "right", desc: tr("кнопка", "button"), cmd: () => move(1) },
        { key: "return", desc: tr("нажать", "press"), cmd: () => press() },
        { key: "space", cmd: () => press() },
        { key: "up", cmd: () => (latest.current.onExitTop ? latest.current.onExitTop() : false) },
        { key: "down", cmd: () => (latest.current.onExitBottom ? latest.current.onExitBottom() : false) },
      ],
    }),
    [getLanguage()],
  )

  return (
    <box ref={ref} focusable focused={props.focused} flexDirection="row" flexShrink={0} columnGap={2}>
      {props.items.map((item, i) => (
        <Button
          key={item.key}
          label={item.label}
          disabled={item.disabled}
          focused={props.focused && i === props.index}
          current={!props.focused && i === props.index}
          onPress={() => {
            props.onFocusRequest?.()
            props.onIndexChange(i)
            props.onPress(item)
          }}
        />
      ))}
    </box>
  )
}
