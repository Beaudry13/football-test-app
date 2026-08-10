/** Structurally typed on purpose. Coach View passes `Quiz`, Admin View
 *  passes `OrganizationQuiz`, and this file needs neither - only the two
 *  fields below. Naming the concrete types here would force a cast at one of
 *  the call sites, and a cast is how a shared helper starts drifting. */
interface FolderShape {
  id: number;
  parent_folder_id: number | null;
}

interface FiledQuiz {
  folder_id: number | null;
}

/** Recursive folder totals - THE one implementation.
 *
 * THE COUNTING RULE
 * -----------------
 * A folder's quiz count is every quiz anywhere in its tree: the quizzes
 * directly inside it, plus the quizzes inside every descendant folder, to any
 * depth.
 *
 *     2026 SEASON (6)
 *       FALL CAMP (4)          <- 4 in INSTALL QUIZ, 0 of its own
 *         INSTALL QUIZ (4)
 *       (2 quizzes sitting directly in 2026 SEASON)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Coach View and FolderPage each counted `quizzes.filter(q => q.folder_id ===
 * folder.id)` - direct children only - so a folder whose quizzes all lived one
 * level down displayed (0) while plainly containing them. Admin View had
 * always aggregated recursively, so the same folder showed a different number
 * on two screens.
 *
 * Both surfaces now call this. Nothing here queries or fetches: it works on
 * the folder and quiz lists the caller already has, which is what lets Coach
 * View stay own-only and Admin View stay organization-wide without this
 * function knowing the difference. Pass it scoped data and the count is
 * scoped; that is the caller's job, deliberately.
 */

/** Every folder id in this folder's tree, including the folder itself.
 *
 * Iterative rather than recursive, and guarded by `seen`: parents are fixed at
 * creation and there is no reparent route, so a cycle is impossible today (see
 * backend models/folder.py) - but a counter is the wrong place to discover
 * that a future move feature broke that invariant, and an unbounded walk would
 * hang the dashboard rather than mis-count. */
export function folderTreeIds(folderId: number, folders: FolderShape[]): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const folder of folders) {
    if (folder.parent_folder_id === null) continue;
    const siblings = childrenOf.get(folder.parent_folder_id) ?? [];
    siblings.push(folder.id);
    childrenOf.set(folder.parent_folder_id, siblings);
  }

  const ids = new Set<number>([folderId]);
  const queue = [folderId];
  while (queue.length > 0) {
    const current = queue.pop() as number;
    for (const child of childrenOf.get(current) ?? []) {
      if (ids.has(child)) continue;
      ids.add(child);
      queue.push(child);
    }
  }
  return ids;
}

/** Every quiz anywhere in this folder's tree, from the quizzes given. */
export function quizzesInFolderTree<T extends FiledQuiz>(
  folderId: number,
  folders: FolderShape[],
  quizzes: T[],
): T[] {
  const ids = folderTreeIds(folderId, folders);
  return quizzes.filter((quiz) => quiz.folder_id !== null && ids.has(quiz.folder_id));
}

/** How many quizzes this folder contains, counting every descendant. */
export function countQuizzesInFolderTree(
  folderId: number,
  folders: FolderShape[],
  quizzes: FiledQuiz[],
): number {
  return quizzesInFolderTree(folderId, folders, quizzes).length;
}

/** How many folders sit below this one, at any depth.
 *
 * Same tree walk, kept here rather than in Admin View so there is exactly one
 * place that knows how to descend a folder tree. Excludes the folder itself. */
export function countSubfoldersInTree(folderId: number, folders: FolderShape[]): number {
  return folderTreeIds(folderId, folders).size - 1;
}

/** Every folder, in tree order, with its depth - for building a picker.
 *
 * Roots first, each immediately followed by its whole subtree, so a <select>
 * can indent by depth and read as the tree it is.
 *
 * This exists because the move-to-folder dropdown listed roots and their
 * DIRECT children only. That was correct while folders could not nest more
 * than two levels; when the cap was lifted, every folder three or more deep
 * silently vanished from the picker and a coach could no longer file a quiz
 * there. Same class of bug as the old direct-children-only counter, which is
 * why it now lives beside it.
 */
export function folderTreeOrder<T extends FolderShape>(
  folders: T[],
): Array<{ folder: T; depth: number }> {
  const childrenOf = new Map<number | null, T[]>();
  for (const folder of folders) {
    const siblings = childrenOf.get(folder.parent_folder_id) ?? [];
    siblings.push(folder);
    childrenOf.set(folder.parent_folder_id, siblings);
  }

  const ordered: Array<{ folder: T; depth: number }> = [];
  const seen = new Set<number>();

  const walk = (parentId: number | null, depth: number) => {
    for (const folder of childrenOf.get(parentId) ?? []) {
      // Same guard as folderTreeIds, for the same reason: a picker should
      // not be the thing that hangs if a future move feature makes a cycle.
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      ordered.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);

  return ordered;
}
