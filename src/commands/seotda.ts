import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type ButtonInteraction
} from 'discord.js'
import { randomUUID } from 'node:crypto'
import type { Subcommand } from '../types.js'
import {
  deleteStoredValue,
  getStoredValue,
  listStoredKeys,
  releaseStoredLease,
  setStoredValue,
  tryAcquireStoredLease
} from '../helpers/kv-store.js'
import {
  applySeotdaAction,
  createSeotdaDeck,
  evaluateSeotdaHand,
  SEOTDA_ANTE,
  SEOTDA_MAX_PLAYERS,
  SEOTDA_RAISE,
  SEOTDA_STARTING_CHIPS,
  SEOTDA_TURN_MS,
  seotdaPot,
  shuffleSeotdaDeck,
  startSeotda,
  timeoutSeotdaTurn,
  type SeotdaBetAction,
  type SeotdaCard,
  type SeotdaPlayer,
  type SeotdaState
} from './seotda-runtime.js'

export const SEOTDA_BUTTON_ID = 'sd'

const STATE_PREFIX = '__seotda-state'
const LOCK_PREFIX = '__seotda-lock'
const STATE_TTL_MS = 6 * 60 * 60 * 1000
const LOBBY_TTL_MS = 30 * 60 * 1000
const activeTokens = new Set<string>()

type SeotdaButtonAction =
  | 'join'
  | 'leave'
  | 'start'
  | 'cancel'
  | 'hand'
  | 'help'
  | 'check'
  | 'call'
  | 'raise'
  | 'allin'
  | 'fold'
  | 'timeout'

