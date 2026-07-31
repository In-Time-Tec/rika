import { TextAttributes, type TextChunk } from "@opentui/core"
import { describe, expect, test } from "vitest"
import { highlightShellCommand } from "../src/syntax-highlight"
import { colors } from "../src/theme"

const flat = (command: string): ReadonlyArray<TextChunk> => highlightShellCommand(command).flat()

const chunkFor = (chunks: ReadonlyArray<TextChunk>, text: string): TextChunk => {
  const chunk = chunks.find((candidate) => candidate.text.includes(text))
  if (chunk === undefined) throw new Error(`Missing styled chunk for ${text}`)
  return chunk
}

const hasAttribute = (chunk: TextChunk, attribute: number): boolean =>
  ((chunk.attributes ?? TextAttributes.NONE) & attribute) === attribute

describe("shell command highlighting", () => {
  test("bolds command words and colors flags and operators across chained commands", () => {
    const chunks = flat("git log --oneline -3 && git status --short")
    const commands = chunks.filter((chunk) => chunk.text === "git")
    expect(commands).toHaveLength(2)
    for (const command of commands) expect(hasAttribute(command, TextAttributes.BOLD)).toBe(true)
    expect(chunkFor(chunks, "log").attributes ?? TextAttributes.NONE).toBe(TextAttributes.NONE)
    expect(chunkFor(chunks, "--oneline").fg?.equals(colors.amber)).toBe(true)
    expect(chunkFor(chunks, "-3").fg?.equals(colors.amber)).toBe(true)
    expect(chunkFor(chunks, "--short").fg?.equals(colors.amber)).toBe(true)
    expect(hasAttribute(chunkFor(chunks, "&&"), TextAttributes.DIM)).toBe(true)
  })

  test("keeps operators inside quoted strings green", () => {
    const chunks = flat('echo "a && b"')
    const quoted = chunkFor(chunks, "&&")
    expect(quoted.text).toBe('"a && b"')
    expect(quoted.fg?.equals(colors.green)).toBe(true)
  })

  test("splits flag values and colors quoted values green", () => {
    const chunks = flat("git commit --message='fix: x'")
    expect(chunkFor(chunks, "--message=").fg?.equals(colors.amber)).toBe(true)
    expect(chunkFor(chunks, "'fix: x'").fg?.equals(colors.green)).toBe(true)
  })

  test("colors environment assignments and keeps the following command bold", () => {
    const chunks = flat("GIT_EDITOR=true git rebase --continue")
    expect(chunkFor(chunks, "GIT_EDITOR=").fg?.equals(colors.amber)).toBe(true)
    expect(hasAttribute(chunkFor(chunks, "git"), TextAttributes.BOLD)).toBe(true)
    expect(chunkFor(chunks, "--continue").fg?.equals(colors.amber)).toBe(true)
  })

  test("keeps command position after a quoted assignment value", () => {
    const chunks = flat('GIT_EDITOR="vim -n" git rebase')
    expect(chunkFor(chunks, '"vim -n"').fg?.equals(colors.green)).toBe(true)
    expect(hasAttribute(chunkFor(chunks, "git"), TextAttributes.BOLD)).toBe(true)
  })

  test("mutes heredoc bodies and terminators while keeping the line count", () => {
    const command = "python3 - <<'PY'\nimport sys\nprint(\"hi && bye\")\nPY"
    const lines = highlightShellCommand(command)
    expect(lines).toHaveLength(command.split("\n").length)
    const chunks = lines.flat()
    expect(hasAttribute(chunkFor(chunks, "python3"), TextAttributes.BOLD)).toBe(true)
    expect(hasAttribute(chunkFor(chunks, "<<"), TextAttributes.DIM)).toBe(true)
    expect(chunkFor(chunks, "'PY'").fg?.equals(colors.muted)).toBe(true)
    expect(chunkFor(chunks, "import sys").fg?.equals(colors.muted)).toBe(true)
    expect(chunkFor(chunks, 'print("hi && bye")').fg?.equals(colors.muted)).toBe(true)
    expect(lines[3]![0]!.text).toBe("PY")
    expect(lines[3]![0]!.fg?.equals(colors.muted)).toBe(true)
  })

  test("mutes comments", () => {
    const chunks = flat("ls # list files")
    expect(chunkFor(chunks, "# list files").fg?.equals(colors.muted)).toBe(true)
  })

  test("dims backslash continuations and classifies continuation-line words", () => {
    const flagged = flat("git log \\\n    --oneline")
    expect(hasAttribute(chunkFor(flagged, "\\"), TextAttributes.DIM)).toBe(true)
    expect(chunkFor(flagged, "--oneline").fg?.equals(colors.amber)).toBe(true)
    const bolded = flat("docker run \\\n    nginx")
    expect(hasAttribute(chunkFor(bolded, "nginx"), TextAttributes.BOLD)).toBe(true)
  })

  test("dims redirects without bolding their targets", () => {
    const chunks = flat("echo hi > out.txt")
    expect(hasAttribute(chunkFor(chunks, ">"), TextAttributes.DIM)).toBe(true)
    const target = chunkFor(chunks, "out.txt")
    expect(target.attributes ?? TextAttributes.NONE).toBe(TextAttributes.NONE)
    expect(target.fg?.equals(colors.text)).toBe(true)
  })

  test("bolds commands after command substitution and pipes", () => {
    const chunks = flat("echo $(git rev-parse HEAD) | wc -l")
    expect(hasAttribute(chunkFor(chunks, "git"), TextAttributes.BOLD)).toBe(true)
    expect(hasAttribute(chunkFor(chunks, "wc"), TextAttributes.BOLD)).toBe(true)
    expect(hasAttribute(chunkFor(chunks, "|"), TextAttributes.DIM)).toBe(true)
  })

  test("returns the cached lines on repeated calls", () => {
    const command = "git status --short"
    expect(highlightShellCommand(command)).toBe(highlightShellCommand(command))
  })
})
