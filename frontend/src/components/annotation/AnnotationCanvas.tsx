import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Canvas, FabricImage, PencilBrush, Point, Polyline, type FabricObject, type TPointerEventInfo } from 'fabric';
import type { AnnotationLayer } from '../../api/types';
import { useAnnotationHistory } from './useAnnotationHistory';
import { AnnotationToolbar } from './AnnotationToolbar';
import { LayersPanel } from './LayersPanel';
import {
  createArrow,
  createCircle,
  createLine,
  createRectangle,
  createSmoothPath,
  createTextbox,
  makeId,
} from './shapeFactories';
import { DEFAULT_STYLE, type AnnotationStyle, type AnnotationTool } from './types';
import styles from './AnnotationCanvas.module.css';

const MAX_CANVAS_WIDTH = 900;

export interface AnnotationCanvasHandle {
  getAnnotations: () => AnnotationLayer[];
}

interface AnnotationCanvasProps {
  imageUrl: string;
  initialAnnotations: AnnotationLayer[];
  onReady?: () => void;
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas({ imageUrl, initialAnnotations, onReady }, ref) {
    const canvasElRef = useRef<HTMLCanvasElement>(null);
    const canvasRef = useRef<Canvas | null>(null);
    const [tool, setTool] = useState<AnnotationTool>('select');
    const toolRef = useRef(tool);
    toolRef.current = tool;
    const [style, setStyle] = useState<AnnotationStyle>(DEFAULT_STYLE);
    const styleRef = useRef(style);
    styleRef.current = style;
    const [isReady, setIsReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [objects, setObjects] = useState<FabricObject[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const refreshLayers = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      setObjects([...canvas.getObjects()].reverse());
    }, []);

    const handleRestored = useCallback(() => {
      refreshLayers();
      setSelectedId(null);
    }, [refreshLayers]);

    const history = useAnnotationHistory(canvasRef, handleRestored);

    useImperativeHandle(ref, () => ({
      getAnnotations: () => {
        const canvas = canvasRef.current;
        if (!canvas) return [];
        return canvas.toObject(['id']).objects as AnnotationLayer[];
      },
    }));

    // --- Canvas + background image setup ---------------------------------
    useEffect(() => {
      if (!canvasElRef.current) return;
      const canvas = new Canvas(canvasElRef.current, { selection: true, preserveObjectStacking: true });
      canvasRef.current = canvas;

      let cancelled = false;

      async function setup() {
        try {
          // crossOrigin: 'anonymous' is required, not optional, once images can
          // come from a different origin (R2) - Fabric caches objects to an
          // internal canvas for performance, and *any* cross-origin image drawn
          // without an explicit CORS-mode load taints that canvas, silently
          // breaking the render (no thrown error - it just paints nothing).
          // The image host must send matching CORS headers back (see R2 bucket
          // CORS policy / backend CORS config for local uploads).
          const image = await FabricImage.fromURL(imageUrl, { crossOrigin: 'anonymous' });
          if (cancelled) return;

          const naturalWidth = image.width ?? MAX_CANVAS_WIDTH;
          const scale = Math.min(1, MAX_CANVAS_WIDTH / naturalWidth);
          const width = naturalWidth * scale;
          const height = (image.height ?? naturalWidth) * scale;

          canvas.setDimensions({ width, height });
          image.scale(scale);
          // objectCaching: false - Fabric's object cache is sized off the
          // image's *native* resolution, not its displayed (scaled-down)
          // size. A large film-still photo (e.g. 2048x1152) blows past
          // Fabric's default cache pixel-count limit, and the cache it
          // builds instead only covers a corner of the image - the rest
          // renders blank. Skipping the cache avoids that entirely; there's
          // no downside since this is a static, non-interactive background.
          image.set({ selectable: false, evented: false, objectCaching: false });
          canvas.backgroundImage = image;

          if (initialAnnotations.length > 0) {
            await canvas.loadFromJSON({ objects: initialAnnotations });
            if (cancelled) return;
          }

          canvas.requestRenderAll();
          history.reset();
          refreshLayers();
          setIsReady(true);
          onReady?.();
        } catch {
          if (!cancelled) setLoadError('Could not load this image. Try re-uploading it.');
        }
      }

      setup();

      return () => {
        cancelled = true;
        canvas.dispose();
        canvasRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [imageUrl]);

    // --- Selection + layer list sync --------------------------------------
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !isReady) return;

      function onSelection() {
        const active = canvas!.getActiveObject();
        setSelectedId((active?.get('id') as string) ?? null);
      }
      function onCleared() {
        setSelectedId(null);
      }
      function onChanged() {
        refreshLayers();
        history.pushSnapshot();
      }

      canvas.on('selection:created', onSelection);
      canvas.on('selection:updated', onSelection);
      canvas.on('selection:cleared', onCleared);
      canvas.on('object:added', onChanged);
      canvas.on('object:removed', onChanged);
      canvas.on('object:modified', onChanged);
      canvas.on('path:created', onChanged);

      return () => {
        canvas.off('selection:created', onSelection);
        canvas.off('selection:updated', onSelection);
        canvas.off('selection:cleared', onCleared);
        canvas.off('object:added', onChanged);
        canvas.off('object:removed', onChanged);
        canvas.off('object:modified', onChanged);
        canvas.off('path:created', onChanged);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady, refreshLayers]);

    // --- Freehand brush follows style/tool changes -------------------------
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !isReady) return;

      canvas.isDrawingMode = tool === 'freehand';
      canvas.selection = tool === 'select';
      canvas.forEachObject((obj) => obj.set({ selectable: tool === 'select', evented: tool === 'select' }));

