/**
 * Host half of dsh-read-aloud.
 *
 * The browser client only ever talks to this file's `/read-aloud/api/*`
 * routes. Behind them there are two backends, resolved per request:
 *
 *  1. The `minimaxVoice` Cordis service, when `dsh-minimax-voice` is installed.
 *     Calling the service directly is what makes this reliable: that plugin's
 *     own HTTP surface runs requests through the DSH `connection` trust check,
 *     which answers 403/401 to plain browser fetches. The service needs no
 *     transport at all, and still owns the key, the voices and the billing.
 *  2. A direct MiniMax call, when the service is absent. Key priority:
 *     `config.apiKey` -> `MINIMAX_API_KEY` env -> saved `secret.json`.
 *
 * In both cases the produced mp3 is copied into this plugin's own output
 * directory, so one stable URL serves it.
 */
import { join, dirname, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'

export const name = 'read-aloud'

const ROUTE_PREFIX = '/read-aloud/api'
/** MiniMax international first, mainland fallback — both verified reachable. */
const API_HOSTS = ['https://api.minimaxi.com', 'https://api.minimax.chat']
const MAX_CHARS = 8000
const DEFAULT_MODEL = 'speech-2.8-hd'
const DEFAULT_VOICE = 'female-shaonv'

/* ----------------------------------------------------------------- helpers */

function defaultDataDir() {
  const profile = process.env.DSH_PROFILE_DIR
  if (profile) return join(profile, 'read-aloud')
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'read-aloud')
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(file, value) {
  const tmp = join(tmpdir(), `dsh-mar-${randomBytes(4).toString('hex')}.tmp`)
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function mimeOf(file) {
  if (file.endsWith('.mp3')) return 'audio/mpeg'
  if (file.endsWith('.wav')) return 'audio/wav'
  return 'application/octet-stream'
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/* ------------------------------------------------------------------ bridge */

function createBridge(ctx, config) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir ? config.dataDir : defaultDataDir()
  const outputDir = join(dataDir, 'output')
  const secretFile = join(dataDir, 'secret.json')

  /** The dsh-minimax-voice service, when that plugin is mounted. */
  function voiceService() {
    try {
      const service = ctx.get('minimaxVoice')
      if (service && typeof service.synthesize === 'function') return service
    } catch {
      /* service not mounted in this composition */
    }
    return undefined
  }

  async function resolveApiKey() {
    if (typeof config.apiKey === 'string' && config.apiKey.trim()) {
      return { key: config.apiKey.trim(), source: 'config' }
    }
    const env = process.env.MINIMAX_API_KEY
    if (env && env.trim()) return { key: env.trim(), source: 'env' }
    const secret = await readJson(secretFile, null)
    if (secret && typeof secret.apiKey === 'string' && secret.apiKey.trim()) {
      return { key: secret.apiKey.trim(), source: 'file' }
    }
    return { key: '', source: null }
  }

  function num(value, fallback, min, max) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
  }

  function normalize(args) {
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) throw new Error('text 不能为空')
    if (text.length > MAX_CHARS) throw new Error(`text 超过 ${MAX_CHARS} 字符`)
    return {
      text,
      voiceId: typeof args.voiceId === 'string' && args.voiceId ? args.voiceId : DEFAULT_VOICE,
      model: typeof args.model === 'string' && args.model ? args.model : DEFAULT_MODEL,
      speed: num(args.speed, 1, 0.5, 2),
    }
  }

  /** Copy a service-produced file into our own output directory. */
  async function adopt(sourcePath) {
    const file = `tts-${stamp()}-${randomBytes(3).toString('hex')}.mp3`
    await fsp.mkdir(outputDir, { recursive: true })
    await fsp.copyFile(sourcePath, join(outputDir, file))
    return join(outputDir, file)
  }

  async function synthesizeViaService(service, args) {
    const { text, voiceId, model, speed } = normalize(args)
    const result = await service.synthesize({ text, voiceId, model, speed })
    const source = result && result.path
    if (typeof source !== 'string' || !source) throw new Error('语音服务没有返回音频路径')
    const target = await adopt(source)
    return {
      path: target,
      file: basename(target),
      durationMs: (result && result.durationMs) ?? null,
      characters: (result && result.characters) ?? text.length,
      voiceId: (result && result.voiceId) || voiceId,
      backend: 'voice-service',
    }
  }

  async function synthesizeDirect(args) {
    const { text, voiceId, model, speed } = normalize(args)
    const { key } = await resolveApiKey()
    if (!key) {
      throw new Error('还没有配置 MiniMax API Key：安装 dsh-minimax-voice，或在「MiniMax 自动朗读」设置里填写')
    }

    const body = {
      model,
      text,
      stream: false,
      voice_setting: { voice_id: voiceId, speed, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
    }

    let lastError = ''
    for (const host of API_HOSTS) {
      let payload
      try {
        const response = await fetch(`${host}/v1/t2a_v2`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        })
        const raw = await response.text()
        if (!response.ok) {
          lastError = `HTTP ${response.status} ${raw.slice(0, 180)}`
          continue
        }
        payload = JSON.parse(raw)
      } catch (error) {
        lastError = error && error.message ? error.message : String(error)
        continue
      }
      const code = payload && payload.base_resp && payload.base_resp.status_code
      if (code !== 0) {
        lastError = (payload.base_resp && payload.base_resp.status_msg) || `status_code ${code}`
        continue
      }
      const hex = payload && payload.data && payload.data.audio
      if (typeof hex !== 'string' || hex.length < 2) {
        lastError = '响应里没有音频数据'
        continue
      }
      const bytes = Buffer.alloc(hex.length / 2)
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      const file = `tts-${stamp()}-${randomBytes(3).toString('hex')}.mp3`
      await fsp.mkdir(outputDir, { recursive: true })
      await fsp.writeFile(join(outputDir, file), bytes)
      return {
        path: join(outputDir, file),
        file,
        durationMs: (payload.extra_info && payload.extra_info.audio_length) || null,
        characters: text.length,
        voiceId,
        backend: 'direct',
      }
    }
    throw new Error(`MiniMax 合成失败：${lastError}`)
  }

  async function synthesize(args) {
    const service = voiceService()
    if (service) return synthesizeViaService(service, args)
    return synthesizeDirect(args)
  }

  async function status() {
    const service = voiceService()
    if (service) {
      let detail = null
      try {
        detail = typeof service.status === 'function' ? await service.status() : null
      } catch {
        /* status is best effort */
      }
      return {
        configured: detail && detail.configured === false ? false : true,
        backend: 'voice-service',
        keySource: detail && detail.keySource ? detail.keySource : null,
        dataDir,
      }
    }
    const { key, source } = await resolveApiKey()
    return { configured: Boolean(key), backend: key ? 'direct' : 'none', keySource: source, dataDir }
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.startsWith(ROUTE_PREFIX)
      ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
      : url.pathname
    const method = req.method || 'GET'

    try {
      if (method === 'GET' && path === '/status') {
        sendJson(res, 200, await status())
        return
      }

      if (method === 'POST' && path === '/key') {
        const parsed = JSON.parse((await readBody(req)) || '{}')
        const key = typeof parsed.key === 'string' ? parsed.key.trim() : ''
        if (!key) {
          sendJson(res, 400, { error: 'key 不能为空' })
          return
        }
        await writeJson(secretFile, { apiKey: key })
        sendJson(res, 200, { configured: true, keySource: 'file' })
        return
      }

      if (method === 'POST' && path === '/tts') {
        const args = JSON.parse((await readBody(req)) || '{}')
        sendJson(res, 200, await synthesize(args))
        return
      }

      if (method === 'GET' && path.startsWith('/output/')) {
        const file = basename(path.slice('/output/'.length))
        if (!/^[a-zA-Z0-9._-]+$/.test(file)) {
          sendJson(res, 400, { error: '非法文件名' })
          return
        }
        const bytes = await fsp.readFile(join(outputDir, file))
        res.writeHead(200, { 'content-type': mimeOf(file), 'content-length': String(bytes.length) })
        res.end(bytes)
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
    }
  }

  return { handleHttp, dataDir }
}

/* ------------------------------------------------------------------- apply */

export function apply(ctx, config = {}) {
  const bridge = createBridge(ctx, config)

  let routeRegistered = false
  const claimRoute = (webServer) => {
    if (routeRegistered || !webServer) return
    routeRegistered = true
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => void bridge.handleHttp(req, res) }),
      'read-aloud: http route',
    )
  }

  claimRoute(ctx.get('webServer'))
  if (!routeRegistered) {
    ctx.on('internal/service', (serviceName, value) => {
      if (serviceName === 'webServer' && value) claimRoute(value)
    })
  }

  try {
    ctx.logger.info('read-aloud ready: bridge at %s, data at %s', ROUTE_PREFIX, bridge.dataDir)
  } catch {
    /* logger unavailable in this composition */
  }
}
