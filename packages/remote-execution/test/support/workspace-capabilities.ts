import type { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"

const ready = (detail: string) => ({ _tag: "Ready" as const, detail })

export const workspaceCapabilities: WorkspaceCapabilitySnapshot = {
  environmentDigest: `sha256:${"0".repeat(64)}`,
  capturedAt: "2026-08-21T00:00:00.000Z",
  filesystem: ready("filesystem ready"),
  typescriptKernel: ready("TypeScript kernel ready"),
  git: ready("Git ready"),
  process: ready("process ready"),
  pty: ready("PTY ready"),
  browser: ready("browser ready"),
  services: ready("repository services ready"),
  workspaceLifecycle: ready("workspace lifecycle ready"),
}
