export const localDate = value => {
  const date = new Date(value)
  return value && !Number.isNaN(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : ''
}

export function defaultHistoryRange(today = new Date()) {
  const year = today.getFullYear(), month = today.getMonth()
  const lastDay = new Date(year, month, 0).getDate()
  const start = new Date(year, month - 1, Math.min(today.getDate(), lastDay))
  return { start: localDate(start), end: localDate(today) }
}