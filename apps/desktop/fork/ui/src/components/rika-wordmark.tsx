export function RikaWordmarkPaths(props: { leadingFill: string; trailingFill: string }) {
  return (
    <>
      <path d="M60 6H84V18H78V12H66V36H60V6Z" fill={props.leadingFill} />
      <path d="M96 0H102V6H96V0ZM96 12H102V36H96V12Z" fill={props.leadingFill} />
      <path
        d="M120 6H126V18H132V12H138V6H144V12H138V18H132V24H138V30H144V36H138V30H132V24H126V36H120V6Z"
        fill={props.trailingFill}
      />
      <path
        d="M156 6H168V12H174V36H156V30H150V24H156V18H168V12H156V6ZM156 24V30H168V24H156Z"
        fill={props.trailingFill}
        fill-rule="evenodd"
      />
    </>
  )
}
