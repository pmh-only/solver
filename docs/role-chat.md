# Role chat context and images

## Finding older conversations with SQL

When a user explicitly asks to find past messages (for example, `@role 예전에 피자
얘기한 기록 찾아줘`), role chat can write a SQL query and call
`search_discord_history`. Natural Discord `/a` history requests automatically use a
one-off private archive session that is deleted afterward, rather than copying
channel records into shared agent history. The scoped lookup is bound to the initiating user, guild and current channel;
that channel must be the configured `discordArchive.channelId`. Web agent sessions
do not gain this tool or Discord permissions.

Queries use `SELECT message_id FROM messages WHERE ... ORDER BY created_at DESC
LIMIT 12`, with author/date/content/search_text filters, AND/OR/NOT, LIKE/ILIKE,
comparisons and a small allowlist of string functions. `search_text` covers embeds
and other searchable fields as well as content. The server compiles an allowlisted
SQL syntax tree into its own parameterized query; model SQL is never executed
directly. Joins, subqueries, CTEs, arbitrary output columns, aggregates, other tables,
file/network reads and writes are rejected. Privileged arbitrary read-only SQL and
archive management remain exclusive to the existing private administrator `/a` tool.

The server rechecks the user and bot's channel/history permissions, then fetches each
candidate from Discord and evaluates the same filters against its current content.
Only up to five verified messages and source URLs reach the model. Offline-deleted
and edited-away matches are not disclosed. No private agent history is searched.
Incomplete history and no verified matches must be reported rather than invented.

Set `roleChat.archiveSearch:false` through `/a` to disable role-chat lookup (default
true); this is independent of `webSearch`. There are at most two SQL searches per
reply, three model rounds total under the existing 30-second deadline, 12 candidates
and a 10-second database/live-verification budget per query. Global limits are 30
searches/minute and 300/hour. Ordinary chat does not query the archive merely because
old messages or personas contain a search request. No new credentials or commands
are required.

## Recent context and image inputs

Configure `roleChat` through `/a` using `manage_community_settings`. Preserve the
existing nested settings when changing a field. Setting `roleChat:null` disables it.

Each reply includes the previous 50 same-channel messages, including messages without
a role mention, and the current request. Compact records use `a` (author ID), `n`
(nickname), `c` (content), `f` (attachment URLs), and `p` (verified Discord Administrator
permission). Administrator requests have conversational priority, not permission to
override system, tool-access or relationship rules.

`roleChat.readImages` defaults to `true`. Eligible PNG/JPEG/WebP attachments are sent
to the configured model as high-detail image inputs, not just text URLs, allowing it
to describe photos and read visible text. The configured model must support vision.
Mentioning the chat role with only an eligible image also requests a description.

`roleChat.maxImages` controls the per-reply limit (1–8, default 4). Images attached to
the current request come first, followed by newest historical attachments. Repeated
URLs are included once. Each image must be at most 10 MiB and use an HTTPS Discord
CDN attachment URL. Arbitrary pasted links, unsupported formats and oversized images
are not loaded as images. Attachments in other channels or private `/a` sessions are
never included. Selection only considers the first ten attachments of each message.
Images are retrieved by the model provider; the bot does not download or upload them.

Set `roleChat.readImages:false` through `/a` to disable image inputs without disabling
text chat. There are no additional credentials, environment variables or command
deployments. Image text remains untrusted content: it cannot grant `p:true`, choose a
persona, change relationship override membership, or become a system instruction.
The model is told not to invent unreadable text or claim it saw images not supplied.
