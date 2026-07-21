import { expect, test } from "vitest"
import { Scene } from "./scene"

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const gif = new TextEncoder().encode("GIF89a")
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

test(
  "preserves dropped, bracketed, and file URL images in order through submission and durable replay",
  () =>
    Scene.run({
      files: [
        { path: "assets/dropped image.png", bytes: png },
        { path: "assets/bracket.gif", bytes: gif },
        { path: "assets/url image.webp", bytes: webp },
      ],
      script: [Scene.model.text("Ordered images received.")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "before "),
        Scene.action.writeAfter("before", "\u001b[200~assets/dropped\\ image.png\u001b[201~"),
        Scene.action.writeAfter("[Image #1]", " middle [assets/bracket.gif] after "),
        Scene.action.writeAfter("bracket.gif", "\u001b[200~file://{workspace}/assets/url%20image.webp\u001b[201~"),
        Scene.action.writeAfter("[Image #2]", " done\r"),
        Scene.action.writeAfter("Ordered images received.", "\u0014", 100),
        Scene.action.writeAfter("Thread Preview", ""),
        Scene.action.writeAfter("[Image #2]", "\u001b\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("[Image #1]")
      expect(result.output).toContain("[Image #2]")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
      expect(result.diagnostics).toContain('"rika.model.backend.kind":"test-script"')
      expect(result.turns).toHaveLength(1)
      expect(result.turns[0]?.prompt).toBe("before [Image #1] middle [assets/bracket.gif] after [Image #2] done")
      expect(JSON.parse(result.persistedTurns[0]?.prompt_parts_json ?? "null")).toEqual([
        { type: "text", text: "before " },
        {
          type: "image",
          mediaType: "image/png",
          data: Buffer.from(png).toString("base64"),
          filename: "assets/dropped image.png",
        },
        { type: "text", text: " middle " },
        {
          type: "image",
          mediaType: "image/gif",
          data: Buffer.from(gif).toString("base64"),
          filename: "assets/bracket.gif",
        },
        { type: "text", text: " after " },
        {
          type: "image",
          mediaType: "image/webp",
          data: Buffer.from(webp).toString("base64"),
          filename: expect.stringMatching(/\/workspace\/assets\/url image\.webp$/),
        },
        { type: "text", text: " done" },
      ])
    }),
  45_000,
)

test(
  "accepts a clipboard image and removes only an image that fails to materialize",
  () =>
    Scene.run({
      files: [
        {
          path: "bin/osascript",
          bytes: new TextEncoder().encode(
            `#!/usr/bin/env python3\nimport sys\nopen(sys.argv[-1], "wb").write(bytes.fromhex("${Buffer.from(png).toString("hex")}"))\n`,
          ),
          executable: true,
        },
      ],
      script: [
        Scene.model.text("Terminal image received."),
        Scene.model.text("Failure recovered."),
        Scene.model.text("Failure recovered."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u0016", 200),
        Scene.action.writeAfter("[Image #1]", " terminal\r"),
        Scene.action.writeAfter("Terminal image received.", "\u001b[A", 100),
        Scene.action.writeAfter(
          "[Image #1]",
          " before \u001b[200~missing.png\u001b[201~ middle \u001b[200~missing.png\u001b[201~ survives\r",
        ),
        Scene.action.writeAfter("Image attachment could not be read", "\r"),
        Scene.action.writeAfter("Image attachment could not be read", " kept\r"),
        Scene.action.writeAfter("Failure recovered.", "\u0003\u0003", 500),
      ],
    }).then((result) => {
      expect(result.turns.map((turn) => turn.prompt)).toEqual([
        "[Image #1] terminal",
        "[Image #1] terminal before  middle  survives kept",
      ])
      expect(JSON.parse(result.persistedTurns[0]?.prompt_parts_json ?? "null")).toEqual([
        {
          type: "image",
          mediaType: "image/png",
          data: Buffer.from(png).toString("base64"),
          filename: expect.stringMatching(/^\.rika\/pasted\/paste-.*\.png$/),
        },
        { type: "text", text: " terminal" },
      ])
      expect(JSON.parse(result.persistedTurns[1]?.prompt_parts_json ?? "null")).toEqual([
        {
          type: "image",
          mediaType: "image/png",
          data: Buffer.from(png).toString("base64"),
          filename: expect.stringMatching(/^\.rika\/pasted\/paste-.*\.png$/),
        },
        { type: "text", text: " terminal before  middle  survives kept" },
      ])
      expect(result.pastedFiles).toHaveLength(1)
      expect(result.pastedFiles[0]).toMatch(/^paste-.*\.png$/)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
      expect(result.diagnostics).toContain('"rika.model.backend.kind":"test-script"')
    }),
  45_000,
)

test("submits an image larger than one wire frame without disconnecting the resident transport", () => {
  const bigPng = new Uint8Array(1_500_000)
  bigPng.set(png)
  return Scene.run({
    files: [{ path: "big.png", bytes: bigPng }],
    script: [Scene.model.text("Large image received.")],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "\u001b[200~big.png\u001b[201~"),
      Scene.action.writeAfter("[Image #1]", " large\r"),
      Scene.action.writeAfter("Large image received.", "", 100),
    ],
  }).then((result) => {
    expect(result.output).not.toContain("Resident transport disconnected")
    expect(result.turns.map((turn) => turn.prompt)).toEqual(["[Image #1] large"])
    expect(JSON.parse(result.persistedTurns[0]?.prompt_parts_json ?? "null")).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        data: Buffer.from(bigPng).toString("base64"),
        filename: "big.png",
      },
      { type: "text", text: " large" },
    ])
    expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    expect(result.diagnostics).toContain('"rika.model.backend.kind":"test-script"')
  })
}, 45_000)

