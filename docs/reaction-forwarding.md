# Reaction forwarding

Configure through `/a`, for example:

> 이 서버에서 반응이 3개 이상인 메시지를 #인기글 채널에 전달하도록 설정해

`manage_community_settings` accepts `reactionForward: { channelId: '...' }`.
This is one global setting for the bot, not a per-server configuration. No server
ID is required. Existing single-server settings migrate automatically.
The default is `null` (disabled); set it back to null to stop processing immediately.
The destination must be a sendable channel in the same server.

## Behavior

- Count the sum of all emoji reaction counts on a message, not the number of
  distinct emojis or distinct people.
- At 3 or more reactions, create a native Discord forward (message snapshot),
  then a separate embed immediately below it with the original author's name,
  avatar/profile link, original-message link, and each emoji's current count.
- Subsequent events edit the existing embed only while the total is greater
  than 3. At 3, 2, 1, or 0, leave the last display and forwarded message intact.
  Updating resumes once the total exceeds 3 again.
- Handle reaction additions, removals, individual-emoji removal, and removal of
  all reactions. Fetch fresh aggregate counts for each synchronization, including
  old/uncached source messages. Users, bots, and webhooks can all be sources.
- Ignore messages in the destination itself to prevent forwarding loops.
- Suppress all outbound mention notifications. Never fall back to copying
  message text or downloading/re-uploading attachments if native forwarding fails.

The bot needs access to/read history in the source and permission to send messages
and embeds in the destination. Discord's own restrictions on native forwarding
still apply. The existing client additionally subscribes to Guild Message Reactions
and partial messages/channels/reactions.

## Reliability and state

Coalesce overlapping events per source message, re-read fresh counts after an
in-flight update, and use enforced deterministic nonces when creating both posts.
Persist the forward ID before creating the embed, so an embed failure does not
forward the source again. Ordinary updates edit only the metadata embed.

Tracking is stored under the hidden, guild-scoped `community:reaction-forward:`
namespace and survives restarts. Store only channel/message IDs, render hashes,
and timestamps. Retain up to 1,000 entries per guild for 30 days, with at most
250 active source synchronizations and a 10-second timeout per Discord operation.
Corrupt state fails closed. `/a` can use `action: 'reset-reaction-forwards'` to
clear tracking without deleting any Discord posts or unrelated settings.
