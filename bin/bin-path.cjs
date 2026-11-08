// Finds the prebuilt binary. The copy in bin/ made by install.cjs wins, and the
// platform package installed as an optional dependency is the fallback: npm 12
// and newer, Bun and pnpm block dependency install scripts, so the copy may
// never appear.
const fs = require("fs")
const os = require("os")
const path = require("path")

const TARGETS = {
  win32: { file: "fx-win-x64.exe", pkg: "fluxware-bin-win-x64" },
  linux: { file: "fx-linux-x64", pkg: "fluxware-bin-linux-x64" },
}

function target(platform) {
  return Object.prototype.hasOwnProperty.call(TARGETS, platform) ? TARGETS[platform] : null
}

function localBinary(platform, dir) {
  const found = target(platform)
  return found ? path.join(dir, found.file) : null
}

function packageBinary(platform) {
  const found = target(platform)
  if (!found) return null
  for (const spec of [`${found.pkg}/${found.file}`, `${found.pkg}/package.json`]) {
    try {
      const resolved = require.resolve(spec)
      const candidate = spec.endsWith("package.json")
        ? path.join(path.dirname(resolved), found.file)
        : resolved
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // The package is not installed, or this platform does not match its os/cpu.
    }
  }
  return null
}

function resolveBinary(platform = process.platform, dir = __dirname) {
  const local = localBinary(platform, dir)
  if (local && fs.existsSync(local)) return local
  return packageBinary(platform)
}

function cacheDir(platform = process.platform) {
  if (platform === "win32") return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "fluxware", "bin")
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(base, "fluxware", "bin")
}

// A binary inside a root-owned global install cannot get its executable bit
// back, so run a private copy from the user's cache instead. Published files all
// carry the same mtime, so the version decides when the copy is refreshed.
function cacheBinary(file, version = "dev", platform = process.platform) {
  try {
    const dir = cacheDir(platform)
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, path.basename(file))
    const stamp = `${dest}.version`
    const known = fs.existsSync(stamp) ? fs.readFileSync(stamp, "utf8").trim() : null
    if (!fs.existsSync(dest) || known !== version) {
      fs.copyFileSync(file, dest)
      fs.writeFileSync(stamp, version)
    }
    fs.chmodSync(dest, 0o755)
    return dest
  } catch {
    return null
  }
}

module.exports = { TARGETS, target, localBinary, packageBinary, resolveBinary, cacheDir, cacheBinary }
