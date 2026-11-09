/**
 * Host half of dsh-minimax-autoread.
 *
 * Primary path needs nothing from this file: the browser client talks to the
 * `dsh-minimax-voice` HTTP surface, which owns the key, the voices and the
 * billing.
 *
 * The host exists for the standalone fallback: when `dsh-minimax-voice` is not
 * installed, it registers `/minimax-autoread/api/*` on the Harness web server
 * and talks to MiniMax directly, using a key resolved as
 * `config.apiKey` -> `MINIMAX_API_KEY` env -> `secret.json` (saved from the
 * settings panel).
 */
import { join, dirname, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'

export const name = 'minimax-autoread'

const ROUTE_PREFIX = '/minimax-autoread/api'
/** MiniMax internation first, mainland fallback — both verified reachable. */
const API_HOSTS = ['https://api.minimaxi.com', 'https://api.minimax.chat']
const MAX_CHARS = 8000
const DEFAULT_MODEL = 'speech-2.8-hd'
const DEFAULT_VOICE = 'female-shaonv'

/* ----------------------------------------------------------------- helpers */

function defaultDataDir() {
  const profile = process.env.DSH_PROFILE_DIR
  if (profile) return join(profile, 'minimax-autoread')
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'minimax-autoread')
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

/* ----------------------------------------------------------- direct client */

function createDirect(ctx, config) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir ? config.dataDir : defaultDataDir()
  const outputDir = join(dataDir, 'output')
  const secretFile = join(dataDir, 'secret.json')

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

  async function synthesize(args) {
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) throw new Error('text 不能为空')
    if (text.length > MAX_CHARS) throw new Error(`text 超过 ${MAX_CHARS} 字符`)
    const { key } = await resolveApiKey()
    if (!key) throw new Error('还没有配置 MiniMax API Key：请在「MiniMax 自动朗读」设置里填写，或设置环境变量 MINIMAX_API_KEY')

    const body = {
      model: typeof args.model === 'string' && args.model ? args.model : DEFAULT_MODEL,
      text,
      stream: false,
      voice_setting: {
        voice_id: typeof args.voiceId === 'string' && args.voiceId ? args.voiceId : DEFAULT_VOICE,
        speed: num(args.speed, 1, 0.5, 2),
        vol: num(args.vol, 1, 0.01, 10),
        pitch: num(args.pitch, 0, -12, 12),
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
    }
    if (typeof args.emotion === 'string' && args.emotion) body.voice_setting.emotion = args.emotion

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
      const file = `tts-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.mp3`
      await fsp.mkdir(outputDir, { recursive: true })
      await fsp.writeFile(join(outputDir, file), bytes)
      return {
        path: join(outputDir, file),
        file,
        durationMs: (payload.extra_info && payload.extra_info.audio_length) || null,
        characters: text.length,
      }
    }
    throw new Error(`MiniMax 合成失败：${lastError}`)
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.startsWith(ROUTE_PREFIX)
      ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
      : url.pathname
    const method = req.method || 'GET'

    try {
      if (method === 'GET' && path === '/status') {
        const { source } = await resolveApiKey()
        sendJson(res, 200, { configured: Boolean(source), keySource: source, mode: 'direct', dataDir })
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
  const direct = createDirect(ctx, config)

  let routeRegistered = false
  const claimRoute = (webServer) => {
    if (routeRegistered || !webServer) return
    routeRegistered = true
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => void direct.handleHttp(req, res) }),
      'minimax-autoread: http route',
    )
  }

  claimRoute(ctx.get('webServer'))
  if (!routeRegistered) {
    ctx.on('internal/service', (serviceName, value) => {
      if (serviceName === 'webServer' && value) claimRoute(value)
    })
  }

  try {
    ctx.logger.info('minimax-autoread ready: standalone fallback at %s, data at %s', ROUTE_PREFIX, direct.dataDir)
  } catch {
    /* logger unavailable in this composition */
  }
}
