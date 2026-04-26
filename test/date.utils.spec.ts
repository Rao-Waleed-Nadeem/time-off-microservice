import {
  calculateBusinessDays,
  isDateTodayOrFuture,
  toDateString,
} from '../src/common/utils/date.utils';

describe('calculateBusinessDays', () => {
  it('counts a single weekday as 1 day', () => {
    // 2025-02-03 is a Monday
    expect(calculateBusinessDays('2025-02-03', '2025-02-03')).toBe(1);
  });

  it('counts Mon-Fri as 5 business days', () => {
    expect(calculateBusinessDays('2025-02-03', '2025-02-07')).toBe(5);
  });

  it('skips weekends over a 2-week span', () => {
    // Mon 2025-02-03 to Fri 2025-02-14 = 10 business days
    expect(calculateBusinessDays('2025-02-03', '2025-02-14')).toBe(10);
  });

  it('returns 0 for a weekend-only range', () => {
    // Sat-Sun 2025-02-01 to 2025-02-02
    expect(calculateBusinessDays('2025-02-01', '2025-02-02')).toBe(0);
  });

  it('returns 0 when end date is before start date', () => {
    expect(calculateBusinessDays('2025-02-10', '2025-02-05')).toBe(0);
  });

  it('handles a single Saturday correctly', () => {
    expect(calculateBusinessDays('2025-02-01', '2025-02-01')).toBe(0);
  });

  it('handles multi-week range correctly', () => {
    // 3 full weeks Mon-Fri = 15 days
    expect(calculateBusinessDays('2025-02-03', '2025-02-21')).toBe(15);
  });
});

describe('isDateTodayOrFuture', () => {
  it('returns true for today', () => {
    const today = toDateString(new Date());
    expect(isDateTodayOrFuture(today)).toBe(true);
  });

  it('returns true for a future date', () => {
    expect(isDateTodayOrFuture('2099-01-01')).toBe(true);
  });

  it('returns false for a past date', () => {
    expect(isDateTodayOrFuture('2000-01-01')).toBe(false);
  });
});