function key(token: string): string {
  return `${STATE_PREFIX}:${token}`
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/([\\`*_[\]])/g, '\\$1')
    .replaceAll('@', '@\u200b')
    .slice(0, 80)
}

function parseCard(value: unknown): SeotdaCard | null {
  if (!value || typeof value !== 'object') return null
  const card = value as Partial<SeotdaCard>
  const canonical = createSeotdaDeck().find((entry) => entry.id === card.id)
  return canonical && canonical.month === card.month && canonical.kind === card.kind
    ? canonical
    : null
}

function parsePlayer(value: unknown): SeotdaPlayer | null {
  if (!value || typeof value !== 'object') return null
  const player = value as Partial<SeotdaPlayer>
  if (typeof player.id !== 'string' || !player.id) return null
  if (typeof player.name !== 'string' || !player.name) return null
  if (![player.chips, player.roundContribution, player.totalContribution].every(Number.isInteger)) {
    return null
  }
  if (player.chips! < 0 || player.roundContribution! < 0 || player.totalContribution! < 0)
    return null
  if (!Array.isArray(player.hand) || player.hand.length > 2) return null
  const hand = player.hand.map(parseCard)
  if (hand.some((card) => !card)) return null
  return {
    id: player.id,
    name: player.name.slice(0, 80),
    chips: player.chips!,
    hand: hand as SeotdaCard[],
    folded: Boolean(player.folded),
    roundContribution: player.roundContribution!,
    totalContribution: player.totalContribution!,
    acted: Boolean(player.acted)
  }
}

function parseState(raw: string): SeotdaState | null {
  try {
    const value = JSON.parse(raw) as Partial<SeotdaState>
    if (typeof value.hostId !== 'string' || typeof value.channelId !== 'string') return null
    if (!['lobby', 'betting', 'finished', 'cancelled'].includes(value.phase ?? '')) return null
    if (!Array.isArray(value.players) || value.players.length > SEOTDA_MAX_PLAYERS) return null
    const players = value.players.map(parsePlayer)
    if (players.some((player) => !player)) return null
    const validPlayers = players as SeotdaPlayer[]
    if (new Set(validPlayers.map((player) => player.id)).size !== validPlayers.length) return null
    const dealtCardIds = validPlayers.flatMap((player) => player.hand.map((card) => card.id))
    if (new Set(dealtCardIds).size !== dealtCardIds.length) return null
    if (
      ![value.turnIndex, value.dealerIndex, value.currentBet, value.revision, value.redeals].every(
        Number.isInteger
      ) ||
      value.turnIndex! < 0 ||
      value.dealerIndex! < 0 ||
      value.currentBet! < 0 ||
      value.revision! < 0 ||
      value.redeals! < 0 ||
      value.redeals! > 3 ||
      typeof value.updatedAt !== 'number' ||
      !Number.isFinite(value.updatedAt) ||
      value.updatedAt < 0 ||
      typeof value.turnDeadline !== 'number' ||
      !Number.isFinite(value.turnDeadline) ||
      value.turnDeadline < 0 ||
      (value.round !== 0 && value.round !== 1)
    ) {
      return null
    }
    if (
      value.phase === 'betting' &&
      (validPlayers.length < 2 ||
        validPlayers.filter((player) => !player.folded).length < 2 ||
        value.turnIndex! < 0 ||
        value.turnIndex! >= validPlayers.length ||
        validPlayers.some((player) => !player.folded && player.hand.length !== 2))
    ) {
      return null
    }
    if (value.result !== undefined) {
      if (!value.result || typeof value.result !== 'object') return null
      if (!['showdown', 'last-player', 'cancelled'].includes(value.result.reason ?? '')) return null
      if (
        !Array.isArray(value.result.lines) ||
        !value.result.lines.every((line) => typeof line === 'string')
      ) {
        return null
      }
      if (!value.result.payouts || typeof value.result.payouts !== 'object') return null
      if (
        !Object.values(value.result.payouts).every(
          (amount) => Number.isInteger(amount) && amount >= 0
        )
      ) {
        return null
      }
    }
    return { ...value, players: validPlayers } as SeotdaState
  } catch {
    return null
  }
}

function loadState(token: string): SeotdaState | null {
  const raw = getStoredValue(key(token))
  if (!raw) return null
  const state = parseState(raw)
  const ttl = state?.phase === 'lobby' ? LOBBY_TTL_MS : STATE_TTL_MS
  if (!state || state.updatedAt > Date.now() + 60_000 || Date.now() - state.updatedAt > ttl) {
    deleteStoredValue(key(token))
    return null
  }
  return state
}

function storeState(token: string, state: SeotdaState): void {
  setStoredValue(key(token), JSON.stringify(state))
}

function cleanupExpired(): void {
  for (const storedKey of listStoredKeys()) {
    if (!storedKey.startsWith(`${STATE_PREFIX}:`)) continue
    const token = storedKey.slice(`${STATE_PREFIX}:`.length)
    loadState(token)
  }
}

function button(
  token: string,
  action: SeotdaButtonAction,
  revision: number,
  label: string,
  style = ButtonStyle.Secondary
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${SEOTDA_BUTTON_ID}:${token}:${action}:${revision}`)
    .setLabel(label)
    .setStyle(style)
}

function controls(token: string, state: SeotdaState): ActionRowBuilder<ButtonBuilder>[] {
  if (state.phase === 'lobby') {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(token, 'join', state.revision, '참가', ButtonStyle.Success),
        button(token, 'leave', state.revision, '나가기'),
        button(token, 'start', state.revision, '시작', ButtonStyle.Primary),
        button(token, 'cancel', state.revision, '취소', ButtonStyle.Danger),
        button(token, 'help', state.revision, '규칙')
      )
    ]
  }
  if (state.phase !== 'betting') return []
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(token, 'check', state.revision, '체크'),
      button(token, 'call', state.revision, '콜', ButtonStyle.Primary),
      button(token, 'raise', state.revision, `레이즈 +${SEOTDA_RAISE}`, ButtonStyle.Success),
      button(token, 'allin', state.revision, '올인', ButtonStyle.Danger),
      button(token, 'fold', state.revision, '다이', ButtonStyle.Danger)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(token, 'hand', state.revision, '내 패 보기', ButtonStyle.Primary),
      button(token, 'leave', state.revision, '게임 나가기'),
      button(token, 'timeout', state.revision, '시간초과 처리'),
      button(token, 'help', state.revision, '규칙')
    )
  ]
}

function cardName(card: SeotdaCard): string {
  const kind = { bright: '광', animal: '열끗', ribbon: '띠', junk: '피' }[card.kind]
  return `${card.month}월 ${kind}`
}

