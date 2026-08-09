import { type ComponentProps } from "solid-js"

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
  return <img data-component="logo-wordmark" src={src} alt="Rika" class={`object-contain ${props.class ?? ""}`} />
}
