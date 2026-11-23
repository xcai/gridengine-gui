import express from 'express'
import { z } from 'zod'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLiveAdapter } from './live.js'
import { createAuth } from './auth.js'

const directory = path.dirname(fileURLToPath(import.meta.url))
const storage = process.env.DATA_FILE || path.join(directory, 'data.json')
const mode = process.env.GRIDENGINE_MODE || 'demo'
if (!['demo', 'live'].includes(mode)) throw new Error('GRIDENGINE_MODE must be demo or live')
const live = mode === 'live' ? createLiveAdapter() : null
const app = express()
app.use(express.json({ limit: '100kb' }))
app.use('/api', createAuth())
app.use('/api', (request, response, next) => {
  if (live && !['GET', 'HEAD'].includes(request.method)) return response.set('Allow', 'GET, HEAD').status(405).json({ error: 'live 模式为只读，不允许修改集群', mode, readOnly: true })
  next()
})

const initialData = () => ({
  clusters: [
    { id: 'production', name: '生产计算集群', host: 'qmaster.prod.internal', status: 'online', description: '核心业务与高性能计算', version: '8.1.9' },
    { id: 'research', name: '科研计算集群', host: 'qmaster.research.internal', status: 'online', description: '模型训练与科学研究', version: '8.1.9' },
    { id: 'development', name: '开发测试集群', host: 'qmaster.dev.internal', status: 'online', description: '开发验证与集成测试', version: '8.1.9' },
  ],
  nodes: Array.from({ length: 24 }, (_, index) => ({ id: `compute-${String(index + 1).padStart(2, '0')}`, name: `compute-${String(index + 1).padStart(2, '0')}`, cluster: index < 16 ? 'production' : index < 22 ? 'research' : 'development', status: index === 19 ? 'offline' : index === 12 ? 'warning' : 'online', cpu: index === 19 ? 0 : 35 + (index * 17 % 61), memory: index === 19 ? 0 : 28 + (index * 13 % 65), cores: 64, ram: 256, ip: `10.0.1.${index + 10}` })),
  queues: [
    { id: 'all.q', name: 'all.q', cluster: 'production', status: 'enabled', slots: 512, used: 386, type: '通用计算', priority: 0 },
    { id: 'gpu.q', name: 'gpu.q', cluster: 'production', status: 'enabled', slots: 128, used: 96, type: 'GPU 加速', priority: 10 },
    { id: 'long.q', name: 'long.q', cluster: 'production', status: 'enabled', slots: 256, used: 148, type: '长时作业', priority: 0 },
    { id: 'short.q', name: 'short.q', cluster: 'research', status: 'enabled', slots: 128, used: 42, type: '短时作业', priority: 5 },
    { id: 'test.q', name: 'test.q', cluster: 'development', status: 'disabled', slots: 64, used: 0, type: '开发测试', priority: 0 },
  ],
  users: ['zhangwei', 'lina', 'wanghao', 'chenxi', 'liuyang', 'admin'].map((name, index) => ({ id: name, name, email: `${name}@gridengine.local`, role: index === 5 ? 'admin' : index === 0 ? 'operator' : 'user', status: 'active', department: ['计算科学', '人工智能', '生物信息', '工程仿真', '数据分析', '平台运维'][index] })),
  jobs: Array.from({ length: 156 }, (_, index) => ({ id: String(10248 - index), name: ['train_llama3_8b', 'molecular_dynamics', 'rnaseq_pipeline', 'cfd_simulation', 'data_preprocessing', 'bert_finetune', 'genome_assembly', 'weather_forecast'][index % 8], user: ['zhangwei', 'lina', 'wanghao', 'chenxi', 'liuyang'][index % 5], queue: ['gpu.q', 'all.q', 'all.q', 'long.q', 'short.q'][index % 5], cluster: index % 5 === 4 ? 'research' : 'production', status: index < 128 ? 'running' : index < 152 ? 'pending' : 'error', slots: [8, 16, 4, 32, 8][index % 5], submitted: new Date(Date.now() - (index * 7 + 12) * 60000).toISOString(), command: '#!/bin/bash\n#$ -cwd\n#$ -j y\npython main.py', duration: index < 128 ? `${Math.floor(index / 5) + 1}h ${index * 7 % 60}m` : '-', node: `compute-${String(index % 18 + 1).padStart(2, '0')}` })),
  events: [
    { id: 1, type: 'warning', title: 'compute-13 CPU 使用率偏高', detail: '生产计算集群 · CPU 使用率超过 90%', time: '2 分钟前' },
    { id: 2, type: 'success', title: '作业 #10249 已完成', detail: 'zhangwei · train_resnet50 · 用时 2h 18m', time: '8 分钟前' },
    { id: 3, type: 'error', title: 'compute-20 节点离线', detail: '科研计算集群 · 执行守护进程无响应', time: '15 分钟前' },
    { id: 4, type: 'info', title: '队列 gpu.q 配置已更新', detail: 'admin · 并行槽位调整为 128', time: '32 分钟前' },
  ],
})

