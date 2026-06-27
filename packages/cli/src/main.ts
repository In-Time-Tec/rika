#!/usr/bin/env bun
import { Effect } from "effect"
import { Output, Runtime } from "./index"

const exitCode = await Effect.runPromise(
  Runtime.runProcess({ argv: Bun.argv.slice(2), env: process.env, cwd: process.cwd() }).pipe(
    Effect.provide(Output.layer),
  ),
)

process.exit(exitCode)
