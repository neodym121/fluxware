import { existsSync, mkdirSync, statSync } from "node:fs"
import { resolve } from "node:path"
import type { BoxRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { useRef, useState } from "react"
import { plural, truncatePath } from "../../core/format"
import { revealInFileManager } from "../../core/process"
import {
  AUDIO_FORMATS,
  MAX_CONCURRENCY,
  VIDEO_FORMATS,
  audioDirOf,
  defaultAudioDir,
  defaultVideoDir,
  videoDirOf,
  type Settings,
} from "../../core/settings"
import { checkCustomArgs } from "../../core/ytdlp"
import { Menu, PromptInput, Spinner, type MenuItem } from "../components"
import { useServices, useSettings } from "../context"
import { theme } from "../theme"
import { cleanPathInput } from "./BatchScreen"
import { ErrorLine, type ScreenProps } from "./shared"

type RowKey = "videoFormat" | "audioFormat" | "videoDir" | "audioDir" | "ytdlpArgs" | "concurrency" | "thumbnails" | "history"
type EditKey = "videoDir" | "audioDir" | "ytdlpArgs"

const HELP: Record<RowKey, string> = {
  videoFormat:
    "контейнер видео. MP4 открывается везде, WEBM чаще даёт 4K на YouTube, MKV берёт лучшие дорожки без ограничений по кодекам.",
  audioFormat:
    "OPUS и M4A с YouTube скачиваются без перекодирования. MP3 перекодируется в 192 кбит/с, зато играет на любом устройстве.",
  videoDir: "куда сохраняются видео.",
  audioDir: "куда сохраняются аудио.",
  ytdlpArgs:
    "параметры yt-dlp как в командной строке. применяются ко всем загрузкам и перебивают настройки fluxware при конфликте.",
  concurrency: "сколько загрузок идёт одновременно. остальные ждут в очереди.",
  thumbnails: "превью обложек в разделе «скачка».",
  history:
    "записывать скачанное в лог истории с датой и временем. выключенная история не стирает уже записанное, новые загрузки видны только до выхода.",
}

function cycleValue<T>(list: readonly T[], current: T, direction: 1 | -1): T {
  const i = list.indexOf(current)
  return list[(i + direction + list.length) % list.length] as T
}

function rows(s: Settings, width: number): MenuItem[] {
  const pathWidth = Math.max(16, width - 26)
  const dirValue = (custom: string | null, effective: string) =>
    truncatePath(effective, pathWidth) + (custom ? "" : "  (по умолчанию)")
  return [
    { key: "videoFormat", label: "формат видео", value: s.videoFormat.toUpperCase(), hint: "←/→" },
    { key: "audioFormat", label: "формат аудио", value: s.audioFormat.toUpperCase(), hint: "←/→" },
    { key: "videoDir", label: "папка для видео", value: dirValue(s.videoDir, videoDirOf(s)) },
    { key: "audioDir", label: "папка для аудио", value: dirValue(s.audioDir, audioDirOf(s)) },
    { key: "ytdlpArgs", label: "параметры yt-dlp", value: s.ytdlpArgs ? truncatePath(s.ytdlpArgs, pathWidth) : "не заданы" },
    { key: "concurrency", label: "одновременно", value: `${s.concurrency} ${plural(s.concurrency, "загрузка", "загрузки", "загрузок")}`, hint: "←/→" },
    { key: "thumbnails", label: "превью обложек", value: s.thumbnails ? "вкл" : "выкл", hint: "←/→" },
    { key: "history", label: "история загрузок", value: s.history ? "вкл" : "выкл", hint: "←/→" },
  ]
}

export function SettingsScreen(props: ScreenProps) {
  const services = useServices()
  const settings = useSettings()
  const rootRef = useRef<BoxRenderable>(null)
  const [index, setIndex] = useState(0)
  const [editing, setEditing] = useState<EditKey | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [confirmCreate, setConfirmCreate] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const items = rows(settings, props.width)
  const current = items[index]?.key as RowKey | undefined

  const latest = useRef({ editing, current })
  latest.current = { editing, current }

  // Letter keys exist only while a folder row is selected and no field has
  // focus, so typing a path never triggers them.
  const folderRow = !editing && (current === "videoDir" || current === "audioDir")
  useBindings(
    () => ({
      targetRef: rootRef,
      priority: 10,
      bindings: [
        {
          key: "escape",
          desc: "назад",
          cmd: () => {
            if (!latest.current.editing) return false
            stopEditing()
          },
        },
        ...(folderRow
          ? [
              {
                key: "o, щ",
                desc: "открыть папку",
                cmd: () => {
                  const s = services.settings.get()
                  const dir = latest.current.current === "videoDir" ? videoDirOf(s) : audioDirOf(s)
                  try {
                    mkdirSync(dir, { recursive: true })
                    revealInFileManager({ dir })
                  } catch (e) {
                    services.toast(`не удалось открыть папку: ${e instanceof Error ? e.message : e}`, "error")
                  }
                },
              },
            ]
          : []),
      ],
    }),
    [folderRow],
  )

  function stopEditing() {
    setEditing(null)
    setError(null)
    setConfirmCreate(null)
    setChecking(false)
  }

  function startEditing(key: EditKey) {
    const s = services.settings.get()
    setDraft(key === "ytdlpArgs" ? s.ytdlpArgs : (key === "videoDir" ? s.videoDir : s.audioDir) ?? "")
    setError(null)
    setConfirmCreate(null)
    setEditing(key)
  }

  function cycle(item: MenuItem, direction: 1 | -1): boolean {
    const s = services.settings.get()
    switch (item.key as RowKey) {
      case "videoFormat":
        services.settings.update({ videoFormat: cycleValue(VIDEO_FORMATS, s.videoFormat, direction) })
        return true
      case "audioFormat":
        services.settings.update({ audioFormat: cycleValue(AUDIO_FORMATS, s.audioFormat, direction) })
        return true
      case "concurrency":
        services.settings.update({ concurrency: ((s.concurrency - 1 + direction + MAX_CONCURRENCY) % MAX_CONCURRENCY) + 1 })
        return true
      case "history":
        services.settings.update({ history: !s.history })
        return true
      case "thumbnails":
        services.settings.update({ thumbnails: !s.thumbnails })
        return true
      default:
        return false
    }
  }

  function activate(item: MenuItem) {
    const key = item.key as RowKey
    if (key === "videoDir" || key === "audioDir" || key === "ytdlpArgs") startEditing(key)
    else cycle(item, 1)
  }

  function saveDir(key: "videoDir" | "audioDir", raw: string) {
    const path = cleanPathInput(raw)
    const fallback = key === "videoDir" ? defaultVideoDir() : defaultAudioDir()
    if (!path) {
      services.settings.update({ [key]: null })
      services.toast(`папка по умолчанию: ${fallback}`, "ok")
      stopEditing()
      return
    }
    const absolute = resolve(path)
    if (existsSync(absolute)) {
      if (!statSync(absolute).isDirectory()) return setError(`это файл, а не папка: ${absolute}`)
    } else if (confirmCreate !== absolute) {
      setConfirmCreate(absolute)
      setError(null)
      return
    } else {
      try {
        mkdirSync(absolute, { recursive: true })
      } catch (e) {
        return setError(`не удалось создать папку: ${e instanceof Error ? e.message : e}`)
      }
    }
    services.settings.update({ [key]: absolute })
    services.toast(`${key === "videoDir" ? "видео" : "аудио"} теперь сохраняются в ${absolute}`, "ok")
    stopEditing()
  }

  async function saveArgs(raw: string) {
    const value = raw.trim()
    if (!value) {
      services.settings.update({ ytdlpArgs: "" })
      services.toast("параметры yt-dlp очищены", "ok")
      stopEditing()
      return
    }
    const ytdlp = services.tools?.ytdlp
    if (!ytdlp) return setError("yt-dlp не найден: проверить параметры нечем")
    setChecking(true)
    const check = await checkCustomArgs(ytdlp, value)
    setChecking(false)
    if (!check.ok) return setError(`ошибка в параметрах: ${check.error}`)
    services.settings.update({ ytdlpArgs: value })
    services.toast(`сохранено: ${check.optionCount} ${plural(check.optionCount, "параметр", "параметра", "параметров")}`, "ok")
    stopEditing()
  }

  function submitDraft(value: string) {
    if (editing === "ytdlpArgs") void saveArgs(value)
    else if (editing) saveDir(editing, value)
  }

  return (
    <box ref={rootRef} flexDirection="column" flexGrow={1}>
      <Menu
        items={items}
        index={index}
        onIndexChange={(i) => {
          setIndex(i)
          stopEditing()
        }}
        onActivate={activate}
        onCycle={cycle}
        focused={props.focused && !editing}
        labelWidth={20}
        onFocusRequest={() => {
          props.onFocusRequest()
          stopEditing()
        }}
      />
      {editing ? (
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <text fg={theme.muted}>
            {editing === "ytdlpArgs" ? "параметры yt-dlp · пусто — очистить" : "путь до папки · пусто — папка по умолчанию"}
          </text>
          <PromptInput
            value={draft}
            onInput={(v) => {
              setDraft(v)
              setConfirmCreate(null)
            }}
            onSubmit={submitDraft}
            focused={props.focused}
            selectOnFocus
          />
          {checking ? <Spinner text="проверяю параметры…" /> : null}
          {confirmCreate ? (
            <box flexDirection="column" flexShrink={0}>
              <text fg={theme.warn} wrapMode="word">{`! такой папки нет: ${confirmCreate}`}</text>
              <text fg={theme.muted}>enter — создать · esc — отмена</text>
            </box>
          ) : null}
          <ErrorLine text={error} />
        </box>
      ) : null}
      {/* The description of the selected row sits at the bottom of the window. */}
      <box flexGrow={1} />
      {current ? (
        <text fg={theme.faint} wrapMode="word" flexShrink={0}>
          {HELP[current]}
        </text>
      ) : null}
    </box>
  )
}
