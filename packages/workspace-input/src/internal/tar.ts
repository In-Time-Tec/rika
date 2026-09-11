import { Effect, Schema, Stream } from "effect"
import { MaximumArchiveEntries, MaximumArchiveUncompressedBytes, WorkspaceArchiveError } from "../contract"
import { runStreaming } from "./process"

const blockSize = 512
const maximumMetadataBytes = 64 * 1024
const maximumTarBytes = MaximumArchiveUncompressedBytes + 64 * 1024 * 1024
const decoder = new TextDecoder()

type EntryType = "directory" | "file" | "hardlink" | "symlink"
type LinkEntryType = "hardlink" | "symlink"
type MetadataKind = "global" | "long-link" | "long-path" | "pax"

interface Entry {
  readonly path: string
  readonly type: EntryType
  readonly target?: string
}

interface PaxValues {
  readonly linkpath: string | undefined
  readonly path: string | undefined
  readonly size: number | undefined
}

interface PaxRecord {
  readonly end: number
  readonly key: string
  readonly value: string
}

interface Header {
  readonly name: string
  readonly linkName: string
  readonly size: number
  readonly type: string
}

interface HeaderValues {
  readonly linkName: string
  readonly path: string
  readonly size: number
}

const failure = (kind: WorkspaceArchiveError["kind"], message: string) => WorkspaceArchiveError.make({ kind, message })
const isWorkspaceArchiveError = Schema.is(WorkspaceArchiveError)

const field = (bytes: Uint8Array) => {
  const nul = bytes.indexOf(0)
  const value = decoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul))
  return value.includes("\uFFFD") ? undefined : value
}

const metadataField = (bytes: Uint8Array) => {
  const value = decoder.decode(bytes)
  return value.includes("\uFFFD") || value.includes("\0") ? undefined : value
}

const parseTarNumber = (bytes: Uint8Array) => {
  if ((bytes[0]! & 0x80) !== 0) {
    if ((bytes[0]! & 0x40) !== 0) return undefined
    let value = BigInt(bytes[0]! & 0x3f)
    for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte)
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined
  }
  const value = decoder.decode(bytes).replaceAll("\0", "").trim()
  if (value.length === 0) return 0
  return /^[0-7]+$/.test(value) ? Number.parseInt(value, 8) : undefined
}

const parseHeader = (header: Uint8Array): Header | undefined => {
  const expectedChecksum = parseTarNumber(header.subarray(148, 156))
  if (expectedChecksum === undefined) return undefined
  let checksum = 0
  for (let index = 0; index < header.length; index++) checksum += index >= 148 && index < 156 ? 0x20 : header[index]!
  if (checksum !== expectedChecksum) return undefined
  const name = field(header.subarray(0, 100))
  const prefix = field(header.subarray(345, 500))
  const linkName = field(header.subarray(157, 257))
  const size = parseTarNumber(header.subarray(124, 136))
  if (name === undefined || prefix === undefined || linkName === undefined || size === undefined) return undefined
  return {
    name: prefix.length === 0 ? name : `${prefix}/${name}`,
    linkName,
    size,
    type: String.fromCharCode(header[156] ?? 0),
  }
}

const forbiddenPath = (path: string) => {
  const parts = path.split("/")
  return (
    parts.some((part) => part === ".git" || part === ".env" || part.startsWith(".env.")) ||
    parts.some(
      (part, index) =>
        (part === ".agents" && parts[index + 1] === "state") || (part === ".rika" && parts[index + 1] === "secrets"),
    ) ||
    [".git-credentials", ".netrc", ".npmrc", ".pypirc"].includes(parts.at(-1) ?? "")
  )
}

const normalizeEntryPath = (input: string) => {
  if (input.length === 0 || input.startsWith("/") || input.includes("\0") || input.length > 4_096) return undefined
  let value = input
  while (value.startsWith("./")) value = value.slice(2)
  while (value.endsWith("/")) value = value.slice(0, -1)
  if (value === ".") return ""
  const parts = value.split("/")
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return undefined
  return forbiddenPath(value) ? undefined : value
}

