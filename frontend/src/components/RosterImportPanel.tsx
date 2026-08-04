import { useRef, useState } from 'react';
import { confirmImport, downloadImportTemplate, previewImport, type ImportRowInput } from '../api/players';
import { getErrorMessage } from '../api/client';
import type { ImportPreviewResponse } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import nb from '../styles/notebook.module.css';
import styles from './RosterImportPanel.module.css';

type RowAction = 'create' | 'update' | 'skip' | 'review';

interface EditableRow {
  first_name: string;
  last_name: string;
  jersey_number: string | null;
  position: string | null;
  errors: string[];
  action: RowAction;
  existing_player_id: number | null;
  possible_duplicates: ImportPreviewResponse['rows'][number]['possible_duplicates'];
}

/** Two-step CSV/pasted-spreadsheet roster import: paste or upload -> preview
 * (never writes anything) -> coach reviews/corrects/confirms -> import.
 * See backend/app/services/roster_import.py for the parsing/validation this
 * drives. */
export function RosterImportPanel({ onImported }: { onImported: () => void }) {
  const [rawText, setRawText] = useState('');
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawText(text);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handlePreview() {
    if (!rawText.trim()) {
      setError('Paste some rows or choose a CSV file first.');
      return;
    }
    setError(null);
    setResult(null);
    setIsBusy(true);
    try {
      const response = await previewImport(rawText);
      setPreview(response);
      setRows(
        response.rows.map((r) => ({
          first_name: r.first_name,
          last_name: r.last_name,
          jersey_number: r.jersey_number,
          position: r.position,
          errors: r.errors,
          action: r.default_action,
          existing_player_id: null,
          possible_duplicates: r.possible_duplicates,
        })),
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsBusy(false);
    }
  }

  function updateRow(index: number, patch: Partial<EditableRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function handleConfirm() {
    setError(null);

    const pendingReview = rows.filter((r) => r.action === 'review').length;
    if (pendingReview > 0) {
      setError(
        `${pendingReview} row${pendingReview === 1 ? '' : 's'} still need${pendingReview === 1 ? 's' : ''} review - a possible existing match was found, so each one needs an explicit Create/Update/Skip choice before importing.`,
      );
      return;
    }

    setIsBusy(true);
    try {
      const payload: ImportRowInput[] = rows
        .filter((r): r is EditableRow & { action: 'create' | 'update' } => r.action !== 'skip')
        .map((r) => ({
          first_name: r.first_name,
          last_name: r.last_name,
          jersey_number: r.jersey_number,
          position: r.position,
          action: r.action,
          existing_player_id: r.action === 'update' ? r.existing_player_id : null,
        }));

      if (payload.length === 0) {
        setError('Every row is set to skip - nothing to import.');
        return;
      }

      const response = await confirmImport(payload);
      setResult({ created: response.created, updated: response.updated });
      setPreview(null);
      setRows([]);
      setRawText('');
      onImported();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDownloadTemplate() {
    try {
      const blob = await downloadImportTemplate();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'peira-roster-template.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  const validCount = rows.filter((r) => r.errors.length === 0).length;
  const createCount = rows.filter((r) => r.action === 'create').length;
  const updateCount = rows.filter((r) => r.action === 'update').length;
  const skipCount = rows.filter((r) => r.action === 'skip').length;
  const reviewCount = rows.filter((r) => r.action === 'review').length;
  const willImportCount = createCount + updateCount;

  return (
    <div className={`${nb.card} ${styles.panel}`}>
      <div className={styles.panelHeader}>
        <h3 className={nb.subheading}>Import Roster</h3>
        <button type="button" className={nb.btnSm} onClick={handleDownloadTemplate}>
          Download template
        </button>
      </div>
      <p className={styles.hint}>
        Paste rows copied from Excel or Google Sheets, or upload a CSV. First and last name, jersey
        number, and position are recognized automatically from common column headers.
      </p>

      <ErrorBanner message={error} />

      {!preview && (
        <>
          <textarea
            className={styles.textarea}
            placeholder={'First Name,Last Name,Jersey Number,Position\nChris,Smith,2,WR'}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            aria-label="Paste roster data"
          />
          <div className={styles.actions}>
            <label className={nb.btnSm} style={{ cursor: 'pointer' }}>
              Choose CSV file
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                hidden
                onChange={handleFileChange}
              />
            </label>
            <button type="button" className={nb.btnPrimary} onClick={handlePreview} disabled={isBusy}>
              {isBusy ? 'Parsing…' : 'Preview import'}
            </button>
          </div>
        </>
      )}

      {result && (
        <div className={`${nb.badge} ${nb.badgeSuccess}`}>
          Imported {result.created} new player{result.created === 1 ? '' : 's'}
          {result.updated > 0 ? `, updated ${result.updated}` : ''}.
        </div>
      )}

      {preview && (
        <>
          <div className={styles.summary}>
            <span>
              {preview.total_rows} row{preview.total_rows === 1 ? '' : 's'} parsed
            </span>
            <span>{validCount} valid</span>
            {preview.invalid_count > 0 && (
              <span className={styles.invalidCount}>{preview.invalid_count} invalid</span>
            )}
            <span>{createCount} to create</span>
            <span>{updateCount} to update</span>
            <span>{skipCount} to skip</span>
            {reviewCount > 0 && (
              <span className={styles.reviewCount}>{reviewCount} need review</span>
            )}
          </div>

          <div className={styles.tableWrap}>
            <table className={nb.table}>
              <thead>
                <tr>
                  <th>First</th>
                  <th>Last</th>
                  <th>#</th>
                  <th>Pos</th>
                  <th>Possible match</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={index}
                    className={
                      row.errors.length > 0
                        ? styles.errorRow
                        : row.action === 'review'
                          ? styles.reviewRow
                          : ''
                    }
                  >
                    <td>
                      <input
                        className={nb.input}
                        value={row.first_name}
                        onChange={(e) => updateRow(index, { first_name: e.target.value })}
                        aria-label={`Row ${index + 1} first name`}
                      />
                    </td>
                    <td>
                      <input
                        className={nb.input}
                        value={row.last_name}
                        onChange={(e) => updateRow(index, { last_name: e.target.value })}
                        aria-label={`Row ${index + 1} last name`}
                      />
                    </td>
                    <td>
                      <input
                        className={nb.input}
                        style={{ width: 60 }}
                        value={row.jersey_number ?? ''}
                        onChange={(e) => updateRow(index, { jersey_number: e.target.value })}
                        aria-label={`Row ${index + 1} jersey number`}
                      />
                    </td>
                    <td>
                      <input
                        className={nb.input}
                        style={{ width: 70 }}
                        value={row.position ?? ''}
                        onChange={(e) => updateRow(index, { position: e.target.value })}
                        aria-label={`Row ${index + 1} position`}
                      />
                    </td>
                    <td>
                      {row.errors.length > 0 ? (
                        <span className={styles.errorText}>{row.errors[0]}</span>
                      ) : row.possible_duplicates.length > 0 ? (
                        <span
                          className={
                            row.possible_duplicates[0].strong_match ? styles.exactMatch : styles.dupNote
                          }
                        >
                          {row.possible_duplicates[0].strong_match ? 'Exact match: ' : 'Same name: '}
                          #{row.possible_duplicates[0].jersey_number ?? '—'}{' '}
                          {row.possible_duplicates[0].position ?? ''}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <select
                        className={nb.input}
                        value={row.action}
                        disabled={row.errors.length > 0 && row.action !== 'skip'}
                        onChange={(e) => {
                          const action = e.target.value as RowAction;
                          updateRow(index, {
                            action,
                            existing_player_id:
                              action === 'update' ? row.possible_duplicates[0]?.player_id ?? null : null,
                          });
                        }}
                      >
                        {row.action === 'review' && (
                          <option value="review" disabled>
                            Review required
                          </option>
                        )}
                        <option value="create">Create new</option>
                        {row.possible_duplicates.length > 0 && <option value="update">Update match</option>}
                        <option value="skip">Skip</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={nb.btnSm}
              onClick={() => {
                setPreview(null);
                setRows([]);
              }}
            >
              Back
            </button>
            <button
              type="button"
              className={nb.btnPrimary}
              onClick={handleConfirm}
              disabled={isBusy || willImportCount === 0 || reviewCount > 0}
              title={reviewCount > 0 ? 'Resolve every "Review required" row before importing.' : undefined}
            >
              {isBusy ? 'Importing…' : `Import ${willImportCount} Player${willImportCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