function statusText(state: SeotdaState): string {
  if (state.phase === 'lobby') {
    return [
      '## 섯다 로비',
      `상태: 참가 대기 · 방장: <@${state.hostId}>`,
      `참가자: ${state.players.length}/${SEOTDA_MAX_PLAYERS}명 (20장 덱 최대 ${SEOTDA_MAX_PLAYERS}명)`,
      `시작 조건: 2명 이상 · 기본 자금 ${SEOTDA_STARTING_CHIPS} 무료칩 · 참가비 ${SEOTDA_ANTE}칩`,
      '',
      ...state.players.map(
        (player, index) =>
          `${index + 1}. ${escapeMarkdown(player.name)}${player.id === state.hostId ? ' (방장)' : ''}`
      ),
      '',
      '-# 무료 게임 전용이며 결제, 현금 환전, 외부 재산 연동이 없습니다.'
    ].join('\n')
  }

  const turn = state.players[state.turnIndex]
  const heading = state.phase === 'betting' ? '## 섯다 게임판' : '## 섯다 결과'
  const lines = [
    heading,
    `상태: ${state.phase === 'betting' ? `${state.round + 1}/2차 베팅` : state.phase === 'cancelled' ? '취소됨' : '종료'}`,
    `팟: **${seotdaPot(state)}칩** · 현재 베팅: **${state.currentBet}칩**${turn && state.phase === 'betting' ? ` · 차례: **${escapeMarkdown(turn.name)}**` : ''}`,
    '',
    ...state.players.map((player, index) => {
      const status = player.folded
        ? '다이'
        : player.chips === 0
          ? '올인'
          : index === state.turnIndex && state.phase === 'betting'
            ? '차례'
            : '대기'
      return `${index + 1}. ${escapeMarkdown(player.name)} · ${player.chips}칩 · 누적 ${player.totalContribution} · ${status}`
    })
  ]
  if (state.result?.lines.length) lines.push('', ...state.result.lines)
  if (state.phase === 'finished' && state.result?.reason === 'showdown') {
    lines.push(
      '',
      '**공개 패**',
      ...state.players
        .filter((player) => !player.folded && player.hand.length === 2)
        .map(
          (player) =>
            `${escapeMarkdown(player.name)}: ${player.hand.map(cardName).join(' + ')} (${evaluateSeotdaHand(player.hand).name})`
        )
    )
  }
  if (state.phase === 'betting') {
    lines.push(
      '',
      `-# 차례 제한 ${SEOTDA_TURN_MS / 60_000}분. 만료 후 참가자는 시간초과 처리를 눌러 자동 다이시킬 수 있습니다.`
    )
  }
  return lines.join('\n')
}

function presentation(token: string, state: SeotdaState) {
  const body = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(statusText(state))
  )
  return [body, ...controls(token, state)]
}

function rulesPresentation() {
  return [
    new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          '## 섯다 채택 규칙',
          `20장 2장 섯다, 2-${SEOTDA_MAX_PLAYERS}명, 시작 ${SEOTDA_STARTING_CHIPS} 무료칩, 참가비 ${SEOTDA_ANTE}칩입니다. 실제 결제/환전/외부 재산 연동은 없습니다.`,
          '',
          '**일반 족보 (높은 순)**',
          '삼팔광땡 > 일팔광땡 > 일삼광땡 > 장땡~삥땡 > 알리 > 독사 > 구삥 > 장삥 > 장사 > 세륙 > 갑오 > 8끗~망통.',
          '',
          '**특수 족보**',
          '- 암행어사(4월 열끗+7월 열끗)는 일삼/일팔광땡만 잡고 삼팔광땡에는 집니다.',
          '- 땡잡이(3월 광+7월 열끗)는 1~9땡만 잡고 장땡에는 집니다.',
          '- 암행어사/땡잡이는 잡을 대상이 없으면 각각 원래 1끗/망통으로 비교합니다.',
          '- 구사(4월+9월)는 최고 일반패가 땡 미만이면 재경기입니다.',
          '- 멍텅구리 구사(4월 열끗+9월 열끗)는 광땡/장땡이 없으면 재경기입니다.',
          `- 재경기는 생존자만 새 패를 받고 기존 팟을 유지합니다. 최대 3회 후 특수 재경기 효과를 무시해 정산합니다.`,
          '',
          '**베팅/정산**',
          `2회 베팅하며 체크, 콜, 고정 ${SEOTDA_RAISE}칩 레이즈, 올인, 다이를 지원합니다. 올인 사이드팟을 만들고 각 팟별로 정산합니다. 생존 자격자가 없는 접힌 상위 팟은 가장 많이 낸 생존자 팟으로 합칩니다. 동률은 균등 분배하며 나머지 1칩씩은 좌석순으로 지급합니다. 추가 베팅 가능한 생존자가 2명 미만이면 즉시 쇼다운하고, 한 명만 남으면 패를 공개하지 않고 즉시 승리합니다.`,
          '',
          '**세션 안전**',
          '중복/오래된 클릭은 상태를 다시 표시하며 정산하지 않습니다. 게임 중 나가기는 다이로 처리되고 방장이 나가면 다음 참가자에게 방장이 넘어갑니다. 로비는 30분, 게임은 마지막 활동 후 6시간에 만료되며 재시작 뒤에도 그 전까지 복구됩니다.'
        ].join('\n')
      )
    )
  ]
}

