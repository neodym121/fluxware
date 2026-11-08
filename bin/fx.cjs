#!/usr/bin/env node
// Launches the prebuilt fluxware binary provided by install.cjs.
const path = require("path")
const { spawn } = require("child_process")
const fs = require("fs")

const FILES = {
  win32: "fx-win-x64.exe",
  linux: "fx-linux-x64",
}

const file = FILES[process.platform]
if (!file) {
  console.error("fluxware: поддерживаются только Windows x64 и Linux x64. Прочие платформы: см. README.")
  process.exit(1)
}
const bin = path.join(__dirname, file)
if (!fs.existsSync(bin)) {
  console.error("fluxware: бинарник не найден. Переустановите пакет: npm i -g fluxware")
  process.exit(1)
}
spawn(bin, process.argv.slice(2), { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0))