let data
if (!live) {
  try { data = JSON.parse(await readFile(storage, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    data = initialData()
  }
  data.hostGroups ??= []
}
let writeChain = Promise.resolve()
const persist = () => {
  const snapshot = JSON.stringify(data, null, 2)
  writeChain = writeChain.catch(() => {}).then(() => writeFile(storage, snapshot))
  return writeChain
}
const record = (title) => data.events.unshift({ id: Date.now(), type: 'info', title, detail: 'admin · 演示环境', time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) })
app.get('/api/state', async (_request, response) => {
  response.set('Cache-Control', 'no-store').json(live ? await live.getState() : { ...data, mode, readOnly: false })
})
app.get('/api/jobs/history', async (request, response) => {
  const parsed = z.object({ start: z.iso.datetime().optional(), end: z.iso.datetime().optional(), refresh: z.literal('1').optional() }).safeParse(request.query)
  if (!parsed.success || (parsed.data.start && parsed.data.end && new Date(parsed.data.start) > new Date(parsed.data.end))) return response.status(400).json({ error: '无效日期范围' })
  const controller = new AbortController()
  const cancel = () => { if (!response.writableEnded) controller.abort() }
  response.on('close', cancel)
  try {
    const jobs = live ? await live.getJobHistory(parsed.data, { signal: controller.signal, refresh: parsed.data.refresh === '1' }) : data.jobs.filter(job => ['completed', 'failed'].includes(job.status))
    if (!controller.signal.aborted) response.set('Cache-Control', 'no-store').json({ jobs })
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally { response.off('close', cancel) }
})
app.get('/api/jobs/:id/detail', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  if (!live) {
    const item = data.jobs.find(job => job.id === request.params.id)
    return item ? response.json({ item }) : response.status(404).json({ error: '作业不存在' })
  }
  if (!/^[0-9]+$/.test(request.params.id)) return response.status(400).json({ error: '无效作业 ID' })
  response.json({ output: await live.getJobDetail(request.params.id) })
})

const hostGroupSchema = z.object({
  name: z.string().regex(/^@[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/, '组名须以 @ 和英文字母开头'),
  cluster: z.string().min(1),
  hosts: z.array(z.string()).max(4096).refine(values => new Set(values).size === values.length),
  queueIds: z.array(z.string()).max(4096).refine(values => new Set(values).size === values.length),
})
async function saveHostGroup(request, response) {
  const existing = request.params.id ? data.hostGroups.find(item => item.id === request.params.id) : null
  if (request.params.id && !existing) return response.status(404).json({ error: '队列组不存在' })
  const parsed = hostGroupSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: '请检查组名、成员节点及关联队列', details: parsed.error.issues })
  const values = parsed.data
  if (!data.clusters.some(item => item.id === values.cluster)) return response.status(400).json({ error: '集群不存在' })
  if (data.hostGroups.some(item => item.id !== existing?.id && item.cluster === values.cluster && item.name === values.name)) return response.status(409).json({ error: '该集群中已存在同名队列组' })
  if (values.hosts.some(id => !data.nodes.some(item => item.id === id && item.cluster === values.cluster))) return response.status(400).json({ error: '成员节点必须属于所选集群' })
  if (values.queueIds.some(id => !data.queues.some(item => item.id === id && item.cluster === values.cluster))) return response.status(400).json({ error: '关联队列必须属于所选集群' })
  const item = existing || { id: crypto.randomUUID() }
  Object.assign(item, values)
  if (!existing) data.hostGroups.unshift(item)
  record(`${existing ? '更新' : '创建'}队列组 ${item.name}`)
  await persist()
  response.status(existing ? 200 : 201).json(item)
}
app.post('/api/hostGroups', saveHostGroup)
app.patch('/api/hostGroups/:id', saveHostGroup)
app.delete('/api/hostGroups/:id', async (request, response) => {
  const item = data.hostGroups.find(entry => entry.id === request.params.id)
  if (!item) return response.status(404).json({ error: '队列组不存在' })
  if (item.queueIds.length) return response.status(409).json({ error: '请先解除队列组的队列关联' })
  data.hostGroups = data.hostGroups.filter(entry => entry.id !== item.id)
  record(`删除队列组 ${item.name}`)
  await persist()
  response.json({ success: true })
})

