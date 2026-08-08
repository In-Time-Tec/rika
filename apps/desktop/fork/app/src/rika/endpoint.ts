// Rika endpoint resolution for the desktop renderer (M3 Phase A).
// A running Rika Server publishes <dataRoot>/server.json with
// {port, pid, tokenPath, version, protocolVersion}; the token lives at
// tokenPath. server.json is authoritative; the port formula below is the
// documented fallback (matches apps/server server-endpoint.ts).
import { realpathSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

export type RikaEndpoint = {
  readonly url: string
  readonly token: string
  readonly port: number
  readonly dataRoot: string
  readonly protocolVersion: number
}

export type ServerJson = {
  readonly port: number
  readonly pid: number
  readonly tokenPath: string
  readonly version: string
  readonly protocolVersion: number
}

const derivePort = (profile: string, canonicalDataRoot: string): number =>
  20_000 + (Number.parseInt(createHash("sha256").update(`${profile}\0${canonicalDataRoot}`).digest("hex").slice(0, 8), 16) % 30_000)

/** Read the endpoint from a running Rika Server's data root (server.json + token). */
export const readRikaEndpoint = (dataRoot: string, profile: string = "default"): RikaEndpoint => {
  const canonical = realpathSync(dataRoot)
  const serverJson: ServerJson = JSON.parse(readFileSync(join(canonical, "server.json"), "utf8"))
  const token = readFileSync(serverJson.tokenPath, "utf8").trim()
  const port = serverJson.port ?? derivePort(profile, canonical)
  return { url: `ws://127.0.0.1:${port}/server`, token, port, dataRoot: canonical, protocolVersion: serverJson.protocolVersion }
}

/** Client identity, matching the server: sha256(profile.trim().toLowerCase() + "\0" + canonicalDataRoot). */
export const rikaIdentity = (profile: string, canonicalDataRoot: string): string =>
  createHash("sha256").update(`${profile.trim().toLowerCase()}\0${canonicalDataRoot}`).digest("hex")
