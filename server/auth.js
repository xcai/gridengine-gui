import { randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router } from 'express'
import { z } from 'zod'

const scrypt = promisify(deriveKey)
export const authFile = () => path.resolve(process.env.AUTH_FILE || fileURLToPath(new URL('../private/auth.json', import.meta.url)))
const usernameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/)
const passwordSchema = z.string().min(12).max(128)
const accountSchema = z.object({ username: usernameSchema, role: z.enum(['admin', 'user']), disabled: z.boolean() })
export const publicAccount = ({ username, role, disabled }) => ({ username, role, disabled })

export async function readAccounts(file = authFile()) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export async function changeAccount(action, username, changes = {}, file = authFile()) {
  usernameSchema.parse(username)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  await mkdir(lock)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const accounts = await readAccounts(file)
    const existing = accounts.find(account => account.username === username)
    if (!['create', 'update', 'delete'].includes(action)) throw new Error('Invalid account action')
    if (action === 'create' && existing) throw new Error('Account already exists')
    if (action !== 'create' && !existing) throw new Error('Account not found')
    let updated
    if (action !== 'delete') {
      const values = accountSchema.parse({ username, role: existing?.role || 'user', disabled: existing?.disabled || false, ...changes })
      updated = { ...existing, ...values, version: randomUUID() }
      if (changes.password !== undefined || !existing) {
        const password = passwordSchema.parse(changes.password)
        const salt = randomBytes(16).toString('hex')
        updated.passwordHash = `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`
      }
    }
    const next = accounts.filter(account => account.username !== username)
    if (updated) next.push(updated)
    if (!next.some(account => account.role === 'admin' && !account.disabled)) throw new Error('At least one enabled administrator is required')
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
    return updated ? publicAccount(updated) : { deleted: username }
  } finally {
    await rm(temporary, { force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

const dummySalt = randomBytes(16).toString('hex')
export async function verifyPassword(account, password) {
  const [salt, encoded] = account?.passwordHash?.split(':') || [dummySalt, '00'.repeat(64)]
  const actual = await scrypt(password, salt, 64)
  const expected = Buffer.from(encoded, 'hex')
  return expected.length === actual.length && timingSafeEqual(actual, expected) && Boolean(account) && !account.disabled
}

export function createAuth({ file = authFile(), now = Date.now, sessionTtl = 8 * 60 * 60 * 1000 } = {}) {
  const router = Router()
  const sessions = new Map()
  const attempts = new Map()
  const secure = process.env.COOKIE_SECURE === 'true'
  const cookieName = secure ? '__Host-ge_session' : 'ge_session'
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure, path: '/' }
  const digest = token => createHash('sha256').update(token).digest('hex')
  const tokenOf = request => request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  const expire = () => {
    for (const [key, session] of sessions) if (session.expires <= now()) sessions.delete(key)
    for (const [key, attempt] of attempts) if (attempt.expires <= now()) attempts.delete(key)
  }
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (request.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || request.get('Sec-Fetch-Site') === 'cross-site')) return response.status(403).json({ error: '请求来源或格式不合法' })
    next()
  })
  router.post('/auth/login', async (request, response) => {
    expire()
    const key = request.ip
    const attempt = attempts.get(key) || { count: 0, expires: now() + 15 * 60 * 1000 }
    if (attempt.count >= 10 || (!attempts.has(key) && attempts.size >= 10000)) return response.set('Retry-After', '900').status(429).json({ error: '登录尝试过多，请稍后重试' })
    attempt.count++
    attempts.set(key, attempt)
    const parsed = z.object({ username: usernameSchema, password: z.string().min(1).max(128) }).safeParse(request.body)
    if (!parsed.success) return response.status(401).json({ error: '账号或密码错误' })
    const account = (await readAccounts(file)).find(item => item.username === parsed.data.username)
    if (!await verifyPassword(account, parsed.data.password)) return response.status(401).json({ error: '账号或密码错误' })
    if (sessions.size >= 10000) return response.status(503).json({ error: '会话数量已达上限' })
    const previous = tokenOf(request)
    if (previous) sessions.delete(digest(previous))
    const token = randomBytes(32).toString('hex')
    sessions.set(digest(token), { username: account.username, version: account.version, expires: now() + sessionTtl })
    attempts.delete(key)
    response.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionTtl }).json({ user: publicAccount(account) })
  })
  router.post('/auth/logout', (request, response) => {
    const token = tokenOf(request)
    if (token) sessions.delete(digest(token))
    response.clearCookie(cookieName, cookieOptions).json({ success: true })
  })
  router.use(async (request, response, next) => {
    expire()
    const token = tokenOf(request)
    const key = token ? digest(token) : null
    const session = sessions.get(key)
    const account = session && (await readAccounts(file)).find(item => item.username === session.username && item.version === session.version && !item.disabled)
    if (!account) {
      sessions.delete(key)
      return response.status(401).json({ error: '请先登录', code: 'UNAUTHENTICATED' })
    }
    request.account = publicAccount(account)
    next()
  })
  router.get('/auth/me', (request, response) => response.json({ user: request.account }))
  router.use((request, response, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.account.role !== 'admin') return response.status(403).json({ error: '仅管理员可执行此操作' })
    next()
  })
  return router
}