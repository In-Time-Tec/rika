import { describe, expect, it } from "@effect/vitest"
import * as BehaviorMode from "@rika/config/behavior-mode"
import * as ModelRoute from "@rika/config/model-route"
import * as ModelRouteLabel from "@rika/config/model-route-label"
import * as ModelRouteResolution from "@rika/config/model-route-resolution"
import * as CanonicalDataRoot from "@rika/config/canonical-data-root"
import * as ConfigurationPaths from "@rika/config/configuration-paths"
import * as ProfileDataPaths from "@rika/config/profile-data-paths"
import * as ConfigurationSettings from "@rika/config/configuration-settings"
import * as ConfigurationService from "@rika/config/configuration-service"

describe("configuration public exports", () => {
  it("resolves every frozen capability subpath to its semantic owner", () => {
    expect(BehaviorMode.modeIds).toContain("medium")
    expect(ModelRoute.isStreamingOnlyBaseUrl("https://chatgpt.com/v1")).toBe(true)
    expect(ModelRouteLabel.modeRouteLabels).toBeTypeOf("function")
    expect(ModelRouteResolution.resolveModelRoute).toBeTypeOf("function")
    expect(CanonicalDataRoot.canonicalDataRoot).toBeTypeOf("function")
    expect(ConfigurationPaths.workspacePaths).toBeTypeOf("function")
    expect(ProfileDataPaths.dataPaths).toBeTypeOf("function")
    expect(ConfigurationSettings).toBeDefined()
    expect(ConfigurationService.ConfigurationService).toBeDefined()
  })
})
