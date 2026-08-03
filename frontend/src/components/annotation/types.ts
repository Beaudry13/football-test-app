export type AnnotationTool =
  | 'select'
  | 'line'
  | 'curve'
  | 'freehand'
  | 'arrow'
  | 'circle'
  | 'rectangle'
  | 'text';

/** What a line/arrow is capped with at one of its two ends. */
export type LineCap = 'none' | 'arrow' | 'filled-circle' | 'open-circle' | 'tbar';

export const LINE_CAPS: { value: LineCap; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'arrow', label: 'Arrow' },
  { value: 'filled-circle', label: 'Filled circle' },
  { value: 'open-circle', label: 'Open circle' },
  { value: 'tbar', label: 'T-bar' },
];

export interface AnnotationStyle {
  color: string;
  strokeWidth: number;
  dashed: boolean;
  /** Fill opacity for shapes (circle/rectangle), used for highlight-style shading. */
  fillOpacity: number;
  /** Heavier text weight for text labels - reads better over busy film stills. */
  bold: boolean;
  startCap: LineCap;
  endCap: LineCap;
}

export const DEFAULT_STYLE: AnnotationStyle = {
  color: '#e63946',
  strokeWidth: 3,
  dashed: false,
  fillOpacity: 0.25,
  bold: true,
  startCap: 'none',
  endCap: 'none',
};

/** Custom (non-Fabric) properties that must survive serialization - used both
 * when saving a question's annotations and when copying one to the clipboard,
 * which have to agree or a pasted shape loses its caps/ids/endpoint tagging. */
export const ANNOTATION_PROPS = [
  'id',
  'annotationFillOpacity',
  'hasEditableEndpoints',
  'isArrow',
  'startCap',
  'endCap',
  'capKind',
  'segStart',
  'segEnd',
  'segRefLeft',
  'segRefTop',
];

export const STROKE_COLORS =['#e63946', '#f2b705', '#2a9d8f', '#264653', '#ffffff', '#000000'];
