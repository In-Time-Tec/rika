import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import {
  isTransientDevelopmentTemplateBuildFailure,
  retryDevelopmentTemplateBuild,
} from "../scripts/ensure-development-template"

describe("development template build", () => {
  it("classifies only service and transport failures as transient", () => {
    expect(isTransientDevelopmentTemplateBuildFailure(new Error("500: Error when requesting layer files upload"))).toBe(
      true,
    )
    expect(
      isTransientDevelopmentTemplateBuildFailure(new Error("An internal error occurred. Please try again later.")),
    ).toBe(true)
    expect(
      isTransientDevelopmentTemplateBuildFailure(new Error("Failed to upload file: TypeError: fetch failed")),
    ).toBe(true)
    expect(isTransientDevelopmentTemplateBuildFailure(new Error("Command '/opt/rika/doctor' exited with code 1"))).toBe(
      false,
    )
    expect(isTransientDevelopmentTemplateBuildFailure(new Error("401: Unauthorized"))).toBe(false)
  })

  it.effect("retries a transient failure at most twice", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const build = Ref.updateAndGet(attempts, (attempt) => attempt + 1).pipe(
        Effect.flatMap((attempt) =>
          attempt < 3
            ? Effect.fail({ _tag: "DevelopmentTemplateError", message: "503: unavailable", transient: true } as const)
            : Effect.succeed("ready"),
        ),
      )
      const fiber = yield* Effect.forkChild(retryDevelopmentTemplateBuild(build))
      yield* TestClock.adjust("10 seconds")

      expect(yield* Fiber.join(fiber)).toBe("ready")
      expect(yield* Ref.get(attempts)).toBe(3)
    }),
  )

  it.effect("does not retry a deterministic build failure", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const build = Ref.update(attempts, (attempt) => attempt + 1).pipe(
        Effect.andThen(
          Effect.fail({
            _tag: "DevelopmentTemplateError",
            message: "Command failed",
            transient: false,
          } as const),
        ),
      )

      yield* retryDevelopmentTemplateBuild(build).pipe(Effect.flip)
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})
