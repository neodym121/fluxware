import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const binDir = path.join(import.meta.dir, "..", "bin")
const roots: string[] = []

type Target = { file: string; pkg: string }

type BinPath = {
  target: (platform: string) => Target | null
  localBinary: (platform: string, dir: string) => string | null
  packageBinary: (platform: string) => string | null
  resolveBinary: (platform?: string, dir?: string) => string | null
  cacheDir: (platform?: string) => string
  cacheBinary: (file: string, version?: string, platform?: string) => string | null
}

type Layout = { bin?: boolean; pkg?: boolean; nested?: boolean }

// Mimics a global npm install: node_modules/fluxware/bin plus a sibling
// node_modules/fluxware-bin-linux-x64, with no postinstall having run.
function globalInstall(layout: Layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fluxware-bin-"))
  roots.push(root)
  const appBin = path.join(root, "node_modules", "fluxware", "bin")
  fs.mkdirSync(appBin, { recursive: true })
  fs.copyFileSync(path.join(binDir, "bin-path.cjs"), path.join(appBin, "bin-path.cjs"))
  if (layout.bin) fs.writeFileSync(path.join(appBin, "fx-linux-x64"), "")
  if (layout.pkg) {
    const pkg = path.join(
      layout.nested ? path.join(appBin, "..", "node_modules") : path.join(root, "node_modules"),
      "fluxware-bin-linux-x64"
    )
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "fluxware-bin-linux-x64", version: "1.1.7" })
    )
    fs.writeFileSync(path.join(pkg, "fx-linux-x64"), "")
  }
  return { root, appBin, binPath: require(path.join(appBin, "bin-path.cjs")) as BinPath }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

test("resolves the binary from the optional package when postinstall was blocked", () => {
  const { root, appBin, binPath } = globalInstall({ pkg: true })
  expect(binPath.resolveBinary("linux", appBin)).toBe(
    path.join(root, "node_modules", "fluxware-bin-linux-x64", "fx-linux-x64")
  )
})

test("prefers the copy that install.cjs put next to fx.cjs", () => {
  const { appBin, binPath } = globalInstall({ bin: true, pkg: true })
  expect(binPath.resolveBinary("linux", appBin)).toBe(path.join(appBin, "fx-linux-x64"))
})

test("finds the package npm nested inside the app", () => {
  const { root, appBin, binPath } = globalInstall({ pkg: true, nested: true })
  expect(binPath.resolveBinary("linux", appBin)).toBe(
    path.join(root, "node_modules", "fluxware", "node_modules", "fluxware-bin-linux-x64", "fx-linux-x64")
  )
})

test("returns null when no binary is installed", () => {
  const { appBin, binPath } = globalInstall({})
  expect(binPath.resolveBinary("linux", appBin)).toBeNull()
})

test("reports no target for unsupported platforms", () => {
  const { appBin, binPath } = globalInstall({ pkg: true })
  expect(binPath.target("freebsd")).toBeNull()
  expect(binPath.localBinary("freebsd", appBin)).toBeNull()
  expect(binPath.resolveBinary("freebsd", appBin)).toBeNull()
})

test("uses the Windows file and package names on win32", () => {
  const binPath = require(path.join(binDir, "bin-path.cjs")) as BinPath
  expect(binPath.target("win32")).toEqual({ file: "fx-win-x64.exe", pkg: "fluxware-bin-win-x64" })
})

test("copies a binary it cannot chmod into the user cache", () => {
  const { root, binPath } = globalInstall({ pkg: true })
  const previous = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = root
  try {
    const source = path.join(root, "node_modules", "fluxware-bin-linux-x64", "fx-linux-x64")
    fs.writeFileSync(source, "1.1.7")
    const cached = binPath.cacheBinary(source, "1.1.7", "linux")
    expect(cached).toBe(path.join(root, "fluxware", "bin", "fx-linux-x64"))
    expect(fs.readFileSync(cached ?? "", "utf8")).toBe("1.1.7")

    expect(binPath.cacheBinary(source, "1.1.7", "linux")).toBe(cached)
    expect(fs.readFileSync(cached ?? "", "utf8")).toBe("1.1.7")

    fs.writeFileSync(source, "1.1.8")
    expect(binPath.cacheBinary(source, "1.1.8", "linux")).toBe(cached)
    expect(fs.readFileSync(cached ?? "", "utf8")).toBe("1.1.8")
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previous
  }
})

test("bin scripts are valid CommonJS", () => {
  for (const name of ["fx.cjs", "install.cjs", "bin-path.cjs"]) {
    const result = Bun.spawnSync(["node", "--check", path.join(binDir, name)])
    expect({ name, code: result.exitCode }).toEqual({ name, code: 0 })
  }
})
