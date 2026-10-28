import { spawn, spawnSync, type ChildProcess } from "node:child_process"

export interface RunOptions {
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  code: number | null
  aborted: boolean
}

/** Environment for Python children: UTF-8 pipes, so Cyrillic titles survive. */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...extra }
}

function lineSplitter(onLine: (line: string) => void) {
  let rest = ""
  return {
    push(chunk: string) {
      rest += chunk
      let index: number
      while ((index = rest.indexOf("\n")) !== -1) {
        onLine(rest.slice(0, index).replace(/\r$/, ""))
        rest = rest.slice(index + 1)
      }
    },
    end() {
      if (rest) onLine(rest.replace(/\r$/, ""))
      rest = ""
    },
  }
}

/**
 * Kills a process and everything it started. yt-dlp starts ffmpeg, and the
 * pip launcher yt-dlp.exe starts python.exe, so killing the top process alone
 * can leave workers behind on Windows.
 */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
  } else {
    child.kill("SIGTERM")
  }
}

const running = new Set<ChildProcess>()

/** Kills every child that is still running, for application shutdown. */
export function killAllChildren(): void {
  for (const child of running) killTree(child)
  running.clear()
}

export function runProcess(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ code: null, aborted: true })
      return
    }

    let child: ChildProcess
    try {
      child = spawn(command, args, { env: options.env ?? childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      options.onStderrLine?.(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
      resolve({ code: -1, aborted: false })
      return
    }
    running.add(child)

    const out = lineSplitter((line) => options.onStdoutLine?.(line))
    const err = lineSplitter((line) => options.onStderrLine?.(line))
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => out.push(chunk))
    child.stderr?.on("data", (chunk: string) => err.push(chunk))

    let aborted = false
    const onAbort = () => {
      aborted = true
      killTree(child)
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      running.delete(child)
      options.signal?.removeEventListener("abort", onAbort)
      out.end()
      err.end()
      resolve({ code, aborted })
    }
    child.on("error", (error) => {
      options.onStderrLine?.(`ERROR: ${error.message}`)
      finish(-1)
    })
    child.on("close", (code) => finish(code))
  })
}

/** Runs a command to completion and returns trimmed stdout, or null on failure. */
export async function captureOutput(command: string, args: readonly string[], timeoutMs = 15000): Promise<string | null> {
  const lines: string[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const result = await runProcess(command, args, { onStdoutLine: (l) => lines.push(l), signal: controller.signal })
    return result.code === 0 ? lines.join("\n").trim() : null
  } finally {
    clearTimeout(timer)
  }
}

/** Opens a folder in the system file manager, selecting a file when given. */
export function revealInFileManager(target: { dir: string; file?: string | null }): void {
  const detached = { detached: true, stdio: "ignore" as const, windowsHide: false }
  try {
    if (process.platform === "win32") {
      // explorer.exe parses its own command line and wants /select,"path"; Node's
      // quoting would wrap the whole argument, so the line is passed verbatim.
      const arg = target.file ? `/select,"${target.file}"` : `"${target.dir}"`
      spawn("explorer.exe", [arg], { ...detached, windowsVerbatimArguments: true }).unref()
    } else if (process.platform === "darwin") {
      spawn("open", target.file ? ["-R", target.file] : [target.dir], detached).unref()
    } else {
      spawn("xdg-open", [target.dir], detached).unref()
    }
  } catch {
    // Nothing useful to report: the file manager is optional.
  }
}
