import stringWidth from "string-width"
import { describe, expect, test } from "vitest"
import { formatContextTokens } from "../src/state/model/terminal-usage-state"
import {
  clipToWidth,
  escapeControlCharacters,
  formatBytes,
  formatTokens,
  homeRelativePath,
  plural,
} from "../src/presentation/terminal/terminal-format"
import { relativeTime } from "../src/presentation/terminal/terminal-relative-time"

describe("format", () => {
  test("abbreviates token counts with one owner", () => {
    expect(formatTokens(1)).toBe("1 tok")
    expect(formatTokens(999)).toBe("999 tok")
    expect(formatTokens(1_234)).toBe("1.2K tok")
    expect(formatTokens(2_000)).toBe("2K tok")
    expect(formatTokens(12_345)).toBe("12.3K tok")
    expect(formatTokens(1_234_567)).toBe("1.2M tok")
  })

  test("keeps context capacities precise", () => {
    expect(formatContextTokens(56_120)).toBe("56.1K")
    expect(formatContextTokens(922_000)).toBe("922K")
    expect(formatContextTokens(1_050_000)).toBe("1.05M")
  })

  test("clips by terminal cell width, not code units", () => {
    expect(stringWidth(clipToWidth("界界界界界", 6))).toBeLessThanOrEqual(6)
    expect(clipToWidth("界界界界界", 6)).toBe("界界…")
    expect(clipToWidth("abc", 10)).toBe("abc")
    expect(clipToWidth("abcdef", 1)).toBe("…")
  })

  test("escapes control characters in one notation", () => {
    expect(escapeControlCharacters("a\nb")).toBe("a\\nb")
    expect(escapeControlCharacters("a\u001bb")).toBe("a\\u{1b}b")
  })

  test("pluralizes including -ch nouns", () => {
    expect(plural(1, "file")).toBe("1 file")
    expect(plural(2, "file")).toBe("2 files")
    expect(plural(2, "search")).toBe("2 searches")
  })

  test("shortens paths under any home directory, not just macOS", () => {
    expect(homeRelativePath("/home/ada/projects")).toBe("~/projects")
    expect(homeRelativePath("/Users/ada/projects")).toBe("~/projects")
    expect(homeRelativePath("/var/home/ada/projects")).toBe("~/projects")
    expect(homeRelativePath("/home/ada")).toBe("~")
    expect(homeRelativePath("/srv/app")).toBe("/srv/app")
  })

  test("renders relative time on one ladder", () => {
    expect(relativeTime(0)).toBe("now")
    expect(relativeTime(30_000)).toBe("now")
    expect(relativeTime(5 * 60_000)).toBe("5m ago")
    expect(relativeTime(3 * 3_600_000)).toBe("3h ago")
    expect(relativeTime(2 * 86_400_000)).toBe("2d ago")
    expect(relativeTime(-5_000)).toBe("now")
  })

  test("formats byte sizes across tiers", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(4_823_117)).toBe("4.8 MB")
  })
})