const schemas = {
  jobs: z.object({ name: z.string().min(1).max(80), queue: z.string().min(1), slots: z.coerce.number().int().min(1).max(512), command: z.string().min(1).max(20000), user: z.string().default('admin') }),
  users: z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/), email: z.email(), role: z.enum(['admin', 'operator', 'user']), department: z.string().max(80) }),
  nodes: z.object({ name: z.string().min(1).max(80), ip: z.ipv4(), cluster: z.string(), cores: z.coerce.number().int().min(1).max(4096), ram: z.coerce.number().int().min(1).max(65536) }),
  queues: z.object({ name: z.string().min(1).max(80), cluster: z.string(), slots: z.coerce.number().int().min(1).max(65536), type: z.string(), priority: z.coerce.number().int().min(-1024).max(1024) }),
  clusters: z.object({ name: z.string().min(1).max(80), host: z.string().min(1).max(255), description: z.string().max(200) }),
}
app.post('/api/:resource', async (request, response) => {
  const { resource } = request.params
  if (!schemas[resource]) return response.status(404).json({ error: '资源不存在' })
  const parsed = schemas[resource].safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: '请检查表单中的必填项和数据格式', details: parsed.error.issues })
  const values = parsed.data
  if (data[resource].some(item => item.name === values.name && resource !== 'jobs')) return response.status(409).json({ error: '名称已存在' })
  if (values.cluster && !data.clusters.some(item => item.id === values.cluster)) return response.status(400).json({ error: '集群不存在' })
  if (resource === 'jobs') {
    const queue = data.queues.find(item => item.id === values.queue)
    if (!queue || queue.status !== 'enabled') return response.status(400).json({ error: '请选择可用队列' })
    if (!data.users.some(item => item.name === values.user && item.status === 'active')) return response.status(400).json({ error: '运行用户不存在或已停用' })
    if (!data.clusters.some(item => item.id === queue.cluster && item.status === 'online')) return response.status(400).json({ error: '目标集群已停用' })
    if (values.slots > queue.slots) return response.status(400).json({ error: '请求槽位数超过队列容量' })
    values.cluster = queue.cluster
  }
  const defaults = { jobs: { status: 'pending', submitted: new Date().toISOString(), duration: '-', node: '-' }, nodes: { status: 'online', cpu: 0, memory: 0 }, users: { status: 'active' }, queues: { status: 'enabled', used: 0 }, clusters: { status: 'online', version: '8.1.9' } }
  const id = resource === 'jobs' ? String(Math.max(...data.jobs.map(item => Number(item.id)), 10248) + 1) : resource === 'queues' || resource === 'nodes' || resource === 'users' ? values.name : `cluster-${Date.now()}`
  const item = { ...defaults[resource], ...values, id }
  data[resource].unshift(item)
  record(`新增${{ jobs: '作业', nodes: '节点', users: '用户', queues: '队列', clusters: '集群' }[resource]} ${item.name}`)
  await persist()
  response.status(201).json(item)
})
app.patch('/api/:resource/:id', async (request, response) => {
  const { resource, id } = request.params
  if (!schemas[resource]) return response.status(404).json({ error: '资源不存在' })
  const item = data[resource].find(entry => entry.id === id)
  if (!item) return response.status(404).json({ error: '记录不存在' })
  if (resource === 'users' && id === 'admin') return response.status(400).json({ error: '不能停用当前管理员' })
  const allowed = { jobs: ['running', 'held', 'deleted'], nodes: ['online', 'offline'], queues: ['enabled', 'disabled'], users: ['active', 'disabled'], clusters: ['online', 'offline'] }
  if (!allowed[resource].includes(request.body.status)) return response.status(400).json({ error: '无效状态' })
  if (resource === 'jobs' && ['deleted', 'error'].includes(item.status)) return response.status(409).json({ error: '该作业已结束，无法更改状态' })
  item.status = request.body.status
  record(`${item.name} 状态已更新为 ${item.status}`)
  await persist()
  response.json(item)
})
app.delete('/api/:resource/:id', async (request, response) => {
  const { resource, id } = request.params
  if (!schemas[resource] || resource === 'jobs') return response.status(400).json({ error: '不支持此操作' })
  const item = data[resource].find(entry => entry.id === id)
  if (!item) return response.status(404).json({ error: '记录不存在' })
  if (resource === 'users' && id === 'admin') return response.status(400).json({ error: '不能删除当前管理员' })
  if (resource === 'clusters' && data.hostGroups.some(entry => entry.cluster === id)) return response.status(409).json({ error: '请先删除集群关联的队列组' })
  if (resource === 'nodes' && data.hostGroups.some(entry => entry.hosts.includes(id))) return response.status(409).json({ error: '请先将节点移出队列组' })
  if (resource === 'queues' && data.hostGroups.some(entry => entry.queueIds.includes(id))) return response.status(409).json({ error: '请先解除队列的队列组关联' })
  if (resource === 'clusters' && [...data.nodes, ...data.queues, ...data.jobs].some(entry => entry.cluster === id)) return response.status(409).json({ error: '请先移除集群关联的节点、队列及作业' })
  if (resource === 'queues' && data.jobs.some(entry => entry.queue === id && ['running', 'pending', 'held'].includes(entry.status))) return response.status(409).json({ error: '该队列仍有活动作业' })
  data[resource] = data[resource].filter(entry => entry.id !== id)
  record(`已删除 ${item.name}`)
  await persist()
  response.json({ success: true })
})
app.use(express.static(path.join(directory, '../dist')))
app.get('/{*path}', (request, response) => {
  if (request.path.startsWith('/api/')) return response.status(404).json({ error: '接口不存在' })
  response.sendFile(path.join(directory, '../dist/index.html'))
})
app.use((error, _request, response, _next) => {
  console.error(error.message)
  response.status(error.status || 500).json({ error: error.code === 'SGE_QUERY_FAILED' ? error.message : '请求失败，请稍后重试', mode, readOnly: Boolean(live) })
})
if (!live) await mkdir(path.dirname(storage), { recursive: true })
const port = process.env.API_PORT || 3101
app.listen(port, '0.0.0.0', error => {
  if (error) { console.error(`API startup failed: ${error.message}`); process.exitCode = 1; return }
  console.log(`Grid Engine API: http://localhost:${port} (${mode}${live ? ', read-only' : ''})`)
})