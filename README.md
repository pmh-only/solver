<img width="750" height="647" alt="AbsoluteSolverIcon" src="https://github.com/user-attachments/assets/3ebf8c8a-4143-4f4e-8431-bbf16656f26d" />

## Web Server

The bot serves a responsive `Hello, World!` page from `/` and a health check from `/healthz` on
`PORT` (default `3000`). Set `WEB_HOST` to control the listening interface.

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
- Browser automation through headless Chromium and Playwright
- Fetching and converting web pages to Markdown
- Reading and writing files under the persistent `data/` directory
- Persistent knowledge-graph memory stored at `data/.agent-memory.jsonl`
- Structured sequential reasoning
- Current-time lookup and time-zone conversion
- Spotify search, library, playlist, and playback control after authentication
- Received-mail search and reading, plus outgoing mail scheduling, when `MAIL_API_KEY` is configured

Docker MCP requires access to a Docker daemon, typically by mounting `/var/run/docker.sock` at the
same path. The runtime image includes the Docker CLI, Chromium, `uvx`, and the packaged Node.js MCP
servers. No extra MCP installation is required after deployment.

Create the Mail API key under `https://mail.pmh.codes/settings/api`, then set `MAIL_API_KEY` in the
bot environment. The key is sent only to `https://mail.pmh.codes/api/external/v1/mcp` as a Bearer
token.
