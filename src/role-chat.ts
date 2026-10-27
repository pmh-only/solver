import type { Message } from 'discord.js'
import OpenAI from 'openai'
import { loadCommunitySettings, type CommunitySettings } from './community-settings.js'
import { consumeStoredRateLimit } from './helpers/kv-store.js'
import { loadOpenAIApiKey, loadOpenAIEndpoint } from './openai-config.js'

type ChatSettings = NonNullable<CommunitySettings['roleChat']>
const TIMEOUT_MS = 30_000
const HOUR_MS = 60 * 60_000
const NO_MENTIONS = { parse: [] as const, repliedUser: false }
const TYPING_INTERVAL_MS = 8000

function createTypingTracker() {
  const channels = new Map<
    string,
    {
      pending: number
      timer: ReturnType<typeof setInterval>
      refresh: () => Promise<void>
    }
  >()

  return (message: Message): (() => void) => {
    const channel = message.channel
    if (!('sendTyping' in channel)) return () => {}
    const existing = channels.get(message.channelId)
    if (existing) {
      existing.pending++
    } else {
      let sending = false
      const send = async () => {
        if (sending) return
        sending = true
        try {
          await channel.sendTyping()
        } catch {
          // Missing permissions or a failed typing request must not interrupt replies.
        } finally {
          sending = false
        }
      }
      const timer = setInterval(() => {
        void send()
      }, TYPING_INTERVAL_MS)
      timer.unref()
      channels.set(message.channelId, { pending: 1, timer, refresh: send })
      void send()
    }

    return () => {
      const state = channels.get(message.channelId)!
      if (--state.pending === 0) {
        clearInterval(state.timer)
        channels.delete(message.channelId)
      } else {
        // Sending a reply can clear Discord's indicator while another request is still running.
        void state.refresh()
      }
    }
  }
}

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
        'Reply with ordinary Discord Markdown text only, not JSON, embeds, or UI components. Keep the response within 2000 characters. You cannot perform actions or access other messages, private sessions, files, or services.',
        settings.webSearch
          ? 'You may use the provided OpenAI web search tool for current public information. Cite sources with Markdown links. No other tools are available.'
          : 'No tools are available.'
      ].join('\n'),
      input: prompt,
      tools: settings.webSearch ? [{ type: 'web_search' }] : [],
      tool_choice: settings.webSearch ? 'auto' : 'none',
      ...(settings.webSearch ? { max_tool_calls: 2 } : {}),
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

export function createRoleChatHandler(generate = generateRoleChatReply, random = Math.random) {
  const cooldowns = new Map<string, number>()
  let activeRequests = 0
  const startTyping = createTypingTracker()

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
    const mentioned = mention.test(message.content)
    mention.lastIndex = 0
    const prompt = message.content.replace(mention, '').trim()
    if (!prompt || prompt.length > 4000) return
    if (!mentioned && random() >= settings.randomReplyChance) return

    const now = Date.now()
    for (const [key, expiresAt] of cooldowns) {
      if (expiresAt <= now) cooldowns.delete(key)
    }
    const key = `${message.guildId}:${message.author.id}`
    if (cooldowns.has(key) || cooldowns.size >= 1000 || activeRequests >= 2) return
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

    activeRequests++
    const stopTyping = startTyping(message)
    try {
      // Acknowledge only admitted work; reaction failures must not block generation.
      const acknowledge = async () => {
        try {
          await message.react('✅')
        } catch {
          // The bot may lack reaction permissions or the message may have been deleted.
        }
      }
      void acknowledge()
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
      stopTyping()
      activeRequests--
    }
  }
}
