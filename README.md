<img width="750" height="647" alt="AbsoluteSolverIcon" src="https://github.com/user-attachments/assets/3ebf8c8a-4143-4f4e-8431-bbf16656f26d" />

## Web Server

The bot serves a browser chat application from `/` and a health check from `/healthz` on `PORT`
(default `3000`). Set `WEB_HOST` to control the listening interface and `WEB_DOMAIN` to the public
origin. The web app uses the same `/a` agent, tools, model settings, per-user conversation storage,
and session serialization as Discord. Responses stream into the browser and render text, common
Markdown, embeds, link buttons, reasoning/tool status, and errors. Discord-only interactive
components are shown as disabled controls; continue those interactions in Discord.

Published single-file pages created by the agent are available at `/hosted` and remain stored at
`data/hosted.html`. The chat UI always owns `/`. Published HTML receives an opaque-origin CSP
sandbox: scripts can run, but cannot access the chat application's cookies or same-origin APIs.

### Web Authentication and OIDC

Web chat always requires a server-side session. Configure these deployment values before first use:

- `WEB_SESSION_SECRET`: a random value of at least 32 characters, used to encrypt the stored OIDC
  client secret. Keep it stable across restarts or the saved OIDC configuration cannot be read.
- `WEB_ADMIN_BOOTSTRAP_SECRET`: a separate random value used only to unlock initial web setup.
- `WEB_ADMIN_OIDC_SUBJECTS`: comma- or whitespace-separated OIDC `sub` claims allowed to open the
  settings page. Ordinary authenticated users can chat but cannot read or change settings.
- `WEB_SECURE_COOKIES`: defaults to secure cookies. Set it to `false` only for local HTTP testing.
- `WEB_TRUST_PROXY`: set to `true` when a trusted reverse proxy overwrites `X-Forwarded-For`, so
  authentication rate limits apply per client rather than to the proxy itself.

Open `/`, expand **Administrator setup**, and enter the bootstrap value. In **OIDC settings**, enter
the issuer URL, client ID, client secret, exact redirect URI ending in `/auth/callback`, scopes
(including `openid`), automatic-login preference, and optional post-logout redirect URI. Add the
exact OIDC `sub` claims authorized for chat and administration. Because `/a` has privileged shell,
filesystem, Docker, and integration tools, authenticated identities are denied chat access unless
explicitly listed; `*` is supported only when every account in the provider is fully trusted.
Register the same redirect and post-logout URIs with the provider, save, then enable OIDC. The
settings and client secret are stored in `data/kv.sqlite`; the secret is AES-256-GCM encrypted and
is never returned by the settings API. Leaving the secret field blank preserves the existing value.
After the first settings save, bootstrap login is disabled. Remove `WEB_ADMIN_BOOTSTRAP_SECRET` from
the deployment. Emergency recovery requires the operator to temporarily set
`WEB_ENABLE_BOOTSTRAP_RECOVERY=true`; disable it immediately after repairing the configuration.

OIDC uses discovery, Authorization Code with PKCE, browser-bound state, nonce, HttpOnly SameSite
cookies, CSRF tokens on mutations, subject allowlisting, request limits, and login/chat rate limits.
Terminate TLS at the reverse proxy and preserve streaming responses (proxy buffering must be off).
Sessions and in-flight OIDC login state are process-local, so a multi-replica deployment requires
sticky routing; restarting the process signs web users out without deleting conversations.

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
- Spotify search, library, playlist, and playback control after authentication
- Received-mail search and reading, plus outgoing mail scheduling, when `MAIL_API_KEY` is configured
- Google Calendar search, availability, and event management after authentication
- Publishing a complete single-file HTML page at `WEB_DOMAIN/hosted`; the page is stored at
  `data/hosted.html` and survives bot restarts

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
