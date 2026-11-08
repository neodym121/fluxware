# fluxware

**English** · [Русский](README.ru.md)

A video and music downloader for the terminal. Paste a link, pick a quality, get the file.

fluxware is a keyboard-first interface over [yt-dlp](https://github.com/yt-dlp/yt-dlp), so it works with YouTube, SoundCloud, X, TikTok, Instagram, VK and the hundreds of other sites yt-dlp supports. The interface is built with [OpenTUI](https://opentui.com) and runs in any modern terminal; it is developed and tested on Windows Terminal.

## Features

**Download.** Paste a link and fluxware shows the title, author, length and cover, then lists the available resolutions with the highest first, plus an audio-only option. The download runs right on the card with a progress bar, speed and time left, and can be canceled. Paste several links at once to get them all as video or all as audio. SoundCloud and other audio-only links start downloading without a question.

**Audio.** OPUS and M4A from YouTube are saved without re-encoding; MP3 is encoded at 192 kbit/s. The cover is cropped to a square and embedded into the file together with the tags.

**Batch.** Paste any text, such as a chat log, and the links are found in it, including links glued together or written without `https://`. Links can also be loaded from a `.txt` file. Pick video or audio and a quality cap, and follow the progress of the whole batch.

**History.** Every finished download goes into a log grouped by date, with the time on the right. Open a file where it was saved, download it again, or remove it from the history. Logging can be turned off in the settings.

**Queue.** Downloads run in the background, one or up to four at a time, so you can paste the next link while the previous one is still downloading. A canceled download removes its partial files.

**Settings.** Video container (MP4, WEBM, MKV), audio format (OPUS, MP3, M4A), separate folders for video and audio, the number of downloads at a time, cover previews, the history log, the interface language (English or Russian), and your own yt-dlp options, which yt-dlp checks before they are saved.

When YouTube returns only its low-quality fallback format, or a video comes out below the best available quality, fluxware says so and shows the yt-dlp warnings that explain why.

## Install

You need [Node.js](https://nodejs.org) — npm comes with it.

```bash
npm install -g fluxware
```

On Linux a system-wide Node needs `sudo` for this, exactly like any other global package: `sudo npm install -g fluxware`. If you would rather not use `sudo`, point npm at a folder of your own first with `npm config set prefix ~/.local`.

Then open a terminal and run `fx`. Windows x64 and Linux x64 are supported; on macOS you can [run from source](#run-from-source) instead.

The binary travels inside the package, so there is nothing to download after the install and no extra flags are needed, even where npm 12 and newer block install scripts. If `fx` ever complains that the binary is missing, put it back in place yourself:

```bash
node "$(npm root -g)/fluxware/bin/install.cjs"
```

You also need ffmpeg, see below. The interface language follows your system and can be switched in the settings.

## Requirements

- [ffmpeg](https://ffmpeg.org): `winget install ffmpeg`, needed to merge video and audio, extract audio and embed covers
- [Deno](https://deno.com), recommended: yt-dlp uses it (or the Node.js you already installed) to solve YouTube's JavaScript challenges, without which YouTube sometimes offers only 360p

yt-dlp comes with fluxware: you do not install it anywhere and Python is not needed. fluxware looks for `yt-dlp` on `PATH`, then for the Python module `yt_dlp`, and otherwise downloads yt-dlp's own standalone build on the first launch (17 MB on Windows, 41 MB on Linux), showing the progress in the status line. The build lives in `%LOCALAPPDATA%\fluxware\bin` on Windows, `~/Library/Application Support/fluxware/bin` on macOS and `~/.local/share/fluxware/bin` on Linux, and is reused from then on.

## Run from source

This needs [Bun](https://bun.sh) 1.3.14 or newer.

```bash
bun install
bun start
```

`bun run build` compiles everything into one executable, `dist/fx.exe`. Tests run with `bun test`.

## Keys

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Move between the section tabs and the windows of a section |
| `←` `→` | Switch sections on the tab bar |
| `↑` `↓`, `Enter` | Move through lists, choose |
| `Esc` | Go back |
| `Ctrl+S` | Start a batch |
| `Ctrl+C` | Quit; while downloads run, press it twice |

The bottom line always shows the keys that work right now. The mouse works too.

## Files

Settings, the history log and a small state file live in `%APPDATA%\fluxware` on Windows, `~/Library/Application Support/fluxware` on macOS and `~/.config/fluxware` on Linux. Settings of the earlier Python version are carried over on the first launch.

The yt-dlp build fluxware downloaded for itself is kept apart: `%LOCALAPPDATA%\fluxware\bin`, `~/Library/Application Support/fluxware/bin` or `~/.local/share/fluxware/bin`. Delete that file to have it fetched again.

## License

MIT
