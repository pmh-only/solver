import { ButtonStyle, ComponentType, createComponentBuilder, ModalBuilder } from 'discord.js'
import { tool, type Tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { deleteStoredValue, getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import {
  GPT_ACTION_COMPONENT_ID,
  GPT_MODAL_ID,
  type GptContext,
  type GptManagedComponent
} from './runtime-types.js'

const GPT_CONTEXT_KEY = 'gpt-ctx'

export function storeGptContext(token: string, ctx: GptContext): void {
  setStoredValue(
    `${GPT_CONTEXT_KEY}:${token}`,
    JSON.stringify({ ...ctx, input: [], history: [], modelHistory: [] })
  )
}

export function deleteGptContext(token: string): void {
  deleteStoredValue(`${GPT_CONTEXT_KEY}:${token}`)
}

function buttonStyle(style: string): ButtonStyle {
  if (style === 'primary') return ButtonStyle.Primary
  if (style === 'success') return ButtonStyle.Success
  if (style === 'danger') return ButtonStyle.Danger
  return ButtonStyle.Secondary
}

export function loadGptContext(token: string): GptContext | null {
  const key = `${GPT_CONTEXT_KEY}:${token}`
  const stored = getStoredValue(key)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as Partial<GptContext> & {
      buttons?: Array<{ id: string; label: string; style: string }>
    }
    if (
      typeof parsed.displayPrompt !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Date.now() ||
      (!Array.isArray(parsed.components) &&
        (!Array.isArray(parsed.buttons) ||
          !parsed.buttons.every(
            (button) =>
              typeof button.id === 'string' &&
              typeof button.label === 'string' &&
              ['primary', 'secondary', 'success', 'danger'].includes(button.style)
          )))
    ) {
      deleteStoredValue(key)
      return null
    }
    if (!Array.isArray(parsed.components)) {
      const buttons = parsed.buttons!
      parsed.components = [
        {
          type: ComponentType.ActionRow,
          components: buttons.map((button) => ({
            type: ComponentType.Button,
            custom_id: `${GPT_ACTION_COMPONENT_ID}:${token}:${button.id}`,
            label: button.label,
            style: buttonStyle(button.style)
          }))
        }
      ]
    }
    if (parsed.senderOnlyComponentIds === undefined) {
      parsed.senderOnlyComponentIds = []
    } else if (
      !Array.isArray(parsed.senderOnlyComponentIds) ||
      !parsed.senderOnlyComponentIds.every((id) => typeof id === 'string')
    ) {
      throw new Error('Invalid sender-only component ids.')
    }
    if (!Array.isArray(parsed.modelHistory)) parsed.modelHistory = []
    if (!Array.isArray(parsed.input)) parsed.input = []
    if (typeof parsed.toolsEnabled !== 'boolean') parsed.toolsEnabled = false
    if (!parsed.modals || typeof parsed.modals !== 'object' || Array.isArray(parsed.modals)) {
      parsed.modals = {}
    }
    for (const [triggerId, modal] of Object.entries(parsed.modals)) {
      if (
        !/^[a-z0-9_-]{1,32}$/.test(triggerId) ||
        !modal ||
        typeof modal !== 'object' ||
        (modal as GptManagedComponent).custom_id !== `${GPT_MODAL_ID}:${token}:${triggerId}`
      ) {
        throw new Error('Invalid stored modal.')
      }
      ModalBuilder.from(modal as never).toJSON()
    }
    return parsed as GptContext
  } catch {
    deleteStoredValue(key)
    return null
  }
}

function namespaceComponentIds(
  value: unknown,
  token: string,
  ids: Set<string>,
  senderOnlyIds: Set<string>
): void {
  if (Array.isArray(value)) {
    for (const item of value) namespaceComponentIds(item, token, ids, senderOnlyIds)
    return
  }
  if (!value || typeof value !== 'object') return

  const component = value as Record<string, unknown>
  const senderOnly = component.sender_only
  if (senderOnly !== undefined && typeof senderOnly !== 'boolean') {
    throw new Error('sender_only must be a boolean.')
  }
  delete component.sender_only
  if (typeof component.custom_id === 'string') {
    if (!/^[a-z0-9_-]{1,32}$/.test(component.custom_id)) {
      throw new Error(`Invalid component id: ${component.custom_id}`)
    }
    if (ids.has(component.custom_id)) {
      throw new Error(`Duplicate component id: ${component.custom_id}`)
    }
    ids.add(component.custom_id)
    if (senderOnly) senderOnlyIds.add(component.custom_id)
    component.custom_id = `${GPT_ACTION_COMPONENT_ID}:${token}:${component.custom_id}`
  } else if (senderOnly) {
    throw new Error('sender_only requires an interactive component with custom_id.')
  }
  for (const child of Object.values(component)) {
    namespaceComponentIds(child, token, ids, senderOnlyIds)
  }
}

export function validateComponents(
  input: string,
  token: string
): { components: GptManagedComponent[]; senderOnlyIds: string[] } {
  const parsed: unknown = JSON.parse(input)
  if (!Array.isArray(parsed)) throw new Error('Components must be a JSON array.')
  if (parsed.length > 10) throw new Error('At most 10 top-level components may exist.')

  const components = structuredClone(parsed) as GptManagedComponent[]
  const senderOnlyIds = new Set<string>()
  namespaceComponentIds(components, token, new Set(), senderOnlyIds)
  let count = 0
  const countComponents = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) countComponents(item)
      return
    }
    if (!value || typeof value !== 'object') return
    const component = value as Record<string, unknown>
    if (typeof component.type === 'number') count++
    if (Array.isArray(component.components)) countComponents(component.components)
  }
  countComponents(components)
  if (count > 30) throw new Error('At most 30 generated components may exist.')

  const topLevelTypes = new Set([
    ComponentType.ActionRow,
    ComponentType.Section,
    ComponentType.TextDisplay,
    ComponentType.MediaGallery,
    ComponentType.File,
    ComponentType.Separator,
    ComponentType.Container
  ])
  const validated = components.map((component) => {
    if (!topLevelTypes.has(component.type as ComponentType)) {
      throw new Error(`Component type ${String(component.type)} cannot be top-level.`)
    }
    return createComponentBuilder(component as never).toJSON() as unknown as GptManagedComponent
  })
  return { components: validated, senderOnlyIds: [...senderOnlyIds] }
}

function validateModal(input: string, token: string, triggerId: string): GptManagedComponent {
  const parsed: unknown = JSON.parse(input)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Modal must be a JSON object.')
  }
  const modal = structuredClone(parsed) as GptManagedComponent
  modal.custom_id = `${GPT_MODAL_ID}:${token}:${triggerId}`
  return new ModalBuilder(modal as never).toJSON() as unknown as GptManagedComponent
}

export function interactionModalTool(token: string, ctx: GptContext): Tool {
  return tool({
    name: 'manage_response_modals',
    description:
      'Set, remove, or clear Discord modals opened by buttons in your response JSON. trigger_id must match the stable custom_id of a button in the response. modal_json is a complete Discord API modal object and supports legacy action-row text inputs plus Components V2 text displays and labels containing selects, text inputs, file uploads, radio groups, checkboxes, and checkbox groups. The modal custom_id is managed automatically. Submitted field values are sent back to you.',
    inputSchema: z.object({
      action: z.enum(['set', 'remove', 'clear']),
      trigger_id: z
        .string()
        .regex(/^[a-z0-9_-]{1,32}$/)
        .optional(),
      modal_json: z
        .string()
        .optional()
        .describe('Complete Discord API modal object; required for set')
    }),
    callback: ({ action, trigger_id, modal_json }) => {
      if (action === 'clear') {
        ctx.modals = {}
        storeGptContext(token, ctx)
        return 'Cleared response modals.'
      }
      if (!trigger_id) return 'trigger_id is required.'
      if (action === 'remove') {
        delete ctx.modals[trigger_id]
        storeGptContext(token, ctx)
        return `Removed modal for ${trigger_id}.`
      }
      if (!modal_json) return 'modal_json is required when setting a modal.'
      try {
        ctx.modals[trigger_id] = validateModal(modal_json, token, trigger_id)
      } catch (error) {
        return `Invalid modal: ${error instanceof Error ? error.message : String(error)}`
      }
      storeGptContext(token, ctx)
      return `Set modal for ${trigger_id}.`
    }
  })
}

export function hasComponentId(value: unknown, customId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasComponentId(item, customId))
  if (!value || typeof value !== 'object') return false
  const component = value as Record<string, unknown>
  return (
    component.custom_id === customId ||
    Object.values(component).some((child) => hasComponentId(child, customId))
  )
}

export function findComponent(value: unknown, customId: string): GptManagedComponent | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findComponent(item, customId)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const component = value as GptManagedComponent
  if (component.custom_id === customId) return component
  for (const child of Object.values(component)) {
    const found = findComponent(child, customId)
    if (found) return found
  }
  return null
}
