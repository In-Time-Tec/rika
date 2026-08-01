import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Context, Effect, FileSystem, Layer, Path } from "effect"

import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"

import * as Thread from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"

import * as Turn from "@rika/product/turn-record"

import { route as ResidentConfiguration } from "../src/resident/composition/resident-configuration-adapter"
import {
  persistedModelRoutesForStartup,
  persistedTitleModelRoutesForStartup,
} from "../src/resident/composition/resident-repository-layer"

import { modelRegistrationIdentity } from "@rika/product/model-registration-identity"
import { withBunServices } from "./model-script-fixtures"
const { executionRoutePin } = ResidentConfiguration

test("restores every pinned role from a nonterminal turn into the restart registration set", () => {
  const route = executionRoutePin(SettingsDefaults.Defaults.defaults, "high")
  const owner: Turn.AgentExecutionTurn = {
    _tag: "AgentExecution",
    id: Turn.TurnId.make("review-owner"),
    threadId: "review-thread" as Turn.AgentExecutionTurn["threadId"],
    prompt: "Review workspace changes",
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    status: "running",
    stopIntent: "none",
    executionRoute: {
      ...route,
      main: { ...route.main, registrationIdentity: modelRegistrationIdentity("workspace-main") },
      oracle: { ...route.oracle, registrationIdentity: modelRegistrationIdentity("workspace-oracle") },
    },
    reviewFanOutId: "review:review-owner",
    createdAt: 1,
    updatedAt: 2,
  }
  expect(persistedModelRoutesForStartup([owner]).map((candidate) => candidate.registrationIdentity)).toEqual([
    "workspace-main",
    "workspace-oracle",
    route.title!.registrationIdentity,
    route.compactionSummary!.registrationIdentity,
  ])
  const titleOwner: Turn.AgentExecutionTurn = {
    ...owner,
    id: Turn.TurnId.make("completed-title-owner"),
    status: "completed",
    executionRoute: {
      ...route,
      title: { ...route.title!, registrationIdentity: modelRegistrationIdentity("completed-title-route") },
    },
  }
  expect(
    [...persistedModelRoutesForStartup([owner]), titleOwner.executionRoute.title!].map(
      (candidate) => candidate.registrationIdentity,
    ),
  ).toContain("completed-title-route")
})

test("loads title model pins from completed turn rows for restart registration", () =>
  Effect.runPromise(
    withBunServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-title-routes-" })
          const databaseContext = yield* Layer.buildWithScope(
            Database.layer(path.join(root, "rika.db")).pipe(Layer.provide(BunServices.layer)),
            yield* Effect.scope,
          )
          const databaseLayer = Layer.succeedContext(databaseContext)
          const repositories = yield* Layer.buildWithScope(
            Layer.merge(
              ThreadRepository.layer.pipe(Layer.provide(databaseLayer)),
              TurnRepository.layer.pipe(Layer.provide(databaseLayer)),
            ),
            yield* Effect.scope,
          )
          const route = executionRoutePin(SettingsDefaults.Defaults.defaults, "medium")
          yield* Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const thread = yield* threads.create({
              id: Thread.ThreadId.make("title-restart-thread"),
              workspace: "/work",
              title: "Seed",
              now: 1,
            })
            const turn = yield* turns.createForSubmission({
              id: Turn.TurnId.make("title-restart-turn"),
              threadId: thread.id,
              prompt: "title me",
              executionRoute: {
                ...route,
                title: {
                  ...route.title!,
                  registrationIdentity: modelRegistrationIdentity("durable-title-registration"),
                },
              },
              queueCapacity: 128,
              now: 1,
            })
            yield* turns.setStatus(turn.id, "completed", undefined, 2)
          }).pipe(Effect.provide(repositories))
          const titleRoutes = yield* persistedTitleModelRoutesForStartup.pipe(Effect.provide(databaseContext))
          expect(titleRoutes.map((candidate) => candidate.registrationIdentity)).toContain("durable-title-registration")
        }),
      ),
    ),
  ))

test("uses the owning thread workspace for durable title executions", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = Layer.merge(ThreadRepository.memoryLayer(), TurnRepository.memoryLayer())
        const repositoryContext = yield* Layer.build(repositories)
        const repositoryLayer = Layer.succeedContext(repositoryContext)
        const threads = Context.get(repositoryContext, ThreadRepository.Service)
        const turns = Context.get(repositoryContext, TurnRepository.Service)
        const thread = yield* threads.create({
          id: Thread.ThreadId.make("title-workspace-thread"),
          workspace: "/thread-workspace",
          title: "Seed",
          now: 1,
        })
        yield* turns.createForSubmission({
          id: Turn.TurnId.make("title-workspace-turn"),
          threadId: thread.id,
          prompt: "title me",
          executionRoute: executionRoutePin(SettingsDefaults.Defaults.defaults, "medium"),
          queueCapacity: 128,
          now: 1,
        })
        const workspace = yield* resolveExecutionWorkspace(
          "child:execution%3Atitle-workspace-turn:title",
          "/backend-workspace",
          repositoryLayer,
          repositoryLayer,
        )
        expect(workspace).toBe("/thread-workspace")
      }),
    ),
  ))
