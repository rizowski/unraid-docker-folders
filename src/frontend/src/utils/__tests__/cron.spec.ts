import { describe, it, expect } from 'vitest';
import { describeCron } from '../cron';

describe('describeCron', () => {
  it.each([
    // Presets and the simple shapes the old description handled.
    ['* * * * *', 'Runs every minute'],
    ['0 * * * *', 'Runs every hour'],
    ['0 3 * * *', 'Runs daily at 03:00'],
    ['30 4 * * *', 'Runs daily at 04:30'],
    ['15 2 * * 3', 'Runs at 02:15 on Wednesday'],
    ['*/5 * * * *', 'Runs every 5 minutes'],
    ['0 */2 * * *', 'Runs every 2 hours'],

    // Fields the old description dropped.
    ['*/5 * * * 5', 'Runs every 5 minutes on Friday'],
    ['*/5 9-17 * * 1-5', 'Runs every 5 minutes between 09:00 and 17:59 on Monday through Friday'],
    ['*/15 */2 * * *', 'Runs every 15 minutes during every 2nd hour'],
    ['30 */3 * * *', 'Runs at minute 30 during every 3rd hour'],

    // Minutes and hours.
    ['30 * * * *', 'Runs at minute 30 past every hour'],
    ['0,30 * * * *', 'Runs at minutes 0 and 30 past every hour'],
    ['0-10 * * * *', 'Runs every minute from minute 0 through 10'],
    ['0-30/10 * * * *', 'Runs every 10 minutes from minute 0 through 30'],
    ['0/3 * * * *', 'Runs every 3 minutes from minute 0 through 59'],
    ['5/10 * * * *', 'Runs every 10 minutes from minute 5 through 59'],
    ['0 9,17 * * *', 'Runs daily at 09:00 and 17:00'],
    ['0,30 8,12,18 * * *', 'Runs daily at 08:00, 08:30, 12:00, 12:30, 18:00, and 18:30'],
    ['* 9 * * *', 'Runs every minute during the 09:00 hour'],
    ['0 8-18/2 * * *', 'Runs at minute 0 during every 2nd hour between 08:00 and 18:59'],

    // Days, months, and weekdays.
    ['0 3 1 * *', 'Runs at 03:00 on day 1 of the month'],
    ['0 3 1,15 * *', 'Runs at 03:00 on days 1 and 15 of the month'],
    ['0 3 1-7 * *', 'Runs at 03:00 on days 1 through 7 of the month'],
    ['0 3 */2 * *', 'Runs at 03:00 on every 2nd day of the month'],
    ['0 3 * 1 *', 'Runs at 03:00 in January'],
    ['0 3 * 6-8 *', 'Runs at 03:00 in June through August'],
    ['0 3 * */3 *', 'Runs at 03:00 in every 3rd month'],
    ['0 3 * * 1,3,5', 'Runs at 03:00 on Monday, Wednesday, and Friday'],
    ['0 3 * * 7', 'Runs at 03:00 on Sunday'],
    ['0 3 1 1 *', 'Runs at 03:00 on day 1 of the month in January'],

    // The backend requires day of month AND day of week to match.
    ['0 3 13 * 5', 'Runs at 03:00 on day 13 of the month, only if it is a Friday'],
    ['0 3 1-7 * 1,2', 'Runs at 03:00 on days 1 through 7 of the month, only if it is a Monday or Tuesday'],
  ])('%s → %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  it('falls back to the raw expression instead of dropping a field', () => {
    expect(describeCron('0 3 * * */2')).toBe('Cron: 0 3 * * */2');
    expect(describeCron('0-5,30 * * * *')).toBe('Cron: 0-5,30 * * * *');
    // Seven fixed times is too many to list.
    expect(describeCron('0 1,2,3,4,5,6,7 * * *')).toBe('Cron: 0 1,2,3,4,5,6,7 * * *');
  });

  it.each([
    '* * * *',
    '* * * * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '*/0 * * * *',
    '5-2 * * * *',
    'a * * * *',
  ])('rejects %s', (expr) => {
    expect(describeCron(expr)).toBe('Invalid expression');
  });
});
