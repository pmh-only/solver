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
`SPOTIFY_CLIENT_ID` is set. Create a Spotify developer app with
`https://<your-public-service>/mcp/spotify/callback` as a redirect URI. The web server proxies that
endpoint to Spotify MCP's loopback authentication listener. Authenticate from the running service
container so the listener and token storage share the bot's network and filesystem:

```sh
SPOTIFY_CLIENT_ID=your_client_id \
SPOTIFY_REDIRECT_URI=https://<your-public-service>/mcp/spotify/callback \
npx spotify-mcp@0.1.4 auth
```

The command stores refreshable credentials in `~/.spotify-mcp/tokens.json`. Run the bot with the
same `SPOTIFY_CLIENT_ID` and `SPOTIFY_REDIRECT_URI`; for Docker deployments, mount
`/home/node/.spotify-mcp` read-write so refreshed tokens survive deployments.
