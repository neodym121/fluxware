// Provides the prebuilt fluxware binary: prefers the platform-specific
// fluxware-bin-* npm package, falls back to downloading from GitHub Releases.
const fs = require("fs")
const path = require("path")
const https = require("https")

const REPO = "neodym121/fluxware"

const TARGETS = {
  "win32-x64": { pkg: "fluxware-bin-win-x64", file: "fx-win-x64.exe" },
  "linux-x64": { pkg: "fluxware-bin-linux-x64", file: "fx-linux-x64" },
}

function fail(message) {
  console.error(`fluxware: ${message}`)
  process.exit(1)
}

function copyLocalBinary(target, dest) {
  try {
    const manifest = require.resolve(`${target.pkg}/package.json`)
    const candidate = path.join(path.dirname(manifest), target.file)
    if (!fs.existsSync(candidate)) return false
    fs.copyFileSync(candidate, dest)
    return true
  } catch {
    return false
  }
}

function downloadOnce(url, dest, redirectsLeft, onDone) {
  https
    .get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location
        res.resume()
        if (!location || redirectsLeft <= 0) return onDone(new Error("слишком много редиректов"))
        return downloadOnce(location, dest, redirectsLeft - 1, onDone)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return onDone(new Error(`HTTP ${res.statusCode}`))
      }
      const tmp = dest + ".tmp"
      const out = fs.createWriteStream(tmp)
      res.pipe(out)
      out.on("finish", () => out.close(() => fs.renameSync(tmp, dest)))
      out.on("error", () => {
        fs.rmSync(tmp, { force: true })
        onDone(new Error("ошибка записи файла"))
      })
    })
    .on("timeout", function () {
      this.destroy(new Error("таймаут соединения"))
    })
    .on("error", (err) => onDone(err))
}

function download(url, dest, attempt) {
  downloadOnce(url, dest, 5, (err) => {
    if (!err) return
    if (attempt < 5) {
      const delay = 3000 * attempt
      console.log(`fluxware: попытка ${attempt + 1}/5 через ${delay / 1000} с (${err.message})`)
      return setTimeout(() => download(url, dest, attempt + 1), delay)
    }
    fail(
      `не удалось скачать бинарник: ${err.message}\n` +
        `Скачайте вручную: ${url}\n` +
        `и положите файл как: ${dest}`
    )
  })
}

function main() {
  const target = TARGETS[`${process.platform}-${process.arch}`]
  if (!target) {
    console.error("fluxware: сборки пока есть только для win32-x64 и linux-x64. Прочие платформы: см. README.")
    process.exit(0)
  }
  // Development checkout: binary comes from `bun run build`, nothing to download.
  if (fs.existsSync(path.join(__dirname, "..", "src", "index.tsx"))) process.exit(0)
  const { version } = require("../package.json")
  const dest = path.join(__dirname, target.file)
  if (fs.existsSync(dest)) process.exit(0)
  console.log(`fluxware: установка бинарника v${version}...`)
  if (copyLocalBinary(target, dest)) {
    fs.chmodSync(dest, 0o755)
    process.exit(0)
  }
  console.log("fluxware: бинарник не найден в npm, скачивание с GitHub...")
  const url = `https://github.com/${REPO}/releases/download/v${version}/${target.file}`
  download(url, dest, 1)
}

main()
