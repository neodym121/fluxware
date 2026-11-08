#!/usr/bin/env node
// Launches the prebuilt fluxware binary.
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const { target, resolveBinary, cacheBinary } = require("./bin-path.cjs")

if (!target(process.platform)) {
  console.error("fluxware: поддерживаются только Windows x64 и Linux x64. Прочие платформы: см. README.")
  process.exit(1)
}

function version() {
  try {
    return require("../package.json").version
  } catch {
    return "dev"
  }
}

const bin = resolveBinary()
if (!bin) {
  console.error(
    "fluxware: бинарник не найден.\n" +
      `Положите его на место: node "${path.join(__dirname, "install.cjs")}"\n` +
      "или переустановите пакет: npm i -g fluxware"
  )
  process.exit(1)
}

function run(file, retried) {
  const child = spawn(file, process.argv.slice(2), { stdio: "inherit" })

  child.on("error", (error) => {
    if (error.code !== "EACCES" || retried) {
      console.error(`fluxware: не удалось запустить ${file}: ${error.message}`)
      process.exit(1)
    }
    // npm can ship the binary without the executable bit, and a global install
    // owned by root cannot be fixed in place.
    try {
      fs.chmodSync(file, 0o755)
      run(file, true)
      return
    } catch {
      const copy = cacheBinary(file, version())
      if (copy) {
        run(copy, true)
        return
      }
    }
    console.error(`fluxware: нет прав на запуск ${file}. Переустановите пакет: npm i -g fluxware`)
    process.exit(1)
  })

  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

run(bin, false)
