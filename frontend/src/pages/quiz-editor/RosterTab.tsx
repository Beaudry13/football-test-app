import { useCallback } from 'react';
import { getRoster, setRoster, uploadRosterCsv } from '../../api/roster';
import type { Quiz } from '../../api/types';
import { PlayerListEditor } from '../../components/PlayerListEditor';

export function RosterTab({ quiz }: { quiz: Quiz }) {
  const load = useCallback(() => getRoster(quiz.id), [quiz.id]);
  const onSave = useCallback((names: string[]) => setRoster(quiz.id, names), [quiz.id]);
  const onUploadCsv = useCallback((file: File) => uploadRosterCsv(quiz.id, file), [quiz.id]);

  return <PlayerListEditor load={load} onSave={onSave} onUploadCsv={onUploadCsv} />;
}