const normalizeLinkTarget = (entryPath: string, target: string, type: "hardlink" | "symlink") => {
  if (target.length === 0 || target.startsWith("/") || target.includes("\0") || target.length > 4_096) return undefined
  const parts = type === "symlink" ? entryPath.split("/").slice(0, -1) : []
  for (const part of target.split("/")) {
    if (part.length === 0 || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) return undefined
      parts.pop()
    } else parts.push(part)
  }
  const resolved = parts.join("/")
  return resolved.length === 0 || forbiddenPath(resolved) ? undefined : resolved
}

const parsePaxRecord = (bytes: Uint8Array, offset: number): PaxRecord | WorkspaceArchiveError => {
  const space = bytes.indexOf(0x20, offset)
  if (space === -1) return failure("archive", "Workspace archive metadata is invalid")
  const lengthText = decoder.decode(bytes.subarray(offset, space))
  if (!/^[1-9][0-9]*$/.test(lengthText)) return failure("archive", "Workspace archive metadata is invalid")
  const length = Number(lengthText)
  const end = offset + length
  if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 0x0a)
    return failure("archive", "Workspace archive metadata is invalid")
  const equals = bytes.indexOf(0x3d, space + 1)
  if (equals === -1 || equals >= end - 1) return failure("archive", "Workspace archive metadata is invalid")
  const key = metadataField(bytes.subarray(space + 1, equals))
  const value = metadataField(bytes.subarray(equals + 1, end - 1))
  if (key === undefined || value === undefined) return failure("archive", "Workspace archive metadata is invalid")
  return { end, key, value }
}

const parsePaxSize = (value: string) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return failure("archive", "Workspace archive metadata is invalid")
  const size = Number(value)
  return Number.isSafeInteger(size) ? size : failure("size", "Workspace archive expands beyond the allowed size")
}

const parsePax = (bytes: Uint8Array): PaxValues | WorkspaceArchiveError => {
  let linkpath: string | undefined
  let path: string | undefined
  let size: number | undefined
  let offset = 0
  while (offset < bytes.length) {
    const record = parsePaxRecord(bytes, offset)
    if (isWorkspaceArchiveError(record)) return record
    if (
      record.key.startsWith("GNU.sparse.") ||
      record.key === "SCHILY.realsize" ||
      (record.key === "SCHILY.filetype" && record.value === "sparse")
    )
      return failure("archive", "Workspace archive sparse entries are not allowed")
    if (record.key === "path") path = record.value
    if (record.key === "linkpath") linkpath = record.value
    if (record.key === "size") {
      const parsed = parsePaxSize(record.value)
      if (isWorkspaceArchiveError(parsed)) return parsed
      size = parsed
    }
    offset = record.end
  }
  return { linkpath, path, size }
}

const metadataText = (bytes: Uint8Array) => {
  const value = field(bytes)
  return value?.replace(/[\0\n]+$/u, "")
}

const validateLinks = (entries: ReadonlyMap<string, Entry>) => {
  const knownPaths = new Set<string>([""])
  const symlinks = new Set<string>()
  for (const entry of entries.values()) {
    const parts = entry.path.split("/")
    for (let index = 1; index <= parts.length; index++) knownPaths.add(parts.slice(0, index).join("/"))
    if (entry.type === "symlink") symlinks.add(entry.path)
  }
  for (const entry of entries.values()) {
    const parts = entry.path.split("/")
    for (let index = 1; index < parts.length; index++)
      if (symlinks.has(parts.slice(0, index).join("/")))
        return failure("archive", "Workspace archive contains an unsafe link path")
    if (entry.target === undefined) continue
    if (!knownPaths.has(entry.target)) return failure("archive", "Workspace archive contains an invalid link")
    const targetParts = entry.target.split("/")
    for (let index = 1; index < targetParts.length; index++)
      if (symlinks.has(targetParts.slice(0, index).join("/")))
        return failure("archive", "Workspace archive contains an unsafe link target")
    if (entry.type === "hardlink" && entries.get(entry.target)?.type !== "file")
      return failure("archive", "Workspace archive contains an invalid hard link")
  }
  return undefined
}

const archiveEntryType = (type: string): EntryType | undefined => {
  switch (type) {
    case "\0":
    case "0":
    case "7":
      return "file"
    case "1":
      return "hardlink"
    case "2":
      return "symlink"
    case "5":
      return "directory"
    default:
      return undefined
  }
}

