# Role chat context and images

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
