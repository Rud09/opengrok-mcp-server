import { describe, it, expect, beforeEach } from 'vitest';
import { ObservationMasker } from '../server/observation-masker.js';

// ---------------------------------------------------------------------------
// Basic record / getMaskedHistoryHeader
// ---------------------------------------------------------------------------

describe('ObservationMasker', () => {
  let masker: ObservationMasker;

  beforeEach(() => {
    masker = new ObservationMasker();
  });

  it('starts with size 0', () => {
    expect(masker.size).toBe(0);
  });

  it('record() stores entries and increments size', () => {
    masker.record(1, 'opengrok_execute', 'search("test")', 'result text');
    expect(masker.size).toBe(1);
    masker.record(2, 'opengrok_execute', 'search("foo")', 'another result');
    expect(masker.size).toBe(2);
  });

  it('getMaskedHistoryHeader returns empty string when no entries', () => {
    expect(masker.getMaskedHistoryHeader()).toBe('');
  });

  it('getMaskedHistoryHeader returns empty string with ≤10 entries', () => {
    for (let i = 1; i <= 10; i++) {
      masker.record(i, 'opengrok_execute', `code${i}`, `result${i}`);
    }
    expect(masker.getMaskedHistoryHeader()).toBe('');
  });

  it('getMaskedHistoryHeader returns compact summaries after >10 entries', () => {
    for (let i = 1; i <= 12; i++) {
      masker.record(i, 'opengrok_execute', `search("sym${i}")`, `result for sym${i}`);
    }
    const header = masker.getMaskedHistoryHeader();
    expect(header).not.toBe('');
    // Should contain the ObservationMask comment
    expect(header).toContain('ObservationMask');
    // Should mention the 2 masked entries (12 - 10 = 2)
    expect(header).toContain('2 earlier tool calls summarized');
  });

  it('header contains [Turn X] references for masked entries', () => {
    for (let i = 1; i <= 11; i++) {
      masker.record(i, 'opengrok_execute', `query${i}`, `result${i}`);
    }
    const header = masker.getMaskedHistoryHeader();
    // The first entry (turn 1) should be summarized
    expect(header).toContain('[Turn 1]');
    // The 11th entry should NOT be in the summary (it's in the full window)
    expect(header).not.toContain('[Turn 11]');
  });

  it('summary extraction preserves file paths', () => {
    masker.record(
      1,
      'opengrok_execute',
      'search',
      'Found in myproject/src/EventLoop.cpp at line L245'
    );
    // Trigger masking with >10 entries
    for (let i = 2; i <= 11; i++) {
      masker.record(i, 'opengrok_execute', `q${i}`, `r${i}`);
    }
    const header = masker.getMaskedHistoryHeader();
    expect(header).toContain('EventLoop.cpp');
  });

  it('summary extraction preserves line numbers', () => {
    masker.record(1, 'opengrok_execute', 'code', 'found at L100 and :200 in file.cpp');
    for (let i = 2; i <= 11; i++) {
      masker.record(i, 'opengrok_execute', `q${i}`, `r${i}`);
    }
    const header = masker.getMaskedHistoryHeader();
    expect(header).toMatch(/L100|:200/);
  });

  it('summary extraction preserves symbol names', () => {
    masker.record(1, 'opengrok_execute', 'code', 'EventLoop::handleEvent triggered from MainLoop');
    for (let i = 2; i <= 11; i++) {
      masker.record(i, 'opengrok_execute', `q${i}`, `r${i}`);
    }
    const header = masker.getMaskedHistoryHeader();
    // Should contain at least one of the CamelCase symbols
    expect(header).toMatch(/EventLoop|MainLoop|handleEvent/);
  });

  it('header ends with END EARLIER OBSERVATIONS marker', () => {
    for (let i = 1; i <= 11; i++) {
      masker.record(i, 'opengrok_execute', `q${i}`, `r${i}`);
    }
    const header = masker.getMaskedHistoryHeader();
    expect(header).toContain('END EARLIER OBSERVATIONS');
  });
});
