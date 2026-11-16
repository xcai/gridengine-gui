import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { spawn } from 'node:child_process'
import { changeAccount, createAuth, readAccounts, verifyPassword } from '../server/auth.js'

test('administrator CLI supports create, list, get, update and delete without exposing credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ge-cli-'))
  const file = path.join(directory, 'accounts.json')
  const run = (args, password = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/users.js', ...args], { env: { ...process.env, AUTH_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, output, errors }))
    child.stdin.end(password)
  })
  try {
    assert.equal((await run(['create', 'admin', '--role', 'admin', '--password-stdin'], 'test-cli-password\n')).code, 0)
    assert.equal((await run(['create', 'reader', '--password-stdin'], 'test-cli-password\n')).code, 0)
    const listed = await run(['list'])
    assert.equal(JSON.parse(listed.output).length, 2)
    assert.equal(listed.output.includes('password'), false)
    assert.equal((await run(['update', 'reader', '--disabled', 'true', '--password-stdin'], 'new-cli-password\n')).code, 0)
    const found = await run(['get', 'reader'])
    assert.equal(JSON.parse(found.output).disabled, true)
    assert.equal((await run(['delete', 'admin'])).code, 1)
    assert.equal((await run(['delete', 'reader'])).code, 0)
    assert.equal((await run(['get', 'reader'])).code, 1)
    assert.equal((await run(['update', 'admin', '--disabled', 'invalid'])).code, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('account CRUD, password hashing, safe output and last admin guard', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ge-auth-'))
  const file = path.join(directory, 'accounts.json')
  try {
    await assert.rejects(changeAccount('create', 'reader', { password: 'a-long-password' }, file), /administrator/)
    const admin = await changeAccount('create', 'admin', { role: 'admin', password: 'a-long-password' }, file)
    assert.deepEqual(admin, { username: 'admin', role: 'admin', disabled: false })
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await readFile(file, 'utf8')).includes('a-long-password'), false)
    const [account] = await readAccounts(file)
    assert.equal(await verifyPassword(account, 'a-long-password'), true)
    assert.equal(await verifyPassword(account, 'incorrect'), false)
    assert.equal(await verifyPassword(undefined, 'a-long-password'), false)
    await assert.rejects(changeAccount('update', 'admin', { disabled: true }, file), /administrator/)
    await assert.rejects(changeAccount('delete', 'admin', {}, file), /administrator/)
    await assert.rejects(changeAccount('create', 'admin', { password: 'a-long-password' }, file), /exists/)
    await assert.rejects(changeAccount('create', 'reader', { password: 'short' }, file))
    await changeAccount('create', 'reader', { password: 'reader-password' }, file)
    await changeAccount('update', 'reader', { password: 'changed-password', disabled: true }, file)
    const reader = (await readAccounts(file)).find(item => item.username === 'reader')
    assert.equal(await verifyPassword(reader, 'changed-password'), false)
    await changeAccount('delete', 'reader', {}, file)
    assert.equal((await readAccounts(file)).length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('API authentication, authorization, CSRF, revocation, expiry and throttling', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ge-session-'))
  const file = path.join(directory, 'accounts.json')
  let time = Date.now()
  await changeAccount('create', 'admin', { role: 'admin', password: 'admin-password' }, file)
  await changeAccount('create', 'reader', { password: 'reader-password' }, file)
  const app = express()
  app.use(express.json())
  app.use('/api', createAuth({ file, now: () => time, sessionTtl: 1000 }))
  app.all('/api/state', (_request, response) => response.json({ ok: true }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const request = (endpoint, method = 'GET', body, cookie, extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/${endpoint}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const login = async (username, password) => {
    const response = await request('auth/login', 'POST', { username, password })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')
    assert.match(cookie, /HttpOnly/i)
    assert.match(cookie, /SameSite=Strict/i)
    assert.equal(JSON.stringify(await response.json()).includes('password'), false)
    return cookie.split(';')[0]
  }
  try {
    assert.equal((await request('state')).status, 401)
    assert.equal((await request('auth/login', 'POST', { username: 'admin', password: 'wrong' })).status, 401)
    let admin = await login('admin', 'admin-password')
    assert.equal((await request('state', 'POST', {}, admin)).status, 200)
    assert.equal((await request('state', 'POST', {}, admin, { 'Content-Type': 'text/plain' })).status, 403)
    assert.equal((await request('state', 'POST', {}, admin, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
    const reader = await login('reader', 'reader-password')
    assert.equal((await request('state', 'GET', null, reader)).status, 200)
    assert.equal((await request('state', 'POST', {}, reader)).status, 403)
    await changeAccount('update', 'reader', { disabled: true }, file)
    assert.equal((await request('state', 'GET', null, reader)).status, 401)
    await changeAccount('update', 'admin', { password: 'new-admin-password' }, file)
    assert.equal((await request('state', 'GET', null, admin)).status, 401)
    admin = await login('admin', 'new-admin-password')
    assert.equal((await request('auth/logout', 'POST', {}, admin)).status, 200)
    assert.equal((await request('state', 'GET', null, admin)).status, 401)
    admin = await login('admin', 'new-admin-password')
    time += 1001
    assert.equal((await request('auth/me', 'GET', null, admin)).status, 401)
    for (let attempt = 0; attempt < 10; attempt++) assert.equal((await request('auth/login', 'POST', { username: 'admin', password: 'wrong' })).status, 401)
    assert.equal((await request('auth/login', 'POST', { username: 'admin', password: 'wrong' })).status, 429)
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) }
})