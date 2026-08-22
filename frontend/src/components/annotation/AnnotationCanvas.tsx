import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Canvas, FabricImage, PencilBrush, Point, Polyline, type FabricObject, type TPointerEventInfo, type XY } from 'fabric';
import type { AnnotationLayer } from '../../api/types';
import { useAnnotationHistory } from './useAnnotationHistory';
import { AnnotationToolbar } from './AnnotationToolbar';
import { LayersPanel } from './LayersPanel';
import {
  applyStyleToObject,
  capsFromObject,
  createArrow,
  createCircle,
  createEndpointMarker,
  createLine,
  createRectangle,
  createSegment,
  createSmoothPath,
  createTextbox,
  currentSegment,
  makeId,
  styleFromObject,
} from './shapeFactories';
import { resolveCanvasWidth } from './canvasSizing';
import { loadPrescaledImage } from './imageLoading';
import {

  fitView,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  sceneHitRadius,
  zoomByStep,
  ZOOM_STEP,
} from './annotationViewport';
import { copyObject, hasClipboardContent, pasteObject } from './annotationClipboard';
import { isTypingTarget, useAnnotationKeyboard } from './useAnnotationKeyboard';
import { getRememberedStyle, rememberStyle } from './styleMemory';
import { ANNOTATION_PROPS, type AnnotationStyle, type AnnotationTool } from './types';
import styles from './AnnotationCanvas.module.css';

export interface AnnotationCanvasHandle {
  getAnnotations: () => AnnotationLayer[];
  getCanvasWidth: () => number;
}

interface AnnotationCanvasProps {
  imageUrl: string;
  initialAnnotations: AnnotationLayer[];
  /** Pinned from a prior save (`QuestionImage.canvas_width`); null for an
   * image that predates this field or has never been saved. */
  savedCanvasWidth: number | null;
  onReady?: () => void;
}

