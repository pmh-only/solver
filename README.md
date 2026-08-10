<img width="750" height="647" alt="AbsoluteSolverIcon" src="https://github.com/user-attachments/assets/3ebf8c8a-4143-4f4e-8431-bbf16656f26d" />

## Web Server

The bot serves a browser chat application from `/` and a health check from `/healthz` on `PORT`
(default `3000`). Set `WEB_HOST` to control the listening interface and `WEB_DOMAIN` to the public
origin. The web app uses the same `/a` agent, tools, model settings, per-user session pool,
conversation storage, and session serialization as Discord. Use the same Discord user ID as the OIDC
`sub` claim to access the same sessions from both clients. Responses stream into the browser and
render text, common Markdown, embeds, link buttons, reasoning/tool status, errors, and the supported
Discord interactions described below.

The selected session is shared too: choosing a session in either client selects it in the other.
While open, the Web UI polls the shared conversation so completed Discord `/a` turns and the shared
one-hour idle reset appear without reloading the page.

System prompts are stored permanently in the SQLite KV store. The global system prompt applies to
every Discord and Web UI request in every session. Each user session can also have a persistent
session system prompt, which is appended to the global instructions only for that session. Manage
both prompts from **System prompts** in the Web UI, or set/reset the current Discord session prompt
with the `/a` options `system_prompt` and `reset_system_prompt`.

Web requests continue running when the user switches sessions. Returning to a session restores its
latest reasoning and tool status. **Cancel** stops the selected session's request while preserving
the request and progress already produced; submitting another message during a run cancels and
records the current run before appending the replacement. Conversation persistence includes the
agent's structured tool calls and tool results so follow-up requests retain that context.

### Web Discord Component Compatibility

Web interactions use the same namespaced `custom_id`, persisted context, session serialization, and
agent event payloads as Discord. The server derives the user from the OIDC session, enforces
`sender_only`, rejects controls owned by another Web user, and prevents a duplicate interaction from
running concurrently within an application process. Controls display disabled and pending states.
Finalized controls loaded from conversation history remain interactive until their persisted context
expires. Legacy history without finalized namespaced IDs remains visible but disabled.

Supported message components:

- Buttons, including label, emoji, style, disabled state, link buttons, and buttons that open a
  registered modal.
- String selects, including options, descriptions, emoji, placeholder, `min_values`, `max_values`,
  disabled state, and default selections.
- User, role, mentionable, and channel selects, including placeholder, limits, disabled state, and
  Discord `default_values`. The Web UI accepts Discord IDs as comma-separated values because an OIDC
  browser session has no Discord guild directory from which to enumerate entities.
- Action rows, text displays, separators, sections, and containers as layout/content wrappers.

Supported modal fields:

- Text inputs (single-line and paragraph), including label, placeholder, initial value, required,
  minimum length, and maximum length.
- String, user, role, mentionable, and channel selects with the same Web behavior as message selects.
- Radio groups, checkbox groups, and individual checkboxes.
- Components V2 labels and text displays.

File-upload modal fields and other unknown component types are not interactive on Web. They render a
visible unsupported-component fallback instead of breaking the response. Media galleries,
thumbnails, attached-file components, and other display-only Discord components also currently use
that fallback. Adding support requires registering another renderer in `componentRenderers` and, for
modal inputs, adding its Discord-shaped serialization and server validation branch.

Ask `/a` to publish a complete single-file HTML document to create a unique URL shaped like
`/shared/<random_uuid>`. Each page is stored persistently under `data/shared/`; publishing another
page does not replace earlier pages. For example: `Publish this HTML as a shared page: <!doctype
html><title>Hello</title><h1>Hello</h1>`. The returned URL uses `WEB_DOMAIN` when configured, or a
relative `/shared/<random_uuid>` path otherwise. The legacy single page at `/hosted`, backed by
`data/hosted.html`, remains available for existing deployments.

The chat UI always owns `/`. All published HTML receives an opaque-origin CSP sandbox: scripts can
run, but cannot access the chat application's cookies or same-origin APIs.

