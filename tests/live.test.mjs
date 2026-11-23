import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createLiveAdapter, parseAccounting, parseConfig, parseJobs, parseNodes } from '../server/live.js'
import { changeAccount } from '../server/auth.js'

const jobsXml = '<job_info><queue_info><job_list state="running"><JB_job_number>42</JB_job_number><JB_name>train</JB_name><JB_owner>alice</JB_owner><state>r</state><queue_name>all.q@node1</queue_name><slots>4</slots><tasks>1</tasks></job_list></queue_info><job_info><job_list state="pending"><JB_job_number>43</JB_job_number><JB_name>wait</JB_name><JB_owner>bob</JB_owner><state>hqw</state><slots>1</slots></job_list></job_info></job_info>'
const hostsXml = '<qhost><host name="global"><hostvalue name="arch_string">-</hostvalue></host><host name="node1"><hostvalue name="arch_string">lx-amd64</hostvalue><hostvalue name="num_proc">64</hostvalue><hostvalue name="m_socket">2</hostvalue><hostvalue name="m_core">32</hostvalue><hostvalue name="m_thread">64</hostvalue><hostvalue name="load_avg">2.21</hostvalue><hostvalue name="mem_total">251.4G</hostvalue><hostvalue name="mem_used">52.7G</hostvalue><hostvalue name="swap_total">8.0G</hostvalue><hostvalue name="swap_used">74.4M</hostvalue></host><host name="node2"><hostvalue name="num_proc">-</hostvalue><hostvalue name="load_avg">-</hostvalue></host></qhost>'
const queuesXml = '<job_info><queue_info><QueueList><name>all.q@node1</name><slots_total>8</slots_total><slots_used>4</slots_used></QueueList><QueueList><name>all.q@node2</name><slots_total>8</slots_total><slots_used>0</slots_used><state>d</state></QueueList></queue_info></job_info>'
const outputs = new Map([
  ['qstat -xml -u *', jobsXml], ['qhost -xml', hostsXml], ['qstat -f -xml -u *', queuesXml],
  ['qstat -j 42', 'job_number: 42\nscript_file: /home/alice/train.sh\n'],
  ['qacct -j', '==============================================================\njobnumber 41\njobname finished\nowner alice\nend_time Thu Jan 02 04:05:05 2025\nfailed 0\nexit_status 0\n'],
  ['qconf -sql', 'all.q\n'], ['qconf -shgrpl', '@compute\n@empty\n'],
  ['qconf -sm', 'manager1\nmanager2\n'], ['qconf -so', 'operator1\n'], ['qconf -sul', 'researchers\nvisitors\n'],
  ['qconf -sq all.q', 'qname all.q\nhostlist @compute\npriority 0\nqtype BATCH INTERACTIVE\n'],
  ['qconf -shgrp @compute', 'group_name @compute\nhostlist node1 \\\n node2\n'],
  ['qconf -shgrp @empty', 'group_name @empty\nhostlist NONE\n'],
])
test('parse accounting records including array tasks and failed jobs', async () => {
  const output = '==============================================================\nqname all.q\nhostname node1\nowner alice\njobname train\njobnumber 42\ntaskid 2\nqsub_time Thu Jan 02 03:04:05 2025\nstart_time Thu Jan 02 03:05:05 2025\nend_time Thu Jan 02 04:05:05 2025\nfailed 0\nexit_status 0\nslots 4\nru_wallclock 3600\n==============================================================\njobnumber 43\ntaskid undefined\nfailed 0\nexit_status 1\n'
  const adapter = createLiveAdapter({}, async (command, args) => {
    assert.equal(command, 'qacct')
    assert.deepEqual(args, ['-j'])
    return { stdout: output }
  })
  const jobs = await adapter.getJobHistory()
  assert.deepEqual(jobs, parseAccounting(output, 'sge'))
  assert.equal(jobs[0].id, '42.2')
  assert.equal(jobs[0].status, 'completed')
  assert.ok(jobs[0].ended)
  assert.equal(jobs[0].duration, '1h 0m')
  assert.equal(jobs[1].id, '43')
  assert.equal(jobs[1].status, 'failed')
  const [unknown] = parseAccounting('jobnumber 44\nend_time 0\n', 'sge')
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.ended, null)
})
test('history passes completion time bounds and a separate timeout to qacct', async () => {
  const adapter = createLiveAdapter({ SGE_HISTORY_TIMEOUT_MS: '180000' }, async (command, args, options) => {
    assert.equal(command, 'qacct')
    const format = date => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}.${String(date.getSeconds()).padStart(2, '0')}`
    assert.deepEqual(args, ['-j', '-E', '-b', format(new Date('2025-01-01T00:00:00.000Z')), '-e', format(new Date('2025-02-02T23:59:59.000Z'))])
    assert.equal(options.timeout, 180000)
    return { stdout: '' }
  })
  assert.deepEqual(await adapter.getJobHistory({ start: '2025-01-02T00:00:00.000Z', end: '2025-02-01T23:59:59.000Z' }), [])
  assert.throws(() => createLiveAdapter({ SGE_HISTORY_TIMEOUT_MS: 'invalid' }))
})
test('stream accounting output larger than the command buffer without truncation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-accounting-test-'))
  try {
    const script = `#!${process.execPath}\nconst record = '==============================================================\\njobnumber 42\\njobname train\\nfailed 0\\nexit_status 0\\nextra ' + 'x'.repeat(1024) + '\\n'; for (let index = 0; index < 9000; index++) process.stdout.write(record);\n`
    await writeFile(path.join(directory, 'qacct'), script, { mode: 0o755 })
    const jobs = await createLiveAdapter({ SGE_BIN_DIR: directory }).getJobHistory()
    assert.equal(jobs.length, 9000)
    assert.equal(jobs[8999].id, '42')
    assert.equal(jobs[8999].status, 'completed')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('GE 6.2 without -E retries without start-time filters', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-accounting-legacy-'))
  try {
    const script = `#!${process.execPath}\nif (process.argv.includes('-E')) { process.stderr.write('GE 6.2u5\\nusage: qacct [options]\\n [-b begin_time] jobs started after\\n [-e end_time] jobs started before\\n'); process.exitCode = 1 } else if (process.argv.slice(2).join(' ') !== '-j') { process.exitCode = 2 } else { process.stdout.write('==============================================================\\njobnumber 42\\njobname long_running\\nstart_time Wed Jan 01 00:00:00 2020\\nend_time Thu Jan 02 12:05:05 2025\\nfailed 0\\nexit_status 0\\n==============================================================\\njobnumber 43\\nend_time Wed Jan 01 12:00:00 2020\\nfailed 0\\nexit_status 0\\n') }\n`
    await writeFile(path.join(directory, 'qacct'), script, { mode: 0o755 })
    const jobs = await createLiveAdapter({ SGE_BIN_DIR: directory }).getJobHistory({ start: '2025-01-01T00:00:00.000Z', end: '2025-01-03T23:59:59.000Z' })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].name, 'long_running')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('qacct usage errors retain failure when -E is supported', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-accounting-usage-'))
  try {
    const script = `#!${process.execPath}\nprocess.stderr.write('usage: qacct [options]\\n [-E] select job end time\\n'); process.exitCode = 1;\n`
    await writeFile(path.join(directory, 'qacct'), script, { mode: 0o755 })
    await assert.rejects(createLiveAdapter({ SGE_BIN_DIR: directory }).getJobHistory({ start: '2025-01-01T00:00:00.000Z' }), /退出码 1/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('streamed accounting failures do not return partial results', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-accounting-failure-'))
  try {
    const executable = path.join(directory, 'qacct')
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('jobnumber 42\\n'); process.exitCode = 3;\n`, { mode: 0o755 })
    await assert.rejects(createLiveAdapter({ SGE_BIN_DIR: directory }).getJobHistory(), /退出码 3/)
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('jobnumber 42\\n'); process.stderr.write('invalid option -E\\n'); process.exitCode = 1;\n`, { mode: 0o755 })
    await assert.rejects(createLiveAdapter({ SGE_BIN_DIR: directory }).getJobHistory(), /退出码 1.*invalid option -E/)
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('extra ' + 'x'.repeat(1024 * 1024) + '\\n');\n`, { mode: 0o755 })
    await assert.rejects(createLiveAdapter({ SGE_BIN_DIR: directory }).getJobHistory(), /单条 accounting 记录超过 1 MiB/)
    await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 })
    await assert.rejects(createLiveAdapter({ SGE_BIN_DIR: directory, SGE_HISTORY_TIMEOUT_MS: '100' }).getJobHistory(), /超时/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('parse SGE XML, array tasks, held jobs and missing metrics without invented CPU data', () => {
  const jobs = parseJobs(jobsXml, 'sge')
  assert.equal(jobs[0].id, '42.1')
  assert.equal(jobs[1].status, 'held')
  assert.equal(jobs[0].node, 'node1')
  assert.equal(jobs[0].priority, null)
  const [timedJob] = parseJobs('<job_info><queue_info><job_list><JB_job_number>44</JB_job_number><JAT_prio>0.55500</JAT_prio><JAT_start_time>2025-01-02T03:04:05Z</JAT_start_time></job_list></queue_info></job_info>', 'sge')
  assert.equal(timedJob.priority, 0.555)
  assert.equal(timedJob.started, '2025-01-02T03:04:05.000Z')
  assert.equal(timedJob.submitted, null)
  const nodes = parseNodes(hostsXml, 'sge')
  assert.equal(nodes.length, 3)
  const globalNode = nodes.find(item => item.id === 'global')
  const node = nodes.find(item => item.id === 'node1')
  const offlineNode = nodes.find(item => item.id === 'node2')
  assert.equal(globalNode.status, 'unknown')
  assert.equal(globalNode.arch, '-')
  assert.equal(node.memory, 21)
  assert.equal(node.cpu, null)
  assert.equal(node.arch, 'lx-amd64')
  assert.equal(node.sockets, 2)
  assert.equal(node.coresPerSocket, 32)
  assert.equal(node.threadsPerCore, 64)
  assert.equal(node.load, 2.21)
  assert.equal(node.ram, 251.4)
  assert.equal(node.memoryUsed, 52.7)
  assert.equal(node.ramText, '251.4G')
  assert.equal(node.memoryUsedText, '52.7G')
  assert.equal(node.swapTotalText, '8.0G')
  assert.equal(node.swapUsedText, '74.4M')
  assert.equal(offlineNode.status, 'offline')
  assert.equal(offlineNode.cores, null)
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
  assert.match(await adapter.getJobDetail('42'), /script_file: \/home\/alice\/train.sh/)
  await assert.rejects(adapter.getJobDetail('-help'), /无效作业 ID/)
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
  for (const resource of ['jobs', 'queues', 'hostGroups', 'users', 'userManagers', 'userOperators', 'userLists', 'events']) assert.deepEqual(state[resource], [])
  assert.deepEqual(state.nodes.map(node => node.id), ['global'])
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
  const accountFile = path.join(path.dirname(env.DATA_FILE), 'auth.json')
  await changeAccount('create', 'testadmin', { role: 'admin', password: 'test-admin-password' }, accountFile)
  env.AUTH_FILE = accountFile
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
  const url = `http://127.0.0.1:${port}`
  const response = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'testadmin', password: 'test-admin-password' }) })
  assert.equal(response.status, 200)
  const headers = { Cookie: response.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  return { url, headers, async close() { const exited = once(child, 'exit'); child.kill(); if (child.exitCode === null) await exited } }
}
test('HTTP live queries execute binaries, reject all writes and never create local demo storage', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-live-test-'))
  let server
  try {
    const binaries = path.join(directory, 'bin')
    await mkdir(binaries)
    const log = path.join(directory, 'commands.jsonl')
    const script = `#!${process.execPath}\nconst { appendFileSync } = require('node:fs'); const path = require('node:path'); const key = path.basename(process.argv[1]) + ' ' + process.argv.slice(2).join(' '); appendFileSync(${JSON.stringify(log)}, JSON.stringify(key) + '\\n'); const outputs = new Map(${JSON.stringify([...outputs])}); if (!outputs.has(key)) process.exit(1); process.stdout.write(outputs.get(key));\n`
    for (const command of ['qstat', 'qacct', 'qhost', 'qconf']) await writeFile(path.join(binaries, command), script, { mode: 0o755 })
    const storage = path.join(directory, 'unused', 'data.json')
    server = await startServer({ GRIDENGINE_MODE: 'live', SGE_BIN_DIR: binaries, DATA_FILE: storage })
    assert.equal((await fetch(`${server.url}/api/state`)).status, 401)
    const stateResponse = await fetch(`${server.url}/api/state`, { headers: server.headers })
    assert.equal(stateResponse.status, 200)
    const state = await stateResponse.json()
    assert.equal(state.mode, 'live')
    assert.equal(state.jobs[0].name, 'train')
    assert.equal(state.hostGroups.length, 2)
    const historyResponse = await fetch(`${server.url}/api/jobs/history`, { headers: server.headers })
    assert.equal(historyResponse.status, 200)
    assert.equal((await historyResponse.json()).jobs[0].name, 'finished')
    const detailResponse = await fetch(`${server.url}/api/jobs/42/detail`, { headers: server.headers })
    assert.equal(detailResponse.status, 200)
    assert.match((await detailResponse.json()).output, /script_file: \/home\/alice\/train.sh/)
    assert.equal((await fetch(`${server.url}/api/jobs/-help/detail`, { headers: server.headers })).status, 400)
    for (const endpoint of ['jobs', 'nodes', 'queues', 'clusters', 'users', 'hostGroups', 'userManagers', 'userOperators', 'userLists', 'unknown']) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const response = await fetch(`${server.url}/api/${endpoint}${method === 'POST' ? '' : '/test'}`, { method, headers: server.headers })
        assert.equal(response.status, 405)
        assert.equal((await response.json()).readOnly, true)
      }
    }
    const cachedResponse = await fetch(`${server.url}/api/state`, { headers: server.headers })
    assert.equal(cachedResponse.status, 200)
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 13)
    await assert.rejects(stat(storage), { code: 'ENOENT' })
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})
test('HTTP missing SGE binaries returns 502 with live metadata instead of demo fallback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-missing-'))
  let server
  try {
    const storage = path.join(directory, 'data.json')
    await writeFile(storage, 'not valid JSON')
    server = await startServer({ GRIDENGINE_MODE: 'live', SGE_BIN_DIR: path.join(directory, 'missing'), DATA_FILE: storage })
    const response = await fetch(`${server.url}/api/state`, { headers: server.headers })
    assert.equal(response.status, 502)
    const result = await response.json()
    assert.equal(result.mode, 'live')
    assert.equal(result.readOnly, true)
    assert.match(result.error, /ENOENT/)
    assert.equal(result.jobs, undefined)
    const historyResponse = await fetch(`${server.url}/api/jobs/history`, { headers: server.headers })
    assert.equal(historyResponse.status, 502)
    assert.match((await historyResponse.json()).error, /qacct 查询失败/)
    assert.equal(await readFile(storage, 'utf8'), 'not valid JSON')
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})
test('demo mode remains writable and persists its state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sge-demo-'))
  let server
  try {
    const storage = path.join(directory, 'data.json')
    server = await startServer({ GRIDENGINE_MODE: 'demo', DATA_FILE: storage })
    const state = await (await fetch(`${server.url}/api/state`, { headers: server.headers })).json()
    assert.equal(state.mode, 'demo')
    assert.equal(state.readOnly, false)
    assert.equal(state.jobs.length, 156)
    assert.deepEqual((await (await fetch(`${server.url}/api/jobs/history`, { headers: server.headers })).json()).jobs, [])
    const response = await fetch(`${server.url}/api/queues`, { method: 'POST', headers: server.headers, body: JSON.stringify({ name: 'live-regression.q', cluster: 'production', slots: 8, type: 'test', priority: 0 }) })
    assert.equal(response.status, 201)
    assert.ok(JSON.parse(await readFile(storage, 'utf8')).queues.some(item => item.name === 'live-regression.q'))
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }) }
})