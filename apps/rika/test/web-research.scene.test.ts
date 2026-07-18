import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "presents web research calls and typed unavailable results without a provider or network",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall(
            "web_search",
            { objective: "Find current documentation", searchQueries: ["current documentation"] },
            "web-search",
          ),
        ]),
        Scene.model.turn([
          Scene.model.toolCall(
            "read_web_page",
            { url: "https://example.com", objective: "Find limits", fullContent: true, forceRefetch: true },
            "read-page",
          ),
        ]),
        Scene.model.text("Done."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Research the current documentation.\r"),
        Scene.action.writeAfter("Don", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Web Search")
      expect(result.output).toContain("https://example.com")
      expect(result.output).toContain("Don")
      expect(result.clientLogs).toContain(":web-search:requested")
      expect(result.clientLogs).toContain(":web-search:result")
      expect(result.clientLogs).toContain(":read-page:requested")
      expect(result.clientLogs).toContain(":read-page:result")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)
