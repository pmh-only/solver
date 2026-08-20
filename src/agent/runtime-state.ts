import type { InteractionEditReplyOptions } from 'discord.js'

export interface ActiveWebRun {
  id: string
  sessionName: string
  prompt: string
  startedAt: string
  controller: AbortController
  latestPayload: InteractionEditReplyOptions
  persisted: boolean
  done: Promise<void>
  finish: () => void
}

export interface ActiveDiscordRun {
  prompt: string
  startedAt: string
  controller: AbortController
  latestPayload: InteractionEditReplyOptions
  persisted: boolean
}

export const activeStreams = new Map<string, AbortController>()
export const sessionQueues = new Map<string, Promise<void>>()
export const activeWebInteractions = new Set<string>()
export const activeWebRuns = new Map<string, ActiveWebRun>()
export const activeDiscordRuns = new Map<string, ActiveDiscordRun>()

export function cancelActiveSession(key: string): void {
  activeWebRuns.get(key)?.controller.abort()
  activeDiscordRuns.get(key)?.controller.abort()
}
