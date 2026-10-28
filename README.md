# fluxware

**Русский** · [English](README.en.md)

Загрузчик видео и музыки для терминала. Вставляешь ссылку, выбираешь качество, файл скачивается. Работает на [yt-dlp](https://github.com/yt-dlp/yt-dlp), так что понимает YouTube, SoundCloud, X, TikTok, Instagram, VK и ещё сотни сайтов. Интерфейс сделан на [OpenTUI](https://opentui.com).

## Что умеет

- Видео в выбранном качестве или только звук (OPUS, MP3, M4A) с обложкой и метаданными
- Ссылки на SoundCloud качаются сразу, без лишних вопросов
- Пакетная загрузка: вставь любой текст, ссылки найдутся сами
- История загрузок по датам
- Отдельные папки для видео и аудио, свои параметры yt-dlp

## Что нужно

- [Bun](https://bun.sh) 1.3.14 или новее
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): `pip install -U "yt-dlp[default]"` или `winget install yt-dlp`
- [ffmpeg](https://ffmpeg.org): `winget install ffmpeg`

## Запуск

```bash
bun install
bun start
```

Собрать один исполняемый файл: `bun run build` (появится в `dist/`).

## Лицензия

MIT
