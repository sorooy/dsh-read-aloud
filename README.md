# dsh-read-aloud

> **One line: text-to-speech for DeepSeek Harness.** Every Assistant reply gets a 🔊 button that reads it aloud in a MiniMax voice. Optional auto-read each turn, and it stops the moment you send a new message.

Turns DSH replies into audio with [MiniMax](https://www.minimaxi.com) synthesis — pick any system voice, or reuse a cloned one.

**Who it is for**: long replies are tiring to read, you want to listen while doing something else, you are on a phone, or you need the answer read out to someone next to you.

| What you get | Detail |
| --- | --- |
| 🔊 one button per reply | In the same strip as copy / fork / 👍👎. Click to read, click to stop, click again to replay (replays are free) |
| Auto-read per turn | Optionally read the last paragraph of every reply |
| Barge-in | Sending a new message cuts the audio immediately (Doubao-style); the next reply is read as usual |
| Voice and rate | MiniMax system or cloned voices, model, speed and emotion, with a preview |
| Code stays silent | Only prose text blocks are read — no code, tool calls or reasoning |

> Synthesis goes through MiniMax's cloud API and **needs network access**; the DSH UI itself stays local.

A community plugin, not an official DeepSeek or MiniMax product.

English | [简体中文](README.zh-CN.md)

-----

## The gap it fills

DeepSeek Harness ships no speech synthesis at all. The community plugin [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice) brings MiniMax cloning, TTS and ASR — but its playback lives in agent tools and a settings panel, with no "click a reply and hear it".

This plugin is the thin layer that connects a message action button to existing synthesis. With [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice) installed it reuses that plugin's key, voice library and billing; without it, the built-in standalone mode talks to MiniMax directly — one pasted API key and it runs.

## Features

- **A speaker button per reply**, in the same strip as copy / fork / 👍👎:
  click to read that message, click while it plays to stop, click again to replay.
- **One reading per turn.** A multi-step turn emits one Assistant message per step; reading each would talk over the tool calls, so only the newest prose is kept and spoken when the turn closes.
- **Optional auto-read**: speak the end of every turn.
- **Barge-in**: sending a new message cuts the current audio immediately (Doubao-style); the next reply is read as usual. Toggle in settings.
- **Code and links are skipped**: fenced blocks are dropped whole, links contribute only their label, and images or table rules never get read. Inline code such as `npm_install` is kept — that is usually the name you need to hear.
- **History works too**: the event stream is cached silently on page load, without speaking it.
- **Single playback**: starting another message stops the current one.
- **Configurable voice**: any MiniMax system voice or a cloned `voice_id`, plus model and speed, with a preview button.

## Requirements

Either of:

- **Recommended**: install [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice). This plugin's host calls its `minimaxVoice` service directly (same process, no HTTP); the key, cloned voices and billing stay there.
- **Standalone mode**: the host calls MiniMax itself. Key priority:

  1. `config.apiKey` in the plugin configuration
  2. the `MINIMAX_API_KEY` environment variable (restart the Harness after setting it)
  3. saved from the settings panel (**plain text** at `~/.dsh/read-aloud/secret.json`)

The browser only ever calls this plugin's own routes:

```
GET  /read-aloud/api/status                                  ->  { configured, backend, keySource }
POST /read-aloud/api/tts    { text, voiceId, model, speed }  ->  { path, file, durationMs, characters, backend }
POST /read-aloud/api/key    { key }                          ->  { configured }
GET  /read-aloud/api/output/:file                            ->  mp3
```

> **Why not fetch `dsh-minimax-voice`'s HTTP surface from the browser?** That route runs every request through the DSH `connection` trust check, which answers 401 to a plain `fetch`. The client then decided "no backend" and failed silently — the bug 0.2.1 fixes. Calling the service in-process removes auth, CORS and ports from the equation.

With neither backend configured, the button shows ⚠️ and puts the concrete error in its tooltip instead of failing silently.

## Install

**Source install only for now** — the package is not on npm yet, so the `dsh plugin add` npm form will not work.

```bash
git clone https://gitee.com/op00007/dsh-minimax-autoread.git dsh-read-aloud
dsh plugin --profile desktop add ./dsh-read-aloud
```

Already have a local copy:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-read-aloud
```

Refresh the page afterwards — client plugins mount at page load.

## Usage

1. Hover any Assistant reply; a **🔊** appears in its action strip.
2. Click to read it. While playing the icon becomes **⏹**; click to stop, click again to replay.
3. **Settings → MiniMax Auto-read** holds the auto-read switch, the voice id, the model, the speed and a preview button.

## Settings

Stored in the browser's `localStorage` under `dsh.read-aloud.settings`. Nothing is polled, reported, or written into host configuration.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Speak the end of each turn |
| `interrupt` | `true` | Cut playback when a new message is sent |
| `skipMarkup` | `true` | Drop code blocks and link addresses |
| `voiceId` | `female-shaonv` | MiniMax voice id, system or cloned |
| `model` | `speech-2.8-hd` | Synthesis model (2.8 / 2.6 / 02 / 01, hd and turbo) |
| `speed` | `1` | Speech rate, 0.8–1.5 |

## How it works

```text
   ┌──────────────────────────── browser ───────────────────────────┐
   │                                                                │
   │  session event stream: binding.eventSource                      │
   │        │                                                       │
   │        ├── assistant/message ──▶ texts.set(message.id, prose)   │
   │        │                                                       │
   │        └── turn/end ──▶ auto-read on? ──▶ speak(pending)        │
   │                                                                │
   │  slot conversation.chat.assistant-actions ──▶ [🔊 button]       │
   │        └── click ──▶ toggle(messageId)                          │
   │                        │                                       │
   │                        ▼                                       │
   │              POST /mmvoice/api/tts ──▶ { path }                 │
   │                        │                                       │
   │                        ▼                                       │
   │              new Audio('/mmvoice/api/output/<file>')            │
   └────────────────────────────────────────────────────────────────┘
```

Design notes:

- **The host resolves the backend; the browser never authenticates.** The client only calls `/read-aloud/api/*`; the host prefers the `minimaxVoice` service and falls back to MiniMax directly. Produced mp3s are copied into this plugin's output directory so one stable URL serves them.
- **Prose is cached by `messageId`.** The action slot hands over an id only, so the button has to learn what that message said. The event stream is the only reliable source.
- **Replay is not speech.** Page load replays history; the first pump runs with `synced` still `false`, so it fills the cache without talking.
- **Replay is free.** Synthesized audio is cached in memory per message id; a second click plays the file instead of re-billing.
- **No DOM fallback.** When the prose is missing the button reports it. An early version scraped the nearest `[data-message-bubble]` element — that attribute marks the *user* bubble, so the fallback would have read your own message back to you.
- **Only `text` blocks are spoken.** Reasoning, code and tool calls stay silent.

## Compatibility

- Developed and verified against **DSH `0.2.2-rc.1`** (desktop).
- `engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0`.
- Depends only on shared modules the web shell provides: `react` and `@deepseek-ai/dsh-client-ui-slots`.
- Uses the slots `conversation.chat.assistant-actions` and `settings.section`. If a later release renames them, the button silently disappears and this plugin needs updating.

## Known limitations

- **Standalone voice suggestions are hardcoded** common system voices; cloned voices are only available through `dsh-minimax-voice`.
- **Prose comes from the event stream.** A message whose events are not in the current stream (older paged-out history, for example) will not be read; the tooltip says the text is not cached yet.
- **Browser autoplay policy.** The first playback needs a prior user interaction on the page; if blocked, the failure shows in the tooltip.
- **Single playback, no queue.** Replies are not chained.
- **Truncated at 8000 characters** (MiniMax accepts 10000 per call).
- **The replay cache is memory only.** After a page reload, replaying the same message synthesizes again and bills again.

## Development

```
dsh-read-aloud/
├── client.js            # all logic: slots, event subscription, synthesis, playback
├── index.js             # host placeholder, declares the plugin
├── cordis.patch.yml     # inserts the read-aloud row
├── package.json
├── icon.svg
├── README.md
├── README.zh-CN.md
├── CHANGELOG.md
└── LICENSE
```

A `file:` install is a **copy**, not a symlink: editing the checkout does not update an installed profile. Reinstall, or overwrite `node_modules/dsh-read-aloud/` and refresh.

## License

[MIT](LICENSE)
