# dsh-minimax-autoread

**用 MiniMax 的声音朗读 DeepSeek Harness 的回复。** 每条助手回复的动作栏里多一个喇叭按钮，另外可以选择每轮结束自动朗读。

> 社区插件，不是 DeepSeek 或 MiniMax 官方产品。

[English](README.md) | 简体中文

-----

## 它补的是哪一块

DeepSeek Harness 本身**没有**语音合成能力——组件文档写得很清楚："不提供…语音合成"。社区里的 [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice) 提供了 MiniMax 的复刻/合成/转写，但它的播放入口是**工具调用和设置面板**，没有"点一下这条回复就读出来"。

本插件就补这一层：把消息动作栏的按钮接到 `dsh-minimax-voice` 已经暴露的合成接口上。**密钥、音色库、计费全部留在那个插件里**，这边一行 MiniMax 代码都没有。

## 功能

- **每条回复一个喇叭按钮**，位置在复制 / 分叉 / 👍👎 同一排：
  点一次 = 读这条，读的时候点 = 停，停了再点 = 重读。
- **一轮只读一次**。多步工具调用会产生多条助手消息，逐条念会插嘴，所以只取本轮最后一段正文，在轮次结束时开口。
- **自动朗读（可选）**。设置里勾选后，每轮结束自动读最后一段。
- **历史消息也能读**。页面加载时先把事件流里已有的正文静默缓存，但不发声。
- **单例播放**。点另一条的按钮会先停掉正在播的那条。
- **音色可配**。MiniMax 系统音色或你在 `dsh-minimax-voice` 里复刻的 `voice_id`，模型与语速也可调，带试听。

## 前置条件

必须先装好并启用 [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice)，并在它的 **设置 → MiniMax 音色** 里填好 API Key。

本插件通过它暴露的本地 HTTP 接口工作：

```
POST /mmvoice/api/tts      { text, voiceId, model, speed }  ->  { path, durationMs, characters }
GET  /mmvoice/api/output/:file                               ->  mp3
```

没有 `dsh-minimax-voice` 时，按钮会报错而不是静默失败。

## 安装

```bash
dsh plugin --profile desktop add dsh-minimax-autoread --registry=https://registry.npmjs.org/
```

从 Gitee 源码装：

```bash
git clone https://gitee.com/shi_zhong_yu/dsh-minimax-autoread.git
dsh plugin --profile desktop add ./dsh-minimax-autoread
```

从本地源码装：

```bash
dsh plugin --profile desktop add /绝对路径/dsh-minimax-autoread
```

装完**刷新页面**。客户端插件在页面加载时挂载。

## 使用

1. 鼠标移到任意一条助手回复底部，动作栏里会出现 **🔊**。
2. 点它读这条；读的时候图标变成 **⏹**，点一下停；再点一次重新读。
3. 设置页右侧会多一栏 **MiniMax 自动朗读**：可以勾"每轮结束自动朗读最后一段"，改音色 ID、模型、语速，点**试听**确认效果。

## 设置项

存在浏览器的 `localStorage`，键名 `dsh.minimax-autoread.settings`。没有轮询、没有上报，也不写宿主配置。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 每轮结束是否自动朗读最后一段 |
| `voiceId` | `female-shaonv` | MiniMax 音色 ID，系统音色或复刻音色 |
| `model` | `speech-2.8-hd` | 合成模型，可选 2.8/2.6/02/01 的 hd 与 turbo |
| `speed` | `1` | 语速 0.8–1.5 |

## 工作原理

```text
   ┌──────────────────────────── 浏览器 ────────────────────────────┐
   │                                                                │
   │  会话事件流 binding.eventSource                                 │
   │        │                                                       │
   │        ├── assistant/message ──▶ texts.set(message.id, 正文)     │
   │        │                                                       │
   │        └── turn/end ──▶ 若开了自动朗读 ──▶ speak(pending)        │
   │                                                                │
   │  槽 conversation.chat.assistant-actions ──▶ [🔊 按钮]            │
   │        └── 点击 ──▶ toggle(messageId)                           │
   │                        │                                       │
   │                        ▼                                       │
   │              POST /mmvoice/api/tts ──▶ { path }                 │
   │                        │                                       │
   │                        ▼                                       │
   │              new Audio('/mmvoice/api/output/<file>')            │
   └────────────────────────────────────────────────────────────────┘
```

几个关键决定：

- **宿主半边是空的。** `index.js` 只声明插件，没有任何逻辑。全部工作在浏览器里完成，所以不存在"宿主发不出声音"的问题。
- **正文按 `messageId` 缓存。** 动作栏槽只给 `messageId`，不给文本，所以按钮必须自己知道"这条消息说了什么"。订阅事件流是唯一可靠的来源。
- **回放不等于朗读。** 页面加载会重放历史事件；第一次 `pump` 时 `synced` 还是 `false`，只填缓存不出声，避免刚刷新就自己念起来。
- **不做 DOM 兜底。** 取不到正文时按钮只报错。我最初写过"就近抓气泡文本"的兜底，后来发现 `data-message-bubble` 标的是**用户消息**气泡——那个兜底会把你自己说的话读出来，比不读更糟。
- **只读 `text` 块。** reasoning、代码块、工具调用都不念，避免把 JSON 参数读成正文。

## 兼容性

- 在 **DSH `0.2.2-rc.1`**（桌面版）上开发与验证。
- `engines.dsh` 声明为 `>=0.2.2-rc.1 <0.3.0-0`。
- 只依赖 Web 外壳提供的共享模块 `react` 与 `@deepseek-ai/dsh-client-ui-slots`，不引入任何自带的客户端依赖。
- 用到的槽：`conversation.chat.assistant-actions`、`settings.section`。这两个槽若在后续版本改名，插件会静默不显示按钮——届时需要跟着改。

## 已知限制

- **强依赖 `dsh-minimax-voice`** 的路由与响应结构。对方改接口就要跟着改。
- **正文来自事件流**。若某条消息的事件不在当前会话的事件流里（例如更早的、未加载的分页历史），按钮不会乱读，只在 tooltip 里显示"正文还没缓存到"。
- **浏览器自动播放策略**。首次播放需要页面已有一次用户交互；如果被拦截，标题栏会显示失败原因。
- **单条播放，无队列**。不排队、不连播多条回复。
- **超长截断** 8000 字符（MiniMax 单次上限 10000），超出部分不读。

## 开发

```
dsh-minimax-autoread/
├── client.js            # 全部逻辑：槽注册、事件订阅、合成与播放
├── index.js             # 宿主占位，仅声明插件
├── cordis.patch.yml     # 插入 minimax-autoread 行
├── package.json
├── icon.svg
├── README.md
├── README.zh-CN.md
├── CHANGELOG.md
└── LICENSE
```

改完要重新同步：用 `file:` 安装时 pnpm 是**拷贝**而不是软链，改源码不会自动生效。删掉重装，或直接覆盖 `node_modules/dsh-minimax-autoread/` 下的文件后刷新页面。

## License

[MIT](LICENSE)
