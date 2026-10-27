import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction
} from 'discord.js'
import type { Subcommand } from '../types.js'
import {
  commandReferenceReply,
  deferCommandResponse,
  errorContainer,
  scheduleEphemeralMessageDelete,
  sendCommandReply,
  summarySection
} from '../components.js'
import { loadCommunitySettings } from '../community-settings.js'
import {
  deleteCommunityState,
  discordId,
  loadCommunityState,
  pruneCommunityState,
  saveCommunityState
} from './community-state.js'
import { parseMemberId, requireCommunityGuild, sendCommunityNotice } from './community-guild.js'

export const KICKVOTE_BUTTON_ID = 'community-kickvote'
const voteSchema = z
  .object({
    guildId: discordId,
    channelId: discordId,
    targetId: discordId,
    ownerId: discordId,
    reason: z.string().min(1).max(500),
    threshold: z.number().int().min(2).max(100),
    idleMinutes: z.number().int().min(1).max(120),
    expiresAt: z.number().int().positive(),
    votes: z
      .array(discordId)
      .max(100)
      .refine((votes) => new Set(votes).size === votes.length)
  })
  .refine((state) => state.votes.length < state.threshold)
type Vote = z.infer<typeof voteSchema>
const pointerSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{32}$/),
  expiresAt: z.number().int().positive()
})
const active = new Set<string>()

