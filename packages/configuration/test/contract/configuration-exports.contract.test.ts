import { describe, expect, it } from "@effect/vitest"
import * as BehaviorMode from "@rika/configuration/behavior-mode"
import * as ModelCatalog from "@rika/configuration/model-catalog"
import * as ModelPreset from "@rika/configuration/model-preset"
import * as ModelRoute from "@rika/configuration/model-route"
import * as ModelRouteLabel from "@rika/configuration/model-route-label"
import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as CanonicalDataRoot from "@rika/configuration/canonical-data-root"
import * as ConfigurationPaths from "@rika/configuration/configuration-paths"
import * as ProfileDataPaths from "@rika/configuration/profile-data-paths"
import * as ConfigurationSettings from "@rika/configuration/configuration-settings"
import * as ConfigurationService from "@rika/configuration/configuration-service"

describe("configuration public exports", () => {
  it("resolves every frozen capability subpath to its semantic owner", () => {
    expect(BehaviorMode.modeIds).toContain("medium")
    expect(ModelCatalog.catalog.gpt56Sol.id).toBe("gpt-5.6-sol")
    expect(ModelPreset.presets.openai.optionKeys).toContain("reasoning")
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
