import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createLiveAdapter, parseConfig, parseJobs, parseNodes } from '../server/live.js'

const jobsXml = '<job_info><queue_info><job_list state="running"><JB_job_number>42</JB_job_number><JB_name>train</JB_name><JB_owner>alice</JB_owner><state>r</state><queue_name>all.q@node1</queue_name><slots>4</slots><tasks>1</tasks></job_list></queue_info><job_info><job_list state="pending"><JB_job_number>43</JB_job_number><JB_name>wait</JB_name><JB_owner>bob</JB_owner><state>hqw</state><slots>1</slots></job_list></job_info></job_info>'
const hostsXml = '<qhost><host name="global"/><host name="node1"><hostvalue name="num_proc">8</hostvalue><hostvalue name="load_avg">2.5</hostvalue><hostvalue name="mem_total">64G</hostvalue><hostvalue name="mem_used">16G</hostvalue></host><host name="node2"><hostvalue name="num_proc">-</hostvalue><hostvalue name="load_avg">-</hostvalue></host></qhost>'
const queuesXml = '<job_info><queue_info><QueueList><name>all.q@node1</name><slots_total>8</slots_total><slots_used>4</slots_used></QueueList><QueueList><name>all.q@node2</name><slots_total>8</slots_total><slots_used>0</slots_used><state>d</state></QueueList></queue_info></job_info>'
const outputs = new Map([
  ['qstat -xml -u *', jobsXml], ['qhost -xml', hostsXml], ['qstat -f -xml -u *', queuesXml],
  ['qconf -sql', 'all.q\n'], ['qconf -shgrpl', '@compute\n@empty\n'],
  ['qconf -sm', 'manager1\nmanager2\n'], ['qconf -so', 'operator1\n'], ['qconf -sul', 'researchers\nvisitors\n'],
  ['qconf -sq all.q', 'qname all.q\nhostlist @compute\npriority 0\nqtype BATCH INTERACTIVE\n'],
  ['qconf -shgrp @compute', 'group_name @compute\nhostlist node1 \\\n node2\n'],
  ['qconf -shgrp @empty', 'group_name @empty\nhostlist NONE\n'],
])
test('parse SGE XML, array tasks, held jobs and missing metrics without invented CPU data', () => {
  const jobs = parseJobs(jobsXml, 'sge')
  assert.equal(jobs[0].id, '42.1')
  assert.equal(jobs[1].status, 'held')
  assert.equal(jobs[0].node, 'node1')
  const nodes = parseNodes(hostsXml, 'sge')
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].memory, 25)
  assert.equal(nodes[0].cpu, null)
  assert.equal(nodes[1].status, 'offline')
  assert.equal(nodes[1].cores, null)
  assert.deepEqual(parseConfig('hostlist node1 \\\n node2\n'), { hostlist: 'node1 node2' })
  assert.throws(() => parseJobs('not XML', 'sge'), /XML/)
  assert.throws(() => parseJobs('<unexpected/>', 'sge'), /XML/)
})
test('collect real command output, aggregate queue slots, share in-flight work and cache', async () => {
  const calls = []
  const adapter = createLiveAdapter({}, async (command, args, options) => {
    calls.push([command, args])
    assert.equal(options.shell, false)
    assert.equal(options.env.LC_ALL, 'C')
    assert.equal(options.timeout, 10000)
    assert.equal(options.maxBuffer, 8 * 1024 * 1024)
    const key = `${command} ${args.join(' ')}`
    assert.ok(outputs.has(key), key)
    return { stdout: outputs.get(key) }
  })
  const [state, same] = await Promise.all([adapter.getState(), adapter.getState()])
  assert.equal(state, same)
  assert.equal(await adapter.getState(), state)
  assert.equal(calls.length, 11)
  assert.equal(state.readOnly, true)
  assert.equal(state.queues[0].slots, 16)
  assert.equal(state.queues[0].used, 4)
  assert.equal(state.queues[0].status, 'warning')
  assert.deepEqual(state.hostGroups[0].hosts, ['node1', 'node2'])
  assert.deepEqual(state.hostGroups[0].queueIds, ['all.q'])
  assert.deepEqual(state.hostGroups[1].hosts, [])
  assert.equal(state.users[0].role, 'observed')
  assert.deepEqual(state.userManagers.map(item => item.name), ['manager1', 'manager2'])
  assert.deepEqual(state.userOperators.map(item => item.name), ['operator1'])
  assert.deepEqual(state.userLists.map(item => item.name), ['researchers', 'visitors'])
  for (const command of ['qconf -sm', 'qconf -so', 'qconf -sul']) assert.ok(calls.some(([, args]) => `qconf ${args.join(' ')}` === command))
  assert.deepEqual(state.events, [])
})
test('command failures are explicit, not cached or replaced by demo data', async () => {
  let count = 0
  const adapter = createLiveAdapter({}, async () => { count++; throw Object.assign(new Error('private output'), { code: 'ENOENT' }) })
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(adapter.getState(), error => error.status === 502 && /ENOENT/.test(error.message) && !error.message.includes('private output'))
  assert.equal(count, 16)
  assert.throws(() => createLiveAdapter({ SGE_COMMAND_TIMEOUT_MS: 'invalid' }))
})
test('reject option-like resource names before passing them to qconf', async () => {
  const adapter = createLiveAdapter({}, async (command, args) => ({ stdout: args[0] === '-sql' ? '-dangerous' : outputs.get(`${command} ${args.join(' ')}`) }))
  await assert.rejects(adapter.getState(), /无效资源名称/)
})

