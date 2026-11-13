import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

const execute = promisify(execFile)
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false })
const list = value => value == null || value === '' ? [] : Array.isArray(value) ? value : [value]
const number = value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const percentage = (used, total) => used == null || !total ? null : Math.round(Math.max(0, Math.min(100, used / total * 100)))
const tokens = value => !value || value === 'NONE' ? [] : value.trim().split(/\s+/)
const entries = output => [...new Set(output.split(/\s+/).filter(value => value && value !== 'NONE'))].map(name => ({ id: name, name }))

function failure(message) { return Object.assign(new Error(message), { status: 502, code: 'SGE_QUERY_FAILED' }) }
function xml(output, root, command) {
  if (XMLValidator.validate(output) !== true) throw failure(`${command} 返回了无效 XML`)
  const parsed = parser.parse(output)
  if (!parsed[root] || typeof parsed[root] !== 'object') throw failure(`${command} 返回了非预期的 XML 结构`)
  return parsed[root]
}
export function parseConfig(output) {
  const result = {}
  for (const line of output.replace(/[ \t]*\\\r?\n[ \t]*/g, ' ').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#\s]+)\s+(.+?)\s*$/)
    if (match) result[match[1]] = match[2]
  }
  return result
}
function gigabytes(value) {
  const match = String(value ?? '').match(/^(\d+(?:\.\d+)?)\s*([KMGTPE]?)(?:i?B)?$/i)
  if (!match) return null
  const exponent = { '': -3, K: -2, M: -1, G: 0, T: 1, P: 2, E: 3 }[match[2].toUpperCase()]
  return Number(match[1]) * 1024 ** exponent
}
function timestamp(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
export function parseJobs(output, cluster) {
  const document = xml(output, 'job_info', 'qstat')
  return [...list(document.queue_info?.job_list), ...list(document.job_info?.job_list)].map(item => {
    const rawState = item.state || item['@_state'] || ''
    const status = /E/.test(rawState) ? 'error' : /h|s|S|T/.test(rawState) ? 'held' : /r|t|running/.test(rawState) ? 'running' : /d/.test(rawState) ? 'deleted' : 'pending'
    const started = timestamp(item.JAT_start_time)
    const elapsed = started ? Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 60000)) : null
    const queueInstance = item.queue_name || ''
    const jobId = String(item.JB_job_number || '')
    const tasks = item.tasks || ''
    return {
      id: tasks ? `${jobId}.${tasks}` : jobId, jobId, tasks,
      name: item.JB_name || jobId, user: item.JB_owner || '-', cluster, status,
      queue: queueInstance.split('@')[0] || '-', node: queueInstance.split('@')[1] || '-',
      slots: number(item.slots), submitted: timestamp(item.JB_submission_time) || started,
      duration: elapsed == null ? '-' : `${Math.floor(elapsed / 60)}h ${elapsed % 60}m`, sgeState: rawState,
    }
  })
}
export function parseNodes(output, cluster) {
  return list(xml(output, 'qhost', 'qhost').host).filter(item => item['@_name'] !== 'global').map(item => {
    const values = Object.fromEntries(list(item.hostvalue).map(value => [value['@_name'], value['#text']]))
    const cores = number(values.num_proc), load = number(values.load_avg)
    const ram = gigabytes(values.mem_total), used = gigabytes(values.mem_used)
    return { id: item['@_name'], name: item['@_name'], cluster, status: load == null ? 'offline' : 'online', cpu: null, load, memory: percentage(used, ram), cores, ram, ip: '-' }
  })
}
export function parseQueueInstances(output) {
  return list(xml(output, 'job_info', 'qstat -f').queue_info?.QueueList).map(item => ({
    name: item.name, slots: number(item.slots_total), used: number(item.slots_used), state: item.state || '',
  }))
}
function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`SGE configuration must be an integer between 1 and ${maximum}`)
  return parsed
}
async function mapLimited(values, action) {
  const results = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(values.length, 4) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await action(values[index]) }
  }))
  return results
}
export function createLiveAdapter(env = process.env, runCommand) {
  const timeout = positiveInteger(env.SGE_COMMAND_TIMEOUT_MS, 10000, 120000)
  const cacheMs = positiveInteger(env.SGE_CACHE_MS, 10000, 300000)
  const cluster = env.SGE_CLUSTER_ID || 'sge'
  let cached, expires = 0, inFlight
  async function run(command, args) {
    try {
      const executable = env.SGE_BIN_DIR ? path.join(env.SGE_BIN_DIR, command) : command
      const result = await (runCommand || execute)(executable, args, { timeout, maxBuffer: 8 * 1024 * 1024, shell: false, env: { ...env, LC_ALL: 'C', LANG: 'C' } })
      return result.stdout
    } catch (error) {
      throw failure(`${command} 查询失败（${error.killed ? '超时' : error.code || '执行错误'}），请检查 SGE 环境与查询权限`)
    }
  }
  function names(output, kind) {
    const values = tokens(output)
    const pattern = kind === 'group' ? /^@[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/ : /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/
    if (values.some(value => !pattern.test(value))) throw failure('qconf 返回了无效资源名称')
    return [...new Set(values)]
  }
  async function collect() {
    const [jobXml, hostXml, queueXml, queueList, groupList, managerList, operatorList, userList] = await Promise.all([
      run('qstat', ['-xml', '-u', '*']), run('qhost', ['-xml']), run('qstat', ['-f', '-xml', '-u', '*']),
      run('qconf', ['-sql']), run('qconf', ['-shgrpl']), run('qconf', ['-sm']), run('qconf', ['-so']), run('qconf', ['-sul']),
    ])
    const jobs = parseJobs(jobXml, cluster), nodes = parseNodes(hostXml, cluster), instances = parseQueueInstances(queueXml)
    const queues = await mapLimited(names(queueList, 'queue'), async name => {
      const config = parseConfig(await run('qconf', ['-sq', name]))
      if (config.qname !== name) throw failure(`qconf -sq ${name} 返回了非预期配置`)
      const members = instances.filter(item => item.name?.split('@')[0] === name)
      return { id: name, name, cluster, status: !members.length ? 'unknown' : members.every(item => /[dD]/.test(item.state)) ? 'disabled' : members.some(item => item.state) ? 'warning' : 'enabled', slots: members.reduce((total, item) => total + (item.slots || 0), 0), used: members.reduce((total, item) => total + (item.used || 0), 0), type: config.qtype || '-', priority: number(config.priority), hostlist: tokens(config.hostlist) }
    })
    const hostGroups = await mapLimited(names(groupList, 'group'), async name => {
      const config = parseConfig(await run('qconf', ['-shgrp', name]))
      if (config.group_name !== name) throw failure(`qconf -shgrp ${name} 返回了非预期配置`)
      return { id: name, name, cluster, hosts: tokens(config.hostlist), queueIds: queues.filter(queue => queue.hostlist.includes(name)).map(queue => queue.id) }
    })
    return {
      mode: 'live', readOnly: true, fetchedAt: new Date().toISOString(),
      clusters: [{ id: cluster, name: env.SGE_CLUSTER_NAME || env.SGE_CELL || 'Grid Engine', host: env.SGE_QMASTER_HOST || '-', status: 'online', description: env.SGE_CELL || '', version: '-' }],
      nodes, queues, jobs, hostGroups,
      users: [...new Set(jobs.map(item => item.user).filter(name => name !== '-'))].map(name => ({ id: name, name, email: '-', role: 'observed', status: 'active', department: '-' })),
      userManagers: entries(managerList), userOperators: entries(operatorList), userLists: entries(userList),
      events: [],
    }
  }
  return {
    async getState() {
      if (cached && Date.now() < expires) return cached
      if (!inFlight) inFlight = collect().then(state => { cached = state; expires = Date.now() + cacheMs; return state }).finally(() => { inFlight = null })
      return inFlight
    },
  }
}