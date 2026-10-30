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

The `discord_message_archive` agent tool supports `collect`, `status`, `query`, and explicit `delete` actions. It is available only to configured Discord administrators in private Discord sessions. Both the user and bot must currently be able to view the requested channel and read its history; private-thread membership is also checked.

DuckDB **2.0.0-r.1** is pinned. Each channel has its own persistent database beside the existing KV store, under `discord-archive/<channel_id>.duckdb`.

Collection paginates in batches of 100. Each tool call processes up to 20 pages or 60 seconds. A transaction commits message upserts and the pagination cursor together. Repeat `collect` with the same channel ID to resume; only `complete: true` means the oldest accessible message has been reached. `restart: true` starts a refresh from newest, preserving previous rows and updating retrieved messages.

`messages` contains searchable author, content, timestamp, type, flags, pin, reference and attachment/embed-count columns. `raw_json` preserves every field returned by Discord's message endpoint, including nested metadata and unknown future fields, except credential/token fields. Use JSON extraction for attachments, embeds, reactions, mentions, components, polls, forwarded snapshots and references. `archive_state` exposes progress.

This is an API-visible snapshot, not a live listener. It cannot recover previously deleted messages or earlier edits. Later deletions do not purge previously collected snapshots. Attachment **metadata** is stored, not file bytes; reaction counts and poll metadata are stored, not exhaustive reactor/voter lists. Threads must be collected separately by their channel IDs. Missing Message Content intent or Discord permissions can limit returned fields.

## Queries and controls

Queries accept one read-only `SELECT`/`WITH` statement, with filesystem/network access and extension loading disabled. Query time is limited to 10 seconds, memory to 256 MB, and output to 200 rows, 4000 characters per cell and 48 KiB. A `truncated` result requires narrowing the SQL; stored data is not truncated. Narrow queries to selected columns, or use `substr` to retrieve portions of large JSON fields.

Configure `discordArchive.enabled`, `maxStorageMiB` (64–20480, default 1024) and `maxChannels` (1–500, default 100) through `/a` using `manage_community_settings`. When a quota is reached, free space with an explicit archive deletion or increase the configured limit. Only one archive operation runs at a time. No real collection runs until requested through `/a`.
