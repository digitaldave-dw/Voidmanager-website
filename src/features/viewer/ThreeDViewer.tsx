/**
 * ThreeDViewer — React component wrapping the OBC 3D world.
 *
 * Responsibilities:
 * - Mount/unmount the Three.js canvas cleanly (no duplicate canvases on hot-reload).
 * - Expose a "Load IFC" button and a hidden (but reachable) file input
 *   for Playwright E2E testing.
 * - Show load progress + error states.
 * - Report element count via data-testid="ifc-status" for E2E assertions.
 * - Accept `voids`/`selectedVoidIds` props; forward to WorldController.
 * - Expose imperative handle (ThreeDViewerHandle) via forwardRef for M6
 *   config save/restore: exportModels(), loadFragments(), hasModels().
 */

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { createWorldController, type WorldController, type LoadedModel } from './world';
import type { VoidRow } from '../../data/VoidRepository';
import { useSelection, setSelection, toggle, clear } from '../../store/selectionStore';
import ModelBrowser from '../browser/ModelBrowser';
import PropertyBrowser from '../browser/PropertyBrowser';
import { normalizeSpatialStructure, type TreeNode } from '../browser/spatialTree';
import styles from './ThreeDViewer.module.css';

/** localStorage key remembering whether the side panel is open. */
const PANEL_KEY = 'vm.viewer.sidePanel';
const XRAY_KEY = 'vm.viewer.voidXray';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewerStatus =
  | { tag: 'idle' }
  | { tag: 'initializing' }
  | { tag: 'ready' }
  | { tag: 'loading'; percent: number; step?: string }
  | { tag: 'loaded'; model: LoadedModel }
  | { tag: 'error'; message: string };

// ---------------------------------------------------------------------------
// Imperative handle (M6 config caching)
// ---------------------------------------------------------------------------

