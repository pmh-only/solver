import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Guild
} from 'discord.js'
import type { CommandInteraction, Subcommand } from '../types.js'
import type { Flags } from '../flags.js'
import {
  commandContainer,
  commandReferenceReply,
  deferCommandResponse,
  errorContainer,
  scheduleEphemeralReplyDelete,
  sendCommandReply,
  summarySection,
  text
} from '../components.js'
import { loadCommunitySettings } from '../community-settings.js'
import { getStoredValue, setStoredValue } from '../helpers/kv-store.js'
import {
  deleteCommunityState,
  discordId,
  loadCommunityState,
  pruneCommunityState,
  saveCommunityState
} from './community-state.js'
import { fetchCommunityBytes } from './community-http.js'
import { normalizeEmojiImage } from './community-image.js'
import { safeErrorMessage } from '../safe-error.js'

export const COMMUNITY_CONFIRM_ID = 'community-confirm'
const confirmationSchema = z.object({
  guildId: discordId,
  channelId: discordId,
  userId: discordId,
  expiresAt: z.number().int().positive(),
  public: z.boolean(),
  action: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('color'),
      primary: z.number().int().min(0).max(0xffffff),
      secondary: z.number().int().min(0).max(0xffffff).optional()
    }),
    z.object({ kind: z.literal('invite') })
  ])
})
const cooldownSchema = z.object({ expiresAt: z.number().int().positive() })
const activeActions = new Set<string>()
const rest = (args: string) => args.replace(/^\S+\s*/, '').trim()

export function requireCommunityGuild(
  interaction: CommandInteraction,
  name: 'date' | 'anon' | 'color' | 'invite' | 'emoji' | 'kickvote'
): Guild {
  if (!interaction.guild) throw new Error('서버에서만 사용할 수 있습니다.')
  const settings = loadCommunitySettings()
  if (settings.disabledCommands.includes(name)) throw new Error('비활성화된 기능입니다.')
  if (name === 'invite' || name === 'kickvote') {
    const channelId = name === 'invite' ? settings.inviteChannelId : settings.kickvoteChannelId
    if (!channelId) throw new Error(`/a에서 ${name} 명령의 허용 채널을 먼저 설정하세요.`)
    if (interaction.channelId !== channelId)
      throw new Error(`/${name} 명령은 <#${channelId}>에서만 사용할 수 있습니다.`)
  }
  return interaction.guild
}

export function parseMemberId(input: string): string {
  const match = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/.exec(input)
  if (!match) throw new Error('사용자 멘션 또는 ID를 입력하세요.')
  return match[1] ?? match[2]!
}

export function parseRoleColor(input: string): number {
  if (!/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(input))
    throw new Error('#rgb 또는 #rrggbb 색상을 입력하세요.')
  const hex = input.slice(1)
  return parseInt(hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex, 16)
}

