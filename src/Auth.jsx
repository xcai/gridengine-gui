import { useEffect, useState } from 'react'
import { Boxes, LoaderCircle, LogIn } from 'lucide-react'
import App from './App.jsx'
import './Auth.css'

export default function Auth() {
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const expired = () => { setUser(null); setError('会话已过期，请重新登录') }
    window.addEventListener('session-expired', expired)
    fetch('/api/auth/me').then(async response => {
      if (response.ok) {
        const result = await response.json()
        if (active) setUser(result.user)
      } else if (response.status !== 401) throw new Error('暂时无法连接认证服务')
    }).catch(() => { if (active) setError('暂时无法连接认证服务') }).finally(() => { if (active) setChecking(false) })
    return () => { active = false; window.removeEventListener('session-expired', expired) }
  }, [])

  async function login(event) {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget))
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '登录失败')
      setUser(result.user)
    } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  async function logout() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (!response.ok) throw new Error('退出失败，请重试')
      setUser(null); setError('')
    } catch (failure) { window.alert(failure.message) }
  }
  if (checking) return <div className="auth-screen"><LoaderCircle className="spinning" aria-label="正在验证登录状态" /></div>
  if (user) return <App account={user} onLogout={logout} />
  return <div className="auth-screen"><section className="auth-content" aria-labelledby="login-title">
    <div className="auth-brand"><span className="brand-mark"><Boxes size={30} /></span><span>GridEngine<small>COMPUTE MANAGEMENT</small></span></div>
    <h1 id="login-title">登录控制台</h1>
    <form className="auth-form" onSubmit={login}>
      <label htmlFor="login-username">账号</label><input id="login-username" name="username" autoComplete="username" required maxLength={40} autoFocus disabled={busy} />
      <label htmlFor="login-password">密码</label><input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={128} disabled={busy} />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spinning" /> : <LogIn size={17} />}{busy ? '正在登录...' : '登录'}</button>
    </form>
  </section></div>
}