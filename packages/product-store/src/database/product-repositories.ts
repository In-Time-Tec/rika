import { Layer } from "effect"
import type { OwnerId } from "@rika/product/hosted-model"
import * as GoalRepository from "../goal/postgres-repository"
import * as ThreadSummaryRepository from "../summary/postgres-repository"
import * as ThreadRepository from "../thread/postgres-repository"
import * as TranscriptRepository from "../transcript/postgres-repository"
import * as TurnRepository from "../turn/postgres/repository"

export const projectionLayer = Layer.merge(TurnRepository.layer, TranscriptRepository.layer)

export const layer = (ownerId: OwnerId) =>
  Layer.mergeAll(
    ThreadRepository.layerForOwner(ownerId),
    TurnRepository.layer,
    ThreadSummaryRepository.layerForOwner(ownerId),
    TranscriptRepository.layer,
    GoalRepository.layer,
  )
