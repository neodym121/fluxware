#!/usr/bin/env node
// Launches the prebuilt fluxware binary downloaded by install.cjs.
const path = require("path")
const { spawn } = require("child_process")
const fs = require("fs")

const bin = path.join(__dirname, "fx-win-x64.exe")
if (!fs.existsSync(bin)) {
  console.error("fluxware: бинарник не найден. Переустановите пакет: npm i -g fluxware")
  process.exit(1)
}
spawn(bin, process.argv.slice(2), { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0))
