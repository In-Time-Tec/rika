import { Function } from "effect"

export type IdentityComponent = string | number

const encodeString = (value: string): string => value.replaceAll("%", "%25").replaceAll(":", "%3A")

const decodeString = (value: string): string | undefined => {
  let decoded = ""
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (character !== "%") {
      decoded += character
      continue
    }
    const escape = value.slice(index, index + 3)
    if (escape === "%25") decoded += "%"
    else if (escape === "%3A") decoded += ":"
    else return undefined
    index += 2
  }
  return decoded
}

const encodeComponent = (value: IdentityComponent): string =>
  typeof value === "string" ? encodeString(value) : `%n${Object.is(value, -0) ? "-0" : String(value)}`

export const identityKey = (family: string, ...components: ReadonlyArray<IdentityComponent>): string =>
  [encodeString(family), ...components.map(encodeComponent)].join(":")

export const scopedIdentity: {
  (id: string): (scope: string) => string
  (scope: string, id: string): string
} = Function.dual(2, (scope: string, id: string): string => [scope, id].map(encodeString).join(":"))

export const decodeScopedIdentity = (value: string): { readonly scope: string; readonly id: string } | undefined => {
  const components = value.split(":")
  if (components.length !== 2) return undefined
  const scope = decodeString(components[0]!)
  const id = decodeString(components[1]!)
  return scope === undefined || id === undefined ? undefined : { scope, id }
}
