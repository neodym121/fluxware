import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Stand-in for yt-dlp in tests: answers -J with a fixed info dict and fakes
// a download with the same output lines that fluxware asks real yt-dlp for.
const args = process.argv.slice(2)
const url = args[args.indexOf("--") + 1] ?? ""

function formats() {
  return [
    { format_id: "18", height: 360, vcodec: "avc1", acodec: "mp4a", ext: "mp4" },
    { format_id: "136", height: 720, vcodec: "avc1", acodec: "none", ext: "mp4" },
    { format_id: "137", height: 1080, vcodec: "avc1", acodec: "none", ext: "mp4" },
    { format_id: "140", vcodec: "none", acodec: "mp4a", ext: "m4a" },
  ]
}

const info = {
  id: "abc123",
  title: "Тестовое видео",
  uploader: "Канал",
  duration: 75,
  extractor_key: "Youtube",
  webpage_url: url,
  formats: formats(),
}

if (args.includes("--bogus")) {
  console.error("yt-dlp: error: no such option: --bogus")
  process.exit(2)
}
if (!url) {
  console.error("yt-dlp: error: You must provide at least one URL.")
  process.exit(2)
}
if (url.includes("fail")) {
  console.error("ERROR: [youtube] abc123: Video unavailable")
  process.exit(1)
}

const soundcloud = {
  id: "777",
  title: "Трек",
  uploader: "Артист",
  duration: 200,
  extractor_key: "Soundcloud",
  webpage_url: url,
  formats: [{ format_id: "http_mp3", vcodec: "none", acodec: "mp3", ext: "mp3" }],
}

if (url.includes("slow")) await Bun.sleep(1500)

if (args.includes("-J")) {
  console.log(JSON.stringify(url.includes("soundcloud") ? soundcloud : info))
  process.exit(0)
}

const height = Number(args.join(" ").match(/height<=(\d+)/)?.[1] ?? 1080)
const dir = args[args.indexOf("-P") + 1] ?? "."
const output = join(dir, "Тестовое видео.mp4")
console.log(JSON.stringify({ ...info, height, _filename: output }))
// A long download, so a test can press cancel while it runs. Like yt-dlp, it
// leaves a cover and a .part file behind when it is killed.
if (url.includes("longdl")) {
  const stream = join(dir, "Тестовое видео.f137.mp4")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "Тестовое видео.jpg"), "cover")
  writeFileSync(`${stream}.part`, "partial")
  for (let done = 1; done <= 100; done++) {
    console.log(`FLUXPROG downloading|${done}|100|NA|2048|5|NA|NA|avc1|none|${JSON.stringify(stream)}`)
    await Bun.sleep(200)
  }
}
for (const done of [256, 512, 1024]) console.log(`FLUXPROG downloading|${done}|1024|NA|2048|1|NA|NA|avc1|none`)
console.log("FLUXPROG finished|1024|1024|NA|NA|NA|NA|NA|avc1|none")
console.error("FLUXPP started|Merger")
console.error("FLUXPP finished|Merger")
console.log(`FLUXFILE ${JSON.stringify("C:\\Videos\\Тестовое видео.mp4")}`)

export {}