const metadataKind = (type: string): MetadataKind | undefined => {
  switch (type) {
    case "g":
      return "global"
    case "K":
      return "long-link"
    case "L":
      return "long-path"
    case "x":
      return "pax"
    default:
      return undefined
  }
}

const isLinkEntry = (type: EntryType): type is LinkEntryType => type === "hardlink" || type === "symlink"

const headerValues = (
  header: Header,
  pax: PaxValues | undefined,
  longPath: string | undefined,
  longLink: string | undefined,
): HeaderValues => ({
  linkName: pax?.linkpath ?? longLink ?? header.linkName,
  path: pax?.path ?? longPath ?? header.name,
  size: pax?.size ?? header.size,
})

const boundedContentBytes = (current: number, declared: number, stored: number) => {
  const size = Math.max(declared, stored)
  return size > MaximumArchiveUncompressedBytes - current
    ? failure("size", "Workspace archive expands beyond the allowed size")
    : current + size
}

const makeEntry = (path: string, type: EntryType, size: number, linkName: string): Entry | WorkspaceArchiveError => {
  if (!isLinkEntry(type)) return { path, type }
  if (size !== 0) return failure("archive", "Workspace archive link metadata is invalid")
  const target = normalizeLinkTarget(path, linkName, type)
  return target === undefined
    ? failure("archive", "Workspace archive contains an escaping link")
    : { path, target, type }
}