async function confirm(
  interaction: CommandInteraction,
  flags: Flags,
  action: z.infer<typeof confirmationSchema>['action'],
  message: string
) {
  const guild = requireCommunityGuild(interaction, action.kind)
  pruneCommunityState()
  const token = randomUUID().replaceAll('-', '')
  saveCommunityState(`confirm:${token}`, {
    guildId: guild.id,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    expiresAt: Date.now() + 10 * 60_000,
    public: flags.has('pub'),
    action
  })
  const payload = errorContainer(
    action.kind,
    flags,
    summarySection('확인', [message, '10분 안에 본인만 확인할 수 있습니다.'])
  )
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMMUNITY_CONFIRM_ID}:${token}`)
      .setLabel('확인')
      .setStyle(ButtonStyle.Success)
  )
  await sendCommandReply(interaction, { ...payload, components: [...payload.components, row] })
}

export function isCommunityConfirmId(id: string) {
  return id.startsWith(`${COMMUNITY_CONFIRM_ID}:`)
}

export async function sendCommunityNotice(interaction: ButtonInteraction, message: string) {
  const payload = errorContainer('community', new Map(), message)
  await interaction.reply(payload)
  scheduleEphemeralReplyDelete(interaction, interaction.id, payload.flags)
}

export async function handleCommunityConfirm(interaction: ButtonInteraction) {
  const match = /^community-confirm:([a-f0-9]{32})$/.exec(interaction.customId)
  const key = `confirm:${match?.[1] ?? ''}`
  const state = match ? loadCommunityState(key, confirmationSchema) : null
  const privateReply = (message: string) => sendCommunityNotice(interaction, message)
  if (
    !state ||
    state.guildId !== interaction.guildId ||
    state.channelId !== interaction.channelId
  ) {
    await privateReply('만료된 요청입니다.')
    return
  }
  if (state.userId !== interaction.user.id) {
    await privateReply('요청한 사용자만 확인할 수 있습니다.')
    return
  }
  let guild: Guild
  try {
    guild = requireCommunityGuild(interaction, state.action.kind)
  } catch (error) {
    await privateReply(safeErrorMessage(error).slice(0, 300))
    return
  }
  const lock = `${guild.id}:${state.userId}:${state.action.kind}`
  if (activeActions.has(lock)) {
    await privateReply('이미 처리 중입니다.')
    return
  }
  activeActions.add(lock)
  // Consume before the first await: a duplicate click can never repeat a side effect.
  deleteCommunityState(key)
  try {
    await interaction.deferUpdate()
    let result: string
    if (state.action.kind === 'color') {
      const member = await guild.members.fetch(state.userId)
      const bot = await guild.members.fetchMe()
      if (!bot.permissions.has(PermissionFlagsBits.ManageRoles))
        throw new Error('봇에 역할 관리 권한이 필요합니다.')
      const roleKey = `community:role:${guild.id}:${state.userId}`
      const roleId = getStoredValue(roleKey)
      let role = roleId ? await guild.roles.fetch(discordId.parse(roleId)) : null
      const colors = { primaryColor: state.action.primary, secondaryColor: state.action.secondary }
      if (role) {
        if (
          !role.editable ||
          role.managed ||
          role.permissions.bitfield !== 0n ||
          role.name !== `color-${state.userId}`
        )
          throw new Error('안전하게 수정할 수 없는 역할입니다.')
        role = await role.edit({ colors })
      } else {
        role = await guild.roles.create({
          name: `color-${state.userId}`,
          colors,
          permissions: [],
          mentionable: false,
          reason: '사용자 색상 역할'
        })
        setStoredValue(roleKey, role.id)
      }
      await member.roles.add(role)
      result = '역할 색상을 적용했습니다.'
    } else {
      // Invites are always private, even if the source message was copied publicly.
      if (!interaction.message.flags.has(MessageFlags.Ephemeral))
        throw new Error('비공개 요청으로 초대 링크를 생성하세요.')
      const settings = loadCommunitySettings()
      const cooldownKey = `invite:${guild.id}:${state.userId}`
      if (loadCommunityState(cooldownKey, cooldownSchema))
        throw new Error('초대 링크 생성 대기 시간이 남아 있습니다.')
      pruneCommunityState()
      const invite = await guild.invites.create(state.channelId, {
        maxUses: 1,
        maxAge: settings.inviteMaxAgeHours * 3600,
        unique: true,
        reason: '일회용 초대 링크'
      })
      saveCommunityState(cooldownKey, {
        expiresAt: Date.now() + settings.inviteCooldownHours * 3_600_000
      })
      result = `일회용 초대 링크 (${settings.inviteMaxAgeHours}시간 유효): ${invite.url}`
      try {
        const member = await guild.members.fetch(state.userId)
        const memberName = member.nickname
          ? `${member.nickname} (${member.user.tag})`
          : member.user.tag
        const channel = await guild.channels.fetch(state.channelId)
        if (!channel?.isSendable()) throw new Error('알림을 전송할 수 없는 채널입니다.')
        await channel.send({
          components: [
            text(
              `\`${memberName.replace(/[`\r\n]/g, '').slice(0, 150)}\`가 1회용 초대 링크를 생성했어요!`
            )
          ],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [], repliedUser: false }
        })
      } catch {
        result += '\n채널에 초대 생성 알림을 보내지 못했습니다.'
      }
    }
    await sendCommandReply(
      interaction,
      errorContainer(state.action.kind, state.public ? new Map([['pub', true]]) : new Map(), result)
    )
  } catch (error) {
    // Do not expose raw API errors, webhook URLs, or credentials.
    await sendCommandReply(
      interaction,
      errorContainer(
        state.action.kind,
        new Map(),
        error instanceof Error && !('code' in error)
          ? safeErrorMessage(error).slice(0, 300)
          : '작업에 실패했습니다. 봇의 권한과 역할 순서를 확인하세요.'
      )
    )
  } finally {
    activeActions.delete(lock)
  }
}

const date: Subcommand = {
  name: 'date',
  description: '서버 가입일 조회',
  usage: '/date [member:@사용자]',
  examples: ['/date', '/date member:@사용자'],
  async execute(interaction, args, flags) {
    const guild = requireCommunityGuild(interaction, 'date')
    const id = rest(args) ? parseMemberId(rest(args)) : interaction.user.id
    await deferCommandResponse(interaction, flags)
    const member = await guild.members.fetch(id)
    if (!member.joinedTimestamp) throw new Error('가입일을 확인할 수 없습니다.')
    const timestamp = Math.floor(member.joinedTimestamp / 1000)
    await sendCommandReply(
      interaction,
      commandContainer(
        date,
        args,
        flags,
        summarySection('서버 가입일', [`<@${id}>`, `<t:${timestamp}:F> (<t:${timestamp}:R>)`])
      )
    )
  }
}