### Web Authentication and OIDC

Web chat always requires a server-side session. These optional deployment values control web
authentication:

- `WEB_SESSION_SECRET`: optional override of at least 32 characters for encrypting the stored OIDC
  client secret. When omitted, the application generates a cryptographically secure secret at
  startup, atomically stores it in `data/kv.sqlite`, and reuses it across restarts and replicas that
  share that database. An explicit value always takes priority. Keep it unchanged after saving OIDC
  settings. Existing deployments that already set this value remain compatible and should leave the
  same override configured; changing or removing it makes the saved OIDC configuration unreadable.
- `WEB_ADMIN_OIDC_SUBJECTS`: optional compatibility list of comma- or whitespace-separated OIDC
  `sub` claims that also receive chat access. Every authenticated Web user can manage settings.
- `WEB_SECURE_COOKIES`: defaults to secure cookies. Set it to `false` only for local HTTP testing.
- `WEB_TRUST_PROXY`: set to `true` when a trusted reverse proxy overwrites `X-Forwarded-For`, so
  authentication rate limits apply per client rather than to the proxy itself.

Open `/`. If OIDC has not been configured, the **OIDC settings** screen opens immediately without an
initial secret or unlock step. Enter the issuer URL, client ID, client secret, exact redirect URI
ending in `/auth/callback`, scopes
(including `openid`), automatic-login preference, and optional post-logout redirect URI. Add the
exact OIDC `sub` claims authorized for chat. Because `/a` has privileged shell,
filesystem, Docker, and integration tools, authenticated identities are denied chat access unless
explicitly listed; `*` is supported only when every account in the provider is fully trusted.
Register the same redirect and post-logout URIs with the provider, then save with OIDC enabled. The
settings, generated encryption key, and client secret are stored in `data/kv.sqlite`; the client
secret is AES-256-GCM encrypted and is never returned by the settings API. Leaving the secret field
blank preserves the existing value. Persist `data/kv.sqlite` and use one shared database file when
running multiple instances.
The first successful save permanently closes unauthenticated setup access; later settings access
requires an authenticated OIDC session and CSRF validation. Because any network client
can claim an unconfigured instance, keep a new deployment private or network-restricted until this
first save completes. Initial setup requires OIDC login to be enabled.

OIDC uses discovery, Authorization Code with PKCE, browser-bound state, nonce, HttpOnly SameSite
cookies, CSRF tokens on mutations, subject allowlisting, request limits, and login/chat rate limits.
Terminate TLS at the reverse proxy and preserve streaming responses (proxy buffering must be off).
Sessions and in-flight OIDC login state are process-local, so a multi-replica deployment requires
sticky routing; restarting the process signs web users out without deleting conversations.

### Global System Prompt

Any authenticated web user can open **System prompt** from the chat screen to view and
replace the global base system prompt or reset it to the built-in default. The setting applies to
every future Discord and web agent request, including requests in existing conversation sessions;
saved conversation history is unchanged. Solver appends its response-protocol, tool-recovery, and
request-specific verbosity instructions separately so prompt edits do not break product output.

The setting is stored as the internal `global-system-prompt` record in `data/kv.sqlite` (or the
configured `KV_STORE_PATH`) with `updatedAt` and `updatedBy` audit fields. The equivalent API is:

- `GET /api/admin/system-prompt` to read the effective global prompt and metadata.
- `PUT /api/admin/system-prompt` with JSON `{ "prompt": "..." }` to replace it.
- `POST /api/admin/system-prompt/reset` to restore the built-in default.

All three endpoints require a current OIDC session whose server-derived `admin` flag is true.
Mutations additionally require the session CSRF token in `X-CSRF-Token`. The server does not trust
an administrator flag, subject, or user ID supplied by the request body.

## Interaction Access

Set `ADMIN_USER_IDS` to a comma- or whitespace-separated list of Discord user IDs. Private
commands, context menus, modals, and autocomplete are restricted to those users. Components on
public messages and commands launched through the constrained Pubtab remain available to everyone.

## Spotify MCP

