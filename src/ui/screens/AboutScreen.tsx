import { useEffect, useState } from "react"
import { tr } from "../../core/i18n"
import { ffmpegVersion } from "../../core/ytdlp"
import { Field } from "../components"
import { useServices, useSettings } from "../context"
import { theme } from "../theme"
import type { ScreenProps } from "./shared"
import pkg from "../../../package.json"

export function ffmpegInstallHint(platform = process.platform): string {
  if (platform === "win32") return `winget install ffmpeg   (${tr("или", "or")} choco install ffmpeg)`
  if (platform === "darwin") return "brew install ffmpeg"
  return "sudo apt install ffmpeg · sudo dnf install ffmpeg · sudo pacman -S ffmpeg"
}

export function ytdlpInstallHint(): string {
  return `pip install -U "yt-dlp[default]"   (${tr("или", "or")} winget install yt-dlp)`
}

export function AboutScreen(props: ScreenProps) {
  const { tools } = useServices()
  useSettings()
  const [ffmpeg, setFfmpeg] = useState<string | null>(null)
  useEffect(() => {
    if (tools?.ffmpeg) void ffmpegVersion(tools.ffmpeg).then(setFfmpeg)
  }, [tools?.ffmpeg])

  const checking = tr("проверяю…", "checking…")
  const notFound = tr("не найден", "not found")
  const ytdlpLine =
    tools === null
      ? checking
      : tools.ytdlp
        ? `${tools.ytdlp.version}${tools.ytdlp.prefix.length ? tr(" (модуль Python)", " (Python module)") : ""}`
        : notFound
  const ffmpegLine = tools === null ? checking : tools.ffmpeg ? ffmpeg ?? tr("найден", "found") : notFound

  return (
    <box flexDirection="column" flexGrow={1} focusable focused={props.focused}>
      <text fg={theme.text} wrapMode="word">
        <b fg={theme.accent}>Fluxware</b>
        {tr(
          " — бесплатный универсальный загрузчик медиа с открытым исходным кодом. Качает видео и аудио почти из любой точки интернета: YouTube, SoundCloud, X, TikTok и ещё сотни сайтов, которые понимает yt-dlp.",
          " is a free, open-source universal media downloader. It saves video and audio from almost anywhere on the internet: YouTube, SoundCloud, X, TikTok and hundreds more sites that yt-dlp understands.",
        )}
      </text>
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Field label={tr("версия", "version")} width={14}>{pkg.version}</Field>
        <Field label={tr("лицензия", "license")} width={14}>MIT</Field>
      </box>
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Field label="yt-dlp" width={14} color={tools && !tools.ytdlp ? theme.error : theme.text}>
          {ytdlpLine}
        </Field>
        <Field label="ffmpeg" width={14} color={tools && !tools.ffmpeg ? theme.error : theme.text}>
          {ffmpegLine}
        </Field>
        <Field label={tr("js для yt-dlp", "js for yt-dlp")} width={14}>
          {tools === null ? checking : tools.jsRuntimes.length ? tools.jsRuntimes.join(", ") : tr("нет (deno или node)", "none (deno or node)")}
        </Field>
        <Field label={tr("интерфейс", "interface")} width={14}>{`OpenTUI ${pkg.dependencies["@opentui/core"]} · Bun ${Bun.version}`}</Field>
      </box>
      {tools && !tools.ytdlp ? (
        <text fg={theme.muted} wrapMode="word" marginTop={1}>
          {tr("без yt-dlp загрузки не работают. установка: ", "downloads do not work without yt-dlp. install: ") + ytdlpInstallHint()}
        </text>
      ) : null}
      {tools && !tools.ffmpeg ? (
        <text fg={theme.muted} wrapMode="word" marginTop={1}>
          {tr(
            "без ffmpeg не работают склейка дорожек, извлечение звука и обложки. установка: ",
            "merging tracks, audio extraction and covers do not work without ffmpeg. install: ",
          ) + ffmpegInstallHint()}
        </text>
      ) : null}
      {tools && tools.jsRuntimes.length === 0 ? (
        <text fg={theme.muted} wrapMode="word" marginTop={1}>
          {tr(
            "без deno или node YouTube иногда отдаёт только 360p: yt-dlp решает ими его JS-задачки.",
            "without deno or node YouTube sometimes serves only 360p: yt-dlp uses them to solve its JavaScript challenges.",
          )}
        </text>
      ) : null}
    </box>
  )
}
