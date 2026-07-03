import { describe, expect, test } from "bun:test"
import { Common, Ids, Orb } from "@rika/schema"
import { Effect } from "effect"
import { OrbManager, OrbManagerHttpClientSpike } from "../src/index"

const threadId = Ids.ThreadId.make("thread_http_spike")
const projectId = Ids.ProjectId.make("project_http_spike")
const orbId = Ids.OrbId.make("orb_http_spike")
const now = Common.TimestampMillis.make(1_980_000_004_000)
const unavailableFetch: NonNullable<OrbManagerHttpClientSpike.LayerInput["fetch"]> = async () =>
  Response.json({ message: "hosted service unavailable", step: "provision_http" }, { status: 503 })

describe("OrbManager HTTP client spike", () => {
  test("drives the OrbManager interface through an HTTP-hosted stub", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const record: Orb.OrbRecord = {
      orb_id: orbId,
      thread_id: threadId,
      project_id: projectId,
      sandbox_id: "sandbox_http_spike",
      status: "running",
      base_commit: "abc123",
      endpoint_url: "https://sandbox-http-spike.example",
      created_at: now,
      last_active_at: now,
    }
    const fetchImpl: NonNullable<OrbManagerHttpClientSpike.LayerInput["fetch"]> = async (input, init) => {
      const url = new URL(urlFromFetchInput(input))
      const body = bodyFromInit(init)
      calls.push({ method: init?.method ?? "GET", path: url.pathname, body })
      if (init?.headers instanceof Headers) {
        expect(init.headers.get("authorization")).toBe("Bearer control-plane-token")
      }
      return Response.json(record)
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* OrbManager.Service
        const provisioned = yield* manager.provisionForThread({
          thread_id: threadId,
          project_id: projectId,
          workspace_root: "/workspace/http-spike",
        })
        const paused = yield* manager.pause(orbId)
        const resumed = yield* manager.resume(orbId)
        const killed = yield* manager.kill(orbId)
        return { provisioned, paused, resumed, killed }
      }).pipe(
        Effect.provide(
          OrbManagerHttpClientSpike.layer({
            baseUrl: "https://control-plane.example",
            token: "control-plane-token",
            fetch: fetchImpl,
          }),
        ),
      ),
    )

    expect(result).toEqual({ provisioned: record, paused: record, resumed: record, killed: record })
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/orb-manager/provision",
        body: { thread_id: threadId, project_id: projectId, workspace_root: "/workspace/http-spike" },
      },
      { method: "POST", path: `/v1/orb-manager/orbs/${orbId}/pause` },
      { method: "POST", path: `/v1/orb-manager/orbs/${orbId}/resume` },
      { method: "POST", path: `/v1/orb-manager/orbs/${orbId}/kill` },
    ])
  })

  test("maps hosted failures back into OrbProvisionError", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        OrbManager.provisionForThread({
          thread_id: threadId,
          project_id: projectId,
          workspace_root: "/workspace/http-spike",
        }).pipe(
          Effect.provide(
            OrbManagerHttpClientSpike.layer({
              baseUrl: "https://control-plane.example",
              fetch: unavailableFetch,
            }),
          ),
        ),
      ),
    )

    expect(error).toMatchObject({ message: "hosted service unavailable", step: "provision_http" })
  })
})

const urlFromFetchInput = (input: string | URL | Request): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

const bodyFromInit = (init: RequestInit | undefined): unknown => {
  if (typeof init?.body !== "string") return undefined
  return JSON.parse(init.body) as unknown
}
