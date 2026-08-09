import { type ComponentProps } from "solid-js"
import { RikaWordmarkPaths } from "./rika-wordmark"

const src = "/rika-logo.png"

export const Mark = (props: { class?: string }) => {
  return <img data-component="logo-mark" src={src} alt="" aria-hidden="true" class={props.class} />
}

export const Splash = (props: Pick<ComponentProps<"img">, "ref" | "class">) => {
  return (
    <img
      ref={props.ref}
      data-component="logo-splash"
      src={src}
      alt=""
      aria-hidden="true"
      class={`object-contain ${props.class ?? ""}`}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-wordmark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      role="img"
      aria-label="Rika"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <RikaWordmarkPaths fill="var(--icon-strong-base)" />
    </svg>
  )
}
