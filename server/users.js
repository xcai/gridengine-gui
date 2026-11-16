import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { changeAccount, publicAccount, readAccounts } from './auth.js'

async function passwordInput(fromStdin) {
  if (fromStdin) {
    let value = ''
    for await (const chunk of process.stdin) {
      value += chunk
      if (value.length > 1024) throw new Error('Password input too long')
    }
    return value.replace(/\r?\n$/, '')
  }
  if (!process.stdin.isTTY) throw new Error('Use --password-stdin for non-interactive password input')
  const output = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const terminal = createInterface({ input: process.stdin, output, terminal: true })
  try {
    process.stdout.write('Password (12-128 characters, hidden): ')
    const password = await terminal.question('')
    process.stdout.write('\nConfirm password: ')
    const confirmation = await terminal.question('')
    process.stdout.write('\n')
    if (password !== confirmation) throw new Error('Passwords do not match')
    return password
  } finally { terminal.close() }
}

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    role: { type: 'string' }, disabled: { type: 'string' },
    'reset-password': { type: 'boolean' }, 'password-stdin': { type: 'boolean' }, help: { type: 'boolean' },
  } })
  const [action, username] = positionals
  if (values.help || !action) {
    console.log('Usage: pnpm admin:users <list|get|create|update|delete> [username] [options]\nOptions: --role admin|user --disabled true|false --reset-password --password-stdin\nCreate prompts for a hidden password. Update uses --reset-password or --password-stdin.\nAUTH_FILE selects the account file; run as the service OS account or a trusted administrator.')
  } else {
    if (!['list', 'get', 'create', 'update', 'delete'].includes(action) || positionals.length > 2 || (action === 'list' ? username : !username)) throw new Error('Invalid command; use --help')
    if (['list', 'get', 'delete'].includes(action) && Object.keys(values).length) throw new Error('This command does not accept update options')
    if (['list', 'get'].includes(action)) {
      const accounts = (await readAccounts()).map(publicAccount)
      const result = action === 'list' ? accounts : accounts.find(account => account.username === username)
      if (!result) throw new Error('Account not found')
      console.log(JSON.stringify(result, null, 2))
    } else {
      const changes = {}
      if (values.role !== undefined) changes.role = values.role
      if (values.disabled !== undefined) {
        if (!['true', 'false'].includes(values.disabled)) throw new Error('--disabled must be true or false')
        changes.disabled = values.disabled === 'true'
      }
      if (action === 'create' || values['reset-password'] || values['password-stdin']) changes.password = await passwordInput(values['password-stdin'])
      if (action === 'update' && !Object.keys(changes).length) throw new Error('No update options supplied')
      console.log(JSON.stringify(await changeAccount(action, username, changes), null, 2))
    }
  }
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Account file is locked by another writer; retry later. After a crashed writer, remove AUTH_FILE.lock only after confirming no writer is running.' : error.message)
  process.exitCode = 1
}