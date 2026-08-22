import { expect, test } from "vitest"

const root = process.cwd()
const image = `rika-proxy-topology-${process.pid}-${Date.now()}`
const containerReady = async (command: string[]) =>
  (await Bun.spawn([...command, "version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0
const containerCommand = Bun.which("docker")
  ? (await containerReady(["docker"]))
    ? ["docker"]
    : undefined
  : Bun.which("podman")
    ? (await containerReady(["sudo", "-n", "podman"]))
      ? ["sudo", "podman", "--cgroup-manager=cgroupfs"]
      : (await containerReady(["podman"]))
        ? ["podman"]
        : undefined
    : undefined
const usesDocker = containerCommand?.length === 1 && containerCommand[0] === "docker"
const containerHost = usesDocker ? "host.docker.internal" : "host.containers.internal"

type CommandResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const command = async (args: ReadonlyArray<string>, timeout = 30_000): Promise<CommandResult> => {
  const child = Bun.spawn(args, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

const checkedCommand = async (args: ReadonlyArray<string>, timeout = 30_000) => {
  const result = await command(args, timeout)
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

const freePort = async () => {
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("unused") })
  const port = server.port
  await server.stop(true)
  return port
}

const jsonRequest = async (base: string, path: string, init?: RequestInit) => {
  const response = await fetch(`${base}${path}`, init)
  const body = (await response.json()) as Record<string, unknown>
  expect(response.status).toBe(200)
  return body
}

const websocketMessage = (url: string, message: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(url)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.close()
      reject(new Error("timed out waiting for the proxied WebSocket message"))
    }, 10_000)
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    socket.addEventListener("open", () => socket.send(message))
    socket.addEventListener("message", (event) =>
      finish(() => {
        const response = String(event.data)
        socket.close()
        resolve(response)
      }),
    )
    socket.addEventListener("error", () => finish(() => reject(new Error("proxied WebSocket failed"))))
    socket.addEventListener("close", () => finish(() => reject(new Error("proxied WebSocket closed before a message"))))
  })

test.skipIf(containerCommand === undefined)("routes the digest-pinned Caddy topology to live API, web, and WebSocket listeners", async () => {
  const apiRequests: Array<{ method: string; path: string; search: string; body: string }> = []
  const apiUpgradePaths: string[] = []
  const webRequests: Array<{ method: string; path: string; search: string; body: string }> = []

  const apiServer = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: async (request, server) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/v1/executors" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        apiUpgradePaths.push(`${url.pathname}${url.search}`)
        return server.upgrade(request) ? undefined : new Response("upgrade failed", { status: 500 })
      }
      apiRequests.push({ method: request.method, path: url.pathname, search: url.search, body: await request.text() })
      return Response.json({
        owner: "api",
        method: request.method,
        path: url.pathname,
        search: url.search,
        body: apiRequests.at(-1)!.body,
      })
    },
    websocket: {
      message: (socket, message) => socket.send(`api-ws:${String(message)}`),
    },
  })
  const webServer = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = await request.text()
      webRequests.push({ method: request.method, path: url.pathname, search: url.search, body })
      return Response.json({ owner: "web", method: request.method, path: url.pathname, search: url.search, body })
    },
  })

  let container: string | undefined
  try {
    const proxyPort = await freePort()
    await checkedCommand([...containerCommand!, "build", "--file", "apps/proxy/Dockerfile", "--tag", image, "."], 120_000)
    const started = await checkedCommand(
      [
        ...containerCommand!,
        "run",
        "--detach",
        "--publish",
        `127.0.0.1:${proxyPort}:3000`,
        ...(usesDocker ? ["--add-host", "host.docker.internal:host-gateway"] : []),
        "--env",
        "PORT=3000",
        "--env",
        `API_DOMAIN=${containerHost}`,
        "--env",
        `API_PORT=${apiServer.port}`,
        "--env",
        `WEB_DOMAIN=${containerHost}`,
        "--env",
        `WEB_PORT=${webServer.port}`,
        image,
      ],
      30_000,
    )
    container = started.stdout.trim()
    expect(container).not.toBe("")
    const base = `http://127.0.0.1:${proxyPort}`
    const deadline = Date.now() + 20_000
    while (true) {
      try {
        const health = await fetch(`${base}/_healthz`, { signal: AbortSignal.timeout(500) })
        if (health.status === 200 && (await health.text()) === "ok") break
      } catch {}
      if (Date.now() >= deadline) throw new Error("proxy did not become ready")
      await Bun.sleep(100)
    }

    const localHealth = await fetch(`${base}/_healthz`)
    expect(localHealth.status).toBe(200)
    expect(await localHealth.text()).toBe("ok")
    expect(apiRequests).toEqual([])
    expect(webRequests).toEqual([])

    for (const path of [
      "/healthz",
      "/readyz",
      "/api/v1/status",
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/oauth-protected-resource/api/v1",
    ]) {
      const response = await jsonRequest(base, path)
      expect(response.owner).toBe("api")
      expect(response.method).toBe("GET")
      expect(response.path).toBe(new URL(path, base).pathname)
    }

    const apiPost = await jsonRequest(base, "/api/v1/echo?source=proxy", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "api-body",
    })
    expect(apiPost).toMatchObject({
      owner: "api",
      method: "POST",
      path: "/api/v1/echo",
      search: "?source=proxy",
      body: "api-body",
    })

    for (const path of ["/", "/browser", "/assets/app.js"]) {
      const response = await jsonRequest(base, path)
      expect(response.owner).toBe("web")
      expect(response.method).toBe("GET")
      expect(response.path).toBe(new URL(path, base).pathname)
    }
    const webPost = await jsonRequest(base, "/assets/upload?source=proxy", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "web-body",
    })
    expect(webPost).toMatchObject({
      owner: "web",
      method: "POST",
      path: "/assets/upload",
      search: "?source=proxy",
      body: "web-body",
    })

    expect(await websocketMessage(`ws://127.0.0.1:${proxyPort}/api/v1/executors?session=one`, "hello")).toBe(
      "api-ws:hello",
    )
    expect(apiUpgradePaths).toEqual(["/api/v1/executors?session=one"])
    expect(apiRequests.map(({ method, path, search }) => [method, path, search])).toEqual([
      ["GET", "/healthz", ""],
      ["GET", "/readyz", ""],
      ["GET", "/api/v1/status", ""],
      ["GET", "/.well-known/oauth-authorization-server/api/auth", ""],
      ["GET", "/.well-known/oauth-protected-resource/api/v1", ""],
      ["POST", "/api/v1/echo", "?source=proxy"],
    ])
    expect(webRequests.map(({ method, path, search }) => [method, path, search])).toEqual([
      ["GET", "/", ""],
      ["GET", "/browser", ""],
      ["GET", "/assets/app.js", ""],
      ["POST", "/assets/upload", "?source=proxy"],
    ])
  } catch (error) {
    const logs =
      container === undefined ? "" : (await command([...containerCommand!, "logs", container], 10_000)).stdout
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`)
  } finally {
    if (container !== undefined) await command([...containerCommand!, "rm", "--force", container], 10_000)
    await command([...containerCommand!, "image", "rm", "--force", image], 30_000)
    await apiServer.stop(true)
    await webServer.stop(true)
  }
}, 180_000)
