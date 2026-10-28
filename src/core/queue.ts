import { mkdirSync } from "node:fs"
import { leftoverCandidates, removeLeftovers } from "./cleanup"
import { describeQualityDrop, downloadLabel, type DownloadLabel, type YtInfo } from "./media"
import { runProcess, type RunOptions, type RunResult } from "./process"
import type { AudioFormat, Settings, VideoFormat } from "./settings"
import { downloadArgs, parseLine, postprocessorLabel, splitArgs, type Tools } from "./ytdlp"

export type JobKind = "video" | "audio"
export type JobSource = "download" | "batch"
export type JobStatus = "queued" | "running" | "done" | "failed" | "canceled"

export interface Job {
  id: number
  url: string
  kind: JobKind
  /** Maximum video height; null means the best available. */
  height: number | null
  source: JobSource
  dir: string
  videoFormat: VideoFormat
  audioFormat: AudioFormat
  status: JobStatus
  label: DownloadLabel | null
  phase: "starting" | "downloading" | "processing" | null
  /** Which track the current progress belongs to. */
  stream: "video" | "audio" | "both" | null
  progress: number | null
  downloaded: number | null
  total: number | null
  speed: number | null
  eta: number | null
  postprocessor: string | null
  /** Position inside a playlist download. */
  item: { index: number; count: number; playlist: string | null } | null
  files: string[]
  /** Quality warnings: the video came out worse than it could. */
  warnings: string[]
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface JobRequest {
  url: string
  kind: JobKind
  height?: number | null
  source: JobSource
  dir: string
  label?: DownloadLabel | null
}

export interface QueueSummary {
  running: number
  queued: number
  done: number
  failed: number
  canceled: number
  /** Sum of the speeds of running downloads, bytes per second. */
  speed: number
  /** Progress of the current run from 0 to 1, or null when idle. */
  overall: number | null
}

export interface RunStats {
  done: number
  failed: number
  canceled: number
}

type Runner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>

export interface QueueDeps {
  getTools: () => Tools | null
  getSettings: () => Settings
  run?: Runner
  mkdir?: (dir: string) => void
  /** How long to coalesce updates before listeners hear about them. */
  throttleMs?: number
}

const FINISHED: readonly JobStatus[] = ["done", "failed", "canceled"]

export function isFinished(job: Job): boolean {
  return FINISHED.includes(job.status)
}

export class DownloadQueue {
  private jobs: Job[] = []
  private nextId = 1
  private listeners = new Set<() => void>()
  private idleListeners = new Set<(stats: RunStats) => void>()
  private finishListeners = new Set<(job: Job) => void>()
  private controllers = new Map<number, AbortController>()
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private runIds = new Set<number>()
  private readonly run: Runner
  private readonly mkdir: (dir: string) => void
  private readonly throttleMs: number

  constructor(private readonly deps: QueueDeps) {
    this.run = deps.run ?? runProcess
    this.mkdir = deps.mkdir ?? ((dir) => mkdirSync(dir, { recursive: true }))
    this.throttleMs = deps.throttleMs ?? 80
  }

  getSnapshot = (): readonly Job[] => this.jobs

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called when the last download of a run finishes. */
  onIdle(listener: (stats: RunStats) => void): () => void {
    this.idleListeners.add(listener)
    return () => this.idleListeners.delete(listener)
  }

  /** Called once for every job that ends: done, failed, or canceled while running. */
  onFinished(listener: (job: Job) => void): () => void {
    this.finishListeners.add(listener)
    return () => this.finishListeners.delete(listener)
  }

  get activeCount(): number {
    return this.jobs.filter((j) => j.status === "running" || j.status === "queued").length
  }

  summary(): QueueSummary {
    const s: QueueSummary = { running: 0, queued: 0, done: 0, failed: 0, canceled: 0, speed: 0, overall: null }
    let runTotal = 0
    let runProgress = 0
    for (const job of this.jobs) {
      if (job.status === "running") {
        s.running++
        s.speed += job.speed ?? 0
      } else s[job.status]++
      if (this.runIds.has(job.id)) {
        runTotal++
        runProgress += isFinished(job) ? 1 : job.status === "running" ? job.progress ?? 0 : 0
      }
    }
    if (runTotal > 0 && (s.running > 0 || s.queued > 0)) s.overall = runProgress / runTotal
    return s
  }

