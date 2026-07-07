import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export { type ClassValue }

export const cn = (...values: ReadonlyArray<ClassValue>): string => twMerge(clsx(values))