export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(
  function AnnotationCanvas({ imageUrl, initialAnnotations, savedCanvasWidth, onReady }, ref) {
    const canvasElRef = useRef<HTMLCanvasElement>(null);
    const canvasWrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<Canvas | null>(null);
    const canvasWidthRef = useRef(
      resolveCanvasWidth(savedCanvasWidth, initialAnnotations.length > 0),
    );
    const [tool, setTool] = useState<AnnotationTool>('select');
    /* Viewport state. `zoom` exists only so the controls can render a number;
       the truth is always canvas.getZoom(). Space-panning is a ref rather than
       state because it is read inside Fabric's mouse handlers, which must not
       re-subscribe every time it flips. */
    const [zoom, setZoom] = useState(1);
    const isSpaceDownRef = useRef(false);
    const panningRef = useRef<{ x: number; y: number } | null>(null);
    const toolRef = useRef(tool);
    toolRef.current = tool;
    const [style, setStyle] = useState<AnnotationStyle>(getRememberedStyle);
    const styleRef = useRef(style);
    styleRef.current = style;
    const [isReady, setIsReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [objects, setObjects] = useState<FabricObject[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selectedIdRef = useRef(selectedId);
    selectedIdRef.current = selectedId;

    const refreshLayers = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      setObjects([...canvas.getObjects()].reverse());
    }, []);

    // Small circles shown at a selected line/arrow's endpoints, in place of
    // the (now hidden, see createLine/createArrow) default resize/rotate
    // box - purely visual, kept in sync from both the selection effect
    // (show on select, hide on deselect, follow whole-body moves) and the
    // mouse-handling effect (follow an active endpoint drag).
    const endpointMarkersRef = useRef<[FabricObject, FabricObject] | null>(null);

    const removeEndpointMarkers = useCallback(() => {
      const canvas = canvasRef.current;
      if (canvas && endpointMarkersRef.current) {
        canvas.remove(...endpointMarkersRef.current);
        canvas.requestRenderAll();
      }
      endpointMarkersRef.current = null;
    }, []);

    const showEndpointMarkersAt = useCallback((start: XY, end: XY) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (endpointMarkersRef.current) canvas.remove(...endpointMarkersRef.current);
      const m1 = createEndpointMarker(start);
      const m2 = createEndpointMarker(end);
      canvas.add(m1, m2);
      endpointMarkersRef.current = [m1, m2];
    }, []);

    const repositionEndpointMarkers = useCallback((start: XY, end: XY) => {
      const markers = endpointMarkersRef.current;
      if (!markers) return;
      markers[0].set({ left: start.x, top: start.y });
      markers[1].set({ left: end.x, top: end.y });
      markers[0].setCoords();
      markers[1].setCoords();
    }, []);

    // In-progress multi-click curve state (click to add a point, double-click
    // to finish - see the draw effect below). Lifted out to refs, rather than
    // left as plain closure locals inside that effect, specifically so
    // resetCurveState (and therefore handleRestored, on every undo/redo) can
    // reach in and clear it - see its own comment for why that matters.
    const curvePointsRef = useRef<Point[]>([]);
    const curvePreviewRef = useRef<Polyline | null>(null);

    /** Discards any in-progress (not yet double-click-finished) curve: the
     * on-canvas preview polyline and the accumulated click points. Used when
     * a curve is deliberately abandoned - Escape, or switching to another
     * tool without finishing it - never on undo/redo (see
     * syncCurveStateFromCanvas for why those need to *resync*, not blindly
     * discard). */
    const resetCurveState = useCallback(() => {
      const canvas = canvasRef.current;
      if (canvas && curvePreviewRef.current) canvas.remove(curvePreviewRef.current);
      curvePreviewRef.current = null;
      curvePointsRef.current = [];
    }, []);

    /** Each click while drawing a curve is its own undo step on purpose - a
     * coach who misclicks a point can Ctrl+Z just that point away without
     * losing the rest of the curve. That's exactly what breaks
     * curvePointsRef/curvePreviewRef: they're plain refs the click handler
     * mutates directly, but undo/redo replace the *entire* Fabric object
     * graph via loadFromJSON, which doesn't know those refs exist. Left
     * unsynced, the refs keep pointing at whatever the curve looked like
     * before the restore - undone points reappear the moment the coach
     * clicks to add the next one, and curvePreviewRef points at a Fabric
     * object loadFromJSON already discarded. Resyncing both from whatever
     * the canvas *actually* contains after every restore - not just
     * blanket-clearing them - is what lets undo-to-zero-points, redo, and
     * "undo one point, then keep drawing" all end up in the right state. */
    const syncCurveStateFromCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) {
        curvePreviewRef.current = null;
        curvePointsRef.current = [];
        return;
      }
      const preview = canvas.getObjects().find((o) => o.type === 'polyline') as Polyline | undefined;
      if (preview) {
        curvePreviewRef.current = preview;
        curvePointsRef.current = (preview.points ?? []).map((p) => new Point(p.x, p.y));
      } else {
        curvePreviewRef.current = null;
        curvePointsRef.current = [];
      }
    }, []);

    const handleRestored = useCallback(() => {
      syncCurveStateFromCanvas();
      refreshLayers();
      setSelectedId(null);
    }, [refreshLayers, syncCurveStateFromCanvas]);

    const history = useAnnotationHistory(canvasRef, handleRestored);

    useImperativeHandle(ref, () => ({
      getAnnotations: () => {
        const canvas = canvasRef.current;
        if (!canvas) return [];
        return canvas.toObject(ANNOTATION_PROPS).objects as AnnotationLayer[];
      },
      getCanvasWidth: () => canvasWidthRef.current,
    }));

    // While something is selected, the toolbar edits *that* shape's real
    // style instead of the "next new shape" default - selecting a red dashed
    // circle should show red/dashed in the toolbar, not whatever was last
    // used to draw something else.
    const activeObject = selectedId ? (objects.find((o) => o.get('id') === selectedId) ?? null) : null;
    const displayedStyle = activeObject ? styleFromObject(activeObject) : style;
    const showFillOpacity = activeObject
      ? activeObject.type === 'rect' || activeObject.type === 'ellipse'
      : tool === 'circle' || tool === 'rectangle';
    const showLineCaps = activeObject
      ? activeObject.get('hasEditableEndpoints') === true
      : tool === 'line' || tool === 'arrow';
    const showTextWeight = activeObject ? activeObject.type === 'textbox' : tool === 'text';

    function handleStyleChange(newStyle: AnnotationStyle) {
      setStyle(newStyle);
      // Seeds the next new shape, including on the next image's canvas.
      rememberStyle(newStyle);
      if (!activeObject) return;

      const canvas = canvasRef.current;
      const caps = capsFromObject(activeObject);
      const capsChanged = caps.startCap !== newStyle.startCap || caps.endCap !== newStyle.endCap;

      if (canvas && capsChanged && activeObject.get('hasEditableEndpoints')) {
        // Changing an end style changes which shapes the annotation is made
        // of (a bare Line gains a cap and becomes a Group, or the reverse),
        // so it has to be rebuilt rather than mutated in place. Keeping the
        // same id means layers, selection, and history all still line up.
        const { start, end } = currentSegment(activeObject);
        const replacement = createSegment(start, end, newStyle);
        replacement.set('id', activeObject.get('id'));
        history.isRestoring.current = true;
        canvas.remove(activeObject);
        canvas.add(replacement);
        history.isRestoring.current = false;
        canvas.setActiveObject(replacement);
      } else {
        applyStyleToObject(activeObject, newStyle);
      }

      canvas?.requestRenderAll();
      refreshLayers();
      history.pushSnapshot();
    }

    // --- Canvas + background image setup ---------------------------------
    useEffect(() => {
      if (!canvasElRef.current) return;
      const canvas = new Canvas(canvasElRef.current, { selection: true, preserveObjectStacking: true });
      canvasRef.current = canvas;

      let cancelled = false;

      async function setup() {
        try {
          const { canvas: prescaled, width, height } = await loadPrescaledImage(
            imageUrl,
            canvasWidthRef.current,
          );
          if (cancelled) return;

          // loadPrescaledImage never upscales past the source photo's real resolution, so for a
          // photo smaller than the requested canvasWidthRef.current, `width` here is the smaller
          // achieved value - shapes drawn below are positioned in *this* space via mouse events,
          // not the originally-requested one. Correct the ref before anything reads it (draws,
          // then getCanvasWidth() on save) so the saved canvas_width matches where shapes actually
          // are - otherwise the mismatch is silently persisted (see AnnotationViewer.tsx's
          // trueCapWidth for how the player-facing side self-corrects for already-saved cases).
          canvasWidthRef.current = width;

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
            // loadFromJSON treats the given JSON as the *entire* canvas
            // state - since { objects: ... } has no backgroundImage key,
            // Fabric clears the one we just set above as part of loading.
            // Re-apply it afterward, or a question with saved annotations
            // shows the drawn shapes over a blank canvas on reload, with
            // the actual photo missing entirely.
            await canvas.loadFromJSON({ objects: initialAnnotations });
            if (cancelled) return;
            canvas.backgroundImage = image;
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
        if (active && active.get('hasEditableEndpoints')) {
          const { start, end } = currentSegment(active);
          showEndpointMarkersAt(start, end);
        } else {
          removeEndpointMarkers();
        }
      }
      function onCleared() {
        setSelectedId(null);
        removeEndpointMarkers();
      }
      // Shared by object:added/removed/modified (which pass {target}) and
      // path:created (which passes {path} instead) - typed to cover both.
      function onChanged(opt?: { target?: FabricObject; path?: FabricObject }) {
        // Endpoint markers are decorations drawn around the current selection
        // (excludeFromExport, never saved), but adding and removing them still
        // fires object:added/removed. Left unfiltered, merely selecting a line
        // banks two junk undo steps that appear to do nothing when replayed.
        if (opt?.target?.excludeFromExport) return;
        refreshLayers();
        history.pushSnapshot();
      }
      function onObjectMoving(opt: { target: FabricObject }) {
        // Keep the endpoint markers glued to a selected line/arrow while
        // it's dragged as a whole (not via an endpoint) - segStart/segEnd
        // are recomputed live from the object's current left/top.
        const target = opt.target;
        if (target?.get('hasEditableEndpoints') && target.get('id') === selectedIdRef.current) {
          const { start, end } = currentSegment(target);
          repositionEndpointMarkers(start, end);
        }
      }

      canvas.on('selection:created', onSelection);
      canvas.on('selection:updated', onSelection);
      canvas.on('selection:cleared', onCleared);
      canvas.on('object:added', onChanged);
      canvas.on('object:removed', onChanged);
      canvas.on('object:modified', onChanged);
      canvas.on('object:moving', onObjectMoving);
      canvas.on('path:created', onChanged);

      return () => {
        canvas.off('selection:created', onSelection);
        canvas.off('selection:updated', onSelection);
        canvas.off('selection:cleared', onCleared);
        canvas.off('object:added', onChanged);
        canvas.off('object:removed', onChanged);
        canvas.off('object:modified', onChanged);
        canvas.off('object:moving', onObjectMoving);
        canvas.off('path:created', onChanged);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady, refreshLayers, showEndpointMarkersAt, removeEndpointMarkers, repositionEndpointMarkers]);

    // --- Freehand brush follows style/tool changes -------------------------
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !isReady) return;

      // Switching to any other tool mid-curve (without double-clicking to
      // finish) abandons it - clear the in-progress points/preview here too,
      // or the next curve started later would silently resume from wherever
      // the abandoned one left off (its points are still in curvePointsRef).
      if (tool !== 'curve') resetCurveState();

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
    }, [tool, style, isReady, resetCurveState]);

    // --- Click/drag drawing for line, arrow, circle, rectangle, curve, text
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !isReady) return;

      let shape: FabricObject | null = null;
      let startPoint: Point | null = null;

      // Dragging one end of an already-placed line/arrow to reshape it,
      // rather than the default resize/rotate bounding-box handles - see
      // handleMouseDown's hit-test below.
      let draggingEndpoint: {
        // Untouched original, kept in case mouseup arrives with no mousemove
        // in between (a plain click, not a drag) - restored as-is instead of
        // being left removed with nothing rebuilt to replace it.
        originalObject: FabricObject;
        object: FabricObject | null;
        id: string;
        which: 'start' | 'end';
        fixed: XY;
        style: AnnotationStyle;
      } | null = null;
      /* A SCREEN radius, converted to scene units per zoom at the moment of
         the test - see sceneHitRadius. Left as 14 so the feel at 1x is exactly
         what it has always been. */
      const ENDPOINT_HIT_RADIUS = 14;

      function finalizeCurve() {
        // The finished path is one deliberate action from the coach's
        // perspective (finalizing the whole curve), so it gets exactly one
        // history snapshot - same isRestoring bracketing pattern used around
        // the line/arrow/circle/rectangle drag gesture below, just spanning
        // the multi-click gesture instead of a single mouse drag.
        history.isRestoring.current = true;
        if (curvePreviewRef.current) canvas!.remove(curvePreviewRef.current);
        curvePreviewRef.current = null;
        if (curvePointsRef.current.length >= 2) {
          const path = createSmoothPath(curvePointsRef.current, styleRef.current);
          path.set('id', makeId());
          canvas!.add(path);
        }
        curvePointsRef.current = [];
        history.isRestoring.current = false;
        refreshLayers();
        history.pushSnapshot();
        // STICKY: the tool stays Route. A coach drawing a coverage draws
        // several routes in a row, and dropping back to Select after each one
        // made the second route cost two actions instead of one.
        canvas!.requestRenderAll();
      }

      function handleMouseDown(opt: TPointerEventInfo) {
        /* SPACE PRE-EMPTS THE TOOL, IT DOES NOT REPLACE IT. Holding Space
           turns the next drag into a pan and returns nothing to the toolbar,
           so an Arrow is still an Arrow when the key comes back up. */
        if (isSpaceDownRef.current) {
          const e = opt.e as MouseEvent;
          panningRef.current = { x: e.clientX, y: e.clientY };
          return;
        }
        const currentTool = toolRef.current;
        const point = opt.scenePoint;

        if (currentTool === 'select') {
          const active = canvas!.getActiveObject();
          if (active && active.get('hasEditableEndpoints')) {
            const { start: segStart, end: segEnd } = currentSegment(active);
            const distToStart = Math.hypot(point.x - segStart.x, point.y - segStart.y);
            const distToEnd = Math.hypot(point.x - segEnd.x, point.y - segEnd.y);
            const hitRadius = sceneHitRadius(ENDPOINT_HIT_RADIUS, canvas!.getZoom());
            if (distToStart <= hitRadius || distToEnd <= hitRadius) {
              const which = distToStart <= distToEnd ? 'start' : 'end';
              const fixed = which === 'start' ? segEnd : segStart;
              draggingEndpoint = {
                originalObject: active,
                object: null,
                id: active.get('id') as string,
                which,
                fixed,
                // styleFromObject already carries the segment's own caps, so
                // the rebuild below preserves them through the drag.
                style: styleFromObject(active),
              };
              history.isRestoring.current = true;
              canvas!.remove(active);
              showEndpointMarkersAt(segStart, segEnd);
              canvas!.requestRenderAll();
              return;
            }
          }
        }

        if (currentTool === 'text') {
          const textbox = createTextbox(point, styleRef.current);
          textbox.set('id', makeId());
          canvas!.add(textbox);
          canvas!.setActiveObject(textbox);
          textbox.enterEditing();
          setTool('select');
          return;
        }

        if (currentTool === 'curve') {
          // Each click is its own history snapshot, deliberately - a coach
          // who misclicks a point can Ctrl+Z just that point away without
          // losing the rest of the curve (see syncCurveStateFromCanvas for
          // how undo/redo stay in sync with curvePointsRef/curvePreviewRef
          // across that).
          curvePointsRef.current.push(point);
          if (curvePreviewRef.current) canvas!.remove(curvePreviewRef.current);
          curvePreviewRef.current = new Polyline(curvePointsRef.current, {
            stroke: styleRef.current.color,
            strokeWidth: styleRef.current.strokeWidth,
            fill: '',
            selectable: false,
            evented: false,
          });
          canvas!.add(curvePreviewRef.current);
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
        if (panningRef.current) {
          const e = opt.e as MouseEvent;
          panBy(canvas!, e.clientX - panningRef.current.x, e.clientY - panningRef.current.y);
          panningRef.current = { x: e.clientX, y: e.clientY };
          canvas!.requestRenderAll();
          return;
        }
        if (draggingEndpoint) {
          const point = opt.scenePoint;
          const newStart = draggingEndpoint.which === 'start' ? point : draggingEndpoint.fixed;
          const newEnd = draggingEndpoint.which === 'end' ? point : draggingEndpoint.fixed;

          if (draggingEndpoint.object) canvas!.remove(draggingEndpoint.object);
          const rebuilt = createSegment(newStart, newEnd, draggingEndpoint.style);
          rebuilt.set('id', draggingEndpoint.id);
          canvas!.add(rebuilt);
          draggingEndpoint.object = rebuilt;

          repositionEndpointMarkers(newStart, newEnd);
          canvas!.requestRenderAll();
          return;
        }

        if (!shape || !startPoint) return;
        const point = opt.scenePoint;
        const currentTool = toolRef.current;

        if (currentTool === 'line' || currentTool === 'arrow') {
          // Rebuilt rather than resized in place: with a start/end cap
          // selected the segment is a Group of shaft + caps, whose geometry
          // can't be updated by setting x2/y2 on a single Line.
          canvas!.remove(shape);
          shape =
            currentTool === 'arrow'
              ? createArrow(startPoint, point, styleRef.current)
              : createLine(startPoint, point, styleRef.current);
          shape.set('id', makeId());
          canvas!.add(shape);
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
        }
        canvas!.requestRenderAll();
      }

      function handleMouseUp() {
        if (panningRef.current) {
          panningRef.current = null;
          return;
        }
        if (draggingEndpoint) {
          removeEndpointMarkers();
          history.isRestoring.current = false;
          if (draggingEndpoint.object) {
            // A real drag happened - the rebuilt shape is already on the canvas.
            draggingEndpoint.object.setCoords();
            canvas!.setActiveObject(draggingEndpoint.object);
            refreshLayers();
            history.pushSnapshot();
          } else {
            // mouseup arrived with no mousemove in between - just a click,
            // not a drag. Nothing was ever rebuilt, so put the original
            // back exactly as it was rather than leaving it deleted.
            canvas!.add(draggingEndpoint.originalObject);
            canvas!.setActiveObject(draggingEndpoint.originalObject);
          }
          draggingEndpoint = null;
          canvas!.requestRenderAll();
          return;
        }

        if (shape) {
          shape.setCoords();
          history.isRestoring.current = false;
          refreshLayers();
          history.pushSnapshot();
          /* STICKY: the tool stays Line / Arrow / Box / Circle.
             This used to return to Select, and the comment here warned that
             the next click-and-drag would be read as "draw another one"
             rather than "move this shape". That hazard is not real: while any
             drawing tool is active every object is set selectable:false and
             evented:false (see the tool effect above), so dragging an
             existing shape is not offered until a coach asks for Select
             anyway. What the reset actually cost was the second line, the
             second arrow and the second box - each one a tool click a coach
             had already made. */
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

      /* WHEEL OVER THE CANVAS ONLY. Fabric's mouse:wheel fires for this canvas
         and nothing else, so the page keeps its own scrolling everywhere
         outside it; preventDefault here stops the browser ALSO scrolling the
         page out from under a coach who meant to zoom. */
      function handleWheel(opt: TPointerEventInfo<WheelEvent>) {
        const e = opt.e;
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          // Sideways, for a wide playbook page.
          panBy(canvas!, -e.deltaY - e.deltaX, 0);
        } else {
          // deltaY is positive scrolling down / away, which reads as "smaller".
          const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
          zoomByStep(canvas!, opt.viewportPoint, factor);
        }
        setZoom(canvas!.getZoom());
        canvas!.requestRenderAll();
      }
      canvas.on('mouse:wheel', handleWheel);

      return () => {
        canvas.off('mouse:down', handleMouseDown);
        canvas.off('mouse:move', handleMouseMove);
        canvas.off('mouse:up', handleMouseUp);
        canvas.off('mouse:dblclick', handleDoubleClick);
        canvas.off('mouse:wheel', handleWheel);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady]);

    /* SPACE IS A MODIFIER, NOT A TOOL.
       It lives here rather than in useAnnotationKeyboard because that hook
       maps keys to actions, and this changes what a DRAG means for exactly as
       long as the key is down. Nothing about the toolbar changes, so releasing
       it leaves the coach on the Arrow they were already using.

       isTypingTarget is the same guard the shortcuts use: Space must stay a
       space character in a quiz field, and inside the hidden textarea Fabric
       mounts while a label is being edited. */
    useEffect(() => {
      if (!isReady) return;

      function onKeyDown(event: KeyboardEvent) {
        if (event.code !== 'Space' || isTypingTarget(event.target)) return;
        if (isSpaceDownRef.current) return;
        isSpaceDownRef.current = true;
        // Stops the page scrolling on a held space bar.
        event.preventDefault();
        const canvas = canvasRef.current;
        if (canvas) canvas.defaultCursor = 'grab';
      }

      function onKeyUp(event: KeyboardEvent) {
        if (event.code !== 'Space') return;
        isSpaceDownRef.current = false;
        panningRef.current = null;
        const canvas = canvasRef.current;
        if (canvas) canvas.defaultCursor = 'default';
      }

      /* A window that loses focus mid-pan (alt-tab with Space held) never
         delivers the keyup, and the editor would stay stuck in pan. */
      function onBlur() {
        isSpaceDownRef.current = false;
        panningRef.current = null;
      }

      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
      return () => {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
      };
    }, [isReady]);

    /* FIT THE IMAGE TO THE WORKSPACE, IN DISPLAY PIXELS ONLY.
     *
     * scale = min(workspaceW / canvasW, workspaceH / canvasH) - contain, so a
     * portrait playbook page and a wide film still both land whole, and the
     * larger of the two ratios never crops.
     *
     * This is the SAME lever the stylesheet used to pull with `max-width:
     * 100%`, just computed so the image can grow into a big monitor instead of
     * stopping at its own resolution. It sets how large the element is drawn;
     * the backing store, every object coordinate and question_images.
     * canvas_width are all untouched, and Fabric keeps resolving pointers by
     * comparing getBoundingClientRect() against the width/height ATTRIBUTES,
     * so a click still lands where it looks like it lands.
     *
     * Deliberately NOT viewport zoom: zoom is the coach's, and having Fit
     * silently spend it would mean the readout no longer said what they had
     * chosen. 100% keeps meaning "the whole image, fitted".
     */
    useEffect(() => {
      const wrap = canvasWrapRef.current;
      if (!wrap || !isReady) return;

      function applyFit() {
        const canvas = canvasRef.current;
        const el = canvasWrapRef.current;
        if (!canvas || !el) return;
        const availableW = el.clientWidth;
        const availableH = el.clientHeight;
        const sceneW = canvas.getWidth();
        const sceneH = canvas.getHeight();
        if (!availableW || !availableH || !sceneW || !sceneH) return;
        const scale = Math.min(availableW / sceneW, availableH / sceneH);
        el.style.setProperty('--fit-w', `${Math.round(sceneW * scale)}px`);
        el.style.setProperty('--fit-h', `${Math.round(sceneH * scale)}px`);
      }

      applyFit();
      /* jsdom has no ResizeObserver, and an editor that throws on mount in the
         test environment is worse than one that simply does not re-fit there -
         the fit itself is still applied once above, so the measurement path
         stays covered. */
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(applyFit);
      observer.observe(wrap);
      return () => observer.disconnect();
    }, [isReady]);

    function handleZoomStep(factor: number) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // The centre of the visible area, so a button press is not anchored to
      // wherever the pointer happens to be resting.
      zoomByStep(canvas, new Point(canvas.getWidth() / 2, canvas.getHeight() / 2), factor);
      setZoom(canvas.getZoom());
      canvas.requestRenderAll();
    }

    function handleFitView() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      fitView(canvas);
      setZoom(canvas.getZoom());
    }

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

    useAnnotationKeyboard(
      {
        onUndo: () => {
          if (!history.canUndo) return false;
          history.undo();
          return true;
        },
        onRedo: () => {
          if (!history.canRedo) return false;
          history.redo();
          return true;
        },
        onCopy: () => {
          const active = canvasRef.current?.getActiveObject();
          if (!active) return false;
          copyObject(active);
          return true;
        },
        onPaste: () => {
          const canvas = canvasRef.current;
          if (!canvas || !hasClipboardContent()) return false;
          // The paste itself is async (Fabric has to rebuild the shape from
          // its serialized form); claiming the keystroke synchronously is
          // what stops the browser's own paste from also firing.
          pasteObject(canvas).then(() => refreshLayers());
          return true;
        },
        onSelectTool: (next) => {
          setTool(next);
          return true;
        },
        onDelete: () => {
          const canvas = canvasRef.current;
          if (!canvas || canvas.getActiveObjects().length === 0) return false;
          handleDeleteSelected();
          return true;
        },
        onEscape: () => {
          const canvas = canvasRef.current;
          if (!canvas) return false;
          /* THE WAY OUT OF A STICKY TOOL, and the reason sticky is safe.
             Escape abandons a half-drawn route, drops any selection, and
             always lands back on Select - so a coach who has been stamping
             arrows is one key away from moving one. */
          const wasDrawing = curvePointsRef.current.length > 0 || curvePreviewRef.current;
          if (wasDrawing) resetCurveState();
          const hadSelection = Boolean(canvas.getActiveObject());
          if (hadSelection) canvas.discardActiveObject();
          const wasToolActive = toolRef.current !== 'select';
          if (wasToolActive) setTool('select');
          if (wasDrawing || hadSelection || wasToolActive) {
            canvas.requestRenderAll();
            return true;
          }
          return false;
        },
      },
      isReady,
    );

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
              style={displayedStyle}
              onStyleChange={handleStyleChange}
              showFillOpacity={showFillOpacity}
              showLineCaps={showLineCaps}
              showTextWeight={showTextWeight}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onUndo={history.undo}
              onRedo={history.redo}
              onDeleteSelected={handleDeleteSelected}
              hasSelection={selectedId !== null}
            />
            <div
              ref={canvasWrapRef}
              className={styles.canvasWrap}
              style={isReady ? undefined : { display: 'none' }}
            >
              <canvas ref={canvasElRef} />
            </div>
            {/* THE MINIMUM THAT MAKES ZOOM DISCOVERABLE. A coach who never
                learns the wheel or the space bar can still get in, get out and
                get back to the whole image; anyone who does learn them never
                needs to look here. Deliberately not a navigator or a minimap -
                and built as its own row so the workspace shell can move it
                without rebuilding it. */}
            {isReady && (
              <div className={styles.viewControls}>
                <button
                  type="button"
                  className={styles.viewButton}
                  onClick={() => handleZoomStep(1 / ZOOM_STEP)}
                  disabled={zoom <= MIN_ZOOM + 0.001}
                  title="Zoom out"
                  aria-label="Zoom out"
                >
                  &minus;
                </button>
                <span className={styles.zoomReadout} aria-live="polite">
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  type="button"
                  className={styles.viewButton}
                  onClick={() => handleZoomStep(ZOOM_STEP)}
                  disabled={zoom >= MAX_ZOOM - 0.001}
                  title="Zoom in"
                  aria-label="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  className={styles.fitButton}
                  onClick={handleFitView}
                  title="Fit the whole image"
                >
                  Fit
                </button>
              </div>
            )}
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