  add(requests: readonly JobRequest[]): Job[] {
    const settings = this.deps.getSettings()
    const added = requests.map((r): Job => {
      const job: Job = {
        id: this.nextId++,
        url: r.url,
        kind: r.kind,
        height: r.height ?? null,
        source: r.source,
        dir: r.dir,
        videoFormat: settings.videoFormat,
        audioFormat: settings.audioFormat,
        status: "queued",
        label: r.label ?? null,
        phase: null,
        stream: null,
        progress: null,
        downloaded: null,
        total: null,
        speed: null,
        eta: null,
        postprocessor: null,
        item: null,
        files: [],
        warnings: [],
        error: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      }
      this.runIds.add(job.id)
      return job
    })
    this.jobs = [...this.jobs, ...added]
    this.emitNow()
    this.pump()
    return added
  }

  cancel(id: number): void {
    const job = this.find(id)
    if (!job) return
    if (job.status === "queued") {
      this.patch(id, { status: "canceled", finishedAt: Date.now() })
      this.emitNow()
      this.checkIdle()
    } else if (job.status === "running") {
      this.controllers.get(id)?.abort()
    }
  }

  cancelAll(): void {
    for (const job of this.jobs) if (!isFinished(job)) this.cancel(job.id)
  }

  /** Resolves once nothing runs, or after `timeoutMs`; shutdown waits here for cleanup. */
  whenIdle(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        off()
        resolve()
      }
      const check = () => {
        if (!this.jobs.some((j) => j.status === "running")) done()
      }
      const timer = setTimeout(done, timeoutMs)
      const off = this.subscribe(check)
      check()
    })
  }

  retry(id: number): void {
    const job = this.find(id)
    if (!job || (job.status !== "failed" && job.status !== "canceled")) return
    this.runIds.add(id)
    this.patch(id, {
      status: "queued",
      error: null,
      warnings: [],
      files: [],
      progress: null,
      phase: null,
      item: null,
      postprocessor: null,
      finishedAt: null,
    })
    this.emitNow()
    this.pump()
  }

  remove(id: number): void {
    const job = this.find(id)
    if (!job || !isFinished(job)) return
    this.jobs = this.jobs.filter((j) => j.id !== id)
    this.runIds.delete(id)
    this.emitNow()
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => !isFinished(j))
    this.emitNow()
  }

  private find(id: number): Job | undefined {
    return this.jobs.find((j) => j.id === id)
  }

  private patch(id: number, changes: Partial<Job>): void {
    this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, ...changes } : j))
  }

  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    for (const listener of this.listeners) listener()
  }

  private emitSoon(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      for (const listener of this.listeners) listener()
    }, this.throttleMs)
  }

  private pump(): void {
    const limit = this.deps.getSettings().concurrency
    // start() marks its job running before it yields, so each pass sees fresh state.
    for (;;) {
      if (this.jobs.filter((j) => j.status === "running").length >= limit) return
      const next = this.jobs.find((j) => j.status === "queued")
      if (!next) return
      void this.start(next.id)
    }
  }

  private checkIdle(): void {
    if (this.activeCount > 0 || this.runIds.size === 0) return
    const stats: RunStats = { done: 0, failed: 0, canceled: 0 }
    for (const job of this.jobs) {
      if (!this.runIds.has(job.id)) continue
      if (job.status === "done") stats.done++
      else if (job.status === "failed") stats.failed++
      else if (job.status === "canceled") stats.canceled++
    }
    this.runIds.clear()
    for (const listener of this.idleListeners) listener(stats)
  }

  private async start(id: number): Promise<void> {
    const initial = this.find(id)
    if (initial?.status !== "queued") return
    this.patch(id, { status: "running", phase: "starting", startedAt: Date.now(), progress: null })
    this.emitNow()

    const finish = (changes: Partial<Job>) => {
      this.controllers.delete(id)
      this.patch(id, { phase: null, speed: null, eta: null, postprocessor: null, finishedAt: Date.now(), ...changes })
      const finished = this.find(id)
      if (finished) for (const listener of this.finishListeners) listener(finished)
      this.emitNow()
      this.checkIdle()
      this.pump()
    }

    const tools = this.deps.getTools()
    if (!tools?.ytdlp) {
      finish({ status: "failed", error: "yt-dlp не найден: установи его и перезапусти fluxware" })
      return
    }
    try {
      this.mkdir(initial.dir)
    } catch (error) {
      finish({ status: "failed", error: `не удалось создать папку ${initial.dir}: ${error instanceof Error ? error.message : error}` })
      return
    }

    const settings = this.deps.getSettings()
    const args = downloadArgs(
      {
        url: initial.url,
        kind: initial.kind,
        height: initial.height,
        dir: initial.dir,
        videoFormat: initial.videoFormat,
        audioFormat: initial.audioFormat,
      },
      { jsRuntimes: tools.jsRuntimes, customArgs: splitArgs(settings.ytdlpArgs).args },
    )

    const controller = new AbortController()
    this.controllers.set(id, controller)
    const errors: string[] = []
    const ytWarnings: string[] = []
    let lastStderr: string | null = null
    let info: YtInfo | null = null
    // Files this run writes into, for the cleanup after a cancel.
    const streams = new Set<string>()
    const outputs = new Set<string>()
    const startedAt = Date.now()

    const onLine = (fromStderr: boolean) => (line: string) => {
      const event = parseLine(line)
      const job = this.find(id)
      if (!job) return
      switch (event.type) {
        case "info": {
          info = event.info
          const output = event.info._filename ?? event.info.filename
          if (output) outputs.add(output)
          const index = event.info.playlist_index
          const count = event.info.n_entries ?? event.info.playlist_count
          this.patch(id, {
            label: downloadLabel(event.info),
            phase: "downloading",
            stream: null,
            progress: 0,
            postprocessor: null,
            item: index && count ? { index, count, playlist: event.info.playlist_title ?? null } : null,
          })
          break
        }
        case "progress": {
          if (event.file) streams.add(event.file)
          if (event.status === "finished") {
            this.patch(id, { progress: 1, speed: null, eta: null })
            break
          }
          const fraction =
            event.total && event.downloaded != null
              ? event.downloaded / event.total
              : event.fragmentIndex && event.fragmentCount
                ? event.fragmentIndex / event.fragmentCount
                : null
          this.patch(id, {
            phase: "downloading",
            stream: event.stream,
            progress: fraction == null ? null : Math.min(1, Math.max(0, fraction)),
            downloaded: event.downloaded,
            total: event.total,
            speed: event.speed,
            eta: event.eta,
            postprocessor: null,
          })
          break
        }
        case "postprocess":
          if (event.status === "started") this.patch(id, { phase: "processing", postprocessor: postprocessorLabel(event.name), speed: null, eta: null })
          break
        case "file": {
          const warnings =
            job.kind === "video" ? describeQualityDrop(info, job.height, ytWarnings, job.videoFormat) : null
          const prefix = job.item && info?.title ? `${info.title}: ` : ""
          this.patch(id, {
            files: [...job.files, event.path],
            warnings: warnings ? [...job.warnings, ...warnings.map((w, i) => (i === 0 ? prefix + w : w))] : job.warnings,
          })
          break
        }
        case "warning":
          ytWarnings.push(event.message)
          break
        case "error":
          errors.push(event.message)
          break
        case "other":
          if (fromStderr && event.line.trim()) lastStderr = event.line.trim()
          break
      }
      this.emitSoon()
    }

    const ytdlp = tools.ytdlp
    const result = await this.run(ytdlp.command, [...ytdlp.prefix, ...args], {
      signal: controller.signal,
      onStdoutLine: onLine(false),
      onStderrLine: onLine(true),
    })

    if (result.aborted) {
      // A canceled download leaves .part pieces and the cover; remove what this run created.
      this.patch(id, { phase: "processing", postprocessor: "удаление временных файлов", speed: null, eta: null })
      this.emitNow()
      await removeLeftovers(await leftoverCandidates(streams, outputs), startedAt)
      finish({ status: "canceled" })
    }
    else if (result.code === 0) finish({ status: "done", progress: 1 })
    else finish({ status: "failed", error: errors.at(-1) ?? lastStderr ?? `yt-dlp завершился с кодом ${result.code}` })
  }
}
