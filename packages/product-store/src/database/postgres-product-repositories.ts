import { Layer } from "effect"
import type { OwnerId } from "@rika/product/hosted-model"
import * as GoalRepository from "../goal/sqlite-goal-repository"
import * as ThreadSummaryRepository from "../summary/sqlite-thread-summary-repository"
import * as ThreadRepository from "../thread/sqlite-thread-repository"
import * as TranscriptRepository from "../transcript/sqlite-transcript-repository"
import * as TurnRepository from "../turn/sqlite-turn-repository"

export const layer = (ownerId: OwnerId) =>
  Layer.mergeAll(
    ThreadRepository.layerForOwner(ownerId),
    TurnRepository.layer,
    ThreadSummaryRepository.layerForOwner(ownerId),
    TranscriptRepository.layer,
    GoalRepository.layer,
  )
