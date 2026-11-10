/**
 * Read Assistant replies out loud with MiniMax voices.
 *
 * Two surfaces, one engine:
 *
 *  - A speaker button in each Assistant reply's action strip
 *    (`conversation.chat.assistant-actions`): click to read, click while
 *    reading to stop, click again to replay.
 *  - An optional auto-read switch in Settings that speaks the end of each turn.
 *
 * Synthesis routes, probed automatically:
 *
 *  1. `dsh-minimax-voice` (`/mmvoice/api/tts`) when that plugin is installed —
 *     it owns the key, the cloned voices and the billing.
 *  2. Standalone mode (`/minimax-autoread/api/tts`) otherwise — the host half
 *     calls MiniMax directly with a key from settings / env / config.
 *
 * Text comes from the Session's event stream: every durable `assistant/message`
 * is remembered under its message id, which is what the slot hands us.
 * Replaying a message reuses the cached audio file instead of paying for a
 * second synthesis.
 */

window.__ModuleLoader__.load({
  id: 'dsh-minimax-autoread',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Host bridge of this plugin; the host picks the real synthesis backend. */
    const API = '/minimax-autoread/api'
    /** localStorage key for the browser-local preferences. */
    const STORE_KEY = 'dsh.minimax-autoread.settings'
    /** Characters sent per request; MiniMax accepts 10000, stay well below. */
    const MAX_CHARS = 8000

    const DEFAULT_SETTINGS = {
      enabled: true,
      voiceId: 'female-shaonv',
      model: 'speech-2.8-hd',
      speed: 1,
    }

    const MODELS = [
      'speech-2.8-hd',
      'speech-2.8-turbo',
      'speech-2.6-hd',
      'speech-2.6-turbo',
      'speech-02-hd',
      'speech-02-turbo',
      'speech-01-hd',
      'speech-01-turbo',
    ]

    /** Common MiniMax system voices, offered as suggestions only. */
    const VOICE_SUGGESTIONS = [
      'female-shaonv',
      'female-yujie',
      'female-chengshu',
      'female-tianmei',
      'male-qn-qingse',
      'male-qn-jingying',
      'male-qn-badao',
      'audiobook_male_2',
    ]

    /* ------------------------------------------------------------ preferences */

    function readSettings() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (!raw) return { ...DEFAULT_SETTINGS }
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
      } catch {
        return { ...DEFAULT_SETTINGS }
      }
    }

    let settings = readSettings()
    const settingsListeners = new Set()

    /** Synthesis inputs whose change invalidates the replay cache. */
    const SYNTH_KEYS = ['voiceId', 'model', 'speed']

    function writeSettings(patch) {
      const changedSynth = SYNTH_KEYS.some((key) => key in patch && patch[key] !== settings[key])
      settings = { ...settings, ...patch }
      if (changedSynth) replayCache.clear()
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(settings))
      } catch {
        /* private mode: keep the in-memory value */
      }
      for (const listener of [...settingsListeners]) listener(settings)
      return settings
    }

    function useSettings() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((n) => n + 1)
        settingsListeners.add(listener)
        return () => {
          settingsListeners.delete(listener)
        }
      }, [])
      return settings
    }

    /* ------------------------------------------------------------- routing */

    /**
     * Send one synthesis request to the host bridge. The host decides whether
     * that means the `minimaxVoice` service or a direct MiniMax call, so the
     * browser never needs to know — or authenticate against — either one.
     */
    async function synthesize(body) {
      const response = await fetch(`${API}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`)
      }
      return response.json()
    }

    /* -------------------------------------------------------------------- text */

    /** Join the visible prose of one finalized Assistant message. */
    function assistantText(content) {
      if (!Array.isArray(content)) return ''
      const pieces = []
      for (const block of content) {
        if (!block || block.type !== 'text') continue
        const text = typeof block.text === 'string' ? block.text.trim() : ''
        if (text) pieces.push(text)
      }
      return pieces.join('\n\n')
    }

    function clamp(text) {
      const value = typeof text === 'string' ? text.trim() : ''
      return value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS)}…` : value
    }

    /** File name of a host-side output path, whatever the separator. */
    function baseName(path) {
      const value = typeof path === 'string' ? path : ''
      const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
      return index >= 0 ? value.slice(index + 1) : value
    }

    /** messageId -> output file name, so replaying never re-bills. */
    const replayCache = new Map()

    /* ------------------------------------------------------------------- reader */

    class Reader {
      constructor(ctx, sessionId) {
        this.sessionId = sessionId
        /** message id -> prose captured from the event stream */
        this.texts = new Map()
        /** newest prose of the running turn, spoken when it closes */
        this.pendingId = null
        this.pendingText = ''
        /** message id currently being read, if any */
        this.currentId = null
        this.playing = false
        this.audio = null
        this.error = null
        this.disposed = false
        /** false until the first pump, so replayed history is cached but not spoken */
        this.synced = false
        this.listeners = new Set()
        this.dispose = undefined

        let binding
        try {
          binding = ctx.sessions.binding(sessionId)
        } catch {
          binding = undefined
        }
        if (!binding || !binding.eventSource) return

        this.dispose = binding.ctx.effect(() => {
          const stop = binding.eventSource.subscribe(() => this.pump(binding.eventSource))
          return () => {
            if (typeof stop === 'function') stop()
          }
        }, 'minimax-autoread: assistant messages')

        // Cache whatever history the store already holds, without speaking it.
        this.pump(binding.eventSource)
      }

      subscribe(listener) {
        this.listeners.add(listener)
        listener()
        return () => {
          this.listeners.delete(listener)
        }
      }

      emit() {
        for (const listener of [...this.listeners]) listener()
      }

      textFor(messageId) {
        if (typeof messageId !== 'string') return ''
        return this.texts.get(messageId) || ''
      }

      pump(source) {
        if (this.disposed) return
        let change
        try {
          change = (source.getSnapshot() || {}).change
        } catch {
          return
        }
        if (!change || !Array.isArray(change.entries)) return

        // Replayed history may also arrive as an append; only a change that lands
        // after this reader has synced counts as live.
        const live = this.synced && change.kind === 'append'
        this.synced = true

        for (const entry of change.entries) {
          const event = entry && entry.event
          if (!event) continue

          // Keep only the newest Assistant prose of the turn: a multi-step turn
          // emits one `assistant/message` per step, and reading every step out
          // loud would talk over the tool calls between them.
          if (event.type === 'assistant/message') {
            const message = event.data && event.data.message
            if (!message) continue
            const id = typeof message.id === 'string' ? message.id : null
            const text = assistantText(message.content)
            if (id && text) this.texts.set(id, text)
            if (live && text) {
              this.pendingId = id
              this.pendingText = text
            }
            continue
          }

          // Speak once, when the turn closes.
          if (live && event.type === 'turn/end') {
            const id = this.pendingId
            const text = this.pendingText
            this.pendingId = null
            this.pendingText = ''
            if (!text || !settings.enabled) continue
            if (this.currentId === id && this.playing) continue
            void this.speak(text, id)
          }
        }
      }

      /** Click behaviour: start, stop, or start again for one message. */
      toggle(messageId) {
        if (this.playing && this.currentId === messageId) {
          this.stop()
          return
        }
        const text = clamp(this.textFor(messageId))
        if (!text && !replayCache.has(messageId)) {
          this.error = '这条消息的正文还没缓存到，刷新页面后再试'
          this.emit()
          return
        }
        void this.speak(text, messageId)
      }

      async speak(text, messageId) {
        this.stop()
        this.error = null
        this.currentId = messageId
        this.playing = true
        this.emit()

        try {
          let file = replayCache.get(messageId)
          let characters = null
          let durationMs = null

          if (file) {
            // Replay: the audio for this exact message was already synthesized.
          } else {
            if (!text) throw new Error('没有可朗读的正文')
            const result = await synthesize({
              text,
              voiceId: settings.voiceId,
              model: settings.model,
              speed: typeof settings.speed === 'number' ? settings.speed : 1,
            })
            file = baseName(result.path) || result.file
          characters = result.characters
          durationMs = result.durationMs
          if (messageId && file) replayCache.set(messageId, file)
          }
          if (this.disposed) return

          const audio = new Audio(`${API}/output/${encodeURIComponent(file)}`)
          this.audio = audio
          audio.addEventListener('ended', () => this.finish(audio))
          audio.addEventListener('error', () => this.finish(audio))
          await audio.play()
        } catch (error) {
          this.error = error && error.message ? error.message : String(error)
          this.playing = false
          this.currentId = null
          this.emit()
        }
      }

      finish(audio) {
        if (this.audio !== audio) return
        this.audio = null
        this.playing = false
        this.currentId = null
        this.emit()
      }

      stop() {
        const audio = this.audio
        this.audio = null
        this.playing = false
        this.currentId = null
        if (audio) {
          try {
            audio.pause()
          } catch {
            /* already detached */
          }
        }
        this.emit()
      }

      dispose_() {
        this.disposed = true
        this.stop()
        if (typeof this.dispose === 'function') this.dispose()
        this.listeners.clear()
        this.texts.clear()
      }
    }

    /* -------------------------------------------------------------- components */

    const actionStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 26,
      height: 26,
      padding: 0,
      border: '1px solid transparent',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 13,
      lineHeight: '26px',
      cursor: 'pointer',
      verticalAlign: 'middle',
    }

    function ReadButton({ messageId, reader }) {
      const [state, setState] = useState({ playing: false, error: null })

      useEffect(() => {
        if (!reader) return undefined
        return reader.subscribe(() => {
          setState({
            playing: reader.playing && reader.currentId === messageId,
            error: reader.error,
          })
        })
      }, [reader, messageId])

      const onClick = useCallback(() => {
        reader.toggle(messageId)
      }, [reader, messageId])

      if (!reader) return null

      const label = state.error
        ? `朗读失败：${state.error}`
        : state.playing
          ? '停止朗读'
          : '朗读这条回复'
      return h(
        'button',
        {
          type: 'button',
          style: {
            ...actionStyle,
            color: state.error
              ? 'var(--dsw-alias-state-error-primary)'
              : state.playing
                ? 'var(--dsw-alias-brand-primary)'
                : actionStyle.color,
          },
          title: label,
          'aria-label': label,
          'aria-pressed': state.playing,
          onClick,
        },
        state.error ? '⚠️' : state.playing ? '⏹' : '🔊',
      )
    }

    const panelStyle = {
      padding: '4px 2px 40px',
      maxWidth: 760,
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      fontFamily: 'inherit',
    }
    const cardStyle = {
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      borderRadius: 10,
      padding: '14px 16px',
      marginBottom: 14,
    }
    const inputStyle = {
      flex: '0 1 220px',
      minWidth: 160,
      height: 30,
      padding: '0 10px',
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      fontSize: 13,
      outline: 'none',
    }
    const buttonStyle = {
      height: 30,
      padding: '0 14px',
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }
    const hintStyle = {
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)',
      lineHeight: 1.6,
      margin: '6px 0 0',
    }
    const rowStyle = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }

    const BACKEND_LABEL = {
      'voice-service': 'dsh-minimax-voice 服务（密钥与音色库由它管理）',
      direct: '独立模式：本插件直连 MiniMax',
      none: '未配置：安装 dsh-minimax-voice，或在下方填写 MiniMax API Key',
    }

    function Settings() {
      const current = useSettings()
      const [voiceId, setVoiceId] = useState(current.voiceId)
      const [apiKey, setApiKey] = useState('')
      const [status, setStatus] = useState(null)
      const [testing, setTesting] = useState(false)
      const [notice, setNotice] = useState(null)
      const [error, setError] = useState(null)
      const audioRef = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(`${API}/status`, { signal: AbortSignal.timeout(3000) })
          if (response.ok) {
            setStatus(await response.json())
            return
          }
          setStatus({ configured: false, backend: 'none', error: `HTTP ${response.status}` })
        } catch (failure) {
          setStatus({
            configured: false,
            backend: 'none',
            error: failure && failure.message ? failure.message : '宿主路由未就绪',
          })
        }
      }, [])

      useEffect(() => {
        void refresh()
      }, [refresh])

      const save = useCallback((patch) => {
        writeSettings(patch)
      }, [])

      const saveKey = useCallback(async () => {
        setNotice(null)
        setError(null)
        try {
          const response = await fetch(`${API}/key`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: apiKey.trim() }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
          setApiKey('')
          await refresh()
          setNotice('密钥已保存')
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        }
      }, [apiKey, refresh])

      const preview = useCallback(async () => {
        setTesting(true)
        setError(null)
        setNotice(null)
        try {
          const result = await synthesize({
            text: '这是一段试听，用来确认自动朗读的音色和语速。',
            voiceId: current.voiceId,
            model: current.model,
            speed: current.speed,
          })
          const file = baseName(result.path) || result.file
          if (!file) throw new Error('没有返回音频路径')
          if (audioRef.current) {
            try {
              audioRef.current.pause()
            } catch {
              /* ignore */
            }
          }
          const audio = new Audio(`${API}/output/${encodeURIComponent(file)}`)
          audioRef.current = audio
          await audio.play()
          setNotice(
            `已合成 ${((result.durationMs || 0) / 1000).toFixed(1)} 秒`
            + (result.characters ? `，计费 ${result.characters} 字符` : '')
            + (result.backend ? `（${result.backend === 'voice-service' ? 'dsh-minimax-voice 服务' : '独立模式'}）` : ''),
          )
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        } finally {
          setTesting(false)
        }
      }, [current.model, current.speed, current.voiceId])

      return h(
        'div',
        { style: panelStyle },
        h(
          'div',
          { style: cardStyle },
          h('div', { style: { fontSize: 13, fontWeight: 600, margin: '0 0 10px' } }, '朗读按钮'),
          h(
            'p',
            { style: { ...hintStyle, margin: 0 } },
            '助手回复下方的动作栏里有一个 🔊：点一次读这条，读的时候再点停止，停了再点重读（重读不重新计费）。',
          ),
          h(
            'label',
            { style: { ...rowStyle, marginTop: 10, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: current.enabled,
              onChange: (event) => save({ enabled: event.target.checked }),
            }),
            h('span', null, '另外，每轮结束自动朗读最后一段'),
          ),
        ),
        h(
          'div',
          { style: cardStyle },
          h('div', { style: { fontSize: 13, fontWeight: 600, margin: '0 0 10px' } }, '音色与参数'),
          h(
            'div',
            { style: rowStyle },
            h('input', {
              style: inputStyle,
              value: voiceId,
              list: 'minimax-autoread-voices',
              placeholder: '音色 ID，例如 female-shaonv',
              onChange: (event) => setVoiceId(event.target.value),
              onBlur: () => save({ voiceId: voiceId.trim() }),
            }),
            h(
              'datalist',
              { id: 'minimax-autoread-voices' },
              VOICE_SUGGESTIONS.map((voice) => h('option', { key: voice, value: voice })),
            ),
            h(
              'select',
              {
                style: inputStyle,
                value: current.model,
                onChange: (event) => save({ model: event.target.value }),
              },
              MODELS.map((model) => h('option', { key: model, value: model }, model)),
            ),
            h(
              'select',
              {
                style: { ...inputStyle, flex: '0 0 120px', minWidth: 100 },
                value: String(current.speed),
                onChange: (event) => save({ speed: Number(event.target.value) }),
              },
              [0.8, 0.9, 1, 1.1, 1.2, 1.5].map((speed) =>
                h('option', { key: speed, value: String(speed) }, `语速 ${speed}x`),
              ),
            ),
            h('button', { type: 'button', style: buttonStyle, onClick: preview, disabled: testing },
              testing ? '合成中…' : '试听'),
          ),
          h(
            'p',
            { style: hintStyle },
            `当前后端：${status === null ? '检测中…' : BACKEND_LABEL[status.backend] || status.backend}`
            + (status && status.keySource ? ` · Key 来源：${status.keySource}` : '')
            + (status && status.error ? ` · ${status.error}` : ''),
          ),
          notice ? h('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-success-primary)' } }, notice) : null,
          error ? h('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        ),
        h(
          'div',
          { style: cardStyle },
          h('div', { style: { fontSize: 13, fontWeight: 600, margin: '0 0 10px' } }, 'MiniMax API Key（独立模式）'),
          h(
            'div',
            { style: rowStyle },
            h('input', {
              style: { ...inputStyle, flex: '1 1 260px' },
              type: 'password',
              value: apiKey,
              placeholder: status && status.configured && status.backend === 'direct'
                ? '已配置（输入新值可覆盖）'
                : '粘贴 MiniMax API Key',
              onChange: (event) => setApiKey(event.target.value),
            }),
            h('button', { type: 'button', style: buttonStyle, onClick: saveKey, disabled: !apiKey.trim() }, '保存'),
          ),
          h(
            'p',
            { style: hintStyle },
            '只有没有安装 dsh-minimax-voice 时才需要在这里填 Key。优先级：插件配置 > 环境变量 MINIMAX_API_KEY > 此处保存（明文存于 ~/.dsh/minimax-autoread/secret.json）。',
          ),
        ),
      )
    }

    /* -------------------------------------------------------------------- plugin */

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      const readers = new Map()

      function readerFor(sessionId) {
        let reader = readers.get(sessionId)
        if (reader === undefined) {
          reader = new Reader(ctx, sessionId)
          readers.set(sessionId, reader)
        }
        return reader
      }

      ctx.effect(() => () => {
        for (const reader of readers.values()) reader.dispose_()
        readers.clear()
      }, 'minimax-autoread: readers')

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'minimax-autoread',
            order: 20,
            inject: (sessionId) => ({ reader: readerFor(sessionId) }),
          },
          ReadButton,
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'minimax-autoread',
            order: 41,
            label: 'MiniMax 自动朗读',
          },
          Settings,
        ),
      )
    }

    return { inject, apply }
  },
})
