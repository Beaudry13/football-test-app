import { describe, expect, it } from 'vitest';
import {
  countQuizzesInFolderTree,
  folderTreeIds,
  folderTreeOrder,
  quizzesInFolderTree,
} from './folderTotals';
import { buildTree } from './admin/adminTree';
import type { Folder, Quiz } from '../api/types';

function folder(id: number, name: string, parent: number | null = null): Folder {
  return {
    id,
    organization_id: 1,
    coach_id: 1,
    name,
    parent_folder_id: parent,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function quiz(id: number, folderId: number | null, coachId = 1): Quiz {
  return {
    id,
    coach_id: coachId,
    organization_id: 1,
    folder_id: folderId,
    title: `Quiz ${id}`,
    description: null,
    one_question_at_a_time: true,
    require_all_answers: false,
    question_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as Quiz;
}

/** The exact structure from the bug report:
 *
 *   2026 SEASON
 *     FALL CAMP
 *       INSTALL QUIZ
 *         Quiz A, B, C, D
 */
const SEASON = 1;
const FALL_CAMP = 2;
const INSTALL_QUIZ = 3;

function reportedTree() {
  const folders = [
    folder(SEASON, '2026 SEASON'),
    folder(FALL_CAMP, 'FALL CAMP', SEASON),
    folder(INSTALL_QUIZ, 'INSTALL QUIZ', FALL_CAMP),
  ];
  const quizzes = [1, 2, 3, 4].map((id) => quiz(id, INSTALL_QUIZ));
  return { folders, quizzes };
}

describe('folder totals', () => {
  it('counts quizzes in descendant folders, not just direct children', () => {
    // THE reported bug: FALL CAMP displayed (0) while INSTALL QUIZ inside it
    // displayed (4).
    const { folders, quizzes } = reportedTree();

    expect(countQuizzesInFolderTree(SEASON, folders, quizzes)).toBe(4);
    expect(countQuizzesInFolderTree(FALL_CAMP, folders, quizzes)).toBe(4);
    expect(countQuizzesInFolderTree(INSTALL_QUIZ, folders, quizzes)).toBe(4);
  });

  it('adds quizzes sitting directly at each level', () => {
    const { folders, quizzes } = reportedTree();
    // Two more directly in FALL CAMP, one directly in 2026 SEASON.
    quizzes.push(quiz(5, FALL_CAMP), quiz(6, FALL_CAMP), quiz(7, SEASON));

    expect(countQuizzesInFolderTree(SEASON, folders, quizzes)).toBe(7);
    expect(countQuizzesInFolderTree(FALL_CAMP, folders, quizzes)).toBe(6);
    expect(countQuizzesInFolderTree(INSTALL_QUIZ, folders, quizzes)).toBe(4);
  });

  it('counts through five levels of nesting', () => {
    const folders = [
      folder(1, 'L1'),
      folder(2, 'L2', 1),
      folder(3, 'L3', 2),
      folder(4, 'L4', 3),
      folder(5, 'L5', 4),
    ];
    const quizzes = [quiz(10, 5)];

    for (const id of [1, 2, 3, 4, 5]) {
      expect(countQuizzesInFolderTree(id, folders, quizzes)).toBe(1);
    }
  });

  it('is zero for a genuinely empty folder', () => {
    const folders = [folder(1, 'Empty'), folder(2, 'Child', 1)];

    expect(countQuizzesInFolderTree(1, folders, [])).toBe(0);
  });

  it('ignores quizzes in sibling branches', () => {
    const folders = [folder(1, 'Root'), folder(2, 'A', 1), folder(3, 'B', 1)];
    const quizzes = [quiz(10, 2), quiz(11, 3)];

    expect(countQuizzesInFolderTree(2, folders, quizzes)).toBe(1);
    expect(countQuizzesInFolderTree(3, folders, quizzes)).toBe(1);
    expect(countQuizzesInFolderTree(1, folders, quizzes)).toBe(2);
  });

  it('never counts an uncategorized quiz', () => {
    const folders = [folder(1, 'Root')];

    expect(countQuizzesInFolderTree(1, folders, [quiz(10, null)])).toBe(0);
  });

  it('counts only what the caller passed, which is what scopes it', () => {
    // Coach View hands it own-only quizzes and Admin View hands it the whole
    // organization. The helper deliberately cannot tell the difference.
    const { folders } = reportedTree();
    const mine = [quiz(1, INSTALL_QUIZ, 1)];
    const everyones = [quiz(1, INSTALL_QUIZ, 1), quiz(2, INSTALL_QUIZ, 99)];

    expect(countQuizzesInFolderTree(FALL_CAMP, folders, mine)).toBe(1);
    expect(countQuizzesInFolderTree(FALL_CAMP, folders, everyones)).toBe(2);
  });

  it('survives a cycle instead of hanging the page', () => {
    // Impossible today - parents are fixed at creation - but a counter is the
    // wrong place to find out that a future move feature broke that.
    const folders = [folder(1, 'A', 2), folder(2, 'B', 1)];

    expect(folderTreeIds(1, folders).size).toBeLessThanOrEqual(2);
    expect(countQuizzesInFolderTree(1, folders, [quiz(10, 2)])).toBe(1);
  });

  it('returns the quizzes themselves, not just a number', () => {
    const { folders, quizzes } = reportedTree();

    expect(quizzesInFolderTree(FALL_CAMP, folders, quizzes).map((q) => q.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

describe('Coach View and Admin View agree', () => {
  it('produce the same total for the same tree', () => {
    // The divergence this file was written to end: Admin View aggregated
    // recursively while Coach View counted direct children only, so one
    // folder showed two different numbers on two screens.
    const { folders, quizzes } = reportedTree();
    quizzes.push(quiz(5, FALL_CAMP), quiz(6, SEASON));

    const tree = buildTree(folders, quizzes as never);
    const season = tree.find((node) => node.id === SEASON);
    const fallCamp = season?.children.find((node) => node.id === FALL_CAMP);

    expect(season?.totalQuizzes).toBe(countQuizzesInFolderTree(SEASON, folders, quizzes));
    expect(fallCamp?.totalQuizzes).toBe(countQuizzesInFolderTree(FALL_CAMP, folders, quizzes));
  });
});

describe('folder picker order', () => {
  it('lists every folder, at any depth, in tree order', () => {
    // The bug: the move-to-folder dropdown listed roots and their DIRECT
    // children only, so once the nesting cap was lifted a folder three or
    // more levels down could not be chosen at all.
    const folders = [
      folder(1, 'L1'),
      folder(2, 'L2', 1),
      folder(3, 'L3', 2),
      folder(4, 'L4', 3),
      folder(5, 'L5', 4),
    ];

    const ordered = folderTreeOrder(folders);

    expect(ordered.map((o) => o.folder.name)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    expect(ordered.map((o) => o.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it('puts each subtree directly under its root', () => {
    const folders = [
      folder(1, 'Season A'),
      folder(2, 'Camp', 1),
      folder(3, 'Season B'),
    ];

    expect(folderTreeOrder(folders).map((o) => o.folder.name)).toEqual([
      'Season A',
      'Camp',
      'Season B',
    ]);
  });

  it('returns nothing for no folders', () => {
    expect(folderTreeOrder([])).toEqual([]);
  });

  it('does not hang on a cycle', () => {
    const folders = [folder(1, 'A', 2), folder(2, 'B', 1)];

    expect(folderTreeOrder(folders).length).toBeLessThanOrEqual(2);
  });
});
