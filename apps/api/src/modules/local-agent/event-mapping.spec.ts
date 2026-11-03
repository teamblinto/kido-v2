import { describe, expect, it } from 'vitest';

import { mapCompanionEvent } from './event-mapping';

const RUN = 'b0400000-0000-4000-8000-000000000001';

describe('mapCompanionEvent', () => {
  it('records the CLI’s own cost of a turn as the run’s cost, and 0 from an older runner', () => {
    expect(
      mapCompanionEvent(RUN, {
        data: { costMicros: 41_250, inputTokens: 10, outputTokens: 5 },
        seq: 1,
        type: 'usage',
      }),
    ).toEqual({ data: { costMicros: 41_250, inputTokens: 10, outputTokens: 5 }, type: 'usage' });
    expect(
      mapCompanionEvent(RUN, { data: { inputTokens: 10, outputTokens: 5 }, seq: 2, type: 'usage' }),
    ).toEqual({ data: { costMicros: 0, inputTokens: 10, outputTokens: 5 }, type: 'usage' });
  });
});