async function replyPrivate(interaction: ButtonInteraction, message: string): Promise<void> {
  await interaction.reply({
    components: [
      new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(message))
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  })
}

function parseButton(
  customId: string
): { token: string; action: SeotdaButtonAction; revision: number } | null {
  const [base, token, action, revisionRaw, extra] = customId.split(':')
  const actions: SeotdaButtonAction[] = [
    'join',
    'leave',
    'start',
    'cancel',
    'hand',
    'help',
    'check',
    'call',
    'raise',
    'allin',
    'fold',
    'timeout'
  ]
  const revision = Number(revisionRaw)
  if (
    base !== SEOTDA_BUTTON_ID ||
    !token ||
    extra ||
    !actions.includes(action as SeotdaButtonAction) ||
    !Number.isInteger(revision)
  )
    return null
  return { token, action: action as SeotdaButtonAction, revision }
}

function interactionPlayer(interaction: ButtonInteraction): SeotdaPlayer {
  return {
    id: interaction.user.id,
    name: interaction.user.globalName ?? interaction.user.username,
    chips: SEOTDA_STARTING_CHIPS,
    hand: [],
    folded: false,
    roundContribution: 0,
    totalContribution: 0,
    acted: false
  }
}

function leaveGame(
  state: SeotdaState,
  userId: string,
  deck: SeotdaCard[],
  now: number
): string | null {
  const index = state.players.findIndex((player) => player.id === userId)
  if (index < 0) return '참가 중인 사용자만 나갈 수 있습니다.'
  if (state.phase === 'lobby') {
    state.players.splice(index, 1)
    if (state.players.length === 0) {
      state.phase = 'cancelled'
      state.result = {
        reason: 'cancelled',
        payouts: {},
        lines: ['모든 참가자가 나가 방이 취소되었습니다.']
      }
    } else if (state.hostId === userId) {
      state.hostId = state.players[0]!.id
    }
    state.updatedAt = now
    state.revision++
    return null
  }
  if (state.phase !== 'betting') return '이미 종료된 게임입니다.'
  const player = state.players[index]!
  if (player.folded) return '이미 다이한 참가자입니다.'
  if (state.hostId === userId) {
    state.hostId =
      state.players.find((entry) => entry.id !== userId && !entry.folded)?.id ?? state.hostId
  }
  const previousTurn = state.turnIndex
  state.turnIndex = index
  const error = applySeotdaAction(state, userId, 'fold', deck, now)
  if (!error && previousTurn !== index && state.phase === 'betting') {
    const previousPlayer = state.players[previousTurn]
    if (previousPlayer && !previousPlayer.folded && previousPlayer.chips > 0) {
      state.turnIndex = previousTurn
    }
  }
  return error
}

export function isSeotdaButtonId(customId: string): boolean {
  return customId.startsWith(`${SEOTDA_BUTTON_ID}:`)
}

