export type AnnotationTool =
  | 'select'
  | 'line'
  | 'curve'
  | 'freehand'
  | 'arrow'
  | 'circle'
  | 'rectangle'
  | 'text';

export interface AnnotationStyle {
  color: string;
  strokeWidth: number;
  dashed: boolean;
  /** Fill opacity for shapes (circle/rectangle), used for highlight-style shading. */
  fillOpacity: number;
}

export const DEFAULT_STYLE: AnnotationStyle = {
  color: '#e63946',
  strokeWidth: 3,
  dashed: false,
  fillOpacity: 0.25,
};

export const STROKE_COLORS = ['#e63946', '#f2b705', '#2a9d8f', '#264653', '#ffffff', '#000000'];
