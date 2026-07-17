<img width="750" height="647" alt="AbsoluteSolverIcon" src="https://github.com/user-attachments/assets/3ebf8c8a-4143-4f4e-8431-bbf16656f26d" />

## Hello World Activity

The bot serves a minimal Discord Activity from `/` and a health check from `/healthz` on
`PORT` (default `3000`). Use `/c activity` to create a button that launches the Activity.

Discord must be able to load the web server through HTTPS before the launch callback will work:

1. Expose the bot's `PORT` through a public HTTPS endpoint.
2. In the Discord Developer Portal, open **Activities > Settings** and enable Activities.
3. Under **Activities > URL Mappings**, map the `/` prefix to the public web-server host.
4. Launch it from Discord's App Launcher, or run `/c activity` and click **Open Activity**.

The managed `Launch` Primary Entry Point keeps App Launcher access intact when global commands are
deployed. `/c activity --pub` creates a shared launch button in the current channel.

The example only renders `Hello, World!` and does not request Discord user data, so it does not
need Activity OAuth or the Embedded App SDK yet.
