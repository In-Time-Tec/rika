import { Schema } from "effect"

import { TurnId } from "@rika/product/turn-record"
import { QueueFull, QueuedTurnUnavailable, RepositoryError } from "@rika/product/turn-repository"

export const repositoryError = (error: unknown) =>
  Schema.is(RepositoryError)(error) ? error : RepositoryError.make({ message: String(error) })
export const submissionError = (error: unknown) => (Schema.is(QueueFull)(error) ? error : repositoryError(error))
export const missing = (id: TurnId) => RepositoryError.make({ message: `Turn ${id} does not exist` })
export const queuedTurnUnavailable = (id: TurnId) =>
  QueuedTurnUnavailable.make({ turnId: id, message: `Turn ${id} is not queued` })
