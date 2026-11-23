import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { changeAccount } from '../server/auth.js'

const directory = await mkdtemp(path.join(tmpdir(), 'gridengine-test-'))
const port = process.env.TEST_API_PORT || '3109'
const api = `http://127.0.0.1:${port}`
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5174'
const accountFile = path.join(directory, 'auth.json')
await changeAccount('create', 'testadmin', { role: 'admin', password: 'smoke-admin-password' }, accountFile)
const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, GRIDENGINE_MODE: 'demo', API_PORT: port, DATA_FILE: path.join(directory, 'state.json'), AUTH_FILE: accountFile }, stdio: ['ignore', 'pipe', 'pipe'] })
let browser
let cookie = ''
const request = async (endpoint, method = 'GET', body) => {
  const response = await fetch(`${api}/api/${endpoint}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
  return { status: response.status, data: await response.json() }
}
try {
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(([code]) => { throw new Error(`Test API exited: ${code}`) }),
    new Promise((_, reject) => server.once('error', reject)),
  ])
  assert.equal((await request('state')).status, 401)
  assert.equal((await request('auth/login', 'POST', { username: 'testadmin', password: 'smoke-admin-password' })).status, 200)
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

  assert.deepEqual(initial.data.hostGroups, [])
  const groupValues = { name: '@test', cluster: 'production', hosts: ['compute-01'], queueIds: ['all.q'] }
  const group = await request('hostGroups', 'POST', groupValues)
  assert.equal(group.status, 201)
  assert.equal((await request('hostGroups', 'POST', groupValues)).status, 409)
  for (const invalid of [
    { name: 'invalid' }, { cluster: 'missing' }, { hosts: ['compute-20'] },
    { hosts: ['missing'] }, { queueIds: ['short.q'] }, { hosts: ['compute-01', 'compute-01'] },
  ]) {
    assert.equal((await request('hostGroups', 'POST', { ...groupValues, name: '@invalid', ...invalid })).status, 400)
  }
  assert.equal((await request('nodes/compute-01', 'DELETE')).status, 409)
  assert.equal((await request(`hostGroups/${group.data.id}`, 'DELETE')).status, 409)
  assert.equal((await request(`hostGroups/${group.data.id}`, 'PATCH', { ...groupValues, hosts: ['compute-02'], queueIds: [] })).status, 200)
  const groupState = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'))
  assert.deepEqual(groupState.hostGroups[0].hosts, ['compute-02'])
  assert.equal((await request(`hostGroups/${group.data.id}`, 'DELETE')).status, 200)
  assert.equal((await request(`hostGroups/${group.data.id}`, 'PATCH', groupValues)).status, 404)
  assert.equal((await request(`hostGroups/${group.data.id}`, 'DELETE')).status, 404)
  console.log('PASS host group CRUD, validation, reference guards and persistence')

  for (const [resource, values] of [
    ['clusters', { name: 'test-cluster', host: 'test.internal', description: 'test' }],
    ['nodes', { name: 'test-node', ip: '10.9.9.9', cluster: 'production', cores: 32, ram: 128 }],
    ['queues', { name: 'smoke-test.q', cluster: 'production', slots: 64, type: '通用计算', priority: 0 }],
    ['users', { name: 'testuser', email: 'test@example.com', role: 'user', department: 'test' }],
  ]) {
    const created = await request(resource, 'POST', values)
    assert.equal(created.status, 201, `${resource}: ${JSON.stringify(created.data)}`)
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
  await page.getByRole('heading', { name: '登录控制台' }).waitFor()
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: `/tmp/gridengine-login-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.getByLabel('账号', { exact: true }).fill('testadmin')
  await page.getByLabel('密码', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('alert').getByText('账号或密码错误').waitFor()
  await page.getByLabel('密码', { exact: true }).fill('smoke-admin-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByText('最近作业', { exact: true }).waitFor()
  await page.reload()
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
  assert.match(await page.getByRole('dialog').textContent(), /作业脚本/)
  await page.getByRole('button', { name: '终止作业', exact: true }).click()
  await page.getByRole('button', { name: '确认操作', exact: true }).click()
  await jobRow.getByText('已终止', { exact: true }).waitFor()
  console.log('PASS job submission, hold, resume, details and termination')

  const liveJob = { id: '42.1', jobId: '42', tasks: '1', name: 'live_job', user: 'alice', cluster: 'production', status: 'running', queue: 'all.q', node: 'node1', slots: 4, priority: 0.555, submitted: null, started: '2025-01-02T03:04:05.000Z', duration: '1h 2m', sgeState: 'r' }
  let detailFails = false
  const stateRoute = route => route.fulfill({ json: { ...initial.data, mode: 'live', readOnly: true, jobs: [liveJob] } })
  const detailRoute = route => route.fulfill(detailFails ? { status: 502, json: { error: '查询失败' } } : { json: { output: 'job_number: 42\nscript_file: /home/alice/train.sh\n' } })
  await page.route('**/api/state', stateRoute)
  await page.route('**/api/jobs/42/detail', detailRoute)
  await page.reload()
  await page.locator('nav').getByRole('button', { name: '作业管理', exact: true }).click()
  const liveRow = page.locator('tbody tr').filter({ hasText: 'live_job' })
  await liveRow.waitFor()
  for (const column of ['执行节点', '优先级', '提交时间', '开始时间', '运行时长']) await page.getByRole('columnheader', { name: column, exact: true }).waitFor()
  assert.match(await liveRow.textContent(), /node1/)
  assert.match(await liveRow.textContent(), /0\.555/)
  await liveRow.getByRole('button', { name: '作业详情', exact: true }).click()
  await page.getByText('script_file: /home/alice/train.sh', { exact: false }).waitFor()
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  detailFails = true
  await liveRow.getByRole('button', { name: '作业详情', exact: true }).click()
  await page.getByRole('alert').getByText('作业详情查询失败：查询失败').waitFor()
  await page.setViewportSize({ width: 360, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await page.unroute('**/api/state', stateRoute)
  await page.unroute('**/api/jobs/42/detail', detailRoute)
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.reload()
  await page.getByText('最近作业', { exact: true }).waitFor()
  console.log('PASS live job columns, full details, errors and mobile layout')

  const historyJobs = [
    { id: '1', name: 'old_job', user: 'alice', cluster: 'production', status: 'completed', ended: '2025-01-01T12:00:00', queue: 'all.q' },
    { id: '2', name: 'new_job', user: 'bob', cluster: 'production', status: 'failed', ended: '2025-01-03T12:00:00', queue: 'all.q' },
    { id: '3', name: 'other_cluster_job', user: 'alice', cluster: 'research', status: 'completed', ended: '2025-01-02T12:00:00', queue: 'short.q' },
    { id: '4', name: 'outside_job', user: 'alice', cluster: 'production', status: 'completed', ended: '2024-12-30T12:00:00', queue: 'all.q' },
    { id: '5', name: 'future_job', user: 'alice', cluster: 'production', status: 'completed', ended: '2025-04-01T12:00:00', queue: 'all.q' },
  ]
  let historyFails = false
  const historyRoute = route => route.fulfill(historyFails ? { status: 502, json: { error: 'qacct 查询失败' } } : { json: { jobs: historyJobs } })
  await page.route('**/api/jobs/history*', historyRoute)
  await page.clock.setFixedTime(new Date('2025-03-31T12:00:00'))
  await page.locator('nav').getByRole('button', { name: '作业管理', exact: true }).click()
  await page.getByRole('tab', { name: '历史作业' }).click()
  await page.getByText('new_job', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('开始日期').inputValue(), '2024-12-31')
  assert.equal(await page.getByLabel('结束日期').inputValue(), '2025-03-31')
  assert.equal(await page.getByText('outside_job', { exact: true }).count(), 0)
  assert.equal(await page.getByText('future_job', { exact: true }).count(), 0)
  assert.deepEqual(await page.locator('tbody tr').allTextContents().then(rows => rows.map(row => row.match(/(?:new|old|other_cluster)_job/)[0])), ['new_job', 'other_cluster_job', 'old_job'])
  await page.getByLabel('开始日期').fill('2025-01-02')
  await page.getByLabel('结束日期').fill('2025-01-02')
  assert.equal(await page.locator('tbody tr').count(), 1)
  await page.getByText('other_cluster_job', { exact: true }).waitFor()
  await page.getByLabel('选择集群').selectOption('production')
  await page.getByText('暂无匹配的历史作业').waitFor()
  await page.setViewportSize({ width: 360, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  historyFails = true
  await page.getByRole('button', { name: '刷新历史作业' }).click()
  await page.getByRole('alert').getByText('qacct 查询失败').waitFor()
  await page.getByRole('tab', { name: '当前作业' }).click()
  await page.getByText('全部作业', { exact: true }).waitFor()
  await page.unroute('**/api/jobs/history*', historyRoute)
  await page.getByLabel('选择集群').selectOption('all')
  await page.clock.setFixedTime(new Date())
  await page.setViewportSize({ width: 1440, height: 1100 })
  console.log('PASS historical jobs ordering, dates, cluster, errors and mobile layout')

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

  await page.locator('nav').getByRole('button', { name: '队列管理', exact: true }).click()
  await page.getByRole('tab', { name: '队列组', exact: true }).click()
  await page.getByRole('button', { name: '创建队列组', exact: true }).click()
  await page.getByLabel('组名', { exact: true }).fill('@browsergroup')
  await page.getByRole('dialog').getByLabel('所属集群', { exact: true }).selectOption('production')
  await page.getByRole('group', { name: '成员节点', exact: false }).getByLabel('compute-01', { exact: true }).check()
  await page.getByRole('group', { name: '关联队列', exact: false }).getByLabel('all.q', { exact: true }).check()
  await page.getByRole('button', { name: '保存队列组', exact: true }).click()
  const groupRow = page.locator('tbody tr').filter({ hasText: '@browsergroup' })
  await groupRow.waitFor()
  assert.match(await groupRow.textContent(), /compute-01/)
  assert.match(await groupRow.textContent(), /all.q/)
  await groupRow.getByRole('button', { name: '删除队列组', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '确认删除', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await groupRow.getByRole('button', { name: '编辑队列组', exact: true }).click()
  await page.getByLabel('compute-01', { exact: true }).uncheck()
  await page.getByLabel('compute-02', { exact: true }).check()
  await page.getByLabel('all.q', { exact: true }).uncheck()
  await page.getByRole('button', { name: '保存队列组', exact: true }).click()
  await groupRow.getByText('compute-02', { exact: true }).waitFor()
  await page.getByLabel('搜索队列组', { exact: true }).fill('absent')
  await groupRow.waitFor({ state: 'detached' })
  await page.getByLabel('搜索队列组', { exact: true }).fill('compute-02')
  await groupRow.waitFor()
  await page.getByLabel('选择集群', { exact: true }).selectOption('research')
  await groupRow.waitFor({ state: 'detached' })
  await page.getByLabel('选择集群', { exact: true }).selectOption('all')
  await groupRow.waitFor()
  await page.screenshot({ path: '/tmp/gridengine-groups-desktop.png', fullPage: true })
  for (const width of [1440, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Group page overflow at ${width}px`)
  }
  await groupRow.getByRole('button', { name: '编辑队列组', exact: true }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/gridengine-groups-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await groupRow.getByRole('button', { name: '删除队列组', exact: true }).click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await groupRow.waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 1440, height: 1100 })
  console.log('PASS host group creation, editing, search, cluster filtering, deletion and responsive layout')

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
  const proxy = await fetch(`${base}/api/auth/me`)
  assert.equal(proxy.status, 401, 'Development API proxy must require authentication')
  console.log('PASS filters, CSV download, desktop/mobile layout, mobile navigation and API proxy')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('heading', { name: '登录控制台' }).waitFor()
  await page.reload()
  await page.getByRole('heading', { name: '登录控制台' }).waitFor()
  await changeAccount('create', 'reader', { password: 'smoke-reader-password' }, accountFile)
  await page.getByLabel('账号', { exact: true }).fill('reader')
  await page.getByLabel('密码', { exact: true }).fill('smoke-reader-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByText('最近作业', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '提交作业', exact: true }).isDisabled(), true)
  await changeAccount('update', 'reader', { disabled: true }, accountFile)
  await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  await page.getByRole('heading', { name: '登录控制台' }).waitFor()
  assert.deepEqual(pageErrors, [])
  console.log('PASS login errors, session restore, logout, read-only account and session revocation')
  console.log('All smoke tests passed. Screenshots: /tmp/gridengine-{desktop,mobile}.png')
} finally {
  await browser?.close()
  server.kill()
  if (server.exitCode === null) await once(server, 'exit')
  await rm(directory, { recursive: true, force: true })
}