      if (tool === 'freehand') {
        const brush = new PencilBrush(canvas);
        brush.color = style.color;
        brush.width = style.strokeWidth;
        canvas.freeDrawingBrush = brush;
      }
      canvas.requestRenderAll();
    }, [tool, style, isReady]);

    // --- Click/drag drawing for line, arrow, circle, rectangle, curve, text
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !isReady) return;

      let shape: FabricObject | null = null;
      let startPoint: Point | null = null;
      let curvePoints: Point[] = [];
      let curvePreview: Polyline | null = null;

      function finalizeCurve() {
        if (curvePoints.length >= 2) {
          const path = createSmoothPath(curvePoints, styleRef.current);
          path.set('id', makeId());
          canvas!.add(path);
        }
        if (curvePreview) canvas!.remove(curvePreview);
        curvePreview = null;
        curvePoints = [];
        canvas!.requestRenderAll();
      }

      function handleMouseDown(opt: TPointerEventInfo) {
        const currentTool = toolRef.current;
        const point = opt.scenePoint;

        if (currentTool === 'text') {
          const textbox = createTextbox(point, styleRef.current);
          textbox.set('id', makeId());
          canvas!.add(textbox);
          canvas!.setActiveObject(textbox);
          textbox.enterEditing();
          return;
        }

        if (currentTool === 'curve') {
          curvePoints.push(point);
          if (curvePreview) canvas!.remove(curvePreview);
          curvePreview = new Polyline(curvePoints, {
            stroke: styleRef.current.color,
            strokeWidth: styleRef.current.strokeWidth,
            fill: '',
            selectable: false,
            evented: false,
          });
          canvas!.add(curvePreview);
          canvas!.requestRenderAll();
          return;
        }

        if (!['line', 'arrow', 'circle', 'rectangle'].includes(currentTool)) return;

        // Suppress history while the shape is created and resized live; handleMouseUp
        // records exactly one snapshot for the finished shape instead of one per tick.
        history.isRestoring.current = true;
        startPoint = point;
        if (currentTool === 'line') shape = createLine(point, point, styleRef.current);
        else if (currentTool === 'arrow') shape = createArrow(point, point, styleRef.current);
        else if (currentTool === 'circle') shape = createCircle(styleRef.current);
        else shape = createRectangle(styleRef.current);

        shape.set('id', makeId());
        canvas!.add(shape);
      }

      function handleMouseMove(opt: TPointerEventInfo) {
        if (!shape || !startPoint) return;
        const point = opt.scenePoint;
        const currentTool = toolRef.current;

        if (currentTool === 'line') {
          shape.set({ x2: point.x, y2: point.y });
        } else if (currentTool === 'circle') {
          shape.set({
            left: Math.min(startPoint.x, point.x),
            top: Math.min(startPoint.y, point.y),
            rx: Math.abs(point.x - startPoint.x) / 2,
            ry: Math.abs(point.y - startPoint.y) / 2,
          });
        } else if (currentTool === 'rectangle') {
          shape.set({
            left: Math.min(startPoint.x, point.x),
            top: Math.min(startPoint.y, point.y),
            width: Math.abs(point.x - startPoint.x),
            height: Math.abs(point.y - startPoint.y),
          });
        } else if (currentTool === 'arrow') {
          canvas!.remove(shape);
          shape = createArrow(startPoint, point, styleRef.current);
          shape.set('id', makeId());
          canvas!.add(shape);
        }
        canvas!.requestRenderAll();
      }

      function handleMouseUp() {
        if (shape) {
          shape.setCoords();
          history.isRestoring.current = false;
          refreshLayers();
          history.pushSnapshot();
        }
        shape = null;
        startPoint = null;
      }

      function handleDoubleClick() {
        if (toolRef.current === 'curve') finalizeCurve();
      }

      canvas.on('mouse:down', handleMouseDown);
      canvas.on('mouse:move', handleMouseMove);
      canvas.on('mouse:up', handleMouseUp);
      canvas.on('mouse:dblclick', handleDoubleClick);

      return () => {
        canvas.off('mouse:down', handleMouseDown);
        canvas.off('mouse:move', handleMouseMove);
        canvas.off('mouse:up', handleMouseUp);
        canvas.off('mouse:dblclick', handleDoubleClick);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady]);

    function handleDeleteSelected() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const active = canvas.getActiveObjects();
      active.forEach((obj) => canvas.remove(obj));
      canvas.discardActiveObject();
      canvas.requestRenderAll();
    }

    function handleDeleteLayer(id: string) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const target = canvas.getObjects().find((o) => o.get('id') === id);
      if (target) {
        canvas.remove(target);
        canvas.requestRenderAll();
      }
    }

    function handleSelectLayer(id: string) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const target = canvas.getObjects().find((o) => o.get('id') === id);
      if (target) {
        canvas.setActiveObject(target);
        canvas.requestRenderAll();
      }
    }

    return (
      <div className={styles.layout}>
        {loadError ? (
          <div className="error-banner">{loadError}</div>
        ) : (
          !isReady && <div className="card">Loading image…</div>
        )}
        {!loadError && (
          <>
            <AnnotationToolbar
              tool={tool}
              onToolChange={setTool}
              style={style}
              onStyleChange={setStyle}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onUndo={history.undo}
              onRedo={history.redo}
              onDeleteSelected={handleDeleteSelected}
              hasSelection={selectedId !== null}
            />
            <div className={styles.canvasWrap} style={isReady ? undefined : { display: 'none' }}>
              <canvas ref={canvasElRef} />
            </div>
            <LayersPanel
              objects={objects}
              selectedId={selectedId}
              onSelect={handleSelectLayer}
              onDelete={handleDeleteLayer}
            />
          </>
        )}
      </div>
    );
  },
);
