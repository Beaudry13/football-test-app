import type { FabricObject } from 'fabric';
import styles from './LayersPanel.module.css';

const TYPE_LABELS: Record<string, string> = {
  line: 'Line',
  group: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Circle',
  path: 'Curve',
  textbox: 'Text',
  polyline: 'Curve (in progress)',
};

function describe(obj: FabricObject, index: number): string {
  const label = TYPE_LABELS[obj.type] ?? obj.type;
  if (obj.type === 'textbox' && 'text' in obj) {
    const text = String((obj as unknown as { text: string }).text).slice(0, 18);
    return `Text: "${text}"`;
  }
  return `${label} ${index + 1}`;
}

interface LayersPanelProps {
  objects: FabricObject[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function LayersPanel({ objects, selectedId, onSelect, onDelete }: LayersPanelProps) {
  return (
    <div className={styles.panel}>
      <h4>Layers ({objects.length})</h4>
      {objects.length === 0 ? (
        <p className={styles.empty}>Draw on the image to add annotations.</p>
      ) : (
        objects.map((obj, index) => {
          const id = obj.get('id') as string;
          return (
            <div
              key={id ?? index}
              className={`${styles.row} ${id === selectedId ? styles.rowActive : ''}`}
              onClick={() => onSelect(id)}
            >
              <span>{describe(obj, objects.length - 1 - index)}</span>
              <button
                className={styles.deleteBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(id);
                }}
                aria-label="Delete layer"
              >
                ✕
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