function targetKey(state: Pick<Vote, 'guildId' | 'targetId'>) {
  return `vote-target:${state.guildId}:${state.targetId}`
}
function saveVote(token: string, state: Vote) {
  saveCommunityState(`vote:${token}`, state)
  saveCommunityState(targetKey(state), { token, expiresAt: state.expiresAt })
}
function removeVote(token: string, state: Vote) {
  deleteCommunityState(`vote:${token}`)
  deleteCommunityState(targetKey(state))
}
function votePayload(token: string, state: Vote, result?: string) {
  const payload = errorContainer(
    'kickvote',
    new Map([['pub', true]]),
    summarySection('추방 투표', [
      '누군가가 추방 투표를 시작했습니다!',
      `대상: <@${state.targetId}>`,
      state.reason,
      `${state.votes.length}/${state.threshold}표 · 무기명 찬성, 취소 불가 · ban이 아닌 kick`,
      result ??
        `마지막 투표 후 ${state.idleMinutes}분 동안 투표가 없으면 만료됩니다. (<t:${Math.floor(state.expiresAt / 1000)}:R>)`
    ])
  )
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${KICKVOTE_BUTTON_ID}:${token}:agree`)
      .setLabel(`찬성 (${state.votes.length}/${state.threshold})`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(Boolean(result)),
    new ButtonBuilder()
      .setCustomId(`${KICKVOTE_BUTTON_ID}:${token}:cancel`)
      .setLabel('투표 취소 (개설자/관리자)')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(Boolean(result))
  )
  return {
    ...payload,
    components: [...payload.components, row],
    allowedMentions: { parse: [] as const }
  }
}

export function isKickvoteButtonId(id: string) {
  return id.startsWith(`${KICKVOTE_BUTTON_ID}:`)
}

export async function handleKickvoteButton(interaction: ButtonInteraction) {
  const match = /^community-kickvote:([a-f0-9]{32}):(agree|cancel)$/.exec(interaction.customId)
  const token = match?.[1]
  const state = token ? loadCommunityState(`vote:${token}`, voteSchema) : null
  const reject = (message: string) => sendCommunityNotice(interaction, message)
  if (
    !state ||
    !token ||
    state.guildId !== interaction.guildId ||
    state.channelId !== interaction.channelId ||
    interaction.message.flags.has(MessageFlags.Ephemeral)
  ) {
    await reject('만료된 투표입니다.')
    return
  }
  if (!interaction.guild) {
    await reject('서버에서만 사용할 수 있습니다.')
    return
  }
  const guild = interaction.guild
  const settings = loadCommunitySettings(guild.id)
  if (settings.disabledCommands.includes('kickvote')) {
    await reject('비활성화된 기능입니다.')
    return
  }
  if (!settings.kickvoteChannelId || interaction.channelId !== settings.kickvoteChannelId) {
    await reject('설정된 투표 채널이 아닙니다.')
    return
  }
  if (active.has(token)) {
    await reject('투표를 처리 중입니다. 다시 눌러주세요.')
    return
  }
  if (match?.[2] === 'cancel') {
    if (
      state.ownerId !== interaction.user.id &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.KickMembers)
    ) {
      await reject('개설자 또는 추방 권한이 있는 관리자만 취소할 수 있습니다.')
      return
    }
    removeVote(token, state)
    await interaction.update({
      components: votePayload(token, state, '취소된 투표입니다.').components,
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    })
    return
  }
  if (state.targetId === interaction.user.id || state.votes.includes(interaction.user.id)) {
    await reject('이미 투표했거나 추방 대상자입니다.')
    return
  }
  active.add(token)
  try {
    await interaction.deferUpdate()
    const voter = await guild.members.fetch(interaction.user.id)
    if (voter.user.bot) throw new Error('봇은 투표할 수 없습니다.')
    // Time may pass while the API call runs. Do not resurrect expired or cancelled votes.
    const current = loadCommunityState(`vote:${token}`, voteSchema)
    if (!current) throw new Error('만료되거나 취소된 투표입니다.')
    current.votes.push(interaction.user.id)
    current.expiresAt = Date.now() + current.idleMinutes * 60_000
    let result: string | undefined
    if (current.votes.length >= current.threshold) {
      // Consume first: duplicate clicks and a failed response edit must never kick twice.
      removeVote(token, current)
      try {
        const target = await guild.members.fetch(current.targetId)
        if (
          !target.kickable ||
          target.user.bot ||
          target.permissions.has(PermissionFlagsBits.Administrator)
        )
          throw new Error('protected member')
        await target.kick(`추방 투표 ${current.votes.length}표: ${current.reason}`.slice(0, 500))
        result = '정족수를 충족하여 추방했습니다.'
      } catch {
        result =
          '정족수를 충족했지만 추방에 실패했습니다. 관리자가 대상과 봇의 권한을 확인하세요. 투표는 종료되었습니다.'
      }
    } else {
      saveVote(token, current)
    }
    await interaction.editReply({
      components: votePayload(token, current, result).components,
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    })
  } catch {
    // Do not overwrite a newer vote with an older snapshot after a failed API operation.
    const notice = errorContainer(
      'kickvote',
      new Map(),
      '투표를 처리하지 못했습니다. 투표가 만료되었거나 서버 멤버를 확인할 수 없습니다.'
    )
    const message = await interaction.followUp(notice)
    if (typeof message.id === 'string')
      scheduleEphemeralMessageDelete(interaction.webhook, message.id, notice.flags)
  } finally {
    active.delete(token)
  }
}

export const subcommand: Subcommand = {
  name: 'kickvote',
  description: '공개 추방 투표 시작',
  usage: '/kickvote user:@사용자 reason:<사유>',
  examples: ['/kickvote user:@사용자 reason:반복적인 스팸'],
  async execute(interaction, args, flags) {
    const guild = requireCommunityGuild(interaction, 'kickvote')
    const input = args.replace(/^\S+\s*/, '').trim()
    const [rawId, ...reasonParts] = input.split(/\s+/)
    const reason = reasonParts.join(' ')
    if (!flags.has('pub') || !rawId || !reason || reason.length > 500) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(
          subcommand,
          args,
          new Map(),
          'usage',
          '대상과 1~500자의 사유, 공개 투표를 위한 --pub가 필요합니다.'
        )
      )
      return
    }
    const targetId = parseMemberId(rawId)
    if (targetId === interaction.user.id)
      throw new Error('본인에 대한 추방 투표는 시작할 수 없습니다.')
    const settings = loadCommunitySettings(guild.id)
    const lock = `${guild.id}:${targetId}`
    if (active.has(lock)) throw new Error('이미 진행 중인 투표입니다.')
    active.add(lock)
    try {
      // Public interaction replies expose the invoking member through Discord metadata.
      // Acknowledge privately and publish an ordinary bot message, like mntserver.
      await deferCommandResponse(interaction, new Map())
      const target = await guild.members.fetch(targetId)
      if (
        !target.kickable ||
        target.user.bot ||
        target.permissions.has(PermissionFlagsBits.Administrator)
      )
        throw new Error('추방할 수 없는 사용자입니다.')
      pruneCommunityState(2)
      if (loadCommunityState(`vote-target:${lock}`, pointerSchema))
        throw new Error('이미 진행 중인 투표입니다.')
      const channel = await guild.channels.fetch(interaction.channelId!)
      if (!channel?.isSendable()) throw new Error('투표를 전송할 수 없는 채널입니다.')
      const token = randomUUID().replaceAll('-', '')
      const state: Vote = {
        guildId: guild.id,
        channelId: interaction.channelId!,
        targetId,
        ownerId: interaction.user.id,
        reason,
        threshold: settings.kickvoteThreshold,
        idleMinutes: settings.kickvoteIdleMinutes,
        expiresAt: Date.now() + settings.kickvoteIdleMinutes * 60_000,
        votes: []
      }
      saveVote(token, state)
      try {
        await channel.send({
          components: votePayload(token, state).components,
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] }
        })
      } catch (error) {
        removeVote(token, state)
        throw error
      }
      await sendCommandReply(
        interaction,
        errorContainer('kickvote', new Map(), '추방 투표를 시작했어요!')
      )
    } finally {
      active.delete(lock)
    }
  }
}