export async function handleSeotdaButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseButton(interaction.customId)
  if (!parsed) {
    await replyPrivate(
      interaction,
      '만료되었거나 잘못된 섯다 조작입니다. `seotda`로 새 방을 만드세요.'
    )
    return
  }
  if (activeTokens.has(parsed.token)) {
    await replyPrivate(interaction, '다른 동작을 처리 중입니다. 잠시 후 다시 시도하세요.')
    return
  }
  activeTokens.add(parsed.token)
  const leaseOwner = randomUUID()
  const leaseKey = `${LOCK_PREFIX}:${parsed.token}`
  if (!tryAcquireStoredLease(leaseKey, leaseOwner, 10_000)) {
    activeTokens.delete(parsed.token)
    await replyPrivate(interaction, '다른 동작을 처리 중입니다. 잠시 후 다시 시도하세요.')
    return
  }
  try {
    const state = loadState(parsed.token)
    if (!state) {
      await replyPrivate(interaction, '이 섯다 방은 만료되었습니다. `seotda`로 새 방을 만드세요.')
      return
    }
    if (state.channelId && interaction.channelId !== state.channelId) {
      await replyPrivate(interaction, '이 게임은 생성된 채널에서만 조작할 수 있습니다.')
      return
    }
    if (parsed.action === 'help') {
      await interaction.reply({
        components: rulesPresentation(),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      })
      return
    }
    if (parsed.action === 'hand') {
      const player = state.players.find((entry) => entry.id === interaction.user.id)
      if (!player) {
        await replyPrivate(interaction, '참가자만 자신의 패를 볼 수 있습니다.')
        return
      }
      if (player.hand.length !== 2) {
        await replyPrivate(interaction, '아직 패가 배분되지 않았습니다.')
        return
      }
      await replyPrivate(
        interaction,
        `## 내 섯다 패\n${player.hand.map(cardName).join(' + ')}\n족보: **${evaluateSeotdaHand(player.hand).name}**\n-# 이 응답은 본인에게만 보입니다.`
      )
      return
    }
    if (parsed.revision !== state.revision) {
      await interaction.update({
        components: presentation(parsed.token, state),
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      })
      return
    }

    const now = Date.now()
    let error: string | null = null
    const deck = shuffleSeotdaDeck()
    if (parsed.action === 'join') {
      if (state.phase !== 'lobby') error = '게임 시작 후에는 참가할 수 없습니다.'
      else if (state.players.some((player) => player.id === interaction.user.id))
        error = '이미 참가 중입니다.'
      else if (state.players.length >= SEOTDA_MAX_PLAYERS)
        error = `20장 덱의 최대 인원은 ${SEOTDA_MAX_PLAYERS}명입니다.`
      else {
        state.players.push(interactionPlayer(interaction))
        state.updatedAt = now
        state.revision++
      }
    } else if (parsed.action === 'leave') {
      error = leaveGame(state, interaction.user.id, deck, now)
    } else if (parsed.action === 'start') {
      if (state.hostId !== interaction.user.id) error = '방장만 게임을 시작할 수 있습니다.'
      else error = startSeotda(state, deck, now)
    } else if (parsed.action === 'cancel') {
      if (state.phase !== 'lobby')
        error = '시작한 게임은 취소할 수 없습니다. 게임 나가기를 사용하세요.'
      else if (state.hostId !== interaction.user.id) error = '방장만 방을 취소할 수 있습니다.'
      else {
        state.phase = 'cancelled'
        state.result = { reason: 'cancelled', payouts: {}, lines: ['방장이 방을 취소했습니다.'] }
        state.updatedAt = now
        state.revision++
      }
    } else if (parsed.action === 'timeout') {
      if (!state.players.some((player) => player.id === interaction.user.id))
        error = '참가자만 시간초과를 처리할 수 있습니다.'
      else error = timeoutSeotdaTurn(state, deck, now)
    } else {
      error = applySeotdaAction(
        state,
        interaction.user.id,
        parsed.action as SeotdaBetAction,
        deck,
        now
      )
    }

    if (error) {
      await replyPrivate(interaction, error)
      return
    }
    storeState(parsed.token, state)
    await interaction.update({
      components: presentation(parsed.token, state),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    })
  } finally {
    releaseStoredLease(leaseKey, leaseOwner)
    activeTokens.delete(parsed.token)
  }
}

export const subcommand: Subcommand = {
  name: 'seotda',
  description: 'Discord 인터랙션으로 플레이하는 2~10인 무료칩 섯다',
  usage: 'seotda',
  examples: ['seotda'],

  async execute(interaction, args) {
    if (args.replace(/^\S+\s*/, '').trim()) {
      const components = [
        new ContainerBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            '`seotda`는 인자를 받지 않습니다. `/c seotda`를 사용하세요.'
          )
        )
      ]
      await interaction.reply({
        components,
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      })
      return
    }
    cleanupExpired()
    const token = randomUUID().replaceAll('-', '').slice(0, 12)
    const now = Date.now()
    const state: SeotdaState = {
      hostId: interaction.user.id,
      channelId: interaction.channelId ?? '',
      phase: 'lobby',
      players: [
        {
          id: interaction.user.id,
          name: interaction.user.globalName ?? interaction.user.username,
          chips: SEOTDA_STARTING_CHIPS,
          hand: [],
          folded: false,
          roundContribution: 0,
          totalContribution: 0,
          acted: false
        }
      ],
      round: 0,
      turnIndex: 0,
      dealerIndex: 0,
      currentBet: 0,
      revision: 0,
      redeals: 0,
      turnDeadline: now + SEOTDA_TURN_MS,
      updatedAt: now
    }
    storeState(token, state)
    await interaction.reply({
      components: presentation(token, state),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    })
  }
}
