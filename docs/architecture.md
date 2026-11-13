# Source layout

The tree follows ownership: application composition, Discord transport, the AI agent,
HTTP transport, user-facing features, external integrations, and shared infrastructure.

```text
src/
├── index.ts                         # Application entrypoint
├── deploy.ts                        # Command deployment entrypoint
├── app/
│   ├── start.ts                     # Registration, gateway wiring, startup/shutdown
│   ├── deploy.ts
│   ├── bot-ready.ts
│   └── features.ts                  # Built-in feature composition
├── discord/
│   ├── client-options.ts
│   ├── commands/                    # Definitions, deployment, parsing, controls, contracts
│   ├── routing/                     # Authorization gate and interaction dispatch
│   ├── gateway/                     # Message and reaction dispatch
│   └── ui/                          # Components V2 and reply delivery
├── agent/
│   ├── index.ts, runtime.ts         # Public exports
│   ├── command.ts, config.ts, system-prompt.ts
│   ├── runtime/                     # Discord/web execution and run lifecycle
│   ├── sessions/                    # Identity, privacy, persistence
│   ├── interactions/                # Attachments and interactive context
│   ├── streaming/                   # Model streaming, JSON parsing, response rendering
│   ├── mcp/                         # MCP connections, configuration, memory path
│   └── tools/                       # Agent shell and subagent tools
├── web/
│   ├── server.ts, http.ts           # HTTP entrypoint and transport helpers
│   ├── ui.ts, hosted-page.ts        # Frontend assets and published pages
│   ├── auth/                       # OIDC, sessions, cookies, CSRF
│   └── routes/                     # Chat, community, administrator settings
├── features/
│   ├── archive/
│   │   ├── service.ts
│   │   ├── capture/                # Gateway capture and history backfill
│   │   ├── storage/                # DuckDB connections, tables, durable outbox
│   │   └── search/                 # Queries, AI search, Discord/web adapters
│   ├── community/
│   │   ├── application-commands.ts, feature.ts, settings.ts
│   │   └── commands/               # Guild and leisure commands
│   ├── conversation/               # Personas, role chat, images, mail, relationships
│   ├── dynamic/                    # Agent-created features, store, JavaScript execution
│   ├── games/                      # Individual games, with quiz/ and seotda/ runtimes
│   ├── media/
│   │   ├── lyrics/                 # Command, providers, pronunciation, live sessions
│   │   ├── download/
│   │   └── convert/
│   ├── memes/                      # Search and voice playback
│   ├── messages/
│   │   ├── bot/                    # Prefix-based message commands
│   │   ├── commands/               # Context menus and message utilities
│   │   └── deleted.ts, edit-history.ts, edit-diff.ts, repeated.ts
│   ├── moderation/                 # Chat moderation and model input preparation
│   └── utilities/
│       ├── network/                # DNS, WHOIS, TLS, GeoIP, ping, HTTP, crawling
│       ├── math/
│       ├── conversion/
│       ├── storage/                # User key/value commands
│       ├── system/                 # Privileged execution and usage commands
│       └── catalog.ts, help.ts, pubtab.ts, mail.ts, poll.ts, qr.ts
├── integrations/
│   └── firecrawl/, google-calendar/, mail/, openai/, spotify/
├── shared/
│   ├── storage/                    # KV database and stored environment configuration
│   ├── security/                   # Administrator policy and secret encryption
│   ├── runtime/                    # Health reporting, safe errors, request timing
│   ├── rendering/                  # Canvas, fonts, game-card presentation
│   └── time/                       # Timezone helpers
└── test/
    ├── setup.ts
    ├── support/                    # Discord interaction harness and database isolation
    ├── fixtures/
    └── app/, discord/, agent/, web/, features/, integrations/, shared/
```

## Placement rules

- Put feature-specific commands, state, protocols, and rendering in the owning
  feature subtree. A multi-file feature gets a directory such as
  `features/media/lyrics/`; short independent games can be individual files.
- Use `discord/` and `web/` for transport-level routing and response handling.
  `app/` composes the services and registers their entrypoints.
- Put reusable external-service clients and authentication in `integrations/`.
  Keep a client used only by one feature beside that feature's implementation.
- Use `shared/` for cross-feature infrastructure. Feature-owned stores stay with
  their feature, such as `features/dynamic/store.ts` and `agent/sessions/store.ts`.
- Mirror the source category under `test/`, keeping descriptive test filenames.
  For example, lyrics tests live in `src/test/features/media/lyrics/`.
- Relative ESM imports use `.js`. Directory names provide context, so nested
  modules use names such as `command.ts`, `runtime.ts`, and `store.ts`.

## Entrypoints and resources

`src/index.ts` loads `app/start.ts`; `src/deploy.ts` loads `app/deploy.ts`.
Both perform live application operations when executed. Test the feature registry
through `test/support/e2e.ts` and the focused startup helpers instead.

Compilation mirrors `src/` into `dist/`. Font/Twemoji URLs in
`shared/rendering/canvas.ts` and MCP executable URLs in `agent/mcp/runtime.ts`
resolve from the module location to the repository/package root in either tree.
Browser assets live in `assets/web/` and are loaded by `web/ui.ts` from the working
directory. These resource paths need to be checked whenever their loaders move.
