export type Language = "ru" | "en"

export const LANGUAGES: readonly Language[] = ["ru", "en"]

export const LANGUAGE_NAMES: Record<Language, string> = { ru: "Русский", en: "English" }

let current: Language = "ru"

export function getLanguage(): Language {
  return current
}

export function setLanguage(language: Language): void {
  current = language
}

/** Picks the text of the active language: `tr("скачка", "download")`. */
export function tr(ru: string, en: string): string {
  return current === "en" ? en : ru
}

/** Counts a noun in the active language: Russian has three forms, English two. */
export function count(n: number, ru: readonly [string, string, string], en: readonly [string, string]): string {
  if (current === "en") return n === 1 ? en[0] : en[1]
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return ru[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return ru[1]
  return ru[2]
}

/** The language of the system, used until the user picks one. */
export function detectLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const hint = env.LC_ALL || env.LC_MESSAGES || env.LANG || ""
  let locale = hint
  if (!locale) {
    try {
      locale = Intl.DateTimeFormat().resolvedOptions().locale
    } catch {
      locale = ""
    }
  }
  return /^ru(?![a-z])/i.test(locale) ? "ru" : "en"
}
