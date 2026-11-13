import { Routes } from 'discord.js'

export function interactionOriginalMessageRoute(applicationId: string, token: string): string {
  return Routes.webhookMessage(applicationId, token, '@original')
}
