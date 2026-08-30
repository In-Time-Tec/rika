import { it } from "@effect/vitest"
import { Effect } from "effect"
import { live, withDatabase } from "./database.harness"
import { continueConvergence } from "../protocol-convergence-decisions.harness"
import { setupConvergence } from "../protocol-convergence-setup.harness"

it.effect.skipIf(!live)("converges duplicate, reordered, and delayed replica frames with durable decisions", () =>
  withDatabase((pool) => setupConvergence(pool).pipe(Effect.flatMap(continueConvergence))),
)
