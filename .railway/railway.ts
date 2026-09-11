import { bucket, defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const rika = github("In-Time-Tec/rika", { checkSuites: false });

  const Postgres = postgres("Postgres", { region: "us-west2" });
  const rikaGeneralistCutover = postgres("rika-generalist-cutover", { region: "us-west2" });
  rikaGeneralistCutover.deploy = { startCommand: "sleep infinity" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 50000 });
  const rikaWorkspaceCheckpoints = bucket("rika-workspace-checkpoints", { region: "sjc" });
  const rivetEngineData = volume("rivet-engine-data", { region: "us-west2", sizeMB: 10240, allowOnlineResize: true });

  const rivet = service("rivet", {
    source: github("In-Time-Tec/rika", { checkSuites: false, rootDirectory: "infra/rivet" }),
    replicas: { "us-west2": 1 },
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["infra/rivet/**"] },
    deploy: {
      startCommand: "bun start.ts",
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
      overlapSeconds: 0,
      drainingSeconds: 30,
      requiredMountPath: "/data",
    },
    volumeMounts: { "/data": rivetEngineData },
    env: {
      RIVET_PUBLIC_URL: "http://rivet.railway.internal:6420",
      RIVET__FILE_SYSTEM__PATH: "/data",
    },
  });

  const api = service("api", {
    source: rika,
    replicas: { "us-west2": 1 },
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/api/Dockerfile",
      watchPatterns: ["apps/api/**", "packages/**", "apps/api/Dockerfile", "package.json", "bun.lock", "tsconfig.json"],
    },
    deploy: {
      startCommand: "bun --cwd apps/api start",
      preDeployCommand: ["bun --cwd apps/api migrate"],
      healthcheckPath: "/api/rivet/metadata",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
      overlapSeconds: 30,
      drainingSeconds: 60,
    },
    env: {
      AWS_ACCESS_KEY_ID: preserve(), AWS_SECRET_ACCESS_KEY: preserve(), BETTER_AUTH_SECRET: preserve(),
      BETTER_AUTH_TRUSTED_ORIGINS: preserve(), BETTER_AUTH_URL: preserve(), BOX_API_KEY: preserve(),
      BOX_API_URL: preserve(), DATABASE_SSL: preserve(), DATABASE_URL: preserve(), EMAIL_FROM: preserve(),
      GITHUB_APP_ID: preserve(), GITHUB_APP_PRIVATE_KEY: preserve(), GITHUB_CLIENT_ID: preserve(),
      GITHUB_CLIENT_SECRET: preserve(), NODE_ENV: preserve(), PORT: preserve(), RESEND_API_KEY: preserve(),
      RIKA_API_REVISION: preserve(), RIVET_ENDPOINT: "http://rivet.railway.internal:6420",
      RIVET_NAMESPACE: "default",
      RIKA_BOX_PROVIDER_SCOPE: preserve(), RIKA_BOX_TEMPLATE_BOX_ID: preserve(),
      RIKA_BOX_TEMPLATE_SNAPSHOT_ID: preserve(), RIKA_MODEL_ID: preserve(), RIKA_MODEL_PROVIDER: preserve(),
      RIKA_PROVIDER_CREDENTIAL_KEY: preserve(), RIKA_PROXY_PUBLIC_DOMAIN: preserve(),
      RIKA_RUNTIME_ENVIRONMENT: preserve(), RIKA_RUNTIME_STORAGE_BUCKET: preserve(),
      RIKA_RUNTIME_STORAGE_ENDPOINT: preserve(), RIKA_RUNTIME_STORAGE_REGION: preserve(),
      RIKA_WORKSPACE_INPUT_KEY: preserve(),
    },
  });

  const web = service("web", {
    source: rika,
    replicas: { "us-west2": 1 },
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/web/Dockerfile",
      watchPatterns: ["apps/web/**", "apps/web/Dockerfile", "package.json", "bun.lock", "tsconfig.json"],
    },
    deploy: { healthcheckPath: "/healthz", healthcheckTimeout: 60 },
    env: { API_DOMAIN: preserve(), API_PORT: preserve(), NODE_ENV: preserve(), PORT: preserve() },
  });

  const proxy = service("proxy", {
    source: rika,
    replicas: { "us-west2": 1 },
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "apps/proxy/Dockerfile",
      watchPatterns: ["apps/proxy/**", "apps/proxy/Dockerfile"],
    },
    deploy: { healthcheckPath: "/_healthz", healthcheckTimeout: 30 },
    env: { API_DOMAIN: preserve(), API_PORT: preserve(), PORT: preserve(), WEB_DOMAIN: preserve(), WEB_PORT: preserve() },
  });

  return project("rika", {
    resources: [Postgres, rivet, api, rikaGeneralistCutover, web, proxy, postgresVolume, rikaWorkspaceCheckpoints, rivetEngineData],
  });
});
