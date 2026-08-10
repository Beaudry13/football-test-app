import { describe, expect, it } from 'vitest';
import {
  UNCATEGORISED_NAME,
  allFolderIds,
  buildTree,
  filterTree,
  quizMatchesSearch,
} from './adminTree';
import type { FolderNode } from './adminTree';
import type { OrganizationQuiz } from '../../api/organizations';
import type { Folder } from '../../api/types';

function folder(id: number, name: string, parent: number | null = null): Folder {
  return {
    id,
    organization_id: 1,
    coach_id: 1,
    name,
    parent_folder_id: parent,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as Folder;
}

function quiz(
  id: number,
  title: string,
  folderId: number | null,
  owner: { id: number; username: string } | null = { id: 1, username: 'coacha' },
): OrganizationQuiz {
  return {
    id,
    organization_id: 1,
    coach_id: owner?.id ?? null,
    created_by_username: owner?.username ?? null,
    title,
    description: null,
    folder_id: folderId,
    question_count: 2,
    owner,
    is_unassigned: owner === null,
  } as OrganizationQuiz;
}

/** Walks to a node by name, at any depth. */
function find(nodes: FolderNode[], name: string): FolderNode {
  for (const node of nodes) {
    if (node.name === name) return node;
    const hit = node.children.length ? tryFind(node.children, name) : null;
    if (hit) return hit;
  }
  throw new Error(`no node named ${name}`);
}
function tryFind(nodes: FolderNode[], name: string): FolderNode | null {
  for (const node of nodes) {
    if (node.name === name) return node;
    const hit = tryFind(node.children, name);
    if (hit) return hit;
  }
  return null;
}

describe('buildTree', () => {
  it('nests folders under their parents', () => {
    const tree = buildTree(
      [folder(1, '2026 Season'), folder(2, 'Fall Camp', 1)],
      [],
    );
    expect(tree.map((n) => n.name)).toEqual(['2026 Season']);
    expect(tree[0].children.map((n) => n.name)).toEqual(['Fall Camp']);
  });

  it('handles five levels, well past what the API can create today', () => {
    // The API caps creation at two levels. The tree rendering has no limit of
    // its own, so the day that cap is lifted nothing here needs to change -
    // this is the test that keeps that true.
    const folders = [
      folder(1, 'L1'),
      folder(2, 'L2', 1),
      folder(3, 'L3', 2),
      folder(4, 'L4', 3),
      folder(5, 'L5', 4),
    ];
    const tree = buildTree(folders, [quiz(1, 'Deep Quiz', 5)]);

    expect(find(tree, 'L5').quizzes.map((q) => q.title)).toEqual(['Deep Quiz']);
    // Every ancestor knows about it.
    expect(find(tree, 'L1').totalQuizzes).toBe(1);
    expect(find(tree, 'L1').totalSubfolders).toBe(4);
    expect(find(tree, 'L5').path).toEqual(['L1', 'L2', 'L3', 'L4']);
  });

  it('files quizzes into the folder they belong to', () => {
    const tree = buildTree([folder(1, 'Week 1')], [quiz(1, 'A', 1), quiz(2, 'B', 1)]);
    expect(tree[0].quizzes.map((q) => q.title)).toEqual(['A', 'B']);
  });

  it('puts quizzes with no folder in Uncategorized rather than dropping them', () => {
    const tree = buildTree([folder(1, 'Week 1')], [quiz(1, 'Homeless', null)]);
    const uncategorised = tree.find((n) => n.name === UNCATEGORISED_NAME)!;
    expect(uncategorised.quizzes.map((q) => q.title)).toEqual(['Homeless']);
  });

  it('omits Uncategorized entirely when everything is filed', () => {
    const tree = buildTree([folder(1, 'Week 1')], [quiz(1, 'A', 1)]);
    expect(tree.map((n) => n.name)).not.toContain(UNCATEGORISED_NAME);
  });

  it('keeps Uncategorized last so it never displaces real folders', () => {
    const tree = buildTree([folder(1, 'Zulu')], [quiz(1, 'A', 1), quiz(2, 'B', null)]);
    expect(tree[tree.length - 1].name).toBe(UNCATEGORISED_NAME);
  });

  it('counts descendants, not just direct children', () => {
    const tree = buildTree(
      [folder(1, 'Season'), folder(2, 'Camp', 1)],
      [quiz(1, 'A', 1), quiz(2, 'B', 2), quiz(3, 'C', 2)],
    );
    const season = find(tree, 'Season');
    // A collapsed folder must say what is inside it, or expanding is a guess.
    expect(season.totalQuizzes).toBe(3);
    expect(season.totalSubfolders).toBe(1);
    expect(season.quizzes).toHaveLength(1);
  });

  it('counts distinct coaches across the whole branch', () => {
    const a = { id: 1, username: 'coacha' };
    const b = { id: 2, username: 'coachb' };
    const tree = buildTree(
      [folder(1, 'Season'), folder(2, 'Camp', 1)],
      [quiz(1, 'A', 1, a), quiz(2, 'B', 2, b), quiz(3, 'C', 2, a)],
    );
    expect(find(tree, 'Season').coachCount).toBe(2);
  });

  it('counts unassigned quizzes as their own owner bucket', () => {
    const tree = buildTree([folder(1, 'Season')], [quiz(1, 'A', 1, null)]);
    expect(find(tree, 'Season').coachCount).toBe(1);
  });

  it('keeps empty folders, which are still navigable and fileable-into', () => {
    const tree = buildTree([folder(1, 'Empty')], []);
    expect(tree.map((n) => n.name)).toEqual(['Empty']);
    expect(tree[0].totalQuizzes).toBe(0);
  });

  it('surfaces a folder whose parent is missing rather than losing the branch', () => {
    // Should not happen - the payload is the whole organization - but a
    // silently vanished branch would be far worse than one shown at the top.
    const tree = buildTree([folder(2, 'Orphan Branch', 99)], [quiz(1, 'A', 2)]);
    expect(tree.map((n) => n.name)).toContain('Orphan Branch');
  });

  it('sorts folders and quizzes by name at every level', () => {
    const tree = buildTree(
      [folder(1, 'Beta'), folder(2, 'Alpha'), folder(3, 'Zeta', 2)],
      [quiz(1, 'Zulu', 2), quiz(2, 'Alpha Quiz', 2)],
    );
    expect(tree.map((n) => n.name)).toEqual(['Alpha', 'Beta']);
    expect(find(tree, 'Alpha').quizzes.map((q) => q.title)).toEqual(['Alpha Quiz', 'Zulu']);
  });
});

describe('filterTree', () => {
  const structure = [
    folder(1, '2026 Season'),
    folder(2, 'Week 3', 1),
    folder(3, 'Redzone', 2),
    folder(4, 'Week 1', 1),
  ];
  const smith = { id: 7, username: 'smith' };
  const jones = { id: 8, username: 'jones' };

  it('preserves the whole ancestor path to a match', () => {
    // THE requirement: Coach Smith's only quiz is three levels down, and all
    // three folders must remain or the path stops making sense.
    const tree = buildTree(structure, [
      quiz(1, "Smith's Quiz", 3, smith),
      quiz(2, "Jones's Quiz", 4, jones),
    ]);
    const filtered = filterTree(tree, (q) => q.owner?.id === smith.id, structure);

    expect(filtered.map((n) => n.name)).toEqual(['2026 Season']);
    expect(find(filtered, 'Week 3')).toBeTruthy();
    expect(find(filtered, 'Redzone').quizzes.map((q) => q.title)).toEqual(["Smith's Quiz"]);
  });

  it('drops branches with no match rather than showing them empty', () => {
    const tree = buildTree(structure, [
      quiz(1, "Smith's Quiz", 3, smith),
      quiz(2, "Jones's Quiz", 4, jones),
    ]);
    const filtered = filterTree(tree, (q) => q.owner?.id === smith.id, structure);
    expect(tryFind(filtered, 'Week 1')).toBeNull();
  });

  it('does not flatten the tree just because a filter is active', () => {
    const tree = buildTree(structure, [quiz(1, "Smith's Quiz", 3, smith)]);
    const filtered = filterTree(tree, (q) => q.owner?.id === smith.id, structure);
    // Still 2026 Season > Week 3 > Redzone, not a flat list of one quiz.
    expect(filtered[0].children[0].children[0].name).toBe('Redzone');
  });

  it('recomputes counts for the filtered view', () => {
    const tree = buildTree(structure, [
      quiz(1, "Smith's A", 3, smith),
      quiz(2, "Smith's B", 4, smith),
      quiz(3, "Jones's", 4, jones),
    ]);
    const filtered = filterTree(tree, (q) => q.owner?.id === smith.id, structure);
    // 2 of Smith's, not the 3 that exist - a stale count would misrepresent
    // the filter.
    expect(find(filtered, '2026 Season').totalQuizzes).toBe(2);
  });

  it('keeps Uncategorized when the match lives there', () => {
    const tree = buildTree(structure, [quiz(1, "Smith's Loose Quiz", null, smith)]);
    const filtered = filterTree(tree, (q) => q.owner?.id === smith.id, structure);
    expect(filtered.map((n) => n.name)).toEqual([UNCATEGORISED_NAME]);
  });

  it('returns nothing when a coach owns nothing', () => {
    const tree = buildTree(structure, [quiz(1, "Jones's", 4, jones)]);
    expect(filterTree(tree, (q) => q.owner?.id === smith.id, structure)).toEqual([]);
  });

  it('filters to unassigned quizzes wherever they live', () => {
    const tree = buildTree(structure, [
      quiz(1, 'Nobody owns me', 3, null),
      quiz(2, "Jones's", 4, jones),
    ]);
    const filtered = filterTree(tree, (q) => q.is_unassigned, structure);
    expect(find(filtered, 'Redzone').quizzes.map((q) => q.title)).toEqual(['Nobody owns me']);
    expect(tryFind(filtered, 'Week 1')).toBeNull();
  });
});

describe('search', () => {
  it('matches a quiz title', () => {
    expect(quizMatchesSearch(quiz(1, 'Redzone Install', 1), 'redzone')).toBe(true);
    expect(quizMatchesSearch(quiz(1, 'Redzone Install', 1), 'blitz')).toBe(false);
  });

  it('matches the owner, so "everything of Dave\'s" works from the search box', () => {
    expect(quizMatchesSearch(quiz(1, 'X', 1, { id: 3, username: 'dave' }), 'dave')).toBe(true);
  });

  it('is case and whitespace insensitive', () => {
    expect(quizMatchesSearch(quiz(1, 'Redzone', 1), '  REDZONE ')).toBe(true);
  });

  it('an empty search matches everything', () => {
    expect(quizMatchesSearch(quiz(1, 'Anything', 1), '   ')).toBe(true);
  });

  it('allFolderIds reaches every level, so search can reveal deep matches', () => {
    const tree = buildTree(
      [folder(1, 'A'), folder(2, 'B', 1), folder(3, 'C', 2)],
      [quiz(1, 'Q', null)],
    );
    const ids = allFolderIds(tree);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).toContain(null); // Uncategorized
  });
});
