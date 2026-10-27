import type { Message } from 'discord.js'
import OpenAI from 'openai'
import { loadCommunitySettings, type CommunitySettings } from './community-settings.js'
import { consumeStoredRateLimit } from './helpers/kv-store.js'
import { loadOpenAIApiKey, loadOpenAIEndpoint } from './openai-config.js'

type ChatSettings = NonNullable<CommunitySettings['roleChat']>
const TIMEOUT_MS = 30_000
const HOUR_MS = 60 * 60_000
const NO_MENTIONS = { parse: [] as const, repliedUser: false }

export async function generateRoleChatReply(
  prompt: string,
  settings: ChatSettings
): Promise<string> {
  const client = new OpenAI({
    apiKey: loadOpenAIApiKey(),
    baseURL: loadOpenAIEndpoint(),
    maxRetries: 0,
    timeout: TIMEOUT_MS
  })
  const response = await client.responses.create(
    {
      model: settings.model,
      instructions: [
        settings.systemPrompt,
        'Reply with ordinary Discord Markdown text only, not JSON, embeds, or UI components. Keep the response within 2000 characters. You have no tools and cannot perform actions or access other messages, private sessions, files, or services.'
      ].join('\n'),
      input: prompt,
      tools: [],
      tool_choice: 'none',
      max_output_tokens: settings.maxOutputTokens,
      store: false
    },
    { signal: AbortSignal.timeout(TIMEOUT_MS) }
  )
  if (response.status !== 'completed' || !response.output_text?.trim()) {
    throw new Error('No complete text response')
  }
  return response.output_text
}

export function createRoleChatHandler(generate = generateRoleChatReply) {
  const cooldowns = new Map<string, number>()
  const activeGuilds = new Set<string>()

  return async (message: Message): Promise<void> => {
    if (!message.guildId || message.author.bot || message.webhookId || message.system) return
    let settings: ChatSettings | null
    try {
      settings = loadCommunitySettings(message.guildId).roleChat
    } catch {
      return // Corrupt configuration must never enable public paid requests.
    }
    if (!settings) return
    // Also accept the literal <&@id> spelling, alongside Discord's actual <@&id> mention.
    const mention = new RegExp(`<(?:@&|&@)${settings.roleId}>`, 'g')
    if (!mention.test(message.content)) return
    mention.lastIndex = 0
    const prompt = message.content.replace(mention, '').trim()
    if (!prompt || prompt.length > 4000) return

    const now = Date.now()
    for (const [key, expiresAt] of cooldowns) {
      if (expiresAt <= now) cooldowns.delete(key)
    }
    const key = `${message.guildId}:${message.author.id}`
    if (
      cooldowns.has(key) ||
      cooldowns.size >= 1000 ||
      activeGuilds.has(message.guildId) ||
      activeGuilds.size >= 2
    )
      return
    cooldowns.set(key, now + settings.cooldownSeconds * 1000)
    if (
      !consumeStoredRateLimit(
        `community:role-chat-rate:${message.guildId}`,
        settings.requestsPerHour,
        HOUR_MS
      ) ||
      !consumeStoredRateLimit('community:role-chat-rate:global', 100, HOUR_MS)
    )
      return

    activeGuilds.add(message.guildId)
    try {
      let content: string
      try {
        content = await generate(prompt, settings)
        if (!content.trim()) throw new Error('Empty reply')
        content = content.length > 2000 ? `${content.slice(0, 1999)}…` : content
      } catch {
        content = '지금은 응답을 생성할 수 없습니다. 잠시 후 다시 시도해 주세요.'
      }
      // This intentionally uses plain Markdown, with no command controls or shared agent runtime.
      await message.reply({ content, allowedMentions: NO_MENTIONS })
    } finally {
      activeGuilds.delete(message.guildId)
    }
  }
}
