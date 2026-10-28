import { useEffect, useState } from "react"
import { ffmpegVersion } from "../../core/ytdlp"
import { Field } from "../components"
import { useServices } from "../context"
import { theme } from "../theme"
import type { ScreenProps } from "./shared"
import pkg from "../../../package.json"

export function ffmpegInstallHint(platform = process.platform): string {
  if (platform === "win32") return "winget install ffmpeg   (или choco install ffmpeg)"
  if (platform === "darwin") return "brew install ffmpeg"
  return "sudo apt install ffmpeg · sudo dnf install ffmpeg · sudo pacman -S ffmpeg"
}

export const YTDLP_INSTALL_HINT = 'pip install -U "yt-dlp[default]"   (или winget install yt-dlp)'

export function AboutScreen(props: ScreenProps) {
  const { tools } = useServices()
  const [ffmpeg, setFfmpeg] = useState<string | null>(null)
  useEffect(() => {
    if (tools?.ffmpeg) void ffmpegVersion(tools.ffmpeg).then(setFfmpeg)
  }, [tools?.ffmpeg])

  const ytdlpLine = tools === null ? "проверяю…" : tools.ytdlp ? `${tools.ytdlp.version}${tools.ytdlp.prefix.length ? " (модуль Python)" : ""}` : "не найден"
  const ffmpegLine = tools === null ? "проверяю…" : tools.ffmpeg ? ffmpeg ?? "найден" : "не найден"

  return (
    <box flexDirection="column" flexGrow={1} focusable focused={props.focused}>
      <text fg={theme.text} wrapMode="word">
        <b fg={theme.accent}>Fluxware</b> — бесплатный универсальный загрузчик медиа с открытым исходным кодом. Качает видео
        и аудио почти из любой точки интернета: YouTube, SoundCloud, X, TikTok и ещё сотни сайтов, которые понимает yt-dlp.
      </text>
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Field label="версия" width={14}>{pkg.version}</Field>
        <Field label="лицензия" width={14}>MIT</Field>
      </box>
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Field label="yt-dlp" width={14} color={tools && !tools.ytdlp ? theme.error : theme.text}>
          {ytdlpLine}
        </Field>
        <Field label="ffmpeg" width={14} color={tools && !tools.ffmpeg ? theme.error : theme.text}>
          {ffmpegLine}
        </Field>
        <Field label="js для yt-dlp" width={14}>
          {tools === null ? "проверяю…" : tools.jsRuntimes.length ? tools.jsRuntimes.join(", ") : "нет (deno или node)"}
        </Field>
        <Field label="интерфейс" width={14}>{`OpenTUI ${pkg.dependencies["@opentui/core"]} · Bun ${Bun.version}`}</Field>
      </box>
      {tools && !tools.ytdlp ? (
        <text fg={theme.muted} wrapMode="word" marginTop={1}>
          {"без yt-dlp загрузки не работают. установка: " + YTDLP_INSTALL_HINT}
        </text>
      ) : null}
      {tools && !tools.ffmpeg ? (
        <text fg={theme.muted} wrapMode="word" marginTop={1}>
          {"без ffmpeg не работают склейка дорожек, извлечение звука и обложки. установка: " + ffmpegInstallHint()}
        </text>
      ) : null}
      {tools && tools.jsRuntimes.length === 0 ? (
        <text fg={theme.muted} wrapMode="word" marginTop={1}>
          без deno или node YouTube иногда отдаёт только 360p: yt-dlp решает ими его JS-задачки.
        </text>
      ) : null}
    </box>
  )
}
