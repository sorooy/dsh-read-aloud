# dsh-minimax-autoread

**Read DeepSeek Harness replies out loud with MiniMax voices.** A speaker button in every Assistant reply's action strip, plus an optional auto-read switch.

> A community plugin, not an official DeepSeek or MiniMax product.

English | [简体中文](README.zh-CN.md)

-----

## The gap it fills

DeepSeek Harness ships no speech synthesis at all. The community plugin [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice) brings MiniMax cloning, TTS and ASR — but its playback lives in agent tools and a settings panel, with no "click a reply and hear it".

This plugin is the thin layer that connects a message action button to the synthesis surface `dsh-minimax-voice` already exposes. **The key, the voice library and the billing stay in that plugin**; there is not a single line of MiniMax code here.

## Features

- **A speaker button per reply**, in the same strip as copy / fork / 👍👎:
  click to read that message, click while it plays to stop, click again to replay.
- **One reading per turn.** A multi-step turn emits one Assistant message per step; reading each would talk over the tool calls, so only the newest prose is kept and spoken when the turn closes.
- **Optional auto-read**: speak the end of every turn.
- **History works too**: the event stream is cached silently on page load, without speaking it.
- **Single playback**: starting another message stops the current one.
- **Configurable voice**: any MiniMax system voice or a cloned `voice_id`, plus model and speed, with a preview button.

## Requirements

Install and enable [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice) first, and put a MiniMax API key in its **Settings → MiniMax Voice** panel.

This plugin talks to its local HTTP surface:

```
POST /mmvoice/api/tts      { text, voiceId, model, speed }  ->  { path, durationMs, characters }
GET  /mmvoice/api/output/:file                               ->  mp3
```

Without that plugin the button reports an error instead of failing silently.

## Install

```bash
dsh plugin --profile desktop add dsh-minimax-autoread --registry=https://registry.npmjs.org/
```

From Gitee:

```bash
git clone https://gitee.com/op00007/dsh-minimax-autoread.git
dsh plugin --profile desktop add ./dsh-minimax-autoread
```

From a local checkout:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-minimax-autoread
```

Refresh the page afterwards — client plugins mount at page load.

## Usage

1. Hover any Assistant reply; a **🔊** appears in its action strip.
2. Click to read it. While playing the icon becomes **⏹**; click to stop, click again to replay.
3. **Settings → MiniMax Auto-read** holds the auto-read switch, the voice id, the model, the speed and a preview button.

## Settings

Stored in the browser's `localStorage` under `dsh.minimax-autoread.settings`. Nothing is polled, reported, or written into host configuration.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Speak the end of each turn |
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

- **The host half is empty.** `index.js` only declares the plugin; everything happens in the browser, so "the host cannot play audio" never becomes a problem.
- **Prose is cached by `messageId`.** The action slot hands over an id only, so the button has to learn what that message said. The event stream is the only reliable source.
- **Replay is not speech.** Page load replays history; the first pump runs with `synced` still `false`, so it fills the cache without talking.
- **No DOM fallback.** When the prose is missing the button reports it. An early version scraped the nearest `[data-message-bubble]` element — that attribute marks the *user* bubble, so the fallback would have read your own message back to you.
- **Only `text` blocks are spoken.** Reasoning, code and tool calls stay silent.

## Compatibility

- Developed and verified against **DSH `0.2.2-rc.1`** (desktop).
- `engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0`.
- Depends only on shared modules the web shell provides: `react` and `@deepseek-ai/dsh-client-ui-slots`.
- Uses the slots `conversation.chat.assistant-actions` and `settings.section`. If a later release renames them, the button silently disappears and this plugin needs updating.

## Known limitations

- **Hard dependency on `dsh-minimax-voice`** routes and response shape.
- **Prose comes from the event stream.** A message whose events are not in the current stream (older paged-out history, for example) will not be read; the tooltip says the text is not cached yet.
- **Browser autoplay policy.** The first playback needs a prior user interaction on the page; if blocked, the failure shows in the tooltip.
- **Single playback, no queue.** Replies are not chained.
- **Truncated at 8000 characters** (MiniMax accepts 10000 per call).

## Development

```
dsh-minimax-autoread/
├── client.js            # all logic: slots, event subscription, synthesis, playback
├── index.js             # host placeholder, declares the plugin
├── cordis.patch.yml     # inserts the minimax-autoread row
├── package.json
├── icon.svg
├── README.md
├── README.zh-CN.md
├── CHANGELOG.md
└── LICENSE
```

A `file:` install is a **copy**, not a symlink: editing the checkout does not update an installed profile. Reinstall, or overwrite `node_modules/dsh-minimax-autoread/` and refresh.

## License

[MIT](LICENSE)
