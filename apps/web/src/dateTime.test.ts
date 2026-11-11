import { expect, it } from 'vitest';
import { formatDate, formatTimestamp } from './dateTime.js';

it('labels local 24-hour timestamps and handles unavailable dates', () => {
  expect(formatTimestamp('2026-11-11T18:30:00Z')).toMatch(
    /11 Nov 2026, \d{2}:30 .+/,
  );
  expect(formatTimestamp('2026-11-11T18:30:00Z')).not.toMatch(/AM|PM/);
  expect(formatTimestamp('invalid')).toBe('Time unavailable');
  expect(formatDate('2026-11-04')).toBe('4 Nov 2026');
});
