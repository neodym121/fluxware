// Downloads the prebuilt fluxware binary for this platform from GitHub Releases.
const fs = require("fs")
const path = require("path")
const https = require("https")
const { platform, arch } = process

const REPO = "neodym121/fluxware"

function fail(message) {
  console.error(`fluxware: ${message}`)
  process.exit(1)
}

function download(url, dest, redirectsLeft) {
  https
    .get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location
        res.resume()
        if (!location || redirectsLeft <= 0) return fail("слишком много редиректов при скачивании")
        return download(location, dest, redirectsLeft - 1)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return fail(`не удалось скачать бинарник (HTTP ${res.statusCode})`)
      }
      const tmp = dest + ".tmp"
      const out = fs.createWriteStream(tmp)
      res.pipe(out)
      out.on("finish", () => out.close(() => fs.renameSync(tmp, dest)))
      out.on("error", () => {
        fs.rmSync(tmp, { force: true })
        fail("ошибка записи файла")
      })
    })
    .on("error", (err) => fail(`ошибка скачивания: ${err.message}`))
}

function main() {
  if (platform !== "win32" || arch !== "x64") {
    console.error("fluxware: пока доступна только сборка win32-x64. Прочие платформы: см. README.")
    process.exit(0)
  }
  // Development checkout: binary comes from `bun run build`, nothing to download.
  if (fs.existsSync(path.join(__dirname, "..", "src", "index.tsx"))) process.exit(0)
  const { version } = require("../package.json")
  const dest = path.join(__dirname, "fx-win-x64.exe")
  if (fs.existsSync(dest)) process.exit(0)
  const url = `https://github.com/${REPO}/releases/download/v${version}/fx-win-x64.exe`
  console.log(`fluxware: скачивание бинарника v${version}...`)
  download(url, dest, 5)
}

main()
