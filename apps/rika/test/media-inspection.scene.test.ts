import { expect, test } from "vitest"
import { Scene } from "./scene"

const setup = String.raw`
import { writeFileSync, symlinkSync } from "node:fs"
const bytes = (signature, size = signature.length) => {
  const value = new Uint8Array(size)
  value.set(signature)
  return value
}
const text = (value) => [...new TextEncoder().encode(value)]
const png = bytes([0x89, 0x50, 0x4e, 0x47], 24)
new DataView(png.buffer).setUint32(16, 320)
new DataView(png.buffer).setUint32(20, 200)
writeFileSync("png", png)
writeFileSync("jpeg", bytes([0xff, 0xd8]))
writeFileSync("gif", bytes(text("GIF89a"), 10))
writeFileSync("webp", bytes([...text("RIFF"), 0, 0, 0, 0, ...text("WEBPVP8X")], 30))
writeFileSync("pdf", bytes(text("%PDF-1.7")))
writeFileSync("mp3-id3", bytes(text("ID3")))
writeFileSync("mp3-frame", bytes([0xff, 0xe0]))
writeFileSync("ogg", bytes(text("OggS")))
writeFileSync("wav", bytes([...text("RIFF"), 0, 0, 0, 0, ...text("WAVE")]))
writeFileSync("mp4", bytes([0, 0, 0, 0, ...text("ftyp")]))
writeFileSync("exact.png", bytes([0x89, 0x50, 0x4e, 0x47], 25 * 1024 * 1024))
writeFileSync("oversized.png", bytes([0x89, 0x50, 0x4e, 0x47], 25 * 1024 * 1024 + 1))
writeFileSync("plain", "plain")
writeFileSync("../outside.png", png)
symlinkSync("png", "inside-link.png")
symlinkSync("../outside.png", "outside-link.png")
`

const setupTurn = Scene.model.turn([
  Scene.model.toolCall("bash", { command: `bun -e ${JSON.stringify(setup)}` }, "setup"),
])

test(
  "inspects every supported media format with metadata and the exact size boundary",
  () =>
    Scene.run({
      mediaAnalyzer: { response: "deterministic media analysis" },
      script: [
        setupTurn,
        Scene.model.turn(
          ["png", "jpeg", "gif", "webp", "pdf", "mp3-id3", "mp3-frame", "ogg", "wav", "mp4", "exact.png"].map((path) =>
            Scene.model.toolCall("view_media", { path }, `view-${path}`),
          ),
        ),
        Scene.model.text("MEDIA_SUCCESS_READY"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Inspect all supported fixtures.\r"),
        Scene.action.writeAfter("MEDIA_SUCCESS_READY", "\t\t\r", 100),
        Scene.action.writeAfter("media files ▾", "\u0003", 100),
      ],
    }).then((result) => {
      for (const path of [
        "png",
        "jpeg",
        "gif",
        "webp",
        "pdf",
        "mp3-id3",
        "mp3-frame",
        "ogg",
        "wav",
        "mp4",
        "exact.png",
      ])
        expect(result.output).toContain(`Viewed ${path}`)
      expect(result.output).toContain("Explored 11 media files")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "renders distinct missing, unsupported, oversized, escaped, and symlink-contained outcomes",
  () =>
    Scene.run({
      mediaAnalyzer: { response: "unused" },
      script: [
        setupTurn,
        Scene.model.turn(
          ["missing", "plain", "oversized.png", "../outside.png", "outside-link.png", "inside-link.png"].map((path) =>
            Scene.model.toolCall("view_media", { path }, `reject-${path}`),
          ),
        ),
        Scene.model.text("MEDIA_ERRORS_READY"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Inspect unsafe and invalid fixtures.\r"),
        Scene.action.writeAfter("MEDIA_ERRORS_READY", "\t\t\r", 100),
        Scene.action.writeAfter("media files ▾", "\u0003", 100),
      ],
    }).then((result) => {
      for (const path of ["missing", "plain", "oversized.png", "../outside.png", "outside-link.png", "inside-link.png"])
        expect(result.output).toContain(`Viewed ${path}`)
      expect(result.output).toContain("Explored 6 media files")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "renders analyzer failure without selecting a provider",
  () =>
    Scene.run({
      mediaAnalyzer: { error: "deterministic analyzer failure" },
      script: [
        setupTurn,
        Scene.model.turn([Scene.model.toolCall("view_media", { path: "pdf" }, "failed-analysis")]),
        Scene.model.text("MEDIA_ANALYZER_FAILED"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Inspect the PDF.\r"),
        Scene.action.writeAfter("MEDIA_ANALYZER_FAILED", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("Explored 1 media file")
      expect(result.diagnostics).toContain('"message":"tool.failed"')
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
