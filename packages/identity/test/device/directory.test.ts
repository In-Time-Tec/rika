import { Effect } from "effect"
import { expect, it, vi } from "@effect/vitest"
import { Pool } from "pg"
import { makePostgresCliDeviceDirectory } from "../../src/device/directory"

it.effect("revokes every grant for only the authenticated user", () =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const queries: Array<{ readonly text: string; readonly values: ReadonlyArray<unknown> }> = []
    const pool = new Pool()
    vi.spyOn(pool, "query").mockImplementation((text: string, values: ReadonlyArray<unknown>) => {
      queries.push({ text, values })
      return Effect.runPromiseWith(context)(
        Effect.succeed({
          rows: text.includes("returning device_id") ? [{ device_id: "device-1" }] : [],
        }),
      )
    })
    const directory = makePostgresCliDeviceDirectory(pool)
    yield* directory.revokeAll({ userId: "user-1", clientId: "client-1", dpopJkt: "thumbprint-1" })
    const revokeQuery = queries.at(-1)
    expect(revokeQuery?.values).toEqual(["user-1"])
    expect(revokeQuery?.text).toContain("where user_id = $1 and revoked_at is null")
    expect(revokeQuery?.text).toContain("token.user_id = $1")
    expect(revokeQuery?.text).not.toContain(
      "update rika_cli_registration\n           set revoked_at = transaction_timestamp()\n           where revoked_at is null",
    )
  }),
)
