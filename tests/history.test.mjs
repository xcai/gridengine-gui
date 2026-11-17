import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultHistoryRange, localDate } from '../src/historyDates.js'

test('default history range uses three calendar months and local dates', () => {
  assert.deepEqual(defaultHistoryRange(new Date(2026, 10, 17)), { start: '2026-08-17', end: '2026-11-17' })
  assert.deepEqual(defaultHistoryRange(new Date(2025, 0, 31)), { start: '2024-10-31', end: '2025-01-31' })
  assert.deepEqual(defaultHistoryRange(new Date(2025, 4, 31)), { start: '2025-02-28', end: '2025-05-31' })
  assert.deepEqual(defaultHistoryRange(new Date(2024, 4, 31)), { start: '2024-02-29', end: '2024-05-31' })
  assert.equal(localDate(null), '')
})