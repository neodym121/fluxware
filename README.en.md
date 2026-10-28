# fluxware

[Русский](README.md) · **English**

A video and music downloader for the terminal. Paste a link, pick a quality, get the file. It runs on [yt-dlp](https://github.com/yt-dlp/yt-dlp), so it handles YouTube, SoundCloud, X, TikTok, Instagram, VK and hundreds of other sites. The interface is built with [OpenTUI](https://opentui.com).

## Features

- Video in the quality you pick, or audio only (OPUS, MP3, M4A) with cover art and tags
- SoundCloud links start downloading right away
- Batch mode: paste any text and the links are found for you
- Download history, grouped by date
- Separate folders for video and audio, custom yt-dlp options

## Requirements

- [Bun](https://bun.sh) 1.3.14 or newer
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): `pip install -U "yt-dlp[default]"` or `winget install yt-dlp`
- [ffmpeg](https://ffmpeg.org): `winget install ffmpeg`

## Run

```bash
bun install
bun start
```

To build a single executable: `bun run build` (it lands in `dist/`).

## License

MIT
