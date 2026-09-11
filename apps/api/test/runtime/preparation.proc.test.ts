import { it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { expect } from "vitest"
import { runnerFixture } from "../fixtures/runner"

it.live(
  "captures the assigned Runner filesystem after admission and restores it without another remote read",
  () =>
    Effect.gen(function* () {
      const { client, session, checkout, fs, fixture, restart } = yield* runnerFixture
      const guidance = "Guidance captured from the assigned Runner after input admission."
      yield* fs.writeFileString(`${checkout}/AGENTS.md`, guidance)
      yield* fs.makeDirectory(`${checkout}/.agents/skills/diagnose`, { recursive: true })
      yield* fs.writeFileString(
        `${checkout}/.agents/skills/diagnose/SKILL.md`,
        "---\nname: diagnose\ndescription: Inspect this assigned workspace\n---\nLazy skill body must not enter the initial prompt.",
      )
      expect(yield* fixture.requests).toEqual([])
      for (let incarnation = 0; incarnation < 2; incarnation += 1) {
        if (incarnation === 1) {
          yield* fs.writeFileString(`${checkout}/AGENTS.md`, "An unread oversized replacement.".repeat(4_096))
          yield* restart
        }
        yield* client.sessions.submit({
          sessionId: session.sessionId,
          commandId: `remote-context-${incarnation}`,
          input: "Use the assigned native workspace",
        })
        const snapshot = yield* client.sessions.snapshot({ sessionId: session.sessionId }).pipe(
          Effect.repeat({
            until: (value) =>
              value.runs.filter((run) => run.parentRunId === undefined && run.status === "succeeded").length ===
                incarnation + 1 && value.runs.every((run) => run.status === "succeeded"),
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("20 seconds"),
        )
        expect(snapshot.runs.every((run) => run.status === "succeeded")).toBe(true)
        const requests = yield* fixture.requests
        expect(requests).toHaveLength((incarnation + 1) * 2)
        for (const request of requests) {
          const system = request.prompt.content
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n")
          expect(system).toContain(guidance)
          expect(system).toContain("diagnose")
          expect(system).not.toContain("Lazy skill body must not enter")
          expect(system).not.toContain("An unread oversized replacement")
        }
      }
      expect(yield* fs.readFileString(`${checkout}/result.txt`)).toBe("hosted-runner")
    }),
  60_000,
)
