import { useEffect, useRef } from "react"
import { theme } from "../theme"

/** Keyboard entry into the content window: Tab lands on the first zone, Shift+Tab on the last. */
export interface FocusEntry {
  seq: number
  edge: "first" | "last"
}

export interface ScreenProps {
  /** The content window has keyboard focus and this screen is shown. */
  focused: boolean
  /** Inner width of the content window, in columns. */
  width: number
  height: number
  onFocusRequest: () => void
  entry: FocusEntry
}

/** Runs `onEnter` each time Tab or Shift+Tab brings focus into the screen. */
export function useFocusEntry(entry: FocusEntry, onEnter: (edge: FocusEntry["edge"]) => void) {
  const handler = useRef(onEnter)
  handler.current = onEnter
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    handler.current(entry.edge)
  }, [entry.seq])
}

export function ErrorLine(props: { text: string | null }) {
  if (!props.text) return null
  return (
    <text fg={theme.error} wrapMode="word">
      {"✗ " + props.text}
    </text>
  )
}
