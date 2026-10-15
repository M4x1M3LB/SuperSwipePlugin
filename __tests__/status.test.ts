import {summarise} from '../src/status';

describe('stroke history', () => {
  it('keeps the time line out of the stroke history', () => {
    const line = summarise({kind: 'ignored', reason: 'not a gesture'}, [
      '  wave check: too few points',
      'time: 12 ms in all; no SDK calls (ms of parallel calls summed)',
    ]);
    expect(line).toMatch(
      /Last stroke left as ink: not a gesture\. \(wave check: too few points\)$/,
    );
  });
});
