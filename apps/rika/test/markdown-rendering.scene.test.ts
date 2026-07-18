import { expect, test } from "vitest"
import { Scene } from "./scene"

const childMarkdown =
  "### CHILD-ALPHA\n\n- **child-bravo**\n- `child-charlie`\n\n| Key | Value |\n|---|---|\n| child-delta | child-echo |"

const runMarkdownScene = (response: string, marker: string, columns = 100) =>
  Scene.run({
    response,
    terminal: { columns, rows: 36 },
    actions: [
      Scene.action.writeAfter("medium", "Render adversarial Markdown.\r"),
      Scene.action.writeAfter(marker, "\u0003", 100),
    ],
  })

const expectIsolatedModel = (result: Awaited<ReturnType<typeof Scene.run>>) => {
  expect(result.timedOut, result.output).toBe(false)
  expect(result.exitCode, result.output).toBe(0)
  expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
}

test(
  "renders every heading depth and inline Markdown in the real transcript",
  () =>
    runMarkdownScene(
      [
        "# H1 ALPHA",
        "## H2 BRAVO",
        "### H3 CHARLIE",
        "#### H4 DELTA",
        "##### H5 ECHO",
        "###### H6 FOXTROT",
        "**bold-golf** *italic-hotel* ~~struck-india~~ `code-juliet` [linked-kilo](https://example.test/kilo)",
        "INLINE-END-LIMA",
      ].join("\n\n"),
      "INLINE-END-LIMA",
    ).then((result) => {
      expectIsolatedModel(result)
      for (const text of [
        "H1 ALPHA",
        "H2 BRAVO",
        "H3 CHARLIE",
        "H4 DELTA",
        "H5 ECHO",
        "H6 FOXTROT",
        "bold-golf",
        "italic-hotel",
        "struck-india",
        "code-juliet",
        "linked-kilo",
      ])
        expect(result.output).toContain(text)
      expect(result.output).not.toContain("https://example.test/kilo")
    }),
  45_000,
)

test(
  "renders nested ordered, unordered, task, and wrapped lists at narrow width",
  () =>
    runMarkdownScene(
      [
        "1. ordered-november",
        "2. wrapped-oscar carries several words without losing the final payload",
        "   - nested-papa",
        "     - deep-quebec",
        "- [x] checked-romeo",
        "- [ ] unchecked-sierra",
        "",
        "LIST-END-TANGO",
      ].join("\n"),
      "LIST-END-TANGO",
      46,
    ).then((result) => {
      expectIsolatedModel(result)
      for (const text of [
        "ordered-november",
        "final payload",
        "nested-papa",
        "deep-quebec",
        "[x] checked-romeo",
        "[ ] unchecked-sierra",
        "LIST-END-TANGO",
      ])
        expect(result.output).toContain(text)
    }),
  45_000,
)

test(
  "preserves fenced code and Unicode graphemes at narrow width",
  () =>
    runMarkdownScene(
      [
        "```ts",
        'const rocket = "界界 👩‍💻 é café"',
        "const unbroken = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS'",
        "```",
        "UNICODE-END-UNIFORM",
      ].join("\n"),
      "UNICODE-END-UNIFORM",
      44,
    ).then((result) => {
      expectIsolatedModel(result)
      for (const text of ["const rocket", "界界", "👩‍💻", "é"]) expect(result.output).toContain(text)
      expect(result.output.replace(/\s/gu, "")).toContain("SUPERCALIFRAGILISTICEXPIALIDOCIOUS")
      expect(result.output).not.toContain("```ts")
    }),
  45_000,
)

test(
  "renders a bounded table grid with wrapped cells",
  () =>
    runMarkdownScene(
      [
        "| Layer | Responsibility |",
        "|---|---|",
        "| Relay | durable-uniform execution |",
        "| Baton | streaming-victor agent loop |",
        "| Rika | product-whiskey semantics |",
        "",
        "TABLE-END-XRAY",
      ].join("\n"),
      "TABLE-END-XRAY",
      72,
    ).then((result) => {
      expectIsolatedModel(result)
      for (const text of ["╭", "Layer", "Responsibility", "durable-uniform", "streaming-victor", "product-whiskey"])
        expect(result.output).toContain(text)
      expect(result.output).not.toContain("|---|---|")
    }),
  45_000,
)

test(
  "stacks table cells when a grid cannot fit the narrow transcript",
  () =>
    runMarkdownScene(
      [
        "| 甲 | 乙 | 丙 | 丁 | 戊 | 己 | 庚 | 辛 |",
        "|---|---|---|---|---|---|---|---|",
        "| one | two | three | four | five | six | seven | eight |",
        "",
        "STACK-END-PSI",
      ].join("\n"),
      "STACK-END-PSI",
      36,
    ).then((result) => {
      expectIsolatedModel(result)
      for (const text of ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "one", "two", "seven", "eight"])
        expect(result.output).toContain(text)
      expect(result.output).not.toContain("|---|---|---|---|---|---|---|---|")
    }),
  45_000,
)

test(
  "renders control sequences as inert visible text",
  () =>
    runMarkdownScene(
      "SAFE-BEFORE \u001b]2;HIJACKED\u0007 SAFE-MIDDLE \u001b[2J SAFE-AFTER CONTROL-END-CHI",
      "CONTROL-END-CHI",
      64,
    ).then((result) => {
      expectIsolatedModel(result)
      for (const text of ["SAFE-BEFORE", "HIJACKED", "SAFE-MIDDLE", "SAFE-AFTER", "CONTROL-END-CHI"])
        expect(result.output).toContain(text)
      expect(result.output).toContain("�]2;HIJACKED�")
      expect(result.output).toContain("�[2J")
    }),
  45_000,
)

test(
  "streams a long mixed Markdown response without exposing source syntax",
  () =>
    runMarkdownScene(
      [
        "## STREAM-ALPHA",
        "A **streamed-bravo** paragraph that crosses rendering chunks and remains complete.",
        "- streamed-charlie",
        "- streamed-delta",
        "`streamed-echo`",
        "STREAM-END-FOXTROT",
      ].join("\n\n"),
      "STREAM-END-FOXTROT",
      52,
    ).then((result) => {
      expectIsolatedModel(result)
      for (const text of [
        "STREAM-ALPHA",
        "streamed-bravo",
        "remains complete",
        "streamed-charlie",
        "streamed-delta",
        "streamed-echo",
      ])
        expect(result.output).toContain(text)
      expect(result.clientLogs).toContain("output-delta")
    }),
  45_000,
)

test(
  "runs Markdown-producing subagents without a provider",
  () =>
    Scene.run({
      terminal: { columns: 100, rows: 36 },
      script: [
        Scene.model.turn(
          ["markdown", "bravo", "charlie", "delta"].map((name) =>
            Scene.model.toolCall("task", { prompt: `Explore ${name}.` }, `call-${name}`),
          ),
        ),
        ...Array.from({ length: 4 }, () => Scene.model.text(childMarkdown, 100)),
        ...Array.from({ length: 4 }, () => Scene.model.object({ summary: "CHILD-SUMMARY-FOXTROT", files: [] })),
        Scene.model.text("PARENT-END-GOLF"),
      ],
      actions: [
        Scene.action.writeAfter("medium", "Delegate Markdown.\r"),
        Scene.action.writeAfter("PARENT-END-GOLF", "\u0003", 1_000),
      ],
    }).then((result) => {
      expectIsolatedModel(result)
      for (const name of ["markdown", "bravo", "charlie", "delta"])
        expect(result.clientLogs).toContain(`:call-${name}:result`)
    }),
  45_000,
)
