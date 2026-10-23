# Community bot integration

Reviewed upstream source snapshots:

- `pmh-only/mntserver`, `develop`, `132f604728015d3383a5302627dd263f3952e3cc`
- `pmh-only/bot`, `main`, `20a90a1af9caa2560d70b972d9ff07378abccdf3`

The integration uses Solver's existing `/c` router, Components V2 replies, SQLite store,
and `/a` settings tools. It does not start a second bot, import credentials, deploy
application commands, or require Message Content/Guild Members privileged intents.
Existing administrator-only command access remains unchanged; anyone in the server
can participate in an explicitly public kick vote. No message-content listener was added.

## Command mapping

| Original | Solver |
| --- | --- |
| ping, math, currency conversion | Existing `ping`, `math`, `conv` implementations retained |
| set, list, help, now | Existing `set`, `list`; new `help [command]`, `now` |
| 점메추 / 저메추 | `/c food [name or tags]`; aliases `foods`, `점메추`, `저메추` |
| pizza | `/c pizza` (unofficial PizzINT DEFCON indicator, not an actual military alert) |
| date | `/c date [@member or ID]` |
| color | `/c color #rgb-or-rrggbb [secondary-color]`, followed by owner confirmation |
| invite | `/c invite`, followed by private owner confirmation |
| anon | `/c anon <message>` (requires Manage Messages) |
| emoji | `/c emoji <name> <Discord attachment URL>` (requires Manage Guild Expressions) |
| kickvote | `/c kickvote @member <reason> --pub` (requires Kick Members to start) |

Use `/c help <command>` for usage. Message-prefix invocation such as `!pizza` and
plain channel messages such as `점메추` are intentionally replaced by `/c` entrypoints.
Existing saved replies and calculations are not overwritten or migrated implicitly.

## Configuration through `/a`

The agent's `manage_community_settings` tool supports `get`, `update`, and `reset`
for a server ID (or user ID for leisure commands in DMs). Updates are validated,
persist across restarts, and take effect immediately. No new environment variables
or terminal operations are required. Example requests:

- `/a 이 서버의 추방 투표 채널을 #공론장으로, 정족수를 7명으로 설정해`
- `/a 이 서버의 일회용 초대 유효시간을 6시간, 재생성 대기를 24시간으로 설정해`
- `/a 이 서버에서 익명 메시지 기능을 비활성화해`
- `/a 이 서버 음식 추천 목록을 비빔밥(한식, 혼밥), 우동(일식, 국물)으로 바꿔`
- `/a 이 서버의 커뮤니티 기능 설정을 기본값으로 초기화해`

Settings: `disabledCommands`, `kickvoteChannelId` (default `null`: any channel),
`kickvoteThreshold` (7), `kickvoteIdleMinutes` (30), `inviteMaxAgeHours` (12),
`inviteCooldownHours` (24-hour rolling window), `anonymousName` (`???`), and
`foods` (null uses the imported default menu). A corrupt configuration fails closed;
reset it through `/a` to recover. An active vote snapshots its quorum and idle
duration; disabling the feature or changing its permitted channel blocks further votes.

Discord still requires the bot's permissions and role hierarchy to permit each action.
Secondary role colors additionally depend on Discord's server feature availability.

## Safety differences from upstream

- Private by default. Anonymous invocation and invite generation refuse `--pub`;
  invite URLs are never returned on public copies of confirmation messages.
- Anonymous messages suppress mentions, use a temporary webhook, and attempt deletion
  even on send failure. Discord audit logs can identify the webhook creator: this is
  not a promise of anonymity from server administrators.
- Color roles have no permissions; only bot-recorded user roles are reused, with
  safety checks. An arbitrary existing `color-<id>` role is never adopted by name.
- Emoji input is limited to trusted HTTPS Discord CDN origins with redirects rejected,
  a 10-second timeout, a 1 MiB download limit, PNG/JPEG/BMP dimension validation before
  decoding, a 4096px/16MP input limit, and a 128px/256KiB output limit. Downloads
  are capped at four concurrent transfers and image decoding at two jobs. No existing
  emojis are deleted automatically, even when names match or the server is full.
- Kick votes are public opt-in, guild/channel-scoped, one vote per actual non-bot
  member, and cannot target the voter themself, bots, administrators, or unkickable
  members. The opener or a moderator can cancel. At quorum the target is checked again,
  the vote is consumed before the kick, and API failures close the vote without retries.
  No five-second delayed kick or collector loop is used.
- Pending confirmations expire after 10 minutes. Votes expire after the configured
  inactivity interval. Expiration is checked lazily, so an untouched expired message
  can still display its old buttons; clicking it produces a private expired notice.
  Records persist across restarts, are purged on reads/creation, and transient state
  is capped at 200 records. Invite cooldowns are server/user-scoped and persistent.

## Upstream license

The food menu in `src/commands/community-foods.ts` is adapted from `pmh-only/bot`:

MIT License

Copyright (c) 2026 Minhyeok Park

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
