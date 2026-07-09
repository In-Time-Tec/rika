import { Context, Layer, Schedule, Stream } from "effect"

export interface Interface {
  readonly ticks: Stream.Stream<void>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tui/Ticker") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    ticks: Stream.fromSchedule(Schedule.fixed("33 millis")).pipe(Stream.map(() => undefined)),
  }),
)

export const memoryLayer = Layer.succeed(Service, Service.of({ ticks: Stream.empty }))
