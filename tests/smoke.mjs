import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'

const directory = await mkdtemp(path.join(tmpdir(), 'gridengine-test-'))
const port = process.env.TEST_API_PORT || '3109'
const api = `http://127.0.0.1:${port}`
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5174'
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, API_PORT: port, DATA_FILE: path.join(directory, 'state.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
let browser
const request = async (endpoint, method = 'GET', body) => {
  const response = await fetch(`${api}/api/${endpoint}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, data: await response.json() }
}
try {
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(([code]) => { throw new Error(`Test API exited: ${code}`) }),
    new Promise((_, reject) => server.once('error', reject)),
  ])
  const initial = await request('state')
  assert.equal(initial.status, 200)
  assert.equal(initial.data.nodes.length, 24)
  assert.equal(initial.data.jobs.length, 156)
  assert.equal((await request('users', 'POST', { name: 'x' })).status, 400)
  assert.equal((await request('users/admin', 'DELETE')).status, 400)
  assert.equal((await request('queues/all.q', 'DELETE')).status, 409)
  assert.equal((await request('clusters/production', 'DELETE')).status, 409)
  assert.equal((await request('jobs/10248', 'PATCH', { status: 'invalid' })).status, 400)
  console.log('PASS API seed data, validation and deletion guards')

  for (const [resource, values] of [
    ['clusters', { name: 'test-cluster', host: 'test.internal', description: 'test' }],
    ['nodes', { name: 'test-node', ip: '10.9.9.9', cluster: 'production', cores: 32, ram: 128 }],
    ['queues', { name: 'test.q', cluster: 'production', slots: 64, type: '通用计算', priority: 0 }],
    ['users', { name: 'testuser', email: 'test@example.com', role: 'user', department: 'test' }],
  ]) {
    const created = await request(resource, 'POST', values)
    assert.equal(created.status, 201)
    assert.equal((await request(resource, 'POST', values)).status, 409)
    assert.equal((await request(`${resource}/${created.data.id}`, 'DELETE')).status, 200)
  }
  const stored = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'))
  assert.equal(stored.users.length, 6)
  console.log('PASS cluster, node, queue and user CRUD with persistence')

  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), args: ['--no-sandbox'], headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${api}${url.pathname}${url.search}` })
    await route.fulfill({ response })
  })
  await page.goto(base)
  await page.getByText('最近作业', { exact: true }).waitFor()
  await page.locator('.recharts-area').first().waitFor()
  assert.equal(await page.locator('.node-tile').count(), 24)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/gridengine-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '提交作业', exact: true }).click()
  await page.getByLabel('作业名称', { exact: true }).fill('browser_test_job')
  await page.getByRole('dialog').getByRole('button', { name: '提交作业', exact: true }).click()
  const jobRow = page.locator('tbody tr').filter({ hasText: 'browser_test_job' })
  await jobRow.waitFor()
  assert.match(await jobRow.textContent(), /等待中/)
  await jobRow.getByRole('button', { name: '挂起作业', exact: true }).click()
  await jobRow.getByText('已挂起', { exact: true }).waitFor()
  await jobRow.getByRole('button', { name: '恢复作业', exact: true }).click()
  await jobRow.getByText('运行中', { exact: true }).waitFor()
  await jobRow.getByRole('button', { name: '作业详情', exact: true }).click()
  await page.getByRole('button', { name: '终止作业', exact: true }).click()
  await page.getByRole('button', { name: '确认操作', exact: true }).click()
  await jobRow.getByText('已终止', { exact: true }).waitFor()
  console.log('PASS job submission, hold, resume, details and termination')

  await page.locator('nav').getByRole('button', { name: '用户管理', exact: true }).click()
  await page.getByRole('button', { name: '添加用户', exact: true }).click()
  await page.getByLabel('用户名', { exact: true }).fill('browseruser')
  await page.getByLabel('邮箱', { exact: true }).fill('browser@example.com')
  await page.getByLabel('部门', { exact: true }).fill('计算科学')
  await page.getByRole('button', { name: '确认创建', exact: true }).click()
  const userRow = page.locator('tbody tr').filter({ hasText: 'browseruser' })
  await userRow.waitFor()
  await userRow.getByRole('button', { name: '停用', exact: true }).click()
  await userRow.getByText('已停用', { exact: true }).waitFor()
  await userRow.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确认操作', exact: true }).click()
  await userRow.waitFor({ state: 'detached' })
  console.log('PASS user creation, disable and deletion')

  await page.locator('nav').getByRole('button', { name: '集群概览', exact: true }).click()
  await page.getByLabel('选择集群', { exact: true }).selectOption('research')
  assert.equal(await page.locator('.node-tile').count(), 6)
  await page.getByLabel('选择集群', { exact: true }).selectOption('all')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出报表', exact: true }).click()
  assert.match((await downloadPromise).suggestedFilename(), /cluster-report.*\.csv$/)
  for (const width of [1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}px`)
  }
  await page.screenshot({ path: '/tmp/gridengine-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '打开菜单', exact: true }).click()
  await page.locator('nav').getByRole('button', { name: '节点管理', exact: true }).click()
  assert.equal(await page.locator('.sidebar.mobile-open').count(), 0)
  await page.getByRole('heading', { name: '节点管理', exact: true }).first().waitFor()
  assert.deepEqual(pageErrors, [])
  const proxy = await fetch(`${base}/api/state`)
  assert.equal(proxy.status, 200, 'Development API proxy must be reachable')
  console.log('PASS filters, CSV download, desktop/mobile layout, mobile navigation and API proxy')
  console.log('All smoke tests passed. Screenshots: /tmp/gridengine-{desktop,mobile}.png')
} finally {
  await browser?.close()
  server.kill()
  if (server.exitCode === null) await once(server, 'exit')
  await rm(directory, { recursive: true, force: true })
}