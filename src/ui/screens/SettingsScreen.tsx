import { existsSync, mkdirSync, statSync } from "node:fs"
import { resolve } from "node:path"
import type { BoxRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { useRef, useState } from "react"
import { truncatePath } from "../../core/format"
import { LANGUAGES, LANGUAGE_NAMES, count, getLanguage, tr } from "../../core/i18n"
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

type RowKey = "videoFormat" | "audioFormat" | "videoDir" | "audioDir" | "ytdlpArgs" | "concurrency" | "thumbnails" | "history" | "language"
type EditKey = "videoDir" | "audioDir" | "ytdlpArgs"

function help(key: RowKey): string {
  switch (key) {
    case "videoFormat":
      return tr(
        "контейнер видео. MP4 открывается везде, WEBM чаще даёт 4K на YouTube, MKV берёт лучшие дорожки без ограничений по кодекам.",
        "video container. MP4 opens everywhere, WEBM more often gives 4K on YouTube, MKV takes the best tracks with no codec limits.",
      )
    case "audioFormat":
      return tr(
        "OPUS и M4A с YouTube скачиваются без перекодирования. MP3 перекодируется в 192 кбит/с, зато играет на любом устройстве.",
        "OPUS and M4A from YouTube are saved without re-encoding. MP3 is encoded at 192 kbit/s but plays on any device.",
      )
    case "videoDir":
      return tr("куда сохраняются видео.", "where videos are saved.")
    case "audioDir":
      return tr("куда сохраняются аудио.", "where audio is saved.")
    case "ytdlpArgs":
      return tr(
        "параметры yt-dlp как в командной строке. применяются ко всем загрузкам и перебивают настройки fluxware при конфликте.",
        "yt-dlp options as on the command line. They apply to every download and override fluxware's own on conflict.",
      )
    case "concurrency":
      return tr("сколько загрузок идёт одновременно. остальные ждут в очереди.", "how many downloads run at once. the rest wait in the queue.")
    case "thumbnails":
      return tr("превью обложек в разделе «скачка».", "cover previews in the \"download\" section.")
    case "history":
      return tr(
        "записывать скачанное в лог истории с датой и временем. выключенная история не стирает уже записанное, новые загрузки видны только до выхода.",
        "write downloads to the history log with the date and time. Turning it off does not erase what is already recorded; new downloads stay visible until you quit.",
      )
    case "language":
      return tr("язык интерфейса.", "interface language.")
  }
}

function cycleValue<T>(list: readonly T[], current: T, direction: 1 | -1): T {
  const i = list.indexOf(current)
  return list[(i + direction + list.length) % list.length] as T
}

function rows(s: Settings, width: number): MenuItem[] {
  const pathWidth = Math.max(16, width - 26)
  const dirValue = (custom: string | null, effective: string) =>
    truncatePath(effective, pathWidth) + (custom ? "" : tr("  (по умолчанию)", "  (default)"))
  return [
    { key: "videoFormat", label: tr("формат видео", "video format"), value: s.videoFormat.toUpperCase(), hint: "←/→" },
    { key: "audioFormat", label: tr("формат аудио", "audio format"), value: s.audioFormat.toUpperCase(), hint: "←/→" },
    { key: "videoDir", label: tr("папка для видео", "video folder"), value: dirValue(s.videoDir, videoDirOf(s)) },
    { key: "audioDir", label: tr("папка для аудио", "audio folder"), value: dirValue(s.audioDir, audioDirOf(s)) },
    { key: "ytdlpArgs", label: tr("параметры yt-dlp", "yt-dlp options"), value: s.ytdlpArgs ? truncatePath(s.ytdlpArgs, pathWidth) : tr("не заданы", "not set") },
    { key: "concurrency", label: tr("одновременно", "at a time"), value: `${s.concurrency} ${count(s.concurrency, ["загрузка", "загрузки", "загрузок"], ["download", "downloads"])}`, hint: "←/→" },
    { key: "thumbnails", label: tr("превью обложек", "cover previews"), value: s.thumbnails ? tr("вкл", "on") : tr("выкл", "off"), hint: "←/→" },
    { key: "history", label: tr("история загрузок", "download history"), value: s.history ? tr("вкл", "on") : tr("выкл", "off"), hint: "←/→" },
    { key: "language", label: tr("язык", "language"), value: LANGUAGE_NAMES[s.language], hint: "←/→" },
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
          desc: tr("назад", "back"),
          cmd: () => {
            if (!latest.current.editing) return false
            stopEditing()
          },
        },
        ...(folderRow
          ? [
              {
                key: "o, щ",
                desc: tr("открыть папку", "open folder"),
                cmd: () => {
                  const s = services.settings.get()
                  const dir = latest.current.current === "videoDir" ? videoDirOf(s) : audioDirOf(s)
                  try {
                    mkdirSync(dir, { recursive: true })
                    revealInFileManager({ dir })
                  } catch (e) {
                    services.toast(`${tr("не удалось открыть папку", "could not open the folder")}: ${e instanceof Error ? e.message : e}`, "error")
                  }
                },
              },
            ]
          : []),
      ],
    }),
    [folderRow, getLanguage()],
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
      case "language":
        services.settings.update({ language: cycleValue(LANGUAGES, s.language, direction) })
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
      services.toast(`${tr("папка по умолчанию", "default folder")}: ${fallback}`, "ok")
      stopEditing()
      return
    }
    const absolute = resolve(path)
    if (existsSync(absolute)) {
      if (!statSync(absolute).isDirectory()) return setError(`${tr("это файл, а не папка", "this is a file, not a folder")}: ${absolute}`)
    } else if (confirmCreate !== absolute) {
      setConfirmCreate(absolute)
      setError(null)
      return
    } else {
      try {
        mkdirSync(absolute, { recursive: true })
      } catch (e) {
        return setError(`${tr("не удалось создать папку", "could not create the folder")}: ${e instanceof Error ? e.message : e}`)
      }
    }
    services.settings.update({ [key]: absolute })
    services.toast(
      key === "videoDir"
        ? tr(`видео теперь сохраняются в ${absolute}`, `videos are now saved to ${absolute}`)
        : tr(`аудио теперь сохраняются в ${absolute}`, `audio is now saved to ${absolute}`),
      "ok",
    )
    stopEditing()
  }

  async function saveArgs(raw: string) {
    const value = raw.trim()
    if (!value) {
      services.settings.update({ ytdlpArgs: "" })
      services.toast(tr("параметры yt-dlp очищены", "yt-dlp options cleared"), "ok")
      stopEditing()
      return
    }
    const ytdlp = services.tools?.ytdlp
    if (!ytdlp) return setError(tr("yt-dlp не найден: проверить параметры нечем", "yt-dlp not found: nothing to check the options with"))
    setChecking(true)
    const check = await checkCustomArgs(ytdlp, value)
    setChecking(false)
    if (!check.ok) return setError(`${tr("ошибка в параметрах", "invalid options")}: ${check.error}`)
    services.settings.update({ ytdlpArgs: value })
    services.toast(
      `${tr("сохранено", "saved")}: ${check.optionCount} ${count(check.optionCount, ["параметр", "параметра", "параметров"], ["option", "options"])}`,
      "ok",
    )
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
            {editing === "ytdlpArgs"
              ? tr("параметры yt-dlp · пусто — очистить", "yt-dlp options · empty — clear")
              : tr("путь до папки · пусто — папка по умолчанию", "folder path · empty — default folder")}
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
          {checking ? <Spinner text={tr("проверяю параметры…", "checking options…")} /> : null}
          {confirmCreate ? (
            <box flexDirection="column" flexShrink={0}>
              <text fg={theme.warn} wrapMode="word">{`! ${tr("такой папки нет", "no such folder")}: ${confirmCreate}`}</text>
              <text fg={theme.muted}>{tr("enter — создать · esc — отмена", "enter — create · esc — cancel")}</text>
            </box>
          ) : null}
          <ErrorLine text={error} />
        </box>
      ) : null}
      {/* The description of the selected row sits at the bottom of the window. */}
      <box flexGrow={1} />
      {current ? (
        <text fg={theme.faint} wrapMode="word" flexShrink={0}>
          {help(current)}
        </text>
      ) : null}
    </box>
  )
}