The `/a` agent receives Spotify search, library, playlist, and playback tools when
authenticated. Create a Spotify developer app with
`https://<your-public-service>/mcp/spotify/callback` as a redirect URI. Then ask `/a` to authenticate
Spotify and include the app's client ID and exact redirect URI. The agent returns a Spotify login
link; opening it completes authentication through the bot's existing web server. No environment
configuration or terminal command is required.

Refreshable credentials and the non-secret client ID are stored under `data/.spotify-mcp`, alongside
the bot's existing persistent data. Existing `SPOTIFY_CLIENT_ID` and `SPOTIFY_REDIRECT_URI`
environment configuration remains supported.

## Agent Tools

The `/a` agent can search the internet through OpenAI's Responses API and includes MCP tools for:

- Docker container and Compose management
- Unrestricted Bash shell access as the `agent` user, with passwordless `sudo` for root operations
- Browser automation through headless Chromium and Playwright
- Fetching and converting web pages to Markdown
- Reading and writing files under the persistent `data/` directory
- Persistent knowledge-graph memory stored at `data/.agent-memory.jsonl`
- Structured sequential reasoning
- Current-time lookup and time-zone conversion
- Cancellable waits from 0.1 seconds through 10 minutes for external operations to make progress
- Spotify search, library, playlist, and playback control after authentication
- Received-mail search and reading, plus outgoing mail scheduling, when `MAIL_API_KEY` is configured
- Google Calendar search, availability, and event management after authentication
- Publishing complete single-file HTML pages at unique `WEB_DOMAIN/shared/<random_uuid>` URLs; pages
  are stored under `data/shared/` and survive bot restarts

Docker MCP requires access to a Docker daemon, typically by mounting `/var/run/docker.sock` at the
same path. The runtime image includes the Docker CLI, Chromium, `uvx`, and the packaged Node.js MCP
servers. No extra MCP installation is required after deployment.

### Model Selection

The optional `/a model` field accepts any model identifier. Suggestions are loaded dynamically from
OpenAI and exposed by the app as `GET /models`; no model catalog is hardcoded. The result is cached
for five minutes and used only for autocomplete, so an unavailable models API does not restrict
manual input. Select a suggestion or keep typing and submit a value that is not listed. The selected
value is stored for that conversation session and sent unchanged on later requests in the same
session.

`GET /models` returns `application/json` with this shape:

```json
{"models":["<model-id>","<another-model-id>"]}
```

To test dynamic discovery, run `curl -sS https://<your-public-service>/models` and confirm the array
reflects the models available to `OPENAI_API_KEY`. In Discord, type `/a`, fill in `prompt`, then type
part of one of those model IDs in `model` to confirm suggestions appear. Enter an unlisted value such
as `vendor/custom-model-preview`, submit the command, and send another `/a` request with the same
session but no `model`; both responses should display that exact custom value in their token-usage
footer. The automated coverage can be run with
`pnpm exec vitest run src/test/gpt.test.ts src/test/web-server.test.ts`.

Create the Mail API key under `https://mail.pmh.codes/settings/api`, then set `MAIL_API_KEY` in the
bot environment. The key is sent only to `https://mail.pmh.codes/api/external/v1/mcp` as a Bearer
token.

## Google Calendar MCP

Create a Google Cloud OAuth client of type **Web application**, enable the Google Calendar API, and add
`https://<your-public-service>/mcp/google-calendar/callback` as an authorized redirect URI. Set
`GOOGLE_OAUTH_CREDENTIALS_BASE64` to a single-line base64 encoding of the downloaded OAuth JSON, and
set `GOOGLE_CALENDAR_REDIRECT_URI` to that exact public callback URI. Then ask `/a` to authenticate
Google Calendar; the agent returns a Google login link without requiring terminal access.

Both values can be applied to the running bot with `/c set env:<name> <value>`. Values set this way
are persisted in the mode `0600` bot store at `data/kv.sqlite` and restored automatically after a
bot restart.

Normalized OAuth credentials and refreshable account tokens are stored with mode `0600` under
`data/.google-calendar-mcp`.
