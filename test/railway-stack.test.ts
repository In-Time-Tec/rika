import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { live, readText } from "./support/platform"

it.effect("pins the exact Alchemy Railway snapshot and keeps its optional website peer unloaded", () =>
  live(
    Effect.gen(function* () {
      const manifest = yield* readText("package.json")
      const stack = yield* readText("alchemy.run.ts")
      expect(manifest).toContain('"alchemy": "https://pkg.ing/alchemy/59573d7"')
      expect(stack).not.toContain('from "alchemy/Railway"')
      for (const module of ["Bucket", "Postgres", "Project", "Providers", "Service", "ref"])
        expect(stack).toContain(`from "alchemy/Railway/${module}"`)
    }),
  ),
)

it.effect("declares the isolated proxy-only public Railway topology", () =>
  live(
    Effect.gen(function* () {
      const stack = yield* readText("alchemy.run.ts")
      const remote = stack.slice(stack.indexOf("const railwayStack"))
      expect(remote.match(/context: "\."/g)).toHaveLength(3)
      expect(remote.match(/publicDomain: false/g)).toHaveLength(2)
      expect(remote.match(/publicDomain: true/g)).toHaveLength(1)
      expect(remote).toContain("public: false")
      expect(remote).toContain('image: "ghcr.io/railwayapp-templates/postgres-ssl:17"')
      expect(remote).toContain('dockerfilePath: "apps/api/Dockerfile"')
      expect(remote).toContain('dockerfilePath: "apps/web/Dockerfile"')
      expect(remote).toContain('dockerfilePath: "apps/proxy/Dockerfile"')
      expect(remote).toContain('preDeploy: { command: "bun --cwd apps/api migrate" }')
      expect(remote).toContain(
        'const databaseUrl = Output.map(Output.of(postgres), () => railwayRef("postgres", "DATABASE_URL"))',
      )
      expect(remote).toContain(
        'const proxyDomain = requireOutput("the proxy public domain", proxy.domain, "destroy.invalid")',
      )
      expect(remote).toContain("AWS_SECRET_ACCESS_KEY: bucketSecretKey")
      expect(remote).toContain("workspaceId: inputs.provisioning.RAILWAY_WORKSPACE_ID")
      expect(remote).toContain('"the Storage Bucket secret key"')
      expect(remote).toContain("bucket.secretAccessKey")
      expect(remote).toContain("stage !== personalRailwayStage")
      expect(remote).toContain("E2B_DEPLOYMENT_ID: `rika-${stage}`")
      expect(remote).not.toMatch(/OPENROUTER|RIKA_DEV_SEED|RAILWAY_API_TOKEN|RAILWAY_TOKEN/)
    }),
  ),
)