export interface ThreeDViewerHandle {
  /** Serialize all loaded fragment models to { id, bytes } pairs. */
  exportModels(): Promise<{ id: string; bytes: Uint8Array }[]>;
  /** Load a pre-converted fragments buffer (no IFC re-parse). */
  loadFragments(id: string, bytes: Uint8Array): Promise<void>;
  /** True if at least one fragment model is currently loaded. */
  hasModels(): boolean;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ThreeDViewerProps {
  /**
   * All void rows currently loaded from the DB.
   * When this array changes (DB load / project filter), void meshes are
   * rebuilt in the scene.
   */
  voids?: VoidRow[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ThreeDViewer = forwardRef<ThreeDViewerHandle, ThreeDViewerProps>(
  function ThreeDViewer({ voids = [] }, ref) {
    // Unified selection store (any source: grid / viewer / browser).
    const selection = useSelection();

    const containerRef = useRef<HTMLDivElement>(null);
    const controllerRef = useRef<WorldController | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [status, setStatus] = useState<ViewerStatus>({ tag: 'idle' });
    const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem(PANEL_KEY) !== 'closed');
    useEffect(() => {
      localStorage.setItem(PANEL_KEY, panelOpen ? 'open' : 'closed');
    }, [panelOpen]);

    // X-ray: voids drawn through the model (on by default — they sit inside their hosts).
    const [voidXray, setVoidXray] = useState(() => localStorage.getItem(XRAY_KEY) !== 'off');
    const initPromiseRef = useRef<Promise<void> | null>(null);
    const [voidMeshCount, setVoidMeshCount] = useState(0);
    // Tracks whether the WorldController is ready to accept setVoids calls.
    const [worldReady, setWorldReady] = useState(false);
    useEffect(() => {
      localStorage.setItem(XRAY_KEY, voidXray ? 'on' : 'off');
      if (worldReady) controllerRef.current?.setVoidXray(voidXray);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [voidXray, worldReady]);

    // M13: model browser tree.
    const [trees, setTrees] = useState<TreeNode[]>([]);

    // Property browser: fetched attributes for the selected element.
    const [elementProperties, setElementProperties] = useState<Record<string, string> | null>(null);
    const [propertiesLoading, setPropertiesLoading] = useState(false);
    const [sectionActive, setSectionActive] = useState(false);

    // -------------------------------------------------------------------------
    // Imperative handle — M6 config caching
    // -------------------------------------------------------------------------
    useImperativeHandle(ref, () => ({
      async exportModels() {
        const ctrl = controllerRef.current;
        if (!ctrl) return [];
        return ctrl.exportLoadedModels();
      },
      async loadFragments(id: string, bytes: Uint8Array) {
        // World init is async; if a restore fires before it finishes, wait for it
        // rather than silently dropping the model (no setTimeout race).
        if (!controllerRef.current && initPromiseRef.current) {
          await initPromiseRef.current;
        }
        const ctrl = controllerRef.current;
        if (!ctrl) return;
        setStatus({ tag: 'loading', percent: 100 });
        try {
          const model = await ctrl.loadFragmentModel(id, bytes);
          setStatus({ tag: 'loaded', model });
        } catch (e) {
          console.error('[ThreeDViewer] loadFragments failed', e);
          setStatus({ tag: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      },
      hasModels() {
        return controllerRef.current?.hasModels() ?? false;
      },
    }), []);

    // -------------------------------------------------------------------------
    // Initialize OBC world on mount, dispose on unmount
    // -------------------------------------------------------------------------
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      // StrictMode (dev) double-mounts: the effect runs, is cleaned up, then runs
      // again. createWorldController is async, so a naive guard leaves the FIRST
      // controller's canvas orphaned (two stacked canvases). We instead track a
      // `cancelled` flag and dispose whichever controller belongs to a cancelled
      // mount — guaranteeing exactly one live controller + canvas.
      let cancelled = false;
      let localCtrl: WorldController | null = null;
      setStatus({ tag: 'initializing' });

      const p = (async () => {
        try {
          const ctrl = await createWorldController(container);
          if (cancelled) {
            ctrl.dispose(); // this mount was torn down mid-init — drop the orphan
            return;
          }
          localCtrl = ctrl;
          controllerRef.current = ctrl;
          setWorldReady(true);
          setStatus({ tag: 'ready' });
        } catch (e) {
          if (cancelled) return;
          console.error('[ThreeDViewer] init failed', e);
          setStatus({ tag: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      })();
      initPromiseRef.current = p;

      return () => {
        cancelled = true;
        if (localCtrl) {
          localCtrl.dispose();
          if (controllerRef.current === localCtrl) controllerRef.current = null;
        }
        initPromiseRef.current = null;
        setWorldReady(false);
      };
      // Run only once on mount — container ref is stable
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // -------------------------------------------------------------------------
    // Sync voids → world when voids change OR when world first becomes ready
    // -------------------------------------------------------------------------
    useEffect(() => {
      if (!worldReady) return;
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      void (async () => {
        try {
          await ctrl.setVoids(voids);
          setVoidMeshCount(ctrl.getVoidMeshCount());
        } catch (e) {
          console.warn('[ThreeDViewer] setVoids failed', e);
        }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [voids, worldReady]);

    // -------------------------------------------------------------------------
    // Sync the unified selection → world highlight (handles voids + elements)
    // -------------------------------------------------------------------------
    useEffect(() => {
      if (!worldReady) return;
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      void (async () => {
        try {
          await ctrl.setSelection([...selection.refs]);
          // A row picked in the grid: fly to it so it can be found in the model.
          if (selection.source === 'grid' && selection.refs.length > 0) await ctrl.zoomToSelection();
        } catch (e) {
          console.warn('[ThreeDViewer] setSelection failed', e);
        }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection, worldReady]);

    // -------------------------------------------------------------------------
    // Click-to-pick in the 3D scene → write the unified selection (source 'viewer')
    // -------------------------------------------------------------------------
    const handleCanvasClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      try {
        const ref = await ctrl.pickAt(e.clientX, e.clientY);
        if (ref) {
          if (additive) toggle(ref, 'viewer');
          else setSelection([ref], 'viewer');
        } else if (!additive) {
          clear('viewer');
        }
      } catch (err) {
        console.warn('[ThreeDViewer] pick failed', err);
      }
    }, []);

    // Zoom toolbar actions.
    const handleZoomToSelection = useCallback(() => {
      void controllerRef.current?.zoomToSelection();
    }, []);
    const handleZoomToFit = useCallback(() => {
      void controllerRef.current?.zoomToFit();
    }, []);

    // Section plane toolbar actions.
    const selectedVoidIds = selection.refs
      .filter((r): r is { kind: 'void'; voidId: number } => r.kind === 'void')
      .map((r) => r.voidId);

    function handleSection() {
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      ctrl.sectionToVoidTops(selectedVoidIds);
      setSectionActive(true);
    }

    function handleClearSection() {
      controllerRef.current?.clearSectionPlane();
      setSectionActive(false);
    }

    // -------------------------------------------------------------------------
    // M13: refresh the model-browser tree whenever a model finishes loading.
    // -------------------------------------------------------------------------
    const refreshTrees = useCallback(async () => {
      const ctrl = controllerRef.current;
      if (!ctrl) return;
      try {
        const structs = await ctrl.getSpatialStructures();
        setTrees(structs.map((s) => normalizeSpatialStructure(s.structure, s.modelId, s.names, s.name)));
      } catch (e) {
        console.warn('[ThreeDViewer] refreshTrees failed', e);
      }
    }, []);

    useEffect(() => {
      if (status.tag === 'loaded') void refreshTrees();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status.tag]);

    // -------------------------------------------------------------------------
    // Fetch IFC element properties whenever the selection gains an element ref.
    // -------------------------------------------------------------------------
    useEffect(() => {
      const ctrl = controllerRef.current;
      if (!ctrl || !worldReady) { setElementProperties(null); return; }

      const elementRef = selection.refs.find(
        (r): r is { kind: 'element'; modelId: string; localId: number } => r.kind === 'element',
      );
      if (!elementRef) { setElementProperties(null); return; }

      // A lookup still running when the selection changes must not overwrite the panel.
      let stale = false;
      setPropertiesLoading(true);
      void ctrl.getElementProperties(elementRef.modelId, elementRef.localId).then((props) => {
        if (stale) return;
        setElementProperties(props);
        setPropertiesLoading(false);
      });
      return () => {
        stale = true;
        setPropertiesLoading(false);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection, worldReady]);

    // -------------------------------------------------------------------------
    // Dev-only deterministic pick hook for Playwright (WebGL clicks aren't
    // addressable by element otherwise). Writes the picked ref to the store.
    // -------------------------------------------------------------------------
    useEffect(() => {
      if (!import.meta.env.DEV || !worldReady) return;
      const w = window as unknown as {
        __pickAt?: (x: number, y: number) => Promise<unknown>;
        __pickRaw?: (x: number, y: number) => Promise<unknown>;
        __debug?: () => unknown;
        __diagVoidPick?: () => unknown;
      };
      w.__pickAt = async (x: number, y: number) => {
        const ref = await controllerRef.current?.pickAt(x, y);
        if (ref) setSelection([ref], 'viewer');
        else clear('viewer');
        return ref ?? null;
      };
      // Raw pick (no store write) for diagnostics.
      w.__pickRaw = async (x: number, y: number) =>
        (await controllerRef.current?.pickAt(x, y)) ?? null;
      w.__debug = () => controllerRef.current?.debugInfo() ?? null;
      w.__diagVoidPick = () => controllerRef.current?.diagVoidPick() ?? null;
      return () => {
        delete w.__pickAt;
        delete w.__pickRaw;
        delete w.__debug;
        delete w.__diagVoidPick;
      };
    }, [worldReady]);

    // -------------------------------------------------------------------------
    // Load IFC handler (shared by button and file input)
    // -------------------------------------------------------------------------
    /** Load one IFC; `step` (e.g. "2/3") labels the progress when several files load in a row. Returns success. */
    const handleFileBytes = useCallback(async (bytes: Uint8Array, name: string, step?: string): Promise<boolean> => {
      const ctrl = controllerRef.current;
      if (!ctrl) return false;

      setStatus({ tag: 'loading', percent: 0, step });
      try {
        const model = await ctrl.loadIfc(bytes, name, ({ percent }) => {
          setStatus({ tag: 'loading', percent, step });
        });
        setStatus({ tag: 'loaded', model });
        return true;
      } catch (e) {
        console.error('[ThreeDViewer] IFC load failed', e);
        setStatus({ tag: 'error', message: `${name}: ${e instanceof Error ? e.message : String(e)}` });
        return false;
      }
    }, []);

    // -------------------------------------------------------------------------
    // File input change handler
    // -------------------------------------------------------------------------
    async function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
      const input = e.target;
      const files = [...(input.files ?? [])];
      // Load one after another, not in parallel: the first model fixes the shared coordinate
      // offset that every later model (and the void meshes) is aligned to.
      for (const [i, file] of files.entries()) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const step = files.length > 1 ? `${i + 1}/${files.length}` : undefined;
        if (!(await handleFileBytes(bytes, file.name.replace(/\.ifc$/i, ''), step))) break;
      }
      // Reset input so the same files can be re-loaded
      input.value = '';
    }

    // -------------------------------------------------------------------------
    // "Load IFC" button handler — triggers the hidden file input
    // -------------------------------------------------------------------------
    function handleLoadButtonClick() {
      fileInputRef.current?.click();
    }

    // -------------------------------------------------------------------------
    // Status text for data-testid="ifc-status"
    // -------------------------------------------------------------------------
    function statusText(): string {
      switch (status.tag) {
        case 'idle':
          return 'Viewer idle';
        case 'initializing':
          return 'Initializing 3D viewer…';
        case 'ready':
          return 'Ready — load an IFC file';
        case 'loading':
          return `Loading IFC${status.step ? ` ${status.step}` : ''}… ${status.percent.toFixed(0)}%`;
        case 'loaded':
          return `Loaded ${status.model.elementCount} elements`;
        case 'error':
          return `Error: ${status.message}`;
      }
    }

    const isLoading = status.tag === 'loading' || status.tag === 'initializing';
    const canLoad = status.tag === 'ready' || status.tag === 'loaded' || status.tag === 'error';

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------
    return (
      <div className={styles.viewerWrapper}>
        {/* Canvas column — fills the space left of the side panel */}
        <div className={styles.canvasColumn}>
          {/* IFC load progress bar */}
          {status.tag === 'loading' && (
            <div className={styles.loadingBar} aria-hidden="true">
              <div
                className={`${styles.loadingBarFill}${status.percent === 0 ? ` ${styles.loadingBarIndeterminate}` : ''}`}
                style={status.percent > 0 ? { width: `${status.percent}%` } : undefined}
              />
            </div>
          )}

          {/* Three.js will append a <canvas> here. Clicks pick void meshes / IFC elements. */}
          <div
            ref={containerRef}
            className={styles.canvas}
            onClick={(e) => void handleCanvasClick(e)}
          />

          {/* Toolbar floats over the canvas column */}
          <div className={styles.toolbar}>
            {/* Load IFC button */}
            <button
              type="button"
              className={styles.loadBtn}
              onClick={handleLoadButtonClick}
              disabled={isLoading || !canLoad}
              title="Load one or more local .ifc files into the 3D viewer (select several to federate them)"
            >
              {status.tag === 'loading'
                ? `Loading${status.step ? ` ${status.step}` : ''}… ${status.percent.toFixed(0)}%`
                : 'Load IFC'}
            </button>

            {/* Visible, reachable file input for Playwright E2E + non-button access */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".ifc"
              multiple
              data-testid="ifc-file-input"
              className={styles.fileInput}
              onChange={(e) => void handleFileInputChange(e)}
              aria-label="Select IFC file"
            />

            {/* Camera framing */}
            <button
              type="button"
              className={styles.loadBtn}
              onClick={handleZoomToSelection}
              disabled={selection.refs.length === 0}
              data-testid="zoom-to-selection"
              title="Zoom the camera to fit the current selection"
            >
              Zoom to
            </button>
            <button
              type="button"
              className={styles.loadBtn}
              onClick={handleZoomToFit}
              data-testid="zoom-to-fit"
              title="Zoom the camera to fit all visible objects"
            >
              Zoom to Fit
            </button>

            <button
              type="button"
              className={`${styles.loadBtn} ${voidXray ? styles.toggleOn : ''}`}
              onClick={() => setVoidXray((on) => !on)}
              aria-pressed={voidXray}
              data-testid="void-xray"
              title="X-ray: show voids through the model instead of hidden inside their slabs and walls"
            >
              X-ray voids
            </button>

            {/* Section plane */}
            <button
              type="button"
              className={styles.loadBtn}
              onClick={handleSection}
              disabled={selectedVoidIds.length === 0}
              data-testid="section-plane"
              title="Clip to a horizontal plane at the top of the selected voids"
            >
              Section
            </button>
            <button
              type="button"
              className={styles.loadBtn}
              onClick={handleClearSection}
              disabled={!sectionActive}
              data-testid="clear-section-plane"
              title="Remove the active section plane"
            >
              Clear Section
            </button>

            {/* Status indicator */}
            <span
              className={`${styles.statusBadge} ${status.tag === 'error' ? styles.statusError : ''}`}
              data-testid="ifc-status"
            >
              {statusText()}
            </span>

            {/* Void mesh + selection status for E2E assertions */}
            <span className={styles.statusBadge} data-testid="void-mesh-status">
              {`voids: ${voidMeshCount} · selected: ${selection.refs.length}`}
            </span>

            {/* Unified selection breakdown for E2E assertions */}
            <span className={styles.statusBadge} data-testid="selection-status">
              {`sel: ${selection.refs.length} (v:${
                selection.refs.filter((r) => r.kind === 'void').length
              } e:${selection.refs.filter((r) => r.kind === 'element').length})`}
            </span>
          </div>

          {/* Error overlay (in addition to status badge) */}
          {status.tag === 'error' && (
            <div className={styles.errorOverlay}>
              <span>{status.message}</span>
            </div>
          )}
        </div>

        {/* Side panel (right): model tree above, properties below. Stays mounted when hidden
            so the tree keeps its expanded nodes; the renderer resizes via its ResizeObserver. */}
        <aside className={styles.sidePanel} hidden={!panelOpen} data-testid="side-panel">
          <div className={styles.panelHeader}>
            <span>Model</span>
            <button
              type="button"
              className={styles.panelToggle}
              onClick={() => setPanelOpen(false)}
              aria-label="Hide side panel"
              title="Hide panel"
            >
              ›
            </button>
          </div>
          <div className={styles.browserSection} data-testid="model-browser-drawer">
            <ModelBrowser trees={trees} />
          </div>
          <div className={styles.panelHeader}>
            <span>Properties</span>
          </div>
          <div className={styles.propertySection} data-testid="property-browser-drawer">
            <PropertyBrowser
              properties={elementProperties}
              loading={propertiesLoading}
              elementLabel={elementProperties?.Name}
            />
          </div>
        </aside>
        {!panelOpen && (
          <button
            type="button"
            className={styles.panelReopen}
            onClick={() => setPanelOpen(true)}
            aria-label="Show side panel"
            data-testid="side-panel-show"
          >
            ‹ Model
          </button>
        )}
      </div>
    );
  }
);

export default ThreeDViewer;