test('empty cluster stays empty without seeding demo resources', async () => {
  const adapter = createLiveAdapter({}, async (command) => ({ stdout: command === 'qstat' ? '<job_info><queue_info/><job_info/></job_info>' : command === 'qhost' ? '<qhost><host name="global"/></qhost>' : '' }))
  const state = await adapter.getState()
  for (const resource of ['jobs', 'nodes', 'queues', 'hostGroups', 'users', 'userManagers', 'userOperators', 'userLists', 'events']) assert.deepEqual(state[resource], [])
  assert.equal(state.clusters.length, 1)
})
test('timeouts return explicit errors and custom binary paths remain argument arrays', async () => {
  const adapter = createLiveAdapter({ SGE_BIN_DIR: '/opt/sge/bin/lx-amd64', SGE_COMMAND_TIMEOUT_MS: '25' }, async (command, args, options) => {
    assert.ok(command.startsWith('/opt/sge/bin/lx-amd64/'))
    assert.ok(Array.isArray(args))
    assert.equal(options.timeout, 25)
    throw Object.assign(new Error('timed out'), { killed: true })
  })
  await assert.rejects(adapter.getState(), /超时/)
})

test('invalid mode fails at startup rather than silently using demo', async () => {
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, GRIDENGINE_MODE: 'invalid' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  child.stderr.on('data', chunk => { output += chunk })
  const [code] = await once(child, 'exit')
  assert.notEqual(code, 0)
  assert.match(output, /GRIDENGINE_MODE must be demo or live/)
})

async function startServer(env) {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, ...env, API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000)
      child.stdout.on('data', chunk => { if (chunk.toString().includes('Grid Engine API:')) { clearTimeout(timer); resolve() } })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`API exited: ${code}`)) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
    })
  } catch (error) { child.kill(); throw error }
  return { url: `http://127.0.0.1:${port}`, async close() { const exited = once(child, 'exit'); child.kill(); if (child.exitCode === null) await exited } }
}
test('HTTP live queries execute binaries, reject all writes and never create local demo storage', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-live-test-'))
  let server
  try {
    const binaries = path.join(directory, 'bin')
    await mkdir(binaries)
    const log = path.join(directory, 'commands.jsonl')
    const script = `#!${process.execPath}\nconst { appendFileSync } = require('node:fs'); const path = require('node:path'); const key = path.basename(process.argv[1]) + ' ' + process.argv.slice(2).join(' '); appendFileSync(${JSON.stringify(log)}, JSON.stringify(key) + '\\n'); const outputs = new Map(${JSON.stringify([...outputs])}); if (!outputs.has(key)) process.exit(1); process.stdout.write(outputs.get(key));\n`
    for (const command of ['qstat', 'qhost', 'qconf']) await writeFile(path.join(binaries, command), script, { mode: 0o755 })
    const storage = path.join(directory, 'unused', 'data.json')
    server = await startServer({ GRIDENGINE_MODE: 'live', SGE_BIN_DIR: binaries, DATA_FILE: storage })
    const stateResponse = await fetch(`${server.url}/api/state`)
    assert.equal(stateResponse.status, 200)
    const state = await stateResponse.json()
    assert.equal(state.mode, 'live')
    assert.equal(state.jobs[0].name, 'train')
    assert.equal(state.hostGroups.length, 2)
    for (const endpoint of ['jobs', 'nodes', 'queues', 'clusters', 'users', 'hostGroups', 'userManagers', 'userOperators', 'userLists', 'unknown']) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const response = await fetch(`${server.url}/api/${endpoint}${method === 'POST' ? '' : '/test'}`, { method })
        assert.equal(response.status, 405)
        assert.equal((await response.json()).readOnly, true)
      }
    }
    const cachedResponse = await fetch(`${server.url}/api/state`)
    assert.equal(cachedResponse.status, 200)
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 11)
    await assert.rejects(stat(path.dirname(storage)), { code: 'ENOENT' })
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})
test('HTTP missing SGE binaries returns 502 with live metadata instead of demo fallback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-missing-'))
  let server
  try {
    const storage = path.join(directory, 'data.json')
    await writeFile(storage, 'not valid JSON')
    server = await startServer({ GRIDENGINE_MODE: 'live', SGE_BIN_DIR: path.join(directory, 'missing'), DATA_FILE: storage })
    const response = await fetch(`${server.url}/api/state`)
    assert.equal(response.status, 502)
    const result = await response.json()
    assert.equal(result.mode, 'live')
    assert.equal(result.readOnly, true)
    assert.match(result.error, /ENOENT/)
    assert.equal(result.jobs, undefined)
    assert.equal(await readFile(storage, 'utf8'), 'not valid JSON')
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})
test('demo mode remains writable and persists its state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-demo-'))
  let server
  try {
    const storage = path.join(directory, 'data.json')
    server = await startServer({ GRIDENGINE_MODE: 'demo', DATA_FILE: storage })
    const state = await (await fetch(`${server.url}/api/state`)).json()
    assert.equal(state.mode, 'demo')
    assert.equal(state.readOnly, false)
    assert.equal(state.jobs.length, 156)
    const response = await fetch(`${server.url}/api/queues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'live-regression.q', cluster: 'production', slots: 8, type: 'test', priority: 0 }) })
    assert.equal(response.status, 201)
    assert.ok(JSON.parse(await readFile(storage, 'utf8')).queues.some(item => item.name === 'live-regression.q'))
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})