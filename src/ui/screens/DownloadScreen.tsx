import type { BoxRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { formatDuration } from "../../core/format"
import { count, getLanguage, tr } from "../../core/i18n"
import { downloadLabel, type MediaInfo } from "../../core/media"
import { isFinished } from "../../core/queue"
import { audioDirOf, videoDirOf } from "../../core/settings"
import { extractUrls, hideSchemes, isSoundCloudUrl, shortUrl } from "../../core/urls"
import { fetchInfo, splitArgs } from "../../core/ytdlp"
import { Button, FocusButton, JobProgress, JobRow, Menu, PromptInput, Spinner, type MenuItem } from "../components"
import { useClipboardUrl, useJobs, useServices, useSettings } from "../context"
import { FlxLogo, LOGO_ROWS } from "../Logo"
import { theme } from "../theme"
import { ErrorLine, useFocusEntry, type ScreenProps } from "./shared"

type Stage =
  | { kind: "idle" }
  | { kind: "loading"; url: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; info: MediaInfo }
  /** Several links pasted at once: one choice applies to all. */
  | { kind: "many"; urls: string[] }
  /** Downloads started from this screen; the card stays to show their progress. */
  | { kind: "started"; info: MediaInfo | null; jobIds: number[] }

const PLAYLIST_HEIGHTS = [2160, 1440, 1080, 720, 480]
const platforms = () => `youtube · soundcloud · x · instagram · tiktok · vk · +1800 ${tr("сайтов", "sites")}`

/** Sources without any video track: SoundCloud, Bandcamp, podcasts. */
function isAudioOnly(info: MediaInfo): boolean {
  if (isSoundCloudUrl(info.url) || info.platform === "SoundCloud") return true
  const formats = info.raw.formats ?? []
  return !info.isPlaylist && formats.length > 0 && formats.every((f) => !f.vcodec || f.vcodec === "none")
}

/** The highest quality comes first, so the list needs no "maximum" item. */
function choices(stage: Stage): MenuItem[] {
  if (stage.kind === "many") {
    return [
      { key: "all-video", label: tr("все как видео", "all as video") },
      { key: "all-audio", label: tr("все как аудио", "all as audio") },
    ]
  }
  if (stage.kind !== "ready") return []
  const info = stage.info
  if (isAudioOnly(info)) return [{ key: "audio", label: info.isPlaylist ? tr("скачать все треки", "download all tracks") : tr("скачать аудио", "download audio") }]
  const heights = info.isPlaylist ? PLAYLIST_HEIGHTS : [...info.heights].reverse().filter((h) => h >= 144).slice(0, 8)
  const items: MenuItem[] = heights.length ? heights.map((h) => ({ key: `h${h}`, label: `${h}p` })) : [{ key: "best", label: tr("видео", "video") }]
  items.push({ key: "audio", label: tr("только звук", "audio only") })
  return items
}

function InfoCard(props: { info: MediaInfo; showThumb: boolean; onThumbError: () => void; children: ReactNode }) {
  const { info } = props
  const audioOnly = isAudioOnly(info)
  const meta = [
    info.uploader,
    info.platform,
    info.isPlaylist ? `${tr("плейлист", "playlist")} · ${info.entryCount} ${count(info.entryCount, ["элемент", "элемента", "элементов"], ["item", "items"])}` : formatDuration(info.duration),
  ]
  return (
    <box flexDirection="row" flexShrink={0}>
      {props.showThumb ? (
        <image
          source={info.thumbnail ?? undefined}
          fit="cover"
          width={audioOnly ? 14 : 28}
          height={audioOnly ? 7 : 8}
          flexShrink={0}
          onError={props.onThumbError}
        />
      ) : null}
      <box flexDirection="column" flexGrow={1} paddingLeft={props.showThumb ? 2 : 0}>
        <text fg={theme.accent} wrapMode="word">
          <b>{info.title}</b>
        </text>
        <text fg={theme.muted} wrapMode="none">
          {meta.join(" · ")}
        </text>
        {info.fallbackOnly ? (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.warn} wrapMode="word">
              {tr("! YouTube отдал только запасной формат: нормальных качеств сейчас нет", "! YouTube returned only a fallback format: no regular qualities right now")}
            </text>
            {info.warnings.map((w) => (
              <text key={w} fg={theme.faint} wrapMode="word">
                {"  yt-dlp: " + hideSchemes(w)}
              </text>
            ))}
            <text fg={theme.faint}>{"  " + tr("обычно это временно: попробуй позже или обнови yt-dlp", "this is usually temporary: try later or update yt-dlp")}</text>
          </box>
        ) : null}
        <box marginTop={1} flexShrink={0} flexDirection="column">
          {props.children}
        </box>
      </box>
    </box>
  )
}

export function DownloadScreen(props: ScreenProps) {
  const services = useServices()
  const settings = useSettings()
  const jobs = useJobs()
  const [url, setUrl] = useState("")
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const [inner, setInner] = useState<"input" | "menu" | "cancel">("input")
  const [menuIndex, setMenuIndex] = useState(0)
  const [thumbFailed, setThumbFailed] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const rootRef = useRef<BoxRenderable>(null)
  const clip = useClipboardUrl(props.focused && inner === "input" && stage.kind !== "loading")
  const items = choices(stage)
  const hasMenu = items.length > 0
  const startedJobs = stage.kind === "started" ? jobs.filter((j) => stage.jobIds.includes(j.id)) : []
  const activeJobs = startedJobs.filter((j) => !isFinished(j))
  const hasCancel = activeJobs.length > 0

  const latest = useRef({ stage, inner, url, hasMenu, hasCancel })
  latest.current = { stage, inner, url, hasMenu, hasCancel }

  // The cancel button disappears with the last running download; focus goes back to the field.
  useEffect(() => {
    if (!hasCancel && inner === "cancel") setInner("input")
  }, [hasCancel, inner])

  useFocusEntry(props.entry, (edge) => {
    const s = latest.current
    setInner(edge === "last" ? (s.hasMenu ? "menu" : s.hasCancel ? "cancel" : "input") : "input")
  })

  /** The zone after the field: the choices, or the cancel button while downloading. */
  function nextZone(): "menu" | "cancel" | null {
    const s = latest.current
    return s.hasMenu ? "menu" : s.hasCancel ? "cancel" : null
  }

  useBindings(
    () => ({
      targetRef: rootRef,
      priority: 10,
      bindings: [
        {
          key: "escape",
          desc: tr("назад", "back"),
          cmd: () => {
            const s = latest.current
            if (s.stage.kind === "loading") {
              abort.current?.abort()
              setStage({ kind: "idle" })
            } else if (s.inner !== "input") {
              setInner("input")
            } else if (s.url || s.stage.kind !== "idle") {
              setUrl("")
              setStage({ kind: "idle" })
            } else return false
          },
        },
        // Tab walks field → cancel → section tabs; at the edge it falls through to the app.
        // The quality choices hold focus until Esc, so Tab does nothing there.
        {
          key: "tab",
          desc: tr("окно", "pane"),
          cmd: () => {
            const s = latest.current
            if (s.inner === "menu") return
            const zone = nextZone()
            if (s.inner !== "input" || !zone) return false
            setInner(zone)
          },
        },
        {
          key: "shift+tab",
          cmd: () => {
            const s = latest.current
            if (s.inner === "menu") return
            if (s.inner === "input") return false
            setInner("input")
          },
        },
        {
          key: "down",
          cmd: () => {
            const zone = nextZone()
            if (latest.current.inner !== "input" || !zone) return false
            setInner(zone)
          },
        },
      ],
    }),
    [getLanguage()],
  )

  async function submit(value: string) {
    if (stage.kind === "loading") return
    // An empty field shows the copied link in gray: the first Enter puts it in, the second confirms.
    if (!value.trim()) {
      if (clip) setUrl(hideSchemes(clip))
      return
    }
    const urls = extractUrls(value)
    if (urls.length === 0) {
      setStage({ kind: "error", message: tr("это не похоже на ссылку", "this does not look like a link") })
      return
    }
    if (urls.length > 1) {
      setMenuIndex(0)
      setStage({ kind: "many", urls })
      setInner("menu")
      return
    }
    const target = urls[0] as string
    const ytdlp = services.tools?.ytdlp
    if (!ytdlp) {
      setStage({ kind: "error", message: tr(
          'yt-dlp не найден. Установи его: pip install -U "yt-dlp[default]"',
          'yt-dlp not found. Install it: pip install -U "yt-dlp[default]"',
        ), })
      return
    }
    setUrl(hideSchemes(target))
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setStage({ kind: "loading", url: target })
    const result = await fetchInfo(ytdlp, target, {
      jsRuntimes: services.tools?.jsRuntimes ?? [],
      customArgs: splitArgs(settings.ytdlpArgs).args,
      signal: controller.signal,
    })
    if (result.aborted || abort.current !== controller) return
    if (!result.info) {
      setStage({ kind: "error", message: `${tr("не удалось получить информацию", "could not get the information")}: ${hideSchemes(result.error ?? tr("проверь ссылку", "check the link"))}` })
      return
    }
    setThumbFailed(false)
    setMenuIndex(0)
    // Audio-only sources such as SoundCloud have nothing to choose: show the card and start.
    if (isAudioOnly(result.info)) {
      start(result.info, "audio")
      return
    }
    setStage({ kind: "ready", info: result.info })
    setInner("menu")
  }

  // The card stays with the progress of what was started; the field clears for the
  // next link, and focus goes to the cancel button.
  function started(info: MediaInfo | null, jobIds: number[]) {
    setUrl("")
    setStage({ kind: "started", info, jobIds })
    setInner("cancel")
  }

  /** Queues one link with the chosen quality: "audio", "h1080", or "best". */
  function start(info: MediaInfo, key: string) {
    const audio = key === "audio"
    const height = key.startsWith("h") ? Number(key.slice(1)) : null
    const added = services.queue.add([
      {
        url: info.url,
        kind: audio ? "audio" : "video",
        height,
        source: "download",
        dir: audio ? audioDirOf(settings) : videoDirOf(settings),
        label: info.isPlaylist ? null : downloadLabel(info.raw),
      },
    ])
    started(info, added.map((j) => j.id))
  }

  function choose(item: MenuItem) {
    if (stage.kind === "many") {
      const audio = item.key === "all-audio"
      const dir = audio ? audioDirOf(settings) : videoDirOf(settings)
      const added = services.queue.add(
        stage.urls.map((u) => ({ url: u, kind: audio ? ("audio" as const) : ("video" as const), source: "download" as const, dir })),
      )
      services.toast(
        `${tr("в очереди", "queued")}: ${added.length} ${count(added.length, ["ссылка", "ссылки", "ссылок"], ["link", "links"])} · ${audio ? tr("аудио", "audio") : tr("видео", "video")}`,
        "ok",
      )
      started(null, added.map((j) => j.id))
      return
    }
    if (stage.kind === "ready") start(stage.info, item.key)
  }

  function cancelStarted() {
    for (const job of activeJobs) services.queue.cancel(job.id)
  }

  const boxWidth = Math.max(30, Math.min(84, props.width - 4))
  const cardInfo = stage.kind === "ready" || stage.kind === "started" ? stage.info : null
  const showThumb = settings.thumbnails && boxWidth >= 64 && !!cardInfo?.thumbnail && !thumbFailed
  const inputFocused = props.focused && inner === "input"
  const progressWidth = boxWidth - (showThumb ? 30 : 0)

  // The logo shrinks to the small font, then hides, when the card needs the rows.
  const cardRows = cardInfo
    ? Math.max(showThumb ? 8 : 0, 3 + (stage.kind === "started" ? 3 : items.length)) + 1
    : stage.kind === "many"
      ? 4 + items.length
      : stage.kind === "started"
        ? startedJobs.length + 3
        : 0
  const statusRows = stage.kind === "loading" ? 3 : stage.kind === "error" || (stage.kind === "idle" && !clip) ? 2 : 0
  const spare = props.height - (3 + 2 + statusRows + cardRows)
  const showLogo = spare >= LOGO_ROWS + 1

  let status: ReactNode = null
  if (stage.kind === "loading")
    status = (
      <box flexDirection="column" alignItems="center" flexShrink={0}>
        <Spinner text={tr("получаю информацию…", "fetching information…")} />
        <text fg={theme.faint}>{tr("esc — отмена", "esc — cancel")}</text>
      </box>
    )
  else if (stage.kind === "error") status = <ErrorLine text={stage.message} />
  else if (stage.kind === "idle" && !clip) status = <text fg={theme.faint} wrapMode="none">{platforms()}</text>

  const menu = hasMenu ? (
    <Menu
      items={items}
      index={menuIndex}
      onIndexChange={setMenuIndex}
      onActivate={choose}
      wrap
      focused={props.focused && inner === "menu"}
      onFocusRequest={() => {
        props.onFocusRequest()
        setInner("menu")
      }}
    />
  ) : null

  const cancelButton = hasCancel ? (
    <FocusButton
      label={tr("отмена", "cancel")}
      primary
      focused={props.focused && inner === "cancel"}
      onPress={cancelStarted}
      onExitTop={() => setInner("input")}
      onFocusRequest={() => {
        props.onFocusRequest()
        setInner("cancel")
      }}
    />
  ) : null

  const progress =
    stage.kind === "started" && stage.info && startedJobs.length === 1 ? (
      <JobProgress job={startedJobs[0]!} width={progressWidth} left={cancelButton} />
    ) : (
      <box flexDirection="column" flexShrink={0}>
        {startedJobs.map((job) => (
          <JobRow key={job.id} job={job} width={boxWidth} />
        ))}
        {cancelButton ? (
          <box marginTop={1} flexShrink={0} alignItems="flex-start">
            {cancelButton}
          </box>
        ) : null}
      </box>
    )

  return (
    <box ref={rootRef} flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" overflow="hidden">
      {showLogo ? (
        <box marginBottom={1} flexShrink={0}>
          <FlxLogo kind={services.intro} onNext={services.nextIntro} dropDistance={Math.ceil(props.height / 2) + LOGO_ROWS + 1} />
        </box>
      ) : null}
      <box
        width={boxWidth}
        border
        borderStyle="rounded"
        borderColor={inputFocused ? theme.accent : theme.line}
        title={` ${tr("вставь ссылку", "paste a link")} `}
        titleColor={inputFocused ? theme.accent : theme.muted}
        paddingX={1}
        flexShrink={0}
        onMouseDown={() => {
          props.onFocusRequest()
          setInner("input")
        }}
      >
        <PromptInput
          value={url}
          onInput={(v) => setUrl(hideSchemes(v))}
          onSubmit={(v) => void submit(v)}
          focused={inputFocused}
          placeholder={clip ? shortUrl(clip, boxWidth - 8) : "youtube.com/watch?v=…"}
          bare
        />
      </box>
      <box marginTop={1} flexShrink={0}>
        <Button
          label={stage.kind === "loading" ? "⋯" : "Enter!"}
          primary
          disabled={stage.kind === "loading"}
          onPress={() => {
            props.onFocusRequest()
            setInner("input")
            void submit(url)
          }}
        />
      </box>
      {status ? (
        <box width={boxWidth} marginTop={1} flexShrink={0} alignItems="center">
          {status}
        </box>
      ) : null}
      {cardInfo ? (
        <box width={boxWidth} marginTop={1} flexShrink={0} flexDirection="column">
          <InfoCard info={cardInfo} showThumb={showThumb} onThumbError={() => setThumbFailed(true)}>
            {stage.kind === "started" ? progress : menu}
          </InfoCard>
        </box>
      ) : stage.kind === "many" || stage.kind === "started" ? (
        <box width={boxWidth} marginTop={1} flexShrink={0} flexDirection="column">
          {stage.kind === "many" ? (
            <>
              <text fg={theme.accent}>
                <b>{`${tr("ссылок", "links")}: ${stage.urls.length}`}</b>
              </text>
              <text fg={theme.faint} wrapMode="none">
                {stage.urls.slice(0, 3).map((u) => shortUrl(u, 26)).join(" · ") + (stage.urls.length > 3 ? " · …" : "")}
              </text>
              <box marginTop={1} flexShrink={0}>
                {menu}
              </box>
            </>
          ) : (
            progress
          )}
        </box>
      ) : null}
    </box>
  )
}
