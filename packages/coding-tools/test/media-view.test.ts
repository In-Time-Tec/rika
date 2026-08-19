import { MediaAnalysisError } from "@rika/coding-tools/media-view-service"
import { AnalysisInput } from "../src/media/media-view-contract"
import { MediaAnalyzer, analyzerTestLayer, analyzerUnavailableLayer } from "@rika/coding-tools/media-view-service"
import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import * as MediaView from "@rika/coding-tools/media-view-service"
import { provide } from "./test-layer"

const bytes = (signature: ReadonlyArray<number>, size = signature.length) => {
  const value = new Uint8Array(size)
  value.set(signature)
  return value
}

const view = (
  content: Uint8Array,
  analyze: (input: AnalysisInput) => Effect.Effect<string, MediaAnalysisError> = (_: AnalysisInput) =>
    Effect.succeed("analysis"),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "rika-media-" })
      yield* fs.writeFile(`${workspace}/media`, content)
      return yield* Effect.gen(function* () {
        const service = yield* MediaView.Service
        return yield* service.view("media")
      }).pipe(provide(MediaView.layer(workspace).pipe(Layer.provide(analyzerTestLayer(analyze)))))
    }),
  ).pipe(provide(BunServices.layer))

describe("MediaView", () => {
  const formats = [
    ["jpeg", bytes([0xff, 0xd8]), "image/jpeg", "image"],
    ["pdf", bytes([...new TextEncoder().encode("%PDF-")]), "application/pdf", "pdf"],
    ["mp3 id3", bytes([...new TextEncoder().encode("ID3")]), "audio/mpeg", "audio"],
    ["mp3 frame", bytes([0xff, 0xe0]), "audio/mpeg", "audio"],
    ["mp4", bytes([0, 0, 0, 0, ...new TextEncoder().encode("ftyp")]), "video/mp4", "video"],
    ["ogg", bytes([...new TextEncoder().encode("OggS")]), "audio/ogg", "audio"],
    [
      "wav",
      bytes([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WAVE")]),
      "audio/wav",
      "audio",
    ],
  ] as const
  for (const [name, content, mimeType, kind] of formats) {
    it.effect(`classifies ${name}`, () =>
      Effect.gen(function* () {
        const result = yield* view(content)
        expect(result.artifact).toMatchObject({ mimeType, kind })
      }),
    )
  }

  it.effect("reads PNG, GIF, and extended WebP dimensions", () =>
    Effect.gen(function* () {
      const png = bytes([0x89, 0x50, 0x4e, 0x47], 24)
      new DataView(png.buffer).setUint32(16, 12)
      new DataView(png.buffer).setUint32(20, 34)
      const gif = bytes([...new TextEncoder().encode("GIF89a")], 10)
      new DataView(gif.buffer).setUint16(6, 21, true)
      new DataView(gif.buffer).setUint16(8, 43, true)
      const webp = bytes([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8X")], 30)
      webp.set([1, 2, 3, 4, 5, 6], 24)
      expect((yield* view(png)).artifact).toMatchObject({ width: 12, height: 34 })
      expect((yield* view(gif)).artifact).toMatchObject({ width: 21, height: 43 })
      expect((yield* view(webp)).artifact).toMatchObject({ width: 197122, height: 394501 })
    }),
  )

  it.effect("truncates analyzer output and propagates analyzer failures", () =>
    Effect.gen(function* () {
      const pdf = bytes([...new TextEncoder().encode("%PDF-")])
      const result = yield* view(pdf, () => Effect.succeed("x".repeat(40_001)))
      expect(new TextEncoder().encode(result.text).byteLength).toBe(16_384)
      expect(result.text).toContain("[truncated: kept first")
      expect(result.truncated).toBe(true)
      const error = yield* Effect.flip(view(pdf, () => Effect.fail(MediaAnalysisError.make({ message: "no route" }))))
      expect(error.message).toBe("no route")
      const unavailable = yield* Effect.gen(function* () {
        const analyzer = yield* MediaAnalyzer
        return yield* Effect.flip(analyzer.analyze({ path: "x", mimeType: "x", kind: "pdf", size: 0, bytes: pdf }))
      }).pipe(provide(analyzerUnavailableLayer))
      expect(unavailable.message).toContain("not configured")
      const fixture = yield* Effect.gen(function* () {
        const service = yield* MediaView.Service
        return yield* service.view("x")
      }).pipe(provide(MediaView.testLayer(() => Effect.succeed(result))))
      expect(fixture).toEqual(result)
    }),
  )

  it.effect("maps filesystem exists, stat, and read failures to missing media", () => {
    const error = (method: string) =>
      PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method, pathOrDescriptor: "/workspace/x" })
    const attempt = (overrides: Parameters<typeof FileSystem.layerNoop>[0]) =>
      Effect.gen(function* () {
        const service = yield* MediaView.Service
        return yield* Effect.flip(service.view("x"))
      }).pipe(
        provide(
          MediaView.layer("/workspace").pipe(
            Layer.provide(analyzerUnavailableLayer),
            Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path), ...overrides })),
            Layer.provide(Path.layer),
          ),
        ),
      )
    return Effect.gen(function* () {
      expect((yield* attempt({ exists: () => Effect.fail(error("exists")) }))._tag).toBe("MediaMissingError")
      expect(
        (yield* attempt({ exists: () => Effect.succeed(true), stat: () => Effect.fail(error("stat")) }))._tag,
      ).toBe("MediaMissingError")
      expect(
        (yield* attempt({
          exists: () => Effect.succeed(true),
          stat: () => Effect.succeed({ type: "File", size: FileSystem.Size(1) } as FileSystem.File.Info),
          readFile: () => Effect.fail(error("readFile")),
        }))._tag,
      ).toBe("MediaMissingError")
    })
  })

  it.effect(
    "views media outside the workspace and rejects missing, directories, unsupported, and oversized media",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "rika-media-errors-" })
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "rika-media-outside-" })
          yield* fs.makeDirectory(`${workspace}/directory`)
          yield* fs.writeFileString(`${workspace}/plain`, "plain")
          yield* fs.writeFile(`${workspace}/inside.png`, bytes([0x89, 0x50, 0x4e, 0x47], 24))
          yield* fs.writeFile(`${outside}/outside.png`, bytes([0x89, 0x50, 0x4e, 0x47], 24))
          yield* fs.symlink(`${workspace}/inside.png`, `${workspace}/inside-link.png`)
          yield* fs.symlink(`${outside}/outside.png`, `${workspace}/outside-link.png`)
          yield* fs.writeFile(`${workspace}/maximum`, bytes([0x89, 0x50, 0x4e, 0x47], 25 * 1024 * 1024))
          yield* fs.writeFile(`${workspace}/huge`, bytes([0x89, 0x50, 0x4e, 0x47], 25 * 1024 * 1024 + 1))
          const layer = MediaView.layer(workspace).pipe(Layer.provide(analyzerUnavailableLayer))
          const result = yield* Effect.gen(function* () {
            const service = yield* MediaView.Service
            const insideLink = yield* service.view("inside-link.png")
            const outsideLink = yield* service.view("outside-link.png")
            const maximum = yield* service.view("maximum")
            const errors = yield* Effect.all(
              ["missing", "directory", "plain", "../escape", "huge"].map((path) => Effect.flip(service.view(path))),
            )
            return { insideLink, outsideLink, maximum, errors }
          }).pipe(provide(layer))
          expect(result.insideLink.artifact).toMatchObject({ path: "inside-link.png", mimeType: "image/png" })
          expect(result.outsideLink.artifact).toMatchObject({ path: "outside-link.png", mimeType: "image/png" })
          expect(result.maximum.artifact.size).toBe(25 * 1024 * 1024)
          expect(result.errors.map((error) => error._tag)).toEqual([
            "MediaMissingError",
            "UnsupportedMediaError",
            "UnsupportedMediaError",
            "MediaMissingError",
            "MediaOversizedError",
          ])
        }).pipe(provide(BunServices.layer)),
      ),
  )
})
