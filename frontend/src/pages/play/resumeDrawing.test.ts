/** Draw Response Phase B - which drawing a resumed attempt shows.
 *
 * ONE ORDERING MECHANISM: the server revision. Every case below is decided by
 * whether the local draft can PROVE it continued from the version the server
 * currently holds. Nothing compares a clock, and there is deliberately no test
 * that a "newer timestamp" wins - because it must not.
 *
 * The rule protects two things that pull in opposite directions:
 *   - unsaved local work must not be thrown away just because a server copy
 *     exists (a player drawing through a bad connection)
 *   - a stale device must not overwrite newer work saved elsewhere
 */
import { describe, expect, it } from 'vitest';
import { resolveResumeDrawing, type ServerDrawing } from './resumeDrawing';
import type { StoredDraft } from './drawingDraft';
import type { DrawingDocument, DrawingSourceImage } from '../../components/drawing/types';

const SOURCE: DrawingSourceImage = {
  image_id: '42',
  image_version: '2026-08-16T00:00:00Z',
  natural_width: 1200,
  natural_height: 800,
};

const doc = (label: string, source: DrawingSourceImage = SOURCE): DrawingDocument =>
  ({
    format: 'peira.drawing',
    version: 1,
    source,
    coordinate_width: 1200,
    coordinate_height: 800,
    strokes: [{ id: label, tool: 'pen', color: '#f00', width: 4, points: [1, 2, 3, 4], order: 0 }],
  }) as unknown as DrawingDocument;

const draft = (label: string, base: number | null, source = SOURCE): StoredDraft => ({
  document: doc(label, source),
  base_revision: base,
});

const server = (label: string, revision: number): ServerDrawing => ({
  document: doc(label),
  revision,
});

describe('no local draft', () => {
  it('shows the server drawing', () => {
    const decision = resolveResumeDrawing(server('saved', 3), null, SOURCE.image_id);

    expect(decision.document).toEqual(server('saved', 3).document);
    expect(decision.baseRevision).toBe(3);
    expect(decision.replacedLocalWork).toBe(false);
  });

  it('shows nothing when neither exists', () => {
    const decision = resolveResumeDrawing(null, null, SOURCE.image_id);

    expect(decision.document).toBeNull();
    expect(decision.baseRevision).toBeNull();
  });
});

describe('gate 1 - the draft is bound to another image', () => {
  it('discards the draft and falls back to the server', () => {
    const stale = draft('stale', 5, { ...SOURCE, image_id: '999' });

    const decision = resolveResumeDrawing(server('saved', 5), stale, SOURCE.image_id);

    expect(decision.reason).toBe('source-mismatch');
    expect(decision.document).toEqual(server('saved', 5).document);
  });

  it('discards it even when nothing is saved, leaving an empty canvas', () => {
    // Rendering it would put the player's strokes over a picture they never
    // drew on - worse than starting again.
    const stale = draft('stale', null, { ...SOURCE, image_id: '999' });

    const decision = resolveResumeDrawing(null, stale, SOURCE.image_id);

    expect(decision.document).toBeNull();
    expect(decision.reason).toBe('source-mismatch');
  });

  it('does not flag it as replaced work', () => {
    // It was never work for THIS question, so there is nothing to apologise
    // for and no message to show.
    const stale = draft('stale', 5, { ...SOURCE, image_id: '999' });

    expect(resolveResumeDrawing(server('s', 5), stale, SOURCE.image_id).replacedLocalWork).toBe(false);
  });
});

describe('gate 2 - nothing saved on the server yet', () => {
  it('keeps the local draft', () => {
    // The autosave never got through. This is the case where localStorage
    // genuinely is the only copy, and discarding it would BE the data loss.
    const decision = resolveResumeDrawing(null, draft('unsaved', null), SOURCE.image_id);

    expect(decision.document).toEqual(doc('unsaved'));
    expect(decision.reason).toBe('local-only');
    expect(decision.baseRevision).toBeNull();
  });
});

describe('gate 3 - the draft cannot prove it is newer', () => {
  it('prefers the server when the draft has no base revision', () => {
    const decision = resolveResumeDrawing(server('saved', 2), draft('older', null), SOURCE.image_id);

    expect(decision.document).toEqual(doc('saved'));
    expect(decision.reason).toBe('draft-unprovable');
    expect(decision.replacedLocalWork).toBe(true);
  });
});

describe('gate 4 - the draft continues the current server version', () => {
  it('keeps the local draft', () => {
    // THE CASE THAT MUST NOT REGRESS. Strokes added after the last successful
    // save are real work, and a server copy existing is not a reason to bin
    // them.
    const decision = resolveResumeDrawing(server('saved', 7), draft('kept-drawing', 7), SOURCE.image_id);

    expect(decision.document).toEqual(doc('kept-drawing'));
    expect(decision.reason).toBe('draft-continues-server');
    expect(decision.replacedLocalWork).toBe(false);
  });

  it('carries the server revision forward so the next save is not a conflict', () => {
    const decision = resolveResumeDrawing(server('saved', 7), draft('kept', 7), SOURCE.image_id);

    expect(decision.baseRevision).toBe(7);
  });
});

describe('gate 5 - another device saved since', () => {
  it('prefers the server', () => {
    const decision = resolveResumeDrawing(server('from-laptop', 9), draft('from-phone', 8), SOURCE.image_id);

    expect(decision.document).toEqual(doc('from-laptop'));
    expect(decision.reason).toBe('server-newer');
  });

  it('flags that local work was replaced, so the player can be told', () => {
    const decision = resolveResumeDrawing(server('newer', 9), draft('stale', 8), SOURCE.image_id);

    expect(decision.replacedLocalWork).toBe(true);
  });

  it('hands back the SERVER revision, so the stale draft cannot overwrite it', () => {
    // Saving next will be based on 9, not 8 - which is what stops the stale
    // device from winning the race it already lost.
    const decision = resolveResumeDrawing(server('newer', 9), draft('stale', 8), SOURCE.image_id);

    expect(decision.baseRevision).toBe(9);
  });
});

describe('gate 6 - a revision ahead of the server', () => {
  it('distrusts the draft', () => {
    // Impossible from an honest client, so it is treated as corrupt rather
    // than believed.
    const decision = resolveResumeDrawing(server('saved', 3), draft('impossible', 99), SOURCE.image_id);

    expect(decision.document).toEqual(doc('saved'));
    expect(decision.reason).toBe('impossible-revision');
    expect(decision.replacedLocalWork).toBe(true);
  });
});

describe('the ordering mechanism', () => {
  it('ignores anything clock-shaped on the documents', () => {
    // A draft carrying a far-future timestamp still loses on revision. If this
    // ever fails, someone has reintroduced clock comparison.
    const future = draft('future-clock', 4);
    (future.document as unknown as { saved_at: string }).saved_at = '2099-01-01T00:00:00Z';

    const decision = resolveResumeDrawing(server('authoritative', 5), future, SOURCE.image_id);

    expect(decision.document).toEqual(doc('authoritative'));
    expect(decision.reason).toBe('server-newer');
  });
});
