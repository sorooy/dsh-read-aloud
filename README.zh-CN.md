# dsh-minimax-autoread

**用 MiniMax 的声音朗读 DeepSeek Harness 的回复。** 每条助手回复的动作栏里多一个喇叭按钮，另外可以选择每轮结束自动朗读。

> 社区插件，不是 DeepSeek 或 MiniMax 官方产品。

[English](README.md) | 简体中文

-----

## 它补的是哪一块

DeepSeek Harness 本身**没有**语音合成能力——组件文档写得很清楚："不提供…语音合成"。社区里的 [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice) 提供了 MiniMax 的复刻/合成/转写，但它的播放入口是**工具调用和设置面板**，没有"点一下这条回复就读出来"。

本插件补的正是这一层：把消息动作栏的按钮接到现成的合成能力上。装了 [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice) 就复用它的密钥、音色库与计费；没装时插件自带的独立模式直连 MiniMax，填一个 Key 就能跑。

## 功能

- **每条回复一个喇叭按钮**，位置在复制 / 分叉 / 👍👎 同一排：
  点一次 = 读这条，读的时候点 = 停，停了再点 = 重读（重读不重复计费）。
- **双后端自动路由**：优先 `dsh-minimax-voice`，缺席时切独立模式直连 MiniMax。
- **一轮只读一次**。多步工具调用会产生多条助手消息，逐条念会插嘴，所以只取本轮最后一段正文，在轮次结束时开口。
- **自动朗读（可选）**。设置里勾选后，每轮结束自动读最后一段。
- **历史消息也能读**。页面加载时先把事件流里已有的正文静默缓存，但不发声。
- **单例播放**。点另一条的按钮会先停掉正在播的那条。
- **音色可配**。MiniMax 系统音色或你在 `dsh-minimax-voice` 里复刻的 `voice_id`，模型与语速也可调，带试听。

## 前置条件

二选一：

- **推荐**：安装并启用 [`dsh-minimax-voice`](https://www.npmjs.com/package/dsh-minimax-voice)，在它的 **设置 → MiniMax 音色** 里填好 API Key。密钥、复刻音色库、计费全由它管理，本插件只调用它的本地接口：

  ```
  POST /mmvoice/api/tts      { text, voiceId, model, speed }  ->  { path, durationMs, characters }
  GET  /mmvoice/api/output/:file                               ->  mp3
  ```

- **独立模式**：不装它也行。本插件宿主半边会在 Harness Web 服务的 `/minimax-autoread/api/*` 上注册自己的路由，直连 MiniMax。Key 的优先级：

  1. 插件配置里的 `config.apiKey`
  2. 环境变量 `MINIMAX_API_KEY`（设置后需重启 Harness）
  3. 设置面板「MiniMax API Key（独立模式）」里保存（**明文**存于 `~/.dsh/minimax-autoread/secret.json`）

  ```
  POST /minimax-autoread/api/key    { key }                          ->  { configured }
  POST /minimax-autoread/api/tts    { text, voiceId, model, speed }  ->  { path, file, durationMs, characters }
  GET  /minimax-autoread/api/output/:file                            ->  mp3
  ```

两个后端都没有时，按钮会明确报错，不会静默失败。客户端启动时自动探测，优先走 `dsh-minimax-voice`。

## 安装

目前**只提供源码安装**，npm 上还没有发布（`dsh plugin add` 的 npm 形式现在跑不通）。

```bash
git clone https://gitee.com/op00007/dsh-minimax-autoread.git
dsh plugin --profile desktop add ./dsh-minimax-autoread
```

已经有一份本地副本：

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

设置面板还会显示当前后端与 Key 来源。另外有一项**不落盘**的行为：每条消息合成后的音频按 `messageId` 缓存在内存里，同一条消息重听直接播放缓存，不再向 MiniMax 重复计费；更换音色 / 模型 / 语速会使缓存失效。

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

- **宿主半边只做兜底。** 装了 `dsh-minimax-voice` 时，`index.js` 注册的路由完全闲置，全部流量走对方的 `/mmvoice/api`；只有它缺席时独立模式才接管。
- **正文按 `messageId` 缓存。** 动作栏槽只给 `messageId`，不给文本，所以按钮必须自己知道"这条消息说了什么"。订阅事件流是唯一可靠的来源。
- **回放不等于朗读。** 页面加载会重放历史事件；第一次 `pump` 时 `synced` 还是 `false`，只填缓存不出声，避免刚刷新就自己念起来。
- **重读免费。** 音频文件按 `messageId` 缓存在内存，第二次点击不再发起合成请求——MiniMax 按字符计费，重复合成就是重复扣钱。
- **不做 DOM 兜底。** 取不到正文时按钮只报错。我最初写过"就近抓气泡文本"的兜底，后来发现 `data-message-bubble` 标的是**用户消息**气泡——那个兜底会把你自己说的话读出来，比不读更糟。
- **只读 `text` 块。** reasoning、代码块、工具调用都不念，避免把 JSON 参数读成正文。

## 兼容性

- 在 **DSH `0.2.2-rc.1`**（桌面版）上开发与验证。
- `engines.dsh` 声明为 `>=0.2.2-rc.1 <0.3.0-0`。
- 只依赖 Web 外壳提供的共享模块 `react` 与 `@deepseek-ai/dsh-client-ui-slots`，不引入任何自带的客户端依赖。
- 用到的槽：`conversation.chat.assistant-actions`、`settings.section`。这两个槽若在后续版本改名，插件会静默不显示按钮——届时需要跟着改。

## 已知限制

- **独立模式的音色建议是硬编码的**常见系统音色；复刻音色只在 `dsh-minimax-voice` 模式下可用（它的面板里有完整音色库）。
- **正文来自事件流**。若某条消息的事件不在当前会话的事件流里（例如更早的、未加载的分页历史），按钮不会乱读，只在 tooltip 里显示"正文还没缓存到"。
- **浏览器自动播放策略**。首次播放需要页面已有一次用户交互；如果被拦截，标题栏会显示失败原因。
- **单条播放，无队列**。不排队、不连播多条回复。
- **超长截断** 8000 字符（MiniMax 单次上限 10000），超出部分不读。
- **重读缓存只在内存**。刷新页面后再次点击同一消息会重新合成、重新计费。

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
