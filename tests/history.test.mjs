import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultHistoryRange, localDate, prepareHistory } from '../src/historyDates.js'

test('default history range uses one calendar month and local dates', () => {
  assert.deepEqual(defaultHistoryRange(new Date(2026, 10, 17)), { start: '2026-10-17', end: '2026-11-17' })
  assert.deepEqual(defaultHistoryRange(new Date(2025, 0, 31)), { start: '2024-12-31', end: '2025-01-31' })
  assert.deepEqual(defaultHistoryRange(new Date(2025, 4, 31)), { start: '2025-04-30', end: '2025-05-31' })
  assert.deepEqual(defaultHistoryRange(new Date(2024, 4, 31)), { start: '2024-04-30', end: '2024-05-31' })
  assert.equal(localDate(null), '')
})

test('prepare history sorts once by completion time and retains searchable data', () => {
  const jobs = [
    { id: '1', name: 'Old', user: 'alice', ended: '2025-01-01T00:00:00Z' },
    { id: '2', name: 'Missing', user: 'bob', ended: null },
    { id: '3', name: 'New', user: 'ALICE', ended: '2025-02-01T00:00:00Z' },
  ]
  const prepared = prepareHistory(jobs)
  assert.deepEqual(prepared.map(entry => entry.item.id), ['3', '1', '2'])
  assert.equal(prepared[0].day, localDate(jobs[2].ended))
  assert.match(prepared[0].search, /new alice/)
  assert.equal(prepared[2].day, '')
  assert.deepEqual(jobs.map(item => item.id), ['1', '2', '3'])
})