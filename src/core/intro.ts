import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** The animations of the FLX logo; they take turns, one per launch. */
export type IntroKind = "flicker" | "contour" | "drop"

export const INTRO_KINDS: readonly IntroKind[] = ["flicker", "contour", "drop"]

export interface IntroFrame {
  /** Brightness of each letter: 0 is unlit, 1 is white. */
  levels: number[]
  /** Pixels of each letter drawn so far, along its stroke order; fractions fade the pen tip in. */
  drawn: number[]
  /** How far the logo still is above its place: 1 is the whole drop, 0 is in place. */
  lift: number
}

export interface Intro {
  kind: IntroKind
  duration: number
  frame(t: number): IntroFrame
}

type Rng = () => number

export function finalFrame(letters: number): IntroFrame {
  return {
    levels: Array.from({ length: letters }, () => 1),
    drawn: Array.from({ length: letters }, () => Number.POSITIVE_INFINITY),
    lift: 0,
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const all = (letters: number, value: number) => Array.from({ length: letters }, () => value)

interface Segment {
  until: number
  level: number
}

/**
 * A fluorescent tube warming up: each letter starts at its own moment, flashes
 * on and off with a faint glow between flashes, flashes more often as it warms
 * up, and then stays lit.
 */
function flicker(letters: number, rng: Rng): Intro {
  const schedules: { start: number; segments: Segment[] }[] = []
  let end = 0
  for (let i = 0; i < letters; i++) {
    const start = 150 + i * 280 + rng() * 260
    const span = 650 + rng() * 450
    const segments: Segment[] = []
    let time = start
    let on = true
    while (time < start + span) {
      const progress = (time - start) / span
      const length = on ? 40 + rng() * 90 : 60 + rng() * 160 * (1 - progress)
      segments.push({ until: Math.min(time + length, start + span), level: on ? 0.55 + rng() * 0.45 : 0.04 + rng() * 0.08 })
      time += length
      // A warm tube goes dark less often and lights up sooner.
      on = on ? rng() > (1 - progress) * 0.85 : rng() < 0.45 + progress * 0.55
    }
    schedules.push({ start, segments })
    end = Math.max(end, start + span)
  }
  return {
    kind: "flicker",
    duration: Math.ceil(end + 80),
    frame(t) {
      const levels = schedules.map(({ start, segments }) => (t < start ? 0 : segments.find((s) => t < s.until)?.level ?? 1))
      return { levels, drawn: all(letters, Number.POSITIVE_INFINITY), lift: 0 }
    },
  }
}

const PIXEL_TIME = 55
const LETTER_DELAY = 420

/** A pen draws each letter along its strokes, pixel by pixel, one letter after another. */
function contour(pixelCounts: readonly number[]): Intro {
  const starts = pixelCounts.map((_, i) => 150 + i * LETTER_DELAY)
  const end = Math.max(...pixelCounts.map((count, i) => (starts[i] ?? 0) + count * PIXEL_TIME))
  return {
    kind: "contour",
    duration: Math.ceil(end + 120),
    frame(t) {
      const drawn = pixelCounts.map((_, i) => Math.max(0, (t - (starts[i] ?? 0)) / PIXEL_TIME))
      return { levels: all(pixelCounts.length, 1), drawn, lift: 0 }
    },
  }
}

const DROP_TIME = 1900
const BLINK = 110
const BLINKS = 3

/** Like a Game Boy boot: the logo slides down slowly, lands, and blinks a few times. */
function drop(letters: number): Intro {
  const landed = DROP_TIME + 160
  return {
    kind: "drop",
    duration: landed + BLINKS * 2 * BLINK + 60,
    frame(t) {
      const drawn = all(letters, Number.POSITIVE_INFINITY)
      if (t < DROP_TIME) return { levels: all(letters, 0.85), drawn, lift: 1 - clamp01(t / DROP_TIME) }
      const phase = Math.floor((t - landed) / BLINK)
      const off = t >= landed && phase < BLINKS * 2 && phase % 2 === 0
      return { levels: all(letters, off ? 0 : 1), drawn, lift: 0 }
    },
  }
}

/** `pixelCounts` holds the stroke length of each letter, which the contour animation draws. */
export function createIntro(kind: IntroKind, pixelCounts: readonly number[], rng: Rng = Math.random): Intro {
  switch (kind) {
    case "flicker":
      return flicker(pixelCounts.length, rng)
    case "contour":
      return contour(pixelCounts)
    case "drop":
      return drop(pixelCounts.length)
  }
}

/**
 * The animation for this launch: the one after the last played, saved in
 * `statePath`. FLUXWARE_INTRO picks one by name, or turns them off with "none".
 */
export function nextIntro(statePath: string, env: NodeJS.ProcessEnv = process.env): IntroKind | null {
  const wanted = env.FLUXWARE_INTRO?.trim().toLowerCase()
  if (wanted === "none" || wanted === "off" || wanted === "0") return null
  if (wanted && (INTRO_KINDS as readonly string[]).includes(wanted)) return wanted as IntroKind
  let last: unknown
  try {
    last = JSON.parse(readFileSync(statePath, "utf8"))?.lastIntro
  } catch {
    last = undefined
  }
  const kind = INTRO_KINDS[(INTRO_KINDS.indexOf(last as IntroKind) + 1) % INTRO_KINDS.length] as IntroKind
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ lastIntro: kind }) + "\n", "utf8")
  } catch {
    // Without a writable state file every launch plays the first animation.
  }
  return kind
}
