import type { OrganizationQuiz } from '../../api/organizations';
import type { Folder } from '../../api/types';

/** A node in Admin View's folder tree. Recursive with no depth limit.
 *
 * The API currently refuses to create a folder more than two levels deep
 * (see create_folder in backend/app/routes/folders.py), but nothing here
 * knows or cares about that - the day the cap is lifted, this renders the
 * deeper tree with no change. The tests build five-level trees to prove it.
 */
export interface FolderNode {
  id: number | null;
  name: string;
  children: FolderNode[];
  /** Quizzes filed directly in this folder, not in its descendants. */
  quizzes: OrganizationQuiz[];
  /** Everything below, summed recursively - what the collapsed row shows. */
  totalQuizzes: number;
  totalSubfolders: number;
  /** Distinct owners across this folder and its descendants. */
  coachCount: number;
  /** Ancestor names, root first. Used for search-result breadcrumbs. */
  path: string[];
}

/** The id used for the virtual "Uncategorized" node.
 *
 * A real id would collide with a folder; null is the actual value
 * `quiz.folder_id` carries when a quiz belongs to no folder, so using it
 * keeps the node honest rather than inventing a sentinel. */
export const UNCATEGORISED_ID = null;
export const UNCATEGORISED_NAME = 'Uncategorized';

function collectSummary(node: FolderNode): FolderNode {
  // Depth-first, so a parent's totals are computed from children that already
  // know their own. Recursion rather than a loop because the shape is a tree
  // of unknown depth and this is the one place that matters.
  node.children = node.children.map(collectSummary);

  const ownerIds = new Set<number | 'unassigned'>();
  const walk = (n: FolderNode) => {
    n.quizzes.forEach((q) => ownerIds.add(q.owner ? q.owner.id : 'unassigned'));
    n.children.forEach(walk);
  };
  walk(node);

  node.totalQuizzes =
    node.quizzes.length + node.children.reduce((sum, child) => sum + child.totalQuizzes, 0);
  node.totalSubfolders =
    node.children.length + node.children.reduce((sum, child) => sum + child.totalSubfolders, 0);
  node.coachCount = ownerIds.size;
  return node;
}

/** Builds the tree an admin navigates, from one flat folders+quizzes payload.
 *
 * Quizzes with no folder land in a virtual "Uncategorized" node at the end
 * rather than being dropped. That state is reachable in ordinary use, not just
 * in theory: deleting a folder sets its quizzes' folder_id to NULL rather than
 * deleting them.
 */
export function buildTree(folders: Folder[], quizzes: OrganizationQuiz[]): FolderNode[] {
  const nodes = new Map<number, FolderNode>();
  for (const folder of folders) {
    nodes.set(folder.id, {
      id: folder.id,
      name: folder.name,
      children: [],
      quizzes: [],
      totalQuizzes: 0,
      totalSubfolders: 0,
      coachCount: 0,
      path: [],
    });
  }

  const roots: FolderNode[] = [];
  for (const folder of folders) {
    const node = nodes.get(folder.id)!;
    const parent = folder.parent_folder_id === null ? null : nodes.get(folder.parent_folder_id);
    // A folder whose parent is missing from the payload is treated as a root
    // rather than dropped. It should not happen - the payload is the whole
    // organization - but losing a branch silently would be far worse than
    // showing it at the top level.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const uncategorised: OrganizationQuiz[] = [];
  for (const quiz of quizzes) {
    const node = quiz.folder_id === null ? null : nodes.get(quiz.folder_id);
    if (node) node.quizzes.push(quiz);
    else uncategorised.push(quiz);
  }

  // Paths, top-down, so search results can say where a quiz lives.
  const stamp = (node: FolderNode, ancestors: string[]) => {
    node.path = ancestors;
    node.children.forEach((child) => stamp(child, [...ancestors, node.name]));
  };
  roots.forEach((root) => stamp(root, []));

  const tree = roots.map(collectSummary);
  sortTree(tree);

  if (uncategorised.length > 0) {
    tree.push(
      collectSummary({
        id: UNCATEGORISED_ID,
        name: UNCATEGORISED_NAME,
        children: [],
        quizzes: uncategorised,
        totalQuizzes: 0,
        totalSubfolders: 0,
        coachCount: 0,
        path: [],
      }),
    );
  }
  return tree;
}

function sortTree(nodes: FolderNode[]): void {
  nodes.sort((a, b) => a.name.localeCompare(b.name));
  nodes.forEach((node) => {
    node.quizzes.sort((a, b) => a.title.localeCompare(b.title));
    sortTree(node.children);
  });
}

/** Narrows the tree to quizzes matching a filter, KEEPING ANCESTOR PATHS.
 *
 * The rule that makes filtering usable rather than disorienting: if a coach's
 * only quiz lives in 2026 SEASON > WEEK 3 > REDZONE, all three folders stay so
 * the path still reads. A branch with no match is dropped entirely.
 *
 * Returns a new tree - the caller keeps the unfiltered one, so clearing a
 * filter costs nothing and needs no refetch.
 */
export function filterTree(
  nodes: FolderNode[],
  matches: (quiz: OrganizationQuiz) => boolean,
): FolderNode[] {
  const filtered: FolderNode[] = [];

  for (const node of nodes) {
    const children = filterTree(node.children, matches);
    const quizzes = node.quizzes.filter(matches);
    // Kept when it holds a match itself, or when something below it does -
    // the second half is what preserves the ancestor path.
    if (children.length > 0 || quizzes.length > 0) {
      filtered.push(collectSummary({ ...node, children, quizzes }));
    }
  }

  return filtered;
}

/** Every folder id in the tree - what search uses to reveal matching paths.
 *
 * Search auto-expands rather than showing a flat result list with
 * breadcrumbs: the tree already communicates location, and switching layouts
 * mid-interaction makes the admin re-orient every time they type. */
export function allFolderIds(nodes: FolderNode[]): Array<number | null> {
  return nodes.flatMap((node) => [node.id, ...allFolderIds(node.children)]);
}

export function quizMatchesSearch(quiz: OrganizationQuiz, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return (
    quiz.title.toLowerCase().includes(needle) ||
    (quiz.description ?? '').toLowerCase().includes(needle) ||
    (quiz.owner?.username ?? '').toLowerCase().includes(needle)
  );
}
