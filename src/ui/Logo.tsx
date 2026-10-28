import { createTimeline, getTimelineEngine, type Timeline } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { createIntro, finalFrame, type Intro, type IntroFrame, type IntroKind } from "../core/intro"

type Point = readonly [x: number, y: number]

/**
 * Pixel letters, 6 pixels tall: half-block cells hold two pixels each, so the
 * logo takes 3 rows. Points go in stroke order, the way a pen draws them; the
 * contour animation follows it.
 */
const GLYPHS: { width: number; strokes: Point[] }[] = [
  {
    // F: stem top to bottom, then the top bar, then the middle bar.
    width: 5,
    strokes: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 0], [2, 0], [3, 0], [4, 0], [1, 2], [2, 2], [3, 2]],
  },
  {
    // L: stem top to bottom, then the foot.
    width: 5,
    strokes: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 5], [2, 5], [3, 5], [4, 5]],
  },
  {
    // X: one diagonal down to the right, then the other down to the left.
    width: 6,
    strokes: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [5, 0], [4, 1], [3, 2], [2, 3], [1, 4], [0, 5]],
  },
]
const HEIGHT = 6
const GAP = 2
export const LOGO_ROWS = HEIGHT / 2
export const LOGO_WIDTH = GLYPHS.reduce((w, g) => w + g.width, 0) + GAP * (GLYPHS.length - 1)

/** Gray for a brightness from 0 to 1: dim pixels read as unlit tubes on a dark terminal. */
function grayOf(level: number): string {
  const v = Math.round(0x1c + (0xff - 0x1c) * Math.min(1, Math.max(0, level)))
  const hex = v.toString(16).padStart(2, "0")
  return `#${hex}${hex}${hex}`
}

interface Run {
  text: string
  fg?: string
  bg?: string
}

/** Turns one frame into text rows: ▀ and ▄ carry the top and bottom pixel of a cell. */
export function logoRows(frame: IntroFrame): Run[][] {
  const grid = Array.from({ length: HEIGHT }, () => new Array<number>(LOGO_WIDTH).fill(0))
  let offset = 0
  GLYPHS.forEach((glyph, letter) => {
    const level = frame.levels[letter] ?? 1
    const drawn = frame.drawn[letter] ?? Number.POSITIVE_INFINITY
    glyph.strokes.forEach(([x, y], k) => {
      const row = grid[y]
      if (row) row[offset + x] = level * Math.min(1, Math.max(0, drawn - k))
    })
    offset += glyph.width + GAP
  })

  const rows: Run[][] = []
  for (let r = 0; r < LOGO_ROWS; r++) {
    const runs: Run[] = []
    for (let x = 0; x < LOGO_WIDTH; x++) {
      const top = grid[r * 2]?.[x] ?? 0
      const bottom = grid[r * 2 + 1]?.[x] ?? 0
      let cell: Run
      if (top > 0 && bottom > 0) cell = top === bottom ? { text: "█", fg: grayOf(top) } : { text: "▀", fg: grayOf(top), bg: grayOf(bottom) }
      else if (top > 0) cell = { text: "▀", fg: grayOf(top) }
      else if (bottom > 0) cell = { text: "▄", fg: grayOf(bottom) }
      else cell = { text: " " }
      const last = runs.at(-1)
      if (last && last.fg === cell.fg && last.bg === cell.bg) last.text += cell.text
      else runs.push(cell)
    }
    rows.push(runs)
  }
  return rows
}

/**
 * The FLX above the link field. It plays the intro of this launch, driven by
 * a Timeline, then stays white; a click plays the next animation, which
 * `onNext` picks. `dropDistance` is how many rows above its place the logo
 * starts in the drop animation; the screen clips it.
 */
export function FlxLogo(props: { kind: IntroKind | null; dropDistance: number; onNext?: () => IntroKind }) {
  const renderer = useRenderer()
  const [intro, setIntro] = useState<Intro | null>(null)
  const [t, setT] = useState(Number.POSITIVE_INFINITY)
  const current = useRef<Timeline | null>(null)

  function play(kind: IntroKind) {
    stop()
    const next = createIntro(kind, GLYPHS.map((g) => g.strokes.length))
    const clock = { t: 0 }
    // Each animation has its own length, so every play gets a fresh Timeline.
    const timeline = createTimeline({ duration: next.duration, autoplay: false }, renderer)
    timeline.add(clock, {
      t: next.duration,
      duration: next.duration,
      ease: "linear",
      onUpdate: () => setT(clock.t),
      onComplete: () => setT(Number.POSITIVE_INFINITY),
    })
    current.current = timeline
    setIntro(next)
    setT(0)
    timeline.play()
  }

  function stop() {
    const timeline = current.current
    if (!timeline) return
    timeline.pause()
    try {
      getTimelineEngine(renderer).unregister(timeline)
    } catch {
      // The renderer is already gone.
    }
    current.current = null
  }

  useEffect(() => {
    if (props.kind) play(props.kind)
    return stop
  }, [])

  const frame = intro && t < intro.duration ? intro.frame(t) : finalFrame(GLYPHS.length)
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={LOGO_WIDTH}
      top={-Math.round(frame.lift * props.dropDistance)}
      onMouseDown={() => {
        if (props.onNext) play(props.onNext())
      }}
    >
      {logoRows(frame).map((runs, r) => (
        <text key={r} wrapMode="none" selectable={false}>
          {runs.map((run, i) => (
            <span key={i} fg={run.fg} bg={run.bg}>
              {run.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  )
}