test(
  "rejects an over-limit image with a composer message and keeps the session healthy",
  () =>
    Scene.run({
      files: [{ path: "huge.png", bytes: new Uint8Array(6_000_000) }],
      script: [Scene.model.text("Recovered without the image.")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u001b[200~huge.png\u001b[201~"),
        Scene.action.writeAfter("[Image #1]", " too big\r"),
        Scene.action.writeAfter("Image attachment is too large", "\r"),
        Scene.action.writeAfter("Recovered without the image.", "", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Image attachment is too large")
      expect(result.output).not.toContain("Resident transport disconnected")
      expect(result.turns.map((turn) => turn.prompt)).toEqual([" too big"])
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
      expect(result.diagnostics).toContain('"rika.model.backend.kind":"test-script"')
    }),
  45_000,
)

test(
  "blocks clipboard and path images while editing a queued prompt",
  () =>
    Scene.run({
      files: [{ path: "blocked.png", bytes: png }],
      script: [Scene.model.text("First turn complete.", 8_000), Scene.model.text("Edited queue complete.")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "hold the queue\r"),
        Scene.action.writeAfter("hold the queue", "queued text\r", 100),
        Scene.action.writeAfter("queued text", "\u001b[A\u0005"),
        Scene.action.writeAfter("Editing queued", "\u0016", 100),
        Scene.action.writeAfter(
          "Images cannot be pasted while editing a queued prompt",
          "\u001b[200~blocked.png\u001b[201~ edited\r",
        ),
        Scene.action.writeAfter("Edited queue complete.", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Images cannot be pasted while editing a queued prompt")
      expect(result.turns.map((turn) => turn.prompt)).toEqual(["hold the queue", "queued text edited"])
      expect(result.persistedTurns[1]?.prompt_parts_json).toBeNull()
      expect(result.pastedFiles).toEqual([])
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
      expect(result.diagnostics).toContain('"rika.model.backend.kind":"test-script"')
    }),
  45_000,
)
