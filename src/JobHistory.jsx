import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Clock3, RefreshCw, Search } from 'lucide-react'
import fetch from './api.js'
import { defaultHistoryRange, localDate } from './historyDates.js'
import './JobHistory.css'

const dateText = value => localDate(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'
const timeValue = value => localDate(value) ? new Date(value).getTime() : -Infinity
const statusNames = { completed: '已完成', failed: '失败', unknown: '未知' }

export default function JobHistory({ cluster }) {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [defaultRange] = useState(defaultHistoryRange)
  const [start, setStart] = useState(defaultRange.start)
  const [end, setEnd] = useState(defaultRange.end)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/jobs/history', { signal: controller.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '历史作业查询失败')
      setJobs(result.jobs); setError('')
    }).catch(failure => { if (failure.name !== 'AbortError') setError(failure.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])

  const rows = jobs.filter(item => {
    const day = localDate(item.ended)
    return (cluster === 'all' || item.cluster === cluster) && (!query || `${item.id} ${item.name} ${item.user}`.toLowerCase().includes(query.toLowerCase())) && (!start || day >= start) && (!end || (day && day <= end))
  }).sort((first, second) => timeValue(second.ended) - timeValue(first.ended))
  const pages = Math.max(1, Math.ceil(rows.length / 10)), currentPage = Math.min(page, pages)

  return <section className="panel job-panel">
    <div className="panel-heading"><div><h2>历史作业</h2><span className="panel-note"><span className="count-pill">{rows.length}</span></span></div><button className="icon-button" title="刷新历史作业" aria-label="刷新历史作业" onClick={() => { setLoading(true); setRevision(value => value + 1) }}><RefreshCw size={17} /></button></div>
    <div className="history-toolbar">
      <label>开始日期<input type="date" aria-label="开始日期" value={start} max={end || undefined} onChange={event => { setStart(event.target.value); setPage(1) }} /></label>
      <label>结束日期<input type="date" aria-label="结束日期" value={end} min={start || undefined} onChange={event => { setEnd(event.target.value); setPage(1) }} /></label>
      <label className="search small-search"><Search size={15} /><input aria-label="搜索历史作业" placeholder="搜索作业名称、ID、用户..." value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} /></label>
    </div>
    {error ? <div className="error-banner" role="alert">{error}<button onClick={() => { setLoading(true); setRevision(value => value + 1) }}>重试</button></div> : loading ? <div className="empty-state">正在加载历史作业...</div> : <>
      <div className="table-scroll"><table><thead><tr><th>作业 ID</th><th>作业名称</th><th>用户</th><th>状态</th><th>队列</th><th>执行节点</th><th>槽位</th><th>提交时间</th><th>开始时间</th><th>完成时间</th><th>运行时长</th><th>退出码</th></tr></thead><tbody>{rows.slice((currentPage - 1) * 10, currentPage * 10).map((item, index) => <tr key={`${item.id}-${item.ended}-${index}`}><td className="mono">#{item.id}</td><td>{item.name}</td><td>{item.user}</td><td><span className={`badge ${item.status === 'completed' ? 'online' : item.status === 'failed' ? 'error' : 'unknown'}`}><i />{statusNames[item.status] || '未知'}</span></td><td>{item.queue || '-'}</td><td className="mono muted">{item.node || '-'}</td><td className="mono muted">{item.slots ?? '-'}</td><td className="mono muted">{dateText(item.submitted)}</td><td className="mono muted">{dateText(item.started)}</td><td className="mono muted">{dateText(item.ended)}</td><td className="mono muted">{item.duration || '-'}</td><td className="mono muted">{item.exitStatus ?? '-'}</td></tr>)}</tbody></table>{!rows.length && <div className="empty-state"><Clock3 size={28} /><h3>暂无匹配的历史作业</h3></div>}</div>
      <div className="table-footer"><span>共 {rows.length} 个作业</span><div className="pagination"><button className="icon-button" aria-label="上一页" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></button><span>{currentPage} / {pages}</span><button className="icon-button" aria-label="下一页" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></button></div></div>
    </>}
  </section>
}