import { QueueFull, QueuedTurnUnavailable, RepositoryError } from "@rika/product/turn-repository"
import { TurnId } from "@rika/product/turn-record"
import { Schema } from "effect"

export const repositoryError = <Failure>(error: Failure) =>
  Schema.is(RepositoryError)(error) ? error : RepositoryError.make({ message: String(error) })
export const submissionError = <Failure>(error: Failure) =>
  Schema.is(QueueFull)(error) ? error : repositoryError(error)
export const missing = (id: TurnId) => RepositoryError.make({ message: `Turn ${id} does not exist` })
export const queuedTurnUnavailable = (id: TurnId) =>
  QueuedTurnUnavailable.make({ turnId: id, message: `Turn ${id} is not queued` })
