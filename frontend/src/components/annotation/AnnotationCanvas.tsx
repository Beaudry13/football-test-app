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

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

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
          // Load the raw element ourselves (not via FabricImage.fromURL) and
          // pre-render it to its exact display size on a plain canvas before
          // handing it to Fabric. Fabric's own image-drawing path has a bug
          // where a large source image (e.g. a 2048x1152 or 1242x2208 photo)
          // only renders a portion of itself once scaled down - traced to its
          // internal filter-scaling/crop math, not to caching or CORS (both
          // independently verified fine: a manual drawImage() at the same
          // target size always renders correctly, regardless of source
          // resolution). Handing Fabric an already-correctly-sized source
          // sidesteps that internal path entirely.
          //
          // crossOrigin: 'anonymous' is still required for the raw load once
          // images can come from a different origin (R2) - without it the
          // browser taints the canvas the moment we draw a cross-origin image
          // onto it, so getContext('2d').drawImage() below would silently
          // fail. The image host must send matching CORS headers back (see R2
          // bucket CORS policy / backend CORS config for local uploads).
          const rawImage = await loadImageElement(imageUrl);
          if (cancelled) return;

          const naturalWidth = rawImage.naturalWidth || MAX_CANVAS_WIDTH;
          const naturalHeight = rawImage.naturalHeight || naturalWidth;
          const scale = Math.min(1, MAX_CANVAS_WIDTH / naturalWidth);
          const width = Math.round(naturalWidth * scale);
          const height = Math.round(naturalHeight * scale);

          const prescaled = document.createElement('canvas');
          prescaled.width = width;
          prescaled.height = height;
          prescaled.getContext('2d')!.drawImage(rawImage, 0, 0, width, height);

          const image = new FabricImage(prescaled);
          canvas.setDimensions({ width, height });
          // originX/Y: Fabric objects default to *center* origin, not
          // top-left - left:0, top:0 (also both defaults, never set here)
          // then places the image's *center* at canvas (0,0), not its
          // corner. Only the bottom-right quadrant of the image ends up
          // inside the visible canvas; the rest renders off-canvas at
          // negative coordinates. This, not caching or CORS, was the actual
          // cause of images only partially showing - confirmed against
          // Fabric's own source defaults (originX/originY: 'center').
          image.set({
            selectable: false,
            evented: false,
            objectCaching: false,
            originX: 'left',
            originY: 'top',
          });
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
