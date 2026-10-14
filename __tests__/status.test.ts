import {status, summarisePageReads, summarise} from '../src/status';

describe('page read counts', () => {
  it('groups how strokes that read the page ended, numbers left out', () => {
    expect(summarisePageReads(0, new Map())).toBe('Page reads: none yet.');

    status.countPageRead({kind: 'ignored', reason: 'loop encloses nothing'});
    status.countPageRead({kind: 'ignored', reason: 'loop encloses nothing'});
    status.countPageRead({
      kind: 'ignored',
      reason: 'bar too short (105 px, needs 112)',
    });
    status.countPageRead({
      kind: 'ignored',
      reason: 'bar too short (90 px, needs 112)',
    });
    status.countPageRead({kind: 'ignored', reason: 'page changed'});
    status.countPageRead({
      kind: 'selected',
      count: 3,
      rect: {left: 0, top: 0, right: 1, bottom: 1},
    });
    status.countPageRead({kind: 'failed', reason: 'timed out'});
    expect(status.pageReadSummary()).toBe(
      'Page reads: 7; 5 left as ink: loop encloses nothing 2, ' +
        'bar too short (# px, needs #) 2, page changed 1; 1 selected; ' +
        '1 failed: timed out 1.',
    );
  });

  it('counts motion events by action and the screens listening', () => {
    for (const action of [0, 2, 2, 1, 7]) {
      status.countMotion(action);
    }
    expect(status.motionSummary()).toBe('0: 1, 1: 1, 2: 2, 7: 1');
    const unsubscribe = status.subscribe(() => {});
    expect(status.listenerCount()).toBe(1);
    unsubscribe();
    expect(status.listenerCount()).toBe(0);
  });

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
