import { useEffect, useRef, useState } from 'react'
import { Layers3, LoaderCircle, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react'
import './QueueGroups.css'

export default function QueueGroups({ data, cluster, onSaved, notify }) {
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef(null)
  const isOpen = Boolean(editor || removing)
  useEffect(() => {
    if (!isOpen) return
    const previous = document.activeElement
    dialog.current?.querySelector('input, button')?.focus()
    return () => previous?.focus()
  }, [isOpen])
  const clusterName = id => data.clusters.find(item => item.id === id)?.name || id
  const groups = (data.hostGroups || []).filter(item => (cluster === 'all' || item.cluster === cluster) && `${item.name} ${item.hosts.join(' ')} ${item.queueIds.join(' ')}`.toLowerCase().includes(query.toLowerCase()))
  function close() { if (!saving) { setEditor(null); setRemoving(null); setError('') } }
  function edit(item) {
    setError('')
    setEditor(item ? { ...item, hosts: [...item.hosts], queueIds: [...item.queueIds] } : { name: '', cluster: cluster === 'all' ? data.clusters[0]?.id || '' : cluster, hosts: [], queueIds: [] })
  }
  function toggle(field, id, checked) {
    setEditor(current => ({ ...current, [field]: checked ? [...current[field], id] : current[field].filter(value => value !== id) }))
  }
  async function submit(event) {
    event.preventDefault()
    setSaving(true); setError('')
    try {
      const item = removing || editor
      const response = await fetch(`/api/hostGroups${item.id ? `/${encodeURIComponent(item.id)}` : ''}`, {
        method: removing ? 'DELETE' : item.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(!removing ? { body: JSON.stringify(editor) } : {}),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setEditor(null); setRemoving(null)
      await onSaved()
      notify(removing ? '队列组已删除' : '队列组已保存')
    } catch (failure) { setError(failure.message) } finally { setSaving(false) }
  }
  return <section className="panel management-panel queue-groups">
    <div className="panel-heading"><div><h2>SGE 队列组</h2><span className="count-pill">{groups.length}</span></div><button className="button primary" disabled={!data.clusters.length} onClick={() => edit()}><Plus size={16} />创建队列组</button></div>
    <div className="management-toolbar"><label className="search"><Search size={16} /><input aria-label="搜索队列组" placeholder="搜索组名、节点、队列..." value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    <div className="table-scroll"><table><thead><tr>{['组名', '所属集群', '成员节点', '关联队列', '操作'].map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{groups.map(item => <tr key={item.id}>
      <td><button className="resource-name" onClick={() => edit(item)}><Layers3 size={16} />{item.name}</button></td><td>{clusterName(item.cluster)}</td><td className="group-members">{item.hosts.join(', ') || '无'}</td><td className="group-members">{item.queueIds.join(', ') || '无'}</td>
      <td><div className="row-actions"><button className="icon-button" title="编辑队列组" aria-label="编辑队列组" onClick={() => edit(item)}><Pencil size={16} /></button><button className="icon-button" title="删除队列组" aria-label="删除队列组" onClick={() => { setError(''); setRemoving(item) }}><Trash2 size={16} /></button></div></td>
    </tr>)}</tbody></table>{!groups.length && <div className="empty-state"><Layers3 size={28} /><h3>{query ? '没有匹配的队列组' : '暂无队列组'}</h3></div>}</div>
    {isOpen && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) close() }}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label={removing ? '删除队列组' : editor.id ? '编辑队列组' : '创建队列组'} onKeyDown={event => {
      if (event.key === 'Escape') close()
      if (event.key !== 'Tab') return
      const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <div className="modal-heading"><h2>{removing ? '删除队列组' : editor.id ? '编辑队列组' : '创建队列组'}</h2><button className="icon-button" title="关闭弹窗" aria-label="关闭弹窗" disabled={saving} onClick={close}><X size={17} /></button></div>
      <form className="resource-form" onSubmit={submit}>
        {removing ? <div className="confirm-content"><h3>确定删除 {removing.name}？</h3><p>{removing.queueIds.length ? '此组仍有关联队列，请先编辑并解除关联。' : '此操作不可撤销，成员节点及队列不会被删除。'}</p></div> : <>
          <label>组名<input name="name" required maxLength={64} pattern="@[a-zA-Z][a-zA-Z0-9_.\-]{0,62}" placeholder="@compute" value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
          <label>所属集群<select value={editor.cluster} required onChange={event => setEditor({ ...editor, cluster: event.target.value, hosts: [], queueIds: [] })}>{data.clusters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {[['hosts', '成员节点', data.nodes], ['queueIds', '关联队列', data.queues]].map(([field, title, resources]) => <fieldset className="group-options" key={field}><legend>{title} · {editor[field].length}</legend><div>{resources.filter(item => item.cluster === editor.cluster).map(item => <label key={item.id}><input type="checkbox" checked={editor[field].includes(item.id)} onChange={event => toggle(field, item.id, event.target.checked)} />{item.name}</label>)}{!resources.some(item => item.cluster === editor.cluster) && <span className="muted">暂无{title}</span>}</div></fieldset>)}
        </>}
        {error && <p className="error-banner" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button" disabled={saving} onClick={close}>取消</button><button type="submit" className={`button ${removing ? 'danger solid' : 'primary'}`} disabled={saving || Boolean(removing?.queueIds.length)}>{saving ? <LoaderCircle size={16} className="spinning" /> : removing ? <Trash2 size={16} /> : <Save size={16} />} {saving ? '正在保存...' : removing ? '确认删除' : '保存队列组'}</button></div>
      </form>
    </section></div>}
  </section>
}