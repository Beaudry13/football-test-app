import { useCallback } from 'react';
import { getRoster, setRoster, uploadRosterCsv } from '../../api/roster';
import { addRosterMembers, removeRosterMember } from '../../api/players';
import type { Quiz } from '../../api/types';
import { PlayerListEditor } from '../../components/PlayerListEditor';
import { PlayerPickerPanel } from '../../components/PlayerPickerPanel';

export function RosterTab({ quiz }: { quiz: Quiz }) {
  const load = useCallback(() => getRoster(quiz.id), [quiz.id]);
  const onSave = useCallback((names: string[]) => setRoster(quiz.id, names), [quiz.id]);
  const onUploadCsv = useCallback((file: File) => uploadRosterCsv(quiz.id, file), [quiz.id]);
  const onAddMember = useCallback((playerId: number) => addRosterMembers(quiz.id, [playerId]), [quiz.id]);
  const onRemoveMember = useCallback((playerId: number) => removeRosterMember(quiz.id, playerId), [quiz.id]);

  return (
    <>
      <PlayerPickerPanel load={load} onAdd={onAddMember} onRemove={onRemoveMember} />
      <PlayerListEditor
        load={load}
        onSave={onSave}
        onUploadCsv={onUploadCsv}
        currentListTitle="Legacy roster (no master-roster link)"
        editTitle="Edit legacy roster"
      />
    </>
  );
}