const color: Subcommand = {
  name: 'color',
  description: '본인 역할 색상 변경',
  usage: '/color hex:<#rgb 또는 #rrggbb> [secondary:<보조 색상>]',
  examples: ['/color hex:#abcdef', '/color hex:#abc secondary:#def'],
  async execute(interaction, args, flags) {
    requireCommunityGuild(interaction, 'color')
    const parts = rest(args).split(/\s+/)
    if (!parts[0] || parts.length > 2) {
      await sendCommandReply(
        interaction,
        commandReferenceReply(color, args, flags, 'usage', '색상을 입력하세요.')
      )
      return
    }
    const primary = parseRoleColor(parts[0])
    const secondary = parts[1] ? parseRoleColor(parts[1]) : undefined
    await confirm(
      interaction,
      flags,
      { kind: 'color', primary, secondary },
      `역할 색상을 ${parts.join(' / ')}(으)로 변경할까요?`
    )
  }
}

const invite: Subcommand = {
  name: 'invite',
  description: '일회용 초대 링크 생성',
  usage: '/invite',
  examples: ['/invite'],
  async execute(interaction, args, flags) {
    requireCommunityGuild(interaction, 'invite')
    if (flags.has('pub') || rest(args))
      throw new Error('초대 링크는 invite 명령으로 비공개 생성만 가능합니다.')
    const settings = loadCommunitySettings()
    await confirm(
      interaction,
      new Map(),
      { kind: 'invite' },
      `1회 사용, ${settings.inviteMaxAgeHours}시간 유효한 초대 링크를 생성할까요? 생성 후 ${settings.inviteCooldownHours}시간 동안 재생성할 수 없습니다.`
    )
  }
}

const anon: Subcommand = {
  name: 'anon',
  description: '현재 채널에 익명 메시지 전송',
  usage: '/anon message:<메시지>',
  examples: ['/anon message:안녕하세요'],
  async execute(interaction, args, flags) {
    // Handle errors locally: the generic router's usage footer includes the raw
    // arguments and --pub flag, which must never disclose anonymous message text.
    try {
      const guild = requireCommunityGuild(interaction, 'anon')
      const message = rest(args)
      if (!message || message.length > 2000 || flags.has('pub'))
        throw new Error('비공개 명령으로 1~2000자의 메시지를 입력하세요.')
      await deferCommandResponse(interaction, new Map())
      const channel = await guild.channels.fetch(interaction.channelId!)
      if (!channel || !('createWebhook' in channel))
        throw new Error('웹훅을 지원하는 서버 채널에서 사용하세요.')
      const webhook = await channel.createWebhook({
        name: loadCommunitySettings().anonymousName
      })
      let cleanupFailed = false
      try {
        await webhook.send({ content: message, allowedMentions: { parse: [] } })
      } finally {
        await webhook.delete().catch(() => {
          cleanupFailed = true
        })
      }
      await sendCommandReply(
        interaction,
        errorContainer(
          'anon',
          new Map(),
          cleanupFailed
            ? '전송했습니다. 임시 웹훅 삭제에 실패했으니 서버의 웹훅 목록을 확인하세요.'
            : '전송했습니다. Discord 감사 로그에서는 관리자가 웹훅 생성자를 확인할 수 있습니다.'
        )
      )
    } catch (error) {
      await sendCommandReply(
        interaction,
        errorContainer('anon', new Map(), safeErrorMessage(error).slice(0, 300))
      )
    }
  }
}

const emoji: Subcommand = {
  name: 'emoji',
  description: '이미지를 128px 이모지로 등록',
  usage: '/emoji name:<이름> image:<첨부 이미지>',
  examples: ['/emoji name:smile image:smile.png'],
  async execute(interaction, args, flags) {
    const guild = requireCommunityGuild(interaction, 'emoji')
    const parts = rest(args).split(/\s+/)
    const [name, url] = parts
    if (parts.length !== 2 || !name || !/^[a-zA-Z0-9_]{2,32}$/.test(name) || !url)
      throw new Error('2~32자의 영문/숫자/밑줄 이름과 Discord 첨부 URL을 입력하세요.')
    await deferCommandResponse(interaction, flags)
    const attachment = await normalizeEmojiImage(await fetchCommunityBytes(url, 1024 * 1024))
    // Never delete unrelated/old emojis to make room. The API reports capacity errors.
    const created = await guild.emojis.create({
      name,
      attachment,
      reason: '사용자 요청 이모지 등록'
    })
    await sendCommandReply(
      interaction,
      errorContainer('emoji', flags, `이모지를 등록했습니다: <:${name}:${created.id}>`)
    )
  }
}

export const guildCommunityCommands = [date, color, invite, anon, emoji]
