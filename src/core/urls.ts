// A link runs until whitespace or the start of the next link: a single-line
// input strips newlines from pasted text, so links can arrive glued together.
// Bare links ("youtu.be/abc") count too, because the interface hides schemes.
const URL_RE =
  /(?:https?:\/\/|www\.)(?:(?!https?:\/\/)\S)+|(?<![\w@./-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/(?:(?!https?:\/\/)\S)*/gi
const TRAILING_PUNCT = /[.,;:!?)\]}>»"'’”]+$/
const SCHEME_RE = /https?:\/\//gi

export function isUrl(text: string): boolean {
  const t = text.trim()
  return /^(https?:\/\/|www\.)/i.test(t)
}

/**
 * Pulls every link out of arbitrary text: a tidy list, a messy log copied
 * from Discord or X, or links glued together. Links without a scheme get
 * https://. Keeps first-seen order and drops duplicates.
 */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of text.match(URL_RE) ?? []) {
    const trimmed = match.replace(TRAILING_PUNCT, "")
    if (!trimmed) continue
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    if (!seen.has(url)) {
      seen.add(url)
      result.push(url)
    }
  }
  return result
}

/**
 * Removes "https://" from text that goes on screen. Windows Terminal
 * underlines what looks like a URL on hover and keeps that underline after
 * the text is gone, so the interface never shows a scheme. A scheme glued to
 * the previous link becomes a space, so the links stay apart.
 */
export function hideSchemes(text: string): string {
  return text.replace(/(\S)https?:\/\//gi, "$1 ").replace(SCHEME_RE, "")
}

export function isYoutubeUrl(url: string): boolean {
  return /(^|[./])(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(url) || /music\.youtube\.com/i.test(url)
}

export function isSoundCloudUrl(url: string): boolean {
  return /(^|[./])soundcloud\.com\//i.test(url) || /(^|\/\/)on\.soundcloud\.com\//i.test(url) || /snd\.sc\//i.test(url)
}

/** Short form for the screen: host and path without the scheme. */
export function shortUrl(url: string, max = 48): string {
  const s = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "")
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}
