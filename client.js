/**
 * Read Assistant replies out loud with MiniMax voices.
 *
 * Two surfaces, one engine:
 *
 *  - A speaker button in each Assistant reply's action strip
 *    (`conversation.chat.assistant-actions`), so the button always belongs to the
 *    message you clicked: click to read, click while reading to stop, click again
 *    to read it once more.
 *  - An optional auto-read switch in Settings that speaks the end of each turn.
 *
 * Text comes from the Session's event stream: every durable `assistant/message`
 * is remembered under its message id, which is what the slot hands us. Messages
 * that predate the page load are not in that cache, so the button falls back to
 * the rendered bubble next to it.
 *
 * Synthesis is delegated to `dsh-minimax-voice` (`POST /mmvoice/api/tts`); the
 * key, the voice catalog and the billing stay owned by that plugin.
 */

window.__ModuleLoader__.load({
  id: 'dsh-minimax-autoread',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** HTTP surface owned by dsh-minimax-voice. */
    const API = '/mmvoice/api'
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

    function writeSettings(patch) {
      settings = { ...settings, ...patch }
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

          if (event.type === 'assistant/message') {
            const message = event.data && event.data.message
            if (!message) continue
            const id = typeof message.id === 'string' ? message.id : null
            const text = assistantText(message.content)
            if (id && text) this.texts.set(id, text)
            // A multi-step turn emits one message per step; keep only the newest
            // prose and speak it once, when the turn closes.
            if (live && text) {
              this.pendingId = id
              this.pendingText = text
            }
            continue
          }

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
        if (!text) {
          this.error = '这条消息的正文还没缓存到，刷新页面后再试'
          this.emit()
          return
        }
        void this.speak(text, messageId)
      }

      async speak(text, messageId) {
        this.stop()
        this.error = null
        const body = {
          text,
          model: settings.model,
          speed: typeof settings.speed === 'number' ? settings.speed : 1,
        }
        if (settings.voiceId) body.voiceId = settings.voiceId

        this.currentId = messageId
        this.playing = true
        this.emit()

        try {
          const response = await fetch(`${API}/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!response.ok) {
            const detail = await response.text().catch(() => '')
            throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`)
          }
          const payload = await response.json()
          const file = baseName(payload && payload.path)
          if (!file) throw new Error('没有返回音频路径')
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

      const label = state.playing ? '停止朗读' : '朗读这条回复'
      return h(
        'button',
        {
          type: 'button',
          style: {
            ...actionStyle,
            color: state.playing ? 'var(--dsw-alias-brand-primary)' : actionStyle.color,
          },
          title: state.error ? `${label}（上次失败：${state.error}）` : label,
          'aria-label': label,
          'aria-pressed': state.playing,
          onClick,
        },
        state.playing ? '⏹' : '🔊',
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

    function Settings() {
      const current = useSettings()
      const [voiceId, setVoiceId] = useState(current.voiceId)
      const [testing, setTesting] = useState(false)
      const [notice, setNotice] = useState(null)
      const [error, setError] = useState(null)
      const audioRef = useRef(null)

      const save = useCallback((patch) => {
        writeSettings(patch)
      }, [])

      const preview = useCallback(async () => {
        setTesting(true)
        setError(null)
        setNotice(null)
        try {
          const response = await fetch(`${API}/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: '这是一段试听，用来确认自动朗读的音色和语速。',
              model: current.model,
              speed: current.speed,
              ...(current.voiceId ? { voiceId: current.voiceId } : {}),
            }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          const file = baseName(payload && payload.path)
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
          setNotice(`已合成 ${((payload.durationMs || 0) / 1000).toFixed(1)} 秒，计费 ${payload.characters || 0} 字符`)
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
            '助手回复下方的动作栏里有一个 🔊：点一次读这条，读的时候再点停止，停了再点重读。',
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
              placeholder: '音色 ID，例如 female-shaonv',
              onChange: (event) => setVoiceId(event.target.value),
              onBlur: () => save({ voiceId: voiceId.trim() }),
            }),
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
            '音色 ID 可以是 MiniMax 系统音色（如 female-shaonv、male-qn-qingse），也可以是你在「设置 → MiniMax 音色」里复刻出来的 voice_id。密钥和音色库都由那个插件管理。',
          ),
          notice ? h('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-success-primary)' } }, notice) : null,
          error ? h('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
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
