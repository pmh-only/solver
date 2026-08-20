import type {
  ActionRowBuilder,
  ButtonBuilder,
  ContainerBuilder,
  InteractionEditReplyOptions,
  StringSelectMenuBuilder
} from 'discord.js'
import type { ContentBlockData, MessageData } from '@strands-agents/sdk'
import type { EffortLevel } from './config.js'

export const GPT_MODEL_SELECT_ID = 'gpt-model'
export const GPT_EFFORT_SELECT_ID = 'gpt-effort'
export const GPT_VERBOSITY_SELECT_ID = 'gpt-verbosity'
export const GPT_ACTION_COMPONENT_ID = 'gpt-action'
export const GPT_MODAL_ID = 'gpt-modal'

export const DEFAULT_MAX_TOKENS = 4096
export const MAX_TEXT_DISPLAY_LENGTH = 4000
export const MAX_RESPONSE_CORRECTION_RETRIES = 2
export const SLOW_RESPONSE_MS = 30_000
export const GPT_INTERACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_MODEL = 'gpt-5.4'
export const DEFAULT_SESSION_NAME = 'default'
export const GPT_SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000

export const VERBOSITY_OPTIONS = [
  { id: 'brief', label: 'Brief' },
  { id: 'normal', label: 'Normal' },
  { id: 'detailed', label: 'Detailed' }
] as const

export type VerbosityLevel = (typeof VERBOSITY_OPTIONS)[number]['id']
export type GptManagedComponent = Record<string, unknown>

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  webContent?: string
  status?: 'complete' | 'cancelled'
}

export interface ResponseState {
  id: string
  model: string
  endpoint: string
}

export interface StoredConversation {
  version: 2
  turns: ConversationTurn[]
  messages: MessageData[]
  responseState?: ResponseState
}

export interface GptContext {
  prompt: string
  displayPrompt: string
  input: ContentBlockData[]
  pub: boolean
  model: string
  effort: EffortLevel
  maxTokens: number
  toolsEnabled: boolean
  verbosity: VerbosityLevel
  userId: string
  sessionName: string
  history: ConversationTurn[]
  modelHistory: MessageData[]
  responseState?: ResponseState
  components: GptManagedComponent[]
  senderOnlyComponentIds: string[]
  modals: Record<string, GptManagedComponent>
  expiresAt: number
}

export interface AgentActivity {
  reasoning: string
  tools: Array<{ id: string; name: string; status: 'running' | 'success' | 'error' }>
  responseStarted: boolean
}

export interface GptSessionSettings {
  model: string
  effort: EffortLevel
  maxTokens: number
  toolsEnabled: boolean
}

export type GptComponent =
  | ContainerBuilder
  | ActionRowBuilder<StringSelectMenuBuilder>
  | ActionRowBuilder<ButtonBuilder>
  | GptManagedComponent

export interface StreamCallbacks {
  editMain: (components: GptComponent[]) => Promise<{ id?: string } | unknown>
  editPayload: (payload: InteractionEditReplyOptions) => Promise<{ id?: string } | unknown>
  stored?: () => void
}
