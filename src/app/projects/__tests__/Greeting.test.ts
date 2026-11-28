import { describe, it, expect } from 'vitest';
import { greetingFor } from '../Greeting';

describe('greetingFor', () => {
  it.each([
    [5, 'Good morning'], [11, 'Good morning'], [12, 'Good afternoon'], [17, 'Good afternoon'],
    [18, 'Good evening'], [23, 'Good evening'], [0, 'Good evening'], [4, 'Good evening'],
  ])('%i o\'clock: %s', (hour, text) => expect(greetingFor(hour)).toBe(text));
});
// ci-replay touch