const makeInspector = () => {
  const header = new Uint8Array(blockSize)
  const entries = new Map<string, Entry>()
  let headerLength = 0
  let dataRemaining = 0
  let contentRemaining = 0
  let metadata: MetadataKind | undefined
  let metadataBytes: Uint8Array | undefined
  let metadataOffset = 0
  let nextLongLink: string | undefined
  let nextLongPath: string | undefined
  let nextPax: PaxValues | undefined
  let zeroBlocks = 0
  let ended = false
  let tarBytes = 0
  let contentBytes = 0

  const finishMetadata = (): WorkspaceArchiveError | undefined => {
    if (metadata === undefined || metadataBytes === undefined) return undefined
    if (metadata === "pax" || metadata === "global") {
      const parsed = parsePax(metadataBytes)
      if (isWorkspaceArchiveError(parsed)) return parsed
      if (
        metadata === "global" &&
        (parsed.path !== undefined || parsed.linkpath !== undefined || parsed.size !== undefined)
      )
        return failure("archive", "Workspace archive global path metadata is not allowed")
      if (metadata === "pax") nextPax = parsed
    } else {
      const value = metadataText(metadataBytes)
      if (value === undefined || value.length === 0) return failure("archive", "Workspace archive metadata is invalid")
      if (metadata === "long-link") nextLongLink = value
      else nextLongPath = value
    }
    metadata = undefined
    metadataBytes = undefined
    metadataOffset = 0
    return undefined
  }

  const beginData = (size: number, kind?: typeof metadata) => {
    dataRemaining = Math.ceil(size / blockSize) * blockSize
    contentRemaining = size
    metadata = kind
    if (kind !== undefined) metadataBytes = new Uint8Array(size)
  }

  const register = (parsed: Header): WorkspaceArchiveError | undefined => {
    const type = archiveEntryType(parsed.type)
    if (type === undefined) return failure("archive", "Workspace archive contains an unsupported entry")
    const selected = headerValues(parsed, nextPax, nextLongPath, nextLongLink)
    nextPax = undefined
    nextLongPath = undefined
    nextLongLink = undefined
    const path = normalizeEntryPath(selected.path)
    if (path === undefined) return failure("archive", "Workspace archive contains a forbidden path")
    const nextContentBytes = boundedContentBytes(contentBytes, selected.size, parsed.size)
    if (isWorkspaceArchiveError(nextContentBytes)) return nextContentBytes
    contentBytes = nextContentBytes
    if (path.length === 0 && type === "directory") return undefined
    if (path.length === 0) return failure("archive", "Workspace archive contains an invalid path")
    if (entries.has(path)) return failure("archive", "Workspace archive contains an invalid path")
    if (entries.size >= MaximumArchiveEntries) return failure("size", "Workspace archive contains too many entries")
    const entry = makeEntry(path, type, selected.size, selected.linkName)
    if (isWorkspaceArchiveError(entry)) return entry
    entries.set(path, entry)
    return undefined
  }

  const acceptHeader = (): WorkspaceArchiveError | undefined => {
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1
      if (zeroBlocks === 2) ended = true
      return undefined
    }
    if (zeroBlocks !== 0) return failure("archive", "Workspace archive termination is invalid")
    const parsed = parseHeader(header)
    if (parsed === undefined) return failure("archive", "Workspace archive header is invalid")
    const kind = metadataKind(parsed.type)
    if (kind !== undefined) {
      if (nextPax !== undefined || nextLongPath !== undefined || nextLongLink !== undefined)
        return failure("archive", "Workspace archive metadata chain is invalid")
      if (parsed.size === 0 || parsed.size > maximumMetadataBytes)
        return failure("size", "Workspace archive metadata exceeds the allowed size")
      beginData(parsed.size, kind)
      return undefined
    }
    const error = register(parsed)
    if (error !== undefined) return error
    beginData(parsed.size)
    return undefined
  }

  const feed = (chunk: Uint8Array): WorkspaceArchiveError | undefined => {
    tarBytes += chunk.byteLength
    if (tarBytes > maximumTarBytes) return failure("size", "Workspace archive expands beyond the allowed size")
    let offset = 0
    while (offset < chunk.length) {
      if (ended) {
        if (chunk.subarray(offset).some((byte) => byte !== 0))
          return failure("archive", "Workspace archive contains data after its terminator")
        return undefined
      }
      if (dataRemaining > 0) {
        const length = Math.min(dataRemaining, chunk.length - offset)
        const contentLength = Math.min(contentRemaining, length)
        if (metadataBytes !== undefined && contentLength > 0) {
          metadataBytes.set(chunk.subarray(offset, offset + contentLength), metadataOffset)
          metadataOffset += contentLength
        }
        contentRemaining -= contentLength
        dataRemaining -= length
        offset += length
        if (dataRemaining === 0) {
          const error = finishMetadata()
          if (error !== undefined) return error
        }
        continue
      }
      const length = Math.min(blockSize - headerLength, chunk.length - offset)
      header.set(chunk.subarray(offset, offset + length), headerLength)
      headerLength += length
      offset += length
      if (headerLength === blockSize) {
        headerLength = 0
        const error = acceptHeader()
        if (error !== undefined) return error
      }
    }
    return undefined
  }

  const finish = () => {
    if (
      !ended ||
      headerLength !== 0 ||
      dataRemaining !== 0 ||
      metadata !== undefined ||
      nextPax !== undefined ||
      nextLongPath !== undefined ||
      nextLongLink !== undefined
    )
      return failure("archive", "Workspace archive is truncated")
    return validateLinks(entries)
  }

  return { feed, finish }
}

export const archiveCompression = (bytes: Uint8Array): "gzip" | "none" | "zstd" => {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip"
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) return "zstd"
  return "none"
}

export const inspectTar = Effect.fn("WorkspaceInput.inspectTar")(function* (bytes: Uint8Array) {
  const inspector = makeInspector()
  const compression = archiveCompression(bytes)
  if (compression === "none") {
    const error = inspector.feed(bytes) ?? inspector.finish()
    if (error !== undefined) return yield* error
    return
  }
  const executable = compression === "gzip" ? "gzip" : "zstd"
  const arguments_ = compression === "gzip" ? ["-dc"] : ["--decompress", "--stdout", "--quiet"]
  const exitCode = yield* runStreaming({ command: [executable, ...arguments_], stdin: bytes }, (stdout) =>
    Stream.runForEach(stdout, (chunk) => {
      const error = inspector.feed(chunk)
      return error === undefined ? Effect.void : Effect.fail(error)
    }),
  ).pipe(
    Effect.mapError((error) =>
      isWorkspaceArchiveError(error) ? error : failure("archive", "Workspace archive could not be decompressed"),
    ),
  )
  if (exitCode !== 0) return yield* failure("archive", "Workspace archive compression is invalid")
  const error = inspector.finish()
  if (error !== undefined) return yield* error
})
