# Discord archives and private sessions

Use the existing `/a` command; no Discord command deployment or extra environment variables are required.

```text
/a prompt:/private
/a prompt:Collect all available message history from <#CHANNEL_ID> into DuckDB.
/a prompt:Show collection progress for <#CHANNEL_ID> and continue until complete.
/a prompt:Query <#CHANNEL_ID>: SELECT author_id, count(*) AS total FROM messages GROUP BY author_id ORDER BY total DESC
/a prompt:/public
```

`/private` persists the current session's private mode for the requesting user. Subsequent replies are ephemeral. `/public` switches subsequent replies back to public. The two histories are separate: switching to public does not publish or reuse private history. Switching back to private resumes that user's private history. Visibility commands do not call a model, and can optionally include a request after the command. `/clear` clears the currently active history only.

`/a prompt:/archive <request>` is an alternative for a one-off private archive request without retained chat history.

## Collection

The `discord_message_archive` agent tool supports `collect`, `watch`, `unwatch`, `status`, `query`, and explicit `delete` actions. It is available only to configured Discord administrators in private Discord sessions. Both the user and bot must currently be able to view the requested channel and read its history; private-thread membership is also checked.

DuckDB **2.0.0-r.1** is pinned. Each channel has its own persistent database beside the existing KV store, under `discord-archive/<channel_id>.duckdb`.

Collection paginates in batches of 100. Each tool call processes up to 20 pages or 60 seconds. A transaction commits message upserts and the pagination cursor together. Repeat `collect` with the same channel ID to resume; only `complete: true` means the oldest accessible message has been reached. `restart: true` starts a refresh from newest, preserving previous rows and updating retrieved messages.

## Realtime tracking

`collect` automatically enables realtime tracking for that channel. Alternatively ask `/a` to start realtime collection: `watch` starts tracking immediately without fetching old messages. `unwatch` stops new capture but retains the archive and finishes writing already queued events. `delete` stops tracking, discards that channel's pending events and deletes its database.

The bot listens to raw gateway events, including messages from bots and webhooks. Creates and partial edits update `messages`; older backfill cannot overwrite a newer gateway edit. Message deletions and bulk deletions set `messages.deleted_at` and populate `message_tombstones`, preserving previously collected content. A deletion observed before backfill cannot resurrect the message as active later. `last_gateway_at` identifies rows observed live. For active messages query `WHERE deleted_at IS NULL`.

`message_events` retains observed creates, edits, deletions, reaction changes and poll votes as raw JSON, with their event type, sequence and received time. Reaction and poll events are queryable there; `messages.raw_json` reaction aggregates remain snapshots unless a full message update refreshes them. Unknown partial edits are hydrated through Discord when available; edits of already unavailable messages retain the raw event without inventing missing content.

Tracking settings and the pending outbox survive process restarts. The SQLite WAL outbox is temporary; final message data and event logs are stored in DuckDB. The writer batches events on a roughly 250 ms cadence, serialized with history collection and SQL queries. Events arriving during backfill are applied between history pages. Channel authorization is rechecked for live batches with a maximum 30-second permission cache, invalidated by relevant gateway permission changes. Queries always recheck requester permissions directly.

The outbox is bounded to 1000 events / 16 MiB of payload with seven-day retention. SQLite WAL uses NORMAL synchronization: it survives normal process restarts, but sudden OS/power failures can lose recent uncheckpointed events. Disk limits or permission failures pause writes and retain pending events. `status` exposes `queued_events`, `realtime_issue`, `last_gateway_event_at` and `needs_history_refresh`; overflow or expiry is reported as a capture gap, not silently ignored. Gap warnings remain visible because missing edits/deletions cannot be reconstructed reliably. Capture is disabled when `discordArchive.enabled` is false.

`messages` contains searchable author, content, timestamp, type, flags, pin, reference and attachment/embed-count columns. `raw_json` preserves every field returned by Discord's message endpoint, including nested metadata and unknown future fields, except credential/token fields. Use JSON extraction for attachments, embeds, reactions, mentions, components, polls, forwarded snapshots and references. `archive_state` exposes progress.

Realtime tracking can only record gateway events delivered while the bot is connected. Historical collection cannot recover earlier deleted messages or earlier edits; refresh history after downtime to recover available messages. Attachment **metadata** is stored, not file bytes. Existing reaction counts and poll metadata are snapshots; gateway events record individual changes observed after tracking starts, not exhaustive past reactor/voter lists. Threads must be tracked separately by their channel IDs. Missing Message Content intent or Discord permissions can limit returned fields.

## Queries and controls

### Public role-mention search

Ask `/a` to set `discordArchive.searchRoleId` to the search role's ID (supply its role mention). The default is `null`, disabling role search. No extra environment variables or Discord command deployment are required.

Anyone can then send `@search-role 임베드나 컨텐츠에 "바나나" 들어가는 내용 있으면 찾아줘`. Neither administrator status nor possession of the role is required. Both `<@&ROLE_ID>` and `<&@ROLE_ID>` spellings are recognized. Use one quoted literal search term; a single bare word also works. Mentioning only 본문/컨텐츠/content searches content, mentioning only 임베드/embed searches embeds, and otherwise both are searched.

Search is restricted to the requesting channel's existing archive and the requester/bot must have channel/history access. Replies are public in that channel, with at most five source links and short snippets. Each candidate is fetched from Discord before disclosure; known deletions, unavailable messages and content edited to remove the term are excluded. Collection gaps or incomplete history can still omit results. Searches are rate-limited and do not call a paid model. Arbitrary SQL and archive management remain administrator-only.

Queries accept one read-only `SELECT`/`WITH` statement, with filesystem/network access and extension loading disabled. Query time is limited to 10 seconds, memory to 256 MB, and output to 200 rows, 4000 characters per cell and 48 KiB. A `truncated` result requires narrowing the SQL; stored data is not truncated. Narrow queries to selected columns, or use `substr` to retrieve portions of large JSON fields.

Configure `discordArchive.enabled`, `maxStorageMiB` (64–20480, default 1024) and `maxChannels` (1–500, default 100) through `/a` using `manage_community_settings`. When a quota is reached, free space with an explicit archive deletion or increase the configured limit. Only one archive writer/query runs at a time. Tracking starts only for channels enrolled through `/a`, and then continues automatically without repeated commands.
