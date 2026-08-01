import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { expect, test } from "vitest"
import { withClientWorkspace } from "../src/interactive/process/process-configuration"
import { modelRoutePlan } from "@rika/relay-execution/model-provider-runtime"
import { distinctModelRoutes } from "./model-script-fixtures"

test("keeps registrations distinct by the exact Baton registry tuple", () => {
  const route = ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "high", "oracle")
  const second = { ...route, fast: true }
  expect(modelRoutePlan(second).registrationKey).not.toBe(modelRoutePlan(route).registrationKey)
  expect(distinctModelRoutes([route, second, route])).toEqual([route, second])
})

test("sends each client's workspace to the resident service", () => {
  const interactive = {
    _tag: "Interactive" as const,
    prompt: [],
    ephemeral: false,
  }
  expect(withClientWorkspace(interactive, "/client-a")).toEqual({
    ...interactive,
    clientWorkspace: "/client-a",
    workspace: "/client-a",
  })
  expect(withClientWorkspace({ ...interactive, workspace: "/explicit" }, "/client-b")).toEqual({
    ...interactive,
    clientWorkspace: "/client-b",
    workspace: "/explicit",
  })
  expect(withClientWorkspace({ _tag: "Config", action: "list" }, "/client-c")).toEqual({
    _tag: "Config",
    action: "list",
    clientWorkspace: "/client-c",
  })
  expect(withClientWorkspace({ _tag: "Auth", action: "status", provider: "openai" }, "/client-auth")).toEqual({
    _tag: "Auth",
    action: "status",
    provider: "openai",
    clientWorkspace: "/client-auth",
  })
  expect(withClientWorkspace({ _tag: "Thread", action: "new" }, "/client-d")).toEqual({
    _tag: "Thread",
    action: "new",
    clientWorkspace: "/client-d",
  })
  expect(
    withClientWorkspace(
      { _tag: "Workflow", action: "start", name: "delivery", runId: "delivery-1" },
      "/client-workflow",
    ),
  ).toEqual({
    _tag: "Workflow",
    action: "start",
    name: "delivery",
    runId: "delivery-1",
    clientWorkspace: "/client-workflow",
  })
})
