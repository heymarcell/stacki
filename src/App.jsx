import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import WelcomeScreen from './panels/WelcomeScreen.jsx';
import PagesPanel from './panels/PagesPanel.jsx';
import PalettePanel from './panels/PalettePanel.jsx';
import StructurePanel from './panels/StructurePanel.jsx';
import { isInlineRun, noteIndexAbove, noteText, noteValue, selectionAfterDelete } from './treeSelection.js';
import { canvasClickAction } from './canvasClick.js';
import { liveClassesById as classesByNodeId, rendersOwnElement } from './liveClasses.js';
import { setSoundEnabled } from './ui/sound.js';
import { createPreviewWatch } from './previewRecovery.js';
import { queryCanvas, tellCanvas } from './canvasQuery.js';
import { buildMcpPayload } from './mcpContext.js';
import CommentsPanel from './panels/CommentsPanel.jsx';
import { anchorSteps, checkAnchor, markerPathFor, modelMatchesFile, peerPath, resolveNode } from './reviewAnchor.js';
import { focusPlan, focusNote, hostPathFor, nothingRestored } from './reviewFocus.js';
import { pinnable } from './reviewPins.js';
import ReviewInspector from './panels/ReviewInspector.jsx';
import { reviewLayout, clampInspector, INSPECTOR_DEFAULT } from './reviewLayout.js';
import { mayPin } from './reviewCheckout.js';
import {
  initialReviewMode,
  isCommentModeKey,
  isCommenting,
  isComposing,
  isPinToggleKey,
  isTextEntry,
  reviewModeReducer,
  wantsCanvasClick,
} from './reviewMode.js';
import { beginCapture, endCapture } from './mcpCanvas.js';
import PropsPanel from './panels/PropsPanel.jsx';
import StylePanel from './panels/StylePanel.jsx';
import PreviewPane from './panels/PreviewPane.jsx';
import GitChip from './panels/GitChip.jsx';
import HistoryPanel, { relativeTime } from './panels/HistoryPanel.jsx';
import { ConfirmHost, confirmDialog } from './ui/ConfirmDialog.jsx';
import McpDialog from './ui/McpDialog.jsx';
import { mergeBranchAction, deleteBranchAction } from './gitActions.js';
import LeftRail from './ui/LeftRail.jsx';
import CodeWindow from './ui/CodeWindow.jsx';
import PageSwitcher from './ui/PageSwitcher.jsx';
import DynamicPicker from './ui/DynamicPicker.jsx';
import {
  ASTRO_ASSETS,
  ASTRO_ASSETS_MODULE,
  PLACEHOLDER_PROPS,
  astroAsset as astroAssetDef,
} from './astroAssets.js';
import InsertSearch from './ui/InsertSearch.jsx';
import AssetsPanel from './panels/AssetsPanel.jsx';
import CmsPanel from './panels/CmsPanel.jsx';
import CmsView from './panels/CmsView.jsx';
import ContentView from './panels/ContentView.jsx';
import VariablesPanel from './panels/VariablesPanel.jsx';
import VariablesView from './panels/VariablesView.jsx';
import { getElementSchema, GLOBAL_ATTRS, HTML_TAGS, VOID_TAGS, canContainTag } from './elementSchemas.js';
import { insertTargetFor as placeInsert } from './insertTarget.js';
import { isInlineOnly } from './ui/RichContent.jsx';
import { onAssetRequest, clearAssetRequest } from './assetPick.js';
import { isDataBound } from './bindings.js';
import { thenBranch } from './branches.js';
import { keepsSlot } from './slotAttr.js';
import {
  namesUsedIn,
  neededFrontmatter,
  unusedDeclarations,
  withStatements,
  withoutDeclarations,
} from './frontmatterMove.js';
import { hasClass, namesIn, withClass } from './classAttr.js';
import { toComponentName } from './componentName.js';
import { resolveInstanceProps } from './instanceProps.js';
import { propsForExtraction } from './extractProps.js';
import TerminalDock from './panels/TerminalDock.jsx';
import { cleanError, stripAnsi } from './cleanError.js';
import { elementLabel } from './classNames.js';
import {
  autoQueryName,
  collectionsInScope,
  findImportOf,
  markedQueries,
  namesInScope,
  queriesInScope,
  QUERY_MARK,
  referencesInScope,
  removeMarkedQuery,
} from './dataSuggest.js';
import {
  PreviewIcon,
  RefreshIcon,
  ExternalIcon,
  ChevronLeftIcon,
  ElementComponentIcon,
  TerminalIcon,
} from './ui/Icons.jsx';

import {
  ancestorChain,
  chooseImportPath,
  codeText,
  DEFAULT_TEXT,
  definitionOf,
  disconnectDependentLoops,
  findElementByTag,
  findNodeById,
  findParentList,
  findParentNode,
  insertIntoModel,
  isDescendantOf,
  loopVarsAt,
  newId,
  nodeAtPath,
  openingSelection,
  outermostNode,
  parseLoopHead,
  pathOfNode,
  pruneImports,
  renameLoopVar,
  slotHostOf,
  stripLostBindings,
  usesPageScope,
  VOID_ELEMENTS,
} from "./modelOps.js";
// The node operations themselves, under one name. Every mutation below that an
// agent can also perform goes through these — see src/modelOps.js for why
// there is exactly one implementation of each of them.
import * as ops from './modelOps.js';
import { applyOperations } from './modelOps.js';
import { createAgentCommands } from './agent/commands.js';
import { digestOfModel } from './agent/digest.js';

// How long a pending save waits, by urgency. See scheduleSave.
const SAVE_DELAY = { true: 0, live: 120, false: 300 };

// A route is stored the way it identifies a page — slashless, so /de/hotel
// and /de/hotel/ are the same entry however a link was typed. A URL is a
// different thing: Astro's dev server serves exactly one of those spellings,
// and answers the other with a 404 help page. So the project's trailingSlash
// is applied on the way from one to the other, never before.
function routeToPath(route, trailingSlash) {
  if (!route || route === '/') return route || '/';
  // An extension means a file, not a directory-style route: /rss.xml keeps
  // its shape under every setting, which is also how Astro checks it.
  if (trailingSlash === 'always') return /\.[^/]+$/.test(route) ? route : route + '/';
  if (trailingSlash === 'never') return route.replace(/\/$/, '');
  return route; // 'ignore' — the default, and it serves either
}


// Whether the props panel would offer this node a Content field — the rich
// inline editor over its words. The same test PropsPanel makes: children that
// are all text and simple inline tags, or an element still empty and able to
// hold text. Kept in step with it by hand; the two disagreeing would mean a
// double-click that focuses a field which isn't there.
function holdsInlineText(node) {
  if (!node || node.kind !== 'element') return false;
  if (VOID_TAGS.has(String(node.name).toLowerCase())) return false;
  const kids = node.children;
  return isInlineOnly(kids) || !Array.isArray(kids) || kids.length === 0;
}

export default function App() {
  const [project, setProject] = useState(null); // {path, name}
  const [scan, setScan] = useState({ pages: [], layouts: [], components: [] });
  const [projectClasses, setProjectClasses] = useState([]);
  const [currentPage, setCurrentPage] = useState(null); // active file {path, name, route?, kind}
  // Drill-down trail: [page, component, nested component, …]. The last entry
  // is what's on screen; anything before it is what Back/Escape returns to.
  const [editStack, setEditStack] = useState([]);
  const [pageState, setPageState] = useState(null); // {editable, model, source, reason}
  const [selectedId, setSelectedId] = useState(null);
  // Classes the selected element actually carries on the page, reported by the
  // preview. An expression-valued class attribute (`class:list={[…]}`,
  // `class={x}`) has no readable text in the source, so this is what lets the
  // style panel show the classes this instance resolved to.
  const [selectedClasses, setSelectedClasses] = useState([]);
  // Which selection the classes above describe, and a counter that lets the
  // effect below re-check the moment a report lands rather than on a timer.
  const classesForRef = useRef(null);
  const [classesTick, setClassesTick] = useState(0);
  const [hoverNodeId, setHoverNodeId] = useState(null); // navigator row hover
  // Paths the page reports as having actually rendered something. Null until
  // the page has said anything, which is not the same as "nothing rendered".
  const [renderedPaths, setRenderedPaths] = useState(null);
  // Nodes the page says are there but taking no part: display:none, and
  // pointer-events:none. Marked in the navigator (see StructurePanel).
  const [nodeStates, setNodeStates] = useState(null);
  // path -> the classes that node rendered with, for labelling rows whose
  // class is an expression the source can't resolve.
  const [nodeClasses, setNodeClasses] = useState(null);
  const [devUrl, setDevUrl] = useState(null);
  const [trailingSlash, setTrailingSlash] = useState('ignore');
  const [devStatus, setDevStatus] = useState('off'); // off | starting | on
  const [devLog, setDevLog] = useState('');
  const [devDiag, setDevDiag] = useState(null); // {kind, nodePath, nodeVersion, …}
  const [busy, setBusy] = useState(null); // string message
  const [toast, setToast] = useState(null); // {msg, kind}
  const [refreshKey, setRefreshKey] = useState(0);
  // Concrete paths behind a dynamic route, and which one the canvas is showing.
  const [dynamicPaths, setDynamicPaths] = useState([]);
  // Routes the dev server serves that aren't files here — pages an integration
  // injected. A project can consist entirely of these (a site whose pages ship
  // in a package), in which case they are the only pages there are to show.
  const [injectedRoutes, setInjectedRoutes] = useState([]);
  // One sampled entry per collection the open file reads by name, for the
  // binding picker. Keyed by collection; a name present with a null value has
  // been asked for and has no answer, which stops it being asked again.
  const [collectionSamples, setCollectionSamples] = useState({});
  // Every collection the project has, so data anywhere in the site is
  // reachable from the picker — not only what this page already reads.
  const [collections, setCollections] = useState([]);
  const sampleAskedRef = useRef(new Set());
  const [dynamicIndex, setDynamicIndex] = useState(0);
  const [dynamicError, setDynamicError] = useState(null);
  const [leftTab, setLeftTab] = useState('navigator'); // pages | navigator | components | assets | cms | null
  const [cmsRel, setCmsRel] = useState(null); // JSON file open in the CMS editor
  // Content collection open in the schema-driven editor. Only one of the two
  // is ever open: they edit the same kind of thing in two different ways.
  const [contentName, setContentName] = useState(null);
  // Which stylesheet group the variables sheet is showing: { file, index }.
  const [varsGroup, setVarsGroup] = useState(null);
  const [cmsTick, setCmsTick] = useState(0); // bumped on save, refreshes counts
  const [cmsSettings, setCmsSettings] = useState(false); // editing that collection's fields
  const [inPreview, setInPreview] = useState(false); // interactive full-site preview
  const [previewSrc, setPreviewSrc] = useState(null);
  // The path the canvas is on, kept where the preview toggle can read it: it's
  // derived at the bottom of this component (a dynamic page's entry is picked
  // there), long after the callbacks up here are defined.
  const livePathRef = useRef(null);
  const [termOpen, setTermOpen] = useState(false); // bottom terminal dock
  const [codeWin, setCodeWin] = useState(null); // {targetId|kind:'file', title, language}
  const openCodeWindowRef = useRef(null); // latest openCodeWindow, for the Enter shortcut
  const selectionKeysRef = useRef([]); // node keys ⇧⌘C resolves to file:line
  const [fileText, setFileText] = useState(''); // loaded text for kind:'file'
  // Breakpoint lives here, not in PreviewPane: a re-mount of that pane must
  // not silently drop the user out of the view they picked (which would
  // reload every preview iframe and flash the canvas white).
  const [device, setDevice] = useState('desktop');
  // Bumped every time the page itself makes the selection, so the navigator
  // scrolls the row into view — a counter, not the id, so clicking the same
  // element twice still reveals it.
  const [revealTick, setRevealTick] = useState(0);
  const [rightTab, setRightTab] = useState('style'); // style | settings
  // ⌘Enter asks the props panel to open Settings and take the caret into the
  // class field — a counter, so pressing it again re-focuses.
  // Git state, read here so the History panel and the title-bar chip cannot
  // disagree about which branch is checked out. The chip still refreshes it on
  // its own schedule; this is the copy the panel reads.
  const [gitInfo, setGitInfo] = useState(null);
  // The commit being previewed, or null for the working tree. See phase 4:
  // while this is set the canvas points at a separate server and the editor is
  // read-only.
  const [previewRef, setPreviewRef] = useState(null);
  const [previewInfo, setPreviewInfo] = useState(null); // {url, subject, when}
  const [classFocus, setClassFocus] = useState(0);
  const [contentFocus, setContentFocus] = useState(0);
  // Sliding highlight behind the active Style/Settings tab, measured from the
  // buttons so it tracks their real geometry (and any panel resize).
  const rightTabRefs = useRef({});
  const [rightTabInd, setRightTabInd] = useState(null);
  // The asset request a field is waiting on, and the tab to go back to once
  // it's answered — "Choose Image…" borrows the left panel rather than
  // opening a window over the canvas.
  const [assetPick, setAssetPick] = useState(null);
  const tabBeforePick = useRef(null);
  // Bumped by ⌘⇧A: the Components panel opens its naming dialog when it changes.
  const [createRequest, setCreateRequest] = useState(0);
  // What the canvas last measured — the breakpoint it is really in, the frame's
  // size, and the selected copy's box. Published to the MCP server, which is
  // the only thing that reads it.
  const [canvasReport, setCanvasReport] = useState(null);
  // The AI-connection panel (File ▸ AI Connection), and the status it shows.
  const [mcpStatus, setMcpStatus] = useState(null);

  // A layout is just a component that lives in src/layouts — it can be
  // placed on a page like any other. Every lookup that answers "what do we
  // know about the component named X" has to search both lists, or a placed
  // layout would come back with no props, no slots and no rest support.
  // Components win a name collision: they're the more likely intent.
  const insertables = useMemo(
    () => [...scan.components, ...scan.layouts],
    [scan.components, scan.layouts]
  );

  const saveTimer = useRef(null);
  const devLogRef = useRef('');
  const pageStateRef = useRef(null);
  pageStateRef.current = { currentPage, pageState };
  const selectedIdRef = useRef(null);
  selectedIdRef.current = selectedId;

  // A report from the canvas about what the selected element's classes really
  // are. It is always about whatever is selected right now — the canvas is
  // asked for the tracked path — so this records which element it answered
  // for, which is what lets the panel tell a fresh answer from a stale one.
  const receiveClasses = useCallback((list) => {
    classesForRef.current = selectedIdRef.current;
    setSelectedClasses(list);
    setClassesTick((n) => n + 1);
  }, []);
  const editStackRef = useRef([]);
  editStackRef.current = editStack;
  const inPreviewRef = useRef(false);
  inPreviewRef.current = inPreview;
  const previewPathRef = useRef(null);
  const previewIframeRef = useRef(null);

  // ----------------------------------------------------------------
  // Toasts & events
  // ----------------------------------------------------------------

  // Why the dev server isn't running (missing Node, a Node too old for the
  // project's Astro, uninstalled deps). Only asked for once it has failed —
  // the answer is what the offline pane explains instead of a raw log.
  // projectRef is declared further down, but this only reads it when called.
  const diagnose = useCallback(() => {
    const p = projectRef.current?.path;
    if (!p) return;
    window.avb
      .diagnoseDev(p)
      .then((d) => setDevDiag(d))
      .catch(() => setDevDiag(null));
  }, []);

  // `picked` is passed as literal true by the pick itself — the Cancel button
  // hands this its click event, which must not read as a pick.
  const endAssetPick = useCallback((picked) => {
    clearAssetRequest();
    setAssetPick(null);
    setLeftTab((t) => {
      if (t !== 'assets') return t;
      // Answering the field ends the errand: show the element it belongs to
      // rather than leaving the user parked in the asset browser — including
      // when the browser is where they started, which used to strand them.
      // Cancelling changed nothing, so that goes back where they came from.
      return picked === true ? 'navigator' : tabBeforePick.current || 'navigator';
    });
    tabBeforePick.current = null;
    // The navigator opens on the element that was just given an asset, not
    // wherever it happened to be scrolled.
    if (picked === true) setRevealTick((n) => n + 1);
  }, []);

  useEffect(() => {
    return onAssetRequest((req) => {
      if (!req) return; // cleared from this side already
      setAssetPick({
        ...req,
        // The entry rides along: which root it came from decides whether the
        // field writes a URL, an import, or a path relative to its own file.
        onPick: (rel, entry) => {
          req.onPick(rel, entry);
          endAssetPick(true);
        },
      });
      setLeftTab((t) => {
        if (t !== 'assets') tabBeforePick.current = t;
        return 'assets';
      });
    });
  }, [endAssetPick]);

  const showToast = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind });
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => {
    const offProgress = window.avb.onProgress(({ message }) => setBusy(message || null));
    const offExit = window.avb.onDevExit(({ log }) => {
      setDevStatus('off');
      setDevUrl(null);
      if (log) {
        devLogRef.current = log;
        setDevLog(log);
      }
      diagnose();
    });
    const offLog = window.avb.onDevLog((chunk) => {
      devLogRef.current = stripAnsi(devLogRef.current + chunk).slice(-4000);
      setDevLog(devLogRef.current);
    });
    return () => {
      offProgress();
      offExit();
      offLog();
    };
  }, []);

  // ----------------------------------------------------------------
  // Recovering the preview after a compile error
  // ----------------------------------------------------------------
  //
  // See src/previewRecovery.js for what this is for and why it asks the server
  // rather than reading the error screen or the log.
  //
  // The route is read through `livePathRef` rather than named as a dependency:
  // it is assigned far below this hook, so a dep array mentioning it reads it
  // before its declaration and the whole app throws (see test/app-renders.js,
  // which is here because that has happened before). The ref is current by the
  // time a probe actually runs, and the watch has no reason to be rebuilt just
  // because the route changed.
  useEffect(() => {
    if (!devUrl) return undefined;
    // Both of these arrive with the main process, which does not reload when the
    // renderer does (see VITE_DEV_SERVER_URL): a renderer newer than the bridge
    // would call undefined and take the app down with it. Absent means there is
    // nothing to ask, which is the same answer as having no dev server.
    if (typeof window.avb.probeDevPage !== 'function' || typeof window.avb.onPageMaybeChanged !== 'function') {
      return undefined;
    }
    const watch = createPreviewWatch({
      probe: () => window.avb.probeDevPage(devUrl + (livePathRef.current || '/')),
      onRecover: () => setRefreshKey((k) => k + 1),
    });
    // Every write the app makes, plus every change made outside it.
    const offWrite = window.avb.onPageMaybeChanged((d) => {
      watch.poke();
      // A change from outside the app — an editor, a script, a checkout. The
      // canvas normally hears about it over the dev server's HMR socket, and
      // when that socket has gone quiet (a dev server restarted under a canvas
      // that stayed open, a machine that slept) nothing says so: the page just
      // stops updating and the only way to see an edit is the refresh button.
      // The app's own watcher saw this change, so it says it directly too.
      if (d?.external) tellCanvas({ type: 'avb:patch-now' });
    });
    return () => {
      offWrite();
      watch.stop();
    };
  }, [devUrl]);

  // ----------------------------------------------------------------
  // Project lifecycle
  // ----------------------------------------------------------------

  const rescan = useCallback(async (projectPath) => {
    const result = await window.avb.scanProject(projectPath);
    setScan(result);
    if (result?.trailingSlash) setTrailingSlash(result.trailingSlash);
    window.avb
      .listProjectClasses(projectPath)
      .then((c) => setProjectClasses(c || []))
      .catch(() => {});
    return result;
  }, []);

  const startPreview = useCallback(
    async (projectPath) => {
      setDevStatus('starting');
      try {
        const { url, external, trailingSlash: resolved } =
          await window.avb.startDevServer(projectPath);
        setDevUrl(url);
        if (resolved) setTrailingSlash(resolved);
        setDevStatus('on');
        setDevDiag(null);
        if (external) {
          showToast(
            `Reusing the dev server already running for this project (${url}) — canvas outlines need the app's own server, so stop that one to enable them.`,
            'info'
          );
        }
      } catch (err) {
        setDevStatus('off');
        setBusy(null);
        showToast(`Preview failed to start — see the log in the preview area.`, 'error');
        const msg = cleanError(err);
        devLogRef.current = msg;
        setDevLog(msg);
        diagnose();
      }
    },
    [showToast, diagnose]
  );

  const loadProject = useCallback(
    async (projectPath) => {
      const name = projectPath.split(/[\\/]/).filter(Boolean).pop();
      setProject({ path: projectPath, name });
      setLeftTab('navigator');
      // Every project opens on desktop — a breakpoint left over from the
      // last project isn't a choice the user made about this one.
      setDevice('desktop');
      window.avb.addRecent(projectPath);
      const result = await rescan(projectPath);

      const hasDeps = await window.avb.hasNodeModules(projectPath);
      if (!hasDeps) {
        try {
          await window.avb.installDeps(projectPath);
        } catch (err) {
          showToast(cleanError(err), 'error');
        }
        setBusy(null);
      }
      startPreview(projectPath);
      window.avb.watchProject(projectPath);

      const first =
        result.pages.find((p) => p.name === 'index.astro') || result.pages[0] || null;
      if (first) selectPage(first);
    },
    [rescan, startPreview] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // A window can come up owing a project: one was picked from the menu and the
  // window reloaded to let go of the last one, or (in dev) the code was reloaded
  // under a project that was open. Null on a cold start and after a window
  // somebody closed, both of which belong on the welcome screen.
  const reopenedRef = useRef(false);
  useEffect(() => {
    if (reopenedRef.current || !window.avb.pendingProject) return;
    reopenedRef.current = true;
    window.avb
      .pendingProject()
      .then((p) => p && loadProject(p))
      .catch(() => {});
  }, [loadProject]);


  // ----------------------------------------------------------------
  // Page loading & saving
  // ----------------------------------------------------------------

  const flushSave = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const { currentPage: page, pageState: state } = pageStateRef.current;
    if (!page || !state || !state.dirty) return;
    if (state.editable) {
      await window.avb.writePage({ pagePath: page.path, model: state.model });
    } else {
      await window.avb.writePageRaw({ pagePath: page.path, source: state.source });
    }
    setPageState((s) => (s ? { ...s, dirty: false } : s));
  }, []);

  // Leaving a project. Main lets go of everything the project had running and
  // starts the window over — forty pieces of state, an undo stack, a canvas
  // holding a page, a watcher and a dev server all belong to the project that
  // was open, and a fresh renderer is the only way to be certain none of it is
  // still here when the next one opens. `next` is the project to open after,
  // which main holds for the window that comes back: a choice made before a
  // reload has to survive it. Anything unsaved goes to disk first.
  const leaveProject = useCallback(
    async (next = null) => {
      await flushSave();
      await window.avb.closeProject(next);
    },
    [flushSave]
  );

  useEffect(() => {
    const offClose = window.avb.onMenu('closeProject', () => {
      if (projectRef.current) void leaveProject(null);
    });
    const offOpen = window.avb.onMenu('openProject', async () => {
      const picked = await window.avb.openProjectDialog();
      const next = picked?.projectPath || picked?.path || null;
      if (!next) return;
      // Nothing open yet: this IS the welcome screen's own button.
      if (!projectRef.current) {
        loadProject(next);
        return;
      }
      void leaveProject(next);
    });
    return () => {
      offClose?.();
      offOpen?.();
    };
  }, [leaveProject, loadProject]);

  // Opens any .astro file for editing — a page, or a component drilled into.
  // `currentPage` is simply whatever is being edited, so saving, undo, the
  // navigator, and the props panel all follow without special cases.
  const openFile = useCallback(
    async (entry) => {
      await flushSave();
      setCurrentPage(entry);
      setSelectedId(null);
      const result = await window.avb.readPage(entry.path);
      // Stamped with the file it was read from.
      //
      // `setCurrentPage` above happens BEFORE this await and `setPageState`
      // after it, so for one render the app names a new file while still
      // holding the previous one's tree. Anything that resolves a position
      // against "the open file" during that window is looking the node up in
      // the wrong document — which is how comments anchored inside components
      // were being marked orphaned by nothing more than navigating past them.
      // Carrying the path on the state is what lets a reader tell the pair
      // apart from a matched one. Edits below spread the previous state, so
      // the stamp survives them.
      setPageState({ ...result, file: entry.path, dirty: false });
      // Whatever opens, opens on something rather than nothing: a component on
      // its <body> when it has one, else the first element it renders; a page
      // on its outermost node, which is the layout wrapper when it has one.
      if (result?.model?.nodes) {
        const start =
          entry.kind === 'component'
            ? openingSelection(result.model.nodes)
            : outermostNode(result.model.nodes);
        if (start) setSelectedId(start.id);
      }
      dropPageHistory(); // page snapshots don't apply to another page; commands stay
    },
    [flushSave]
  );

  // What's typed in the URL bar while it's being edited; null means "show the
  // real one". Kept separate so the bar keeps tracking the canvas until you
  // actually start typing.
  const [urlDraft, setUrlDraft] = useState(null);

  const selectPage = useCallback(
    async (page) => {
      // Opening a page from the switcher leaves any component drill-down.
      setEditStack([{ ...page, kind: 'page' }]);
      await openFile({ ...page, kind: 'page' });
    },
    [openFile]
  );

  // An injected route has no file in this project to open — its source lives
  // in a dependency — so this points the canvas at it and leaves the editor
  // empty rather than pretending there is a model behind it.
  const selectRoute = useCallback(
    async (entry) => {
      await flushSave();
      setEditStack([]);
      setCurrentPage({ kind: 'route', name: entry.route, route: entry.route, from: entry.from });
      setPageState(null);
      setSelectedId(null);
    },
    [flushSave]
  );

  // Enter in the URL bar. A route names a page file, so this switches the
  // editor to it rather than pointing the canvas somewhere the panels know
  // nothing about — the model and the canvas showing different pages is the
  // one state the app can't represent.
  const goToUrl = useCallback(
    (typed) => {
      setUrlDraft(null);
      const raw = String(typed || '').trim();
      if (!raw) return;
      // Accept a full URL or a bare path.
      let route = raw;
      const m = raw.match(/^https?:\/\/[^/]+(\/.*)?$/i);
      if (m) route = m[1] || '/';
      if (!route.startsWith('/')) route = '/' + route;
      route = route.replace(/\?.*$|#.*$/, '');
      const norm = (r) => (r !== '/' ? r.replace(/\/$/, '') : r);
      const page = (scan.pages || []).find((p) => norm(p.route) === norm(route));
      if (page) {
        selectPage(page);
        return;
      }
      showToast(`No page matches ${route}`, 'error');
    },
    [scan.pages, showToast, selectPage]
  );


  // Re-reads whatever is open straight from disk. A git checkout rewrites the
  // working tree wholesale, and the file watcher can't be relied on for it:
  // events for files the app itself wrote moments earlier are suppressed (so
  // its own save isn't echoed back), which is exactly the case when you edit,
  // switch branch, and expect to see the other branch's content.
  const reloadFromDisk = useCallback(async () => {
    const proj = projectRef.current;
    const open = pageStateRef.current.currentPage;
    if (!proj) return;
    const result = await rescan(proj.path);
    if (!open) return;
    // The open file may not exist on the branch just switched to.
    const stillThere =
      result.pages.some((p) => p.path === open.path) ||
      result.components.some((c) => c.path === open.path) ||
      result.layouts.some((l) => l.path === open.path);
    if (stillThere) {
      const fresh = await window.avb.readPage(open.path);
      setPageState({ ...fresh, file: open.path, dirty: false });
      setSelectedId(null);
      dropPageHistory(); // page snapshots don't apply to another page; commands stay
    } else {
      const next = result.pages[0] || null;
      setEditStack(next ? [{ ...next, kind: 'page' }] : []);
      if (next) await openFile({ ...next, kind: 'page' });
      else {
        setCurrentPage(null);
        setPageState(null);
        setSelectedId(null);
      }
    }
    setRefreshKey((k) => k + 1); // the preview is showing the old branch too
  }, [rescan, openFile]);

  // Drill into a component: its own file becomes the edited document, and the
  // stack remembers what to come back to (pages and components alike, so
  // nesting works to any depth).
  const openComponent = useCallback(
    async (name, hostPath, hostOcc = 0, filePath = null) => {
      // A tag is only a local binding — `import Layout from
      // '@/layouts/BaseLayout.astro'` renders as <Layout> — so follow the
      // page's own import first, and fall back to matching by filename.
      const { currentPage: host, pageState: state } = pageStateRef.current;
      const spec = (state?.model?.imports || []).find((i) => i.name === name)?.path;
      let comp = null;
      // A caller that already knows the file means THAT file — the instances
      // popup names a component by where it lives, and two folders can hold
      // the same basename.
      if (filePath) {
        comp =
          scan.components.find((c) => c.path === filePath) ||
          scan.layouts.find((l) => l.path === filePath) ||
          { name, path: filePath };
      }
      if (!comp && spec && host?.path) {
        const { path: file } = await window.avb.resolveImport({
          projectPath: projectRef.current.path,
          fromFile: host.path,
          spec,
        });
        if (file && /\.astro$/i.test(file)) {
          comp = { name: file.split('/').pop().replace(/\.astro$/i, ''), path: file };
        } else if (file) {
          // A framework island (.jsx/.svelte/…) has no Astro tree to show.
          showToast(`<${name}> is a ${file.split('.').pop()} component — edit it in code.`, 'error');
          return;
        }
      }
      comp =
        comp ||
        scan.components.find((c) => c.name === name) ||
        scan.layouts.find((l) => l.name === name);
      if (!comp) {
        showToast(`Can't find a file for <${name}>.`, 'error');
        return;
      }
      const stack = editStackRef.current;
      // The canvas keeps showing the page, so remember which instance was
      // opened — that region stays lit while the rest dims. Drilling deeper
      // keeps the outermost instance as the focus: a nested component's
      // internals aren't addressable in the page's own markers.
      //
      // Which copy of it, too: a component rendered inside a loop is on the
      // page once per item, and opening one card means that card. Without the
      // occurrence every instance stayed lit, and editing one looked like
      // editing all of them.
      //
      // A layout is the exception: it wraps <html>, so the instance IS the
      // page and there is nothing around it to dim. Its path still names the
      // focus — clicks route by it, and one in the page's own content still
      // means "I'm done in here" — but the lit region would be the page's slot
      // content, which is the one part of the canvas the layout does NOT own.
      // Dimming the header, the sidebar and the footer while lighting the page
      // body said the opposite of what opening a layout does.
      const top = stack[stack.length - 1];
      const hostNode = hostPath
        ? nodeAtPath(
            state?.model?.nodes || [],
            String(hostPath).split('|').pop().split('.').map(Number)
          )
        : null;
      const focusPath = top?.focusPath ?? hostPath ?? null;
      const nested = top?.focusPath != null;
      const focusOcc = nested ? top.focusOcc ?? 0 : hostOcc;
      const focusWhole = nested ? !!top.focusWhole : hostNode?.id === 'layout';
      const entry = {
        kind: 'component',
        name: comp.name,
        path: comp.path,
        focusPath,
        focusOcc,
        focusWhole,
        hostKey: hostPath ?? null,
      };
      setEditStack((s) =>
        s.some((e) => e.path === comp.path) ? s : [...s, entry]
      );
      await openFile(entry);
    },
    [scan.components, scan.layouts, openFile, showToast]
  );

  // Back out one level: to the parent component if nested, else to the page.
  const closeComponent = useCallback(async () => {
    const stack = editStackRef.current;
    if (stack.length < 2) return;
    const next = stack.slice(0, -1);
    setEditStack(next);
    await openFile(next[next.length - 1]);
  }, [openFile]);

  // ----------------------------------------------------------------
  // Undo / redo
  //
  // One stack for the whole app, so ⌘Z means "undo the last thing I did"
  // wherever focus happens to be. Two kinds of entry live in it:
  //
  //   snapshot — the page model (or raw source) before an edit. Cheap to take
  //              and restores structure exactly, but only meaningful for the
  //              page it came from, so these are dropped when a page closes.
  //   command  — an {undo, redo} pair for anything outside the page model:
  //              a CSS file, a CMS entry, an asset rename. Each records how to
  //              put things back, so these survive page switches.
  // ----------------------------------------------------------------

  // Previewing an old version points the canvas at a second dev server running
  // against a checkout of that commit, and makes the editor read-only. The
  // read-only part is not decoration: the files behind that server are a
  // disposable checkout, so anything typed into them would be thrown away the
  // moment the preview ends, with nothing to say it had happened.
  const previewCommit = useCallback(
    async (commit) => {
      if (!project) return;
      setBusy('Getting that version ready…');
      try {
        const r = await window.avb.previewAtCommit({ projectPath: project.path, ref: commit.hash });
        setPreviewRef(commit.hash);
        setPreviewInfo({ url: r.url, subject: commit.subject, when: commit.when });
      } catch (err) {
        showToast(cleanError(err), 'error');
      } finally {
        setBusy(null);
      }
    },
    [project, showToast]
  );

  // Named apart from exitPreview below, which is the app's own interactive
  // preview mode — a different thing entirely.
  const exitCommitPreview = useCallback(async () => {
    setPreviewRef(null);
    setPreviewInfo(null);
    if (project) await window.avb.previewStop({ projectPath: project.path }).catch(() => {});
  }, [project]);

  // Leaving the project (or closing it) must not leave a second server and a
  // checkout behind inside it.
  useEffect(() => {
    if (!project) return undefined;
    return () => {
      window.avb.previewStop({ projectPath: project.path }).catch(() => {});
    };
  }, [project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshGit = useCallback(async () => {
    if (!project) return null;
    const r = await window.avb.gitInfo(project.path);
    setGitInfo(r);
    return r;
  }, [project]);

  useEffect(() => {
    refreshGit();
  }, [refreshGit, refreshKey]);

  const historyRef = useRef({ past: [], future: [], lastPush: 0, lastKey: null });

  // How many times the open document has changed.
  //
  // The MCP context revision counts what is on SCREEN — a selection moving
  // bumps it and an edit to an unselected node may not. A write has to name
  // the document, so it gets a counter of its own: bumped by every accepted
  // model or source change, including the ones undo and redo make. Monotonic
  // across files, and reported beside the file it is about, so two documents
  // can never be mistaken for one because their numbers agree.
  const docRevRef = useRef(0);
  const bumpDoc = useCallback(() => {
    docRevRef.current += 1;
  }, []);

  const snapshotOf = (state) =>
    state.editable
      ? { kind: 'model', model: structuredClone(state.model) }
      : { kind: 'source', source: state.source };

  // Records the state *before* a mutation. Consecutive edits with the same
  // coalesceKey within 800 ms collapse into one undo step (typing bursts,
  // dropdown hover-scrubs); structural edits (no key) always get their own.
  const pushHistory = useCallback((coalesceKey = null) => {
    const state = pageStateRef.current.pageState;
    if (!state) return;
    const h = historyRef.current;
    const now = Date.now();
    const coalesce =
      coalesceKey !== null && coalesceKey === h.lastKey && now - h.lastPush < 800 && h.past.length > 0;
    if (!coalesce) {
      h.past.push(snapshotOf(state));
      if (h.past.length > 100) h.past.shift();
    }
    h.future = [];
    h.lastKey = coalesceKey;
    h.lastPush = now;
  }, []);

  // Records an already-performed change from outside the page model. `undo`
  // and `redo` are async and do the work themselves (rewrite the file, restore
  // the entry, rename back). Consecutive commands sharing a coalesceKey inside
  // the same burst collapse into one step, so a slider drag or a run of live
  // CSS writes is a single ⌘Z — the first one's `undo` (the oldest state) is
  // kept and the newest `redo` replaces the previous.
  const pushCommand = useCallback((cmd) => {
    const h = historyRef.current;
    const now = Date.now();
    const prev = h.past[h.past.length - 1];
    const coalesce =
      cmd.coalesceKey != null &&
      cmd.coalesceKey === h.lastKey &&
      now - h.lastPush < 800 &&
      prev?.kind === 'cmd' &&
      prev.coalesceKey === cmd.coalesceKey;
    if (coalesce) {
      prev.redo = cmd.redo;
      prev.label = cmd.label ?? prev.label;
    } else {
      h.past.push({ kind: 'cmd', ...cmd });
      if (h.past.length > 100) h.past.shift();
    }
    h.future = [];
    h.lastKey = cmd.coalesceKey ?? null;
    h.lastPush = now;
  }, []);
  const pushCommandRef = useRef(null);
  pushCommandRef.current = pushCommand;

  // Snapshots belong to one page, so they're dropped when that page closes;
  // commands carry their own inverse and stay.
  const dropPageHistory = useCallback(() => {
    const h = historyRef.current;
    h.past = h.past.filter((e) => e.kind === 'cmd');
    h.future = h.future.filter((e) => e.kind === 'cmd');
    h.lastKey = null;
    h.lastPush = 0;
  }, []);

  const applySnapshot = useCallback((entry) => {
    docRevRef.current += 1; // an undo is a change to the document like any other
    setPageState((s) => {
      if (!s) return s;
      if (entry.kind === 'model') {
        return { ...s, editable: true, model: structuredClone(entry.model), dirty: true };
      }
      return { ...s, source: entry.source, dirty: true };
    });
    // Clear selection if the restored model no longer has the selected node.
    if (entry.kind === 'model') {
      setSelectedId((id) =>
        id && id !== 'layout' && !findNodeById(entry.model.nodes || [], id) ? null : id
      );
    }
    scheduleSaveRef.current?.(true);
  }, []);

  const scheduleSaveRef = useRef(null);

  // Undo and redo rewrite files and the page model under whatever is reading
  // them; bumping this tells the style panel to re-read rather than wait for
  // its own polling to notice.
  const [historyTick, setHistoryTick] = useState(0);

  const undo = useCallback(async () => {
    setHistoryTick((n) => n + 1);
    const h = historyRef.current;
    if (!h.past.length) return;
    h.lastKey = null;
    h.lastPush = 0;
    const entry = h.past.pop();
    if (entry.kind === 'cmd') {
      h.future.push(entry);
      try {
        await entry.undo();
      } catch (err) {
        showToast(`Couldn’t undo${entry.label ? ` ${entry.label}` : ''}: ${cleanError(err)}`, 'error');
      }
      return;
    }
    const state = pageStateRef.current.pageState;
    if (!state) return; // its page is gone — nothing to restore onto
    h.future.push(snapshotOf(state));
    applySnapshot(entry);
  }, [applySnapshot, showToast]);

  const redo = useCallback(async () => {
    setHistoryTick((n) => n + 1);
    const h = historyRef.current;
    if (!h.future.length) return;
    h.lastKey = null;
    h.lastPush = 0;
    const entry = h.future.pop();
    if (entry.kind === 'cmd') {
      h.past.push(entry);
      try {
        await entry.redo();
      } catch (err) {
        showToast(`Couldn’t redo${entry.label ? ` ${entry.label}` : ''}: ${cleanError(err)}`, 'error');
      }
      return;
    }
    const state = pageStateRef.current.pageState;
    if (!state) return;
    h.past.push(snapshotOf(state));
    applySnapshot(entry);
  }, [applySnapshot, showToast]);

  // Discrete edits (dropdown, checkbox, drag, delete) save immediately;
  // typing batches keystrokes for 300 ms so the preview doesn't rebuild
  // per character. The timeout-0 for immediate saves lets React commit the
  // state update first so flushSave sees the new model.
  //
  // 'live' is the third case: a style-panel scrub or mid-typing write, which
  // arrives already debounced (100 ms at the field) and is watched on the
  // canvas as it happens. Making it wait out the typing pause too put nearly
  // half a second between the drag and the result. It still coalesces, just
  // over the gap between two ticks rather than the gap between two words.
  const scheduleSave = useCallback(
    (immediate = false) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => {
          flushSave().catch((err) => showToast(`Save failed: ${cleanError(err)}`, 'error'));
        },
        SAVE_DELAY[immediate] ?? 300
      );
    },
    [flushSave, showToast]
  );
  scheduleSaveRef.current = scheduleSave;

  const mutateModel = useCallback(
    (fn, immediate = false, coalesceKey = null) => {
      pushHistory(coalesceKey);
      bumpDoc();
      setPageState((s) => {
        if (!s || !s.editable) return s;
        const model = fn(structuredClone(s.model));
        return { ...s, model, dirty: true };
      });
      scheduleSave(immediate);
    },
    [scheduleSave, pushHistory, bumpDoc]
  );

  const setRawSource = useCallback(
    (source) => {
      pushHistory('raw-source');
      bumpDoc();
      setPageState((s) => (s ? { ...s, source, dirty: true } : s));
      scheduleSave();
    },
    [scheduleSave, pushHistory, bumpDoc]
  );

  // ----------------------------------------------------------------
  // External file changes → refresh panels
  // ----------------------------------------------------------------

  useEffect(() => {
    const off = window.avb.onFsChanged(async ({ files }) => {
      const proj = projectRef.current;
      if (!proj) return;

      // Refresh pages list, palette, and prop schemas.
      const scanResult = await rescan(proj.path);

      const { currentPage: page, pageState: state } = pageStateRef.current;
      if (!page) return;
      // Chunk .html files feed the open page's Fragment subtrees — treat a
      // change to any of them like a change to the page itself.
      const affectsPage =
        files.includes(page.path) || files.some((f) => f.toLowerCase().endsWith('.html'));
      if (!affectsPage) return;

      // Current page deleted externally.
      if (!scanResult.pages.some((p) => p.path === page.path)) {
        setCurrentPage(null);
        setPageState(null);
        setSelectedId(null);
        return;
      }

      await reloadOpenPageRef.current?.();
    });
    return off;
  }, [rescan]);

  /**
   * Take the open page's model from disk again.
   *
   * The file watcher's answer to somebody editing the open file in another
   * editor — and the Agent API's answer to its own raw source write, which is
   * the same situation wearing a different hat: the bytes changed and the model
   * in memory is now describing a file that is gone. Left to itself the next
   * save would put the old model back over it.
   *
   * Through a ref so both callers reach the one implementation; the watcher
   * effect binds long before this is in scope.
   */
  const reloadOpenPageRef = useRef(null);
  reloadOpenPageRef.current = async () => {
    const { currentPage: page, pageState: state } = pageStateRef.current;
    if (!page) return false;
    // Unsaved edits in flight win: their pending save is about to be written,
    // and reloading over them would throw away work nobody has seen yet.
    if (state?.dirty) return false;
    let result;
    try {
      result = await window.avb.readPage(page.path);
    } catch {
      return false;
    }
    // Re-select the node at the same tree position (ids regenerate).
    const selId = selectedIdRef.current;
    let nextSelected = selId;
    if (selId && selId !== 'layout' && selId !== 'frontmatter') {
      if (state?.editable && result.editable) {
        const trail = pathOfNode(state.model.nodes, selId);
        nextSelected = trail ? (nodeAtPath(result.model.nodes, trail)?.id ?? null) : null;
      } else {
        nextSelected = null;
      }
    }
    // A document that came from somewhere other than this model is a new
    // document as far as anything holding a revision is concerned.
    docRevRef.current += 1;
    setPageState({ ...result, file: page.path, dirty: false });
    setSelectedId(nextSelected);
    // The history is deliberately left alone. Somebody editing the open file in
    // another editor has always been able to press ⌘Z afterwards and get the
    // model back — that is what undo means here, and it is not this function's
    // place to decide otherwise. An earlier version of this dropped the page's
    // snapshots and it was a behaviour change nobody asked for.
    return true;
  };

  // ----------------------------------------------------------------
  // Model operations
  // ----------------------------------------------------------------

  const projectRef = useRef(null);
  projectRef.current = project;

  const resolveImportPath = useCallback(async (targetPath) => {
    const page = pageStateRef.current.currentPage;
    return window.avb.importPathFor({
      pagePath: page.path,
      targetPath,
      projectPath: projectRef.current?.path,
    });
  }, []);

  // target: {parentId: string|null, index: number} | null (append at end)
  const addComponent = useCallback(
    async (componentName, target) => {
      const comp = insertables.find((c) => c.name === componentName);
      const page = pageStateRef.current.currentPage;
      if (!comp || !page) return;
      const paths = await resolveImportPath(comp.path);
      const id = newId();
      mutateModel((model) => {
        if (!model.imports.some((i) => i.name === comp.name)) {
          model.imports.push({
            name: comp.name,
            path: chooseImportPath(model, paths),
          });
        }
        // A component whose default slot sits in a text context arrives with a
        // word in it, the way an inserted <h1> or <p> does — something on the
        // canvas to aim at. A wrapper whose slot holds blocks (ButtonWrapper,
        // Section) comes in empty: a stray "Text" there is only ever deleted.
        const takesText = (comp.slots || []).includes('default') && !!comp.slotText;
        const node = {
          id,
          kind: 'component',
          name: comp.name,
          props: {},
          children: takesText ? [{ id: newId(), kind: 'text', value: 'Text' }] : null,
        };
        insertIntoModel(model, node, target);
        return model;
      }, true);
      setSelectedId(id);
    },
    [insertables, mutateModel, resolveImportPath]
  );

  // The page values a subtree reads — the props it would need once it's a file
  // of its own. Asked twice (once to show in the dialog, once to act on) and
  // both times of the live model, so nothing can drift between them.
  const propsNeededFor = useCallback((model, node) => {
    if (!model || !node) return [];
    const scope = namesInScope(model.extraFrontmatter || '', model.imports || []);
    for (const v of loopVarsAt(model.nodes, node.id)) scope.add(v);
    // An imported component is carried across as an import, not passed as a prop.
    for (const imp of model.imports || []) scope.delete(imp.name);
    return propsForExtraction(node, scope);
  }, []);

  // Where a component is used, for the palette's instance count. Asked of the
  // project (not the open file) so it covers pages and components alike; the
  // component's own file is left out — a file is not one of its own users.
  const componentUsage = useCallback(async (comp) => {
    if (!projectRef.current?.path) return { files: [] };
    try {
      return await window.avb.componentUsage({
        projectPath: projectRef.current.path,
        name: comp.name,
        exclude: comp.path,
      });
    } catch (err) {
      // Reported, never swallowed into an empty list: "we couldn't look" and
      // "it isn't used anywhere" are opposite answers, and the second one is
      // the sort of thing somebody acts on.
      return { error: cleanError(err) };
    }
  }, []);

  // The instances in the file that's already open — those a click can select
  // rather than navigate to.
  const pageInstancesOf = useCallback(
    (name) => {
      const model = pageStateRef.current.pageState?.model;
      if (!model) return [];
      const out = [];
      const walk = (list) => {
        for (const n of list || []) {
          if (n.kind === 'component' && n.name === name) out.push({ id: n.id });
          if (Array.isArray(n.children)) walk(n.children);
        }
      };
      walk(model.nodes);
      return out;
    },
    []
  );

  // Turn what's selected into a component of its own: write the file, then
  // replace the element in the page with an instance of it. The markup MOVES —
  // the page ends up with `<Card />` where the element was — so this is one
  // edit to two files, and the component file is written first: a page that
  // imports a file that isn't there yet is a broken page, however briefly.
  const createComponentFromSelection = useCallback(
    async (name, { withProps = true } = {}) => {
      const page = pageStateRef.current.currentPage;
      const model = pageStateRef.current.pageState?.model;
      const node = model && selectedIdRef.current ? findNodeById(model.nodes, selectedIdRef.current) : null;
      if (!page || !model || !node) return;
      const props = withProps ? propsNeededFor(model, node) : [];
      let created;
      try {
        created = await window.avb.createComponent({
          projectPath: projectRef.current?.path,
          pagePath: page.path,
          name,
          nodes: [node],
          imports: model.imports || [],
          props,
        });
      } catch (err) {
        showToast(cleanError(err), 'error');
        return;
      }
      const paths = await window.avb.importPathFor({
        pagePath: page.path,
        targetPath: created.path,
        projectPath: projectRef.current?.path,
      });
      const id = newId();
      mutateModel((m) => {
        const found = findParentList(m, node.id);
        if (!found) return m;
        if (!m.imports.some((i) => i.name === name)) {
          m.imports.push({ name, path: chooseImportPath(m, paths) });
        }
        // The instance passes each value straight back in under its own name.
        // That's what reconnects it: `title` meant the page's title where this
        // markup used to sit, and it still does, one level out.
        found.list[found.index] = {
          id,
          kind: 'component',
          name,
          props: Object.fromEntries(props.map((p) => [p, { type: 'expr', value: p }])),
          children: null,
        };
        return m;
      }, true);
      setSelectedId(id);
      await rescan(projectRef.current.path);
      // Anything left reading the page's scope can't be reconnected on its own
      // — an expression naming something that isn't a value the page holds, or
      // props turned off. The person who just moved it knows what it needs.
      const stranded = usesPageScope(node) && !props.length;
      showToast(
        stranded
          ? `Created ${created.rel} — it reads page data, so it will need props.`
          : props.length
            ? `Created ${created.rel} with ${props.length} prop${props.length === 1 ? '' : 's'}.`
            : `Created ${created.rel}`
      );
    },
    [mutateModel, propsNeededFor, rescan, showToast]
  );

  const moveNode = useCallback(
    (nodeId, target) => {
      const said = [];
      mutateModel((model) => {
        const result = ops.moveNode(model, { nodeId, target }, { insertables });
        said.push(...(result.notes || []));
        return model;
      }, true);
      for (const note of said) showToast(note, 'info');
    },
    [insertables, mutateModel, showToast]
  );

  // What the last delete took out of the frontmatter, to say so once the model
  // has settled — a toast raised inside a mutation would fire twice under
  // StrictMode and once per retry.
  const droppedRef = useRef(null);

  const removeNode = useCallback(
    (nodeId) => {
      const said = [];
      let landed;
      let refused = null;
      mutateModel((model) => {
        const result = ops.removeNode(model, { nodeId });
        if (!result.ok) {
          refused = result.message;
          return model;
        }
        said.push(...(result.notes || []));
        landed = result.selectId;
        return model;
      }, true);
      if (refused) {
        showToast(refused, 'error');
        return;
      }
      for (const note of said) showToast(note, 'info');
      // Only the selection that just vanished moves — deleting some other row
      // (navigator menu, canvas) leaves what you were working on alone.
      setSelectedId((id) => (id === nodeId ? landed ?? null : id));
    },
    [mutateModel, showToast]
  );

  // ----------------------------------------------------------------
  // Clipboard: copy / paste / duplicate nodes
  // ----------------------------------------------------------------

  const nodeClipboardRef = useRef(null);

  const cloneWithNewIds = (node) => {
    const clone = structuredClone(node);
    const walk = (n) => {
      n.id = newId();
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(clone);
    return clone;
  };

  const copyNode = useCallback(
    (nodeId) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) return;
      const node = findNodeById(state.model.nodes, nodeId);
      if (!node) return;
      nodeClipboardRef.current = {
        node: structuredClone(node),
        // The loop variables this subtree may reference; pasting somewhere
        // they don't exist has to drop those bindings.
        vars: loopVarsAt(state.model.nodes, nodeId),
        // And the code behind it. A `<Card options={jobs}/>` is not just its
        // markup: `jobs` is a const on the page it was copied from, and pasted
        // into another page it names nothing at all. Taken now rather than at
        // paste time, because by then this page may not even be open.
        frontmatter: state.model.extraFrontmatter || '',
        imports: (state.model.imports || []).map((i) => ({ name: i.name, path: i.path })),
        pagePath: pageStateRef.current.currentPage?.path || null,
      };
      showToast(`Copied ${node.name || 'text'}`, 'success');
    },
    [showToast]
  );

  const duplicateNode = useCallback(
    (nodeId) => {
      let landed = null;
      let refused = null;
      mutateModel((model) => {
        const result = ops.duplicateNode(model, { nodeId });
        if (!result.ok) refused = result.message;
        else landed = result.selectId;
        return model;
      }, true);
      if (refused) showToast(refused, 'error');
      else if (landed) setSelectedId(landed);
    },
    [mutateModel, showToast]
  );

  // Pastes into the current selection when it can host children (a non-void
  // element, or a component with a default slot), otherwise after it (same
  // parent), or at the end of the page. Imports for components in the pasted
  // subtree are added if the target page is missing them (cross-page paste).
  const pasteNode = useCallback(async () => {
    const clip = nodeClipboardRef.current;
    const state = pageStateRef.current.pageState;
    if (!clip || !state?.editable) return;

    // Everything the subtree reads: the components it renders and every name in
    // the code hanging off it — `options={jobs}`, a loop's `posts.map`, a
    // condition's test.
    const names = namesUsedIn([clip.node]);
    const knows = (nm) =>
      state.model.imports.some((i) => i.name === nm) ||
      new RegExp(`\\b${nm.replace(/\$/g, '\\$')}\\b`).test(state.model.extraFrontmatter || '');
    const missing = [...names].filter((nm) => !knows(nm));
    // A component this project has is imported from where it actually lives,
    // whatever the page it was copied from called it.
    const resolved = [];
    const byScan = new Set();
    for (const nm of missing) {
      const target = insertables.find((c) => c.name === nm);
      if (target) {
        byScan.add(nm);
        resolved.push({ name: nm, paths: await resolveImportPath(target.path) });
      }
    }

    // And what is left is the page's own code: an import of something that is
    // not a component (an image, `getCollection`), or a `const` it declared.
    // Both come across, and a declaration brings whatever it reads in turn.
    const carried = neededFrontmatter({
      names: missing.filter((nm) => !byScan.has(nm)),
      frontmatter: clip.frontmatter || '',
      imports: clip.imports || [],
      has: knows,
    });
    const carriedImports = [];
    for (const imp of carried.imports) {
      // A relative path means something different from another page's folder.
      const rebased =
        clip.pagePath && String(imp.path || '').startsWith('.')
          ? await window.avb.rebaseImport({
              fromPagePath: clip.pagePath,
              toPagePath: pageStateRef.current.currentPage?.path,
              spec: imp.path,
            })
          : { path: imp.path };
      carriedImports.push({ name: imp.name, path: rebased?.path || imp.path });
    }

    const clone = cloneWithNewIds(clip.node);
    const selId = selectedIdRef.current;
    const acceptsChildren = (n) => {
      if (n.id === 'layout') return true;
      if (n.kind === 'element') return !VOID_ELEMENTS.has(String(n.name).toLowerCase());
      if (n.kind === 'component') {
        return (insertables.find((c) => c.name === n.name)?.slots || []).includes('default');
      }
      return false;
    };
    mutateModel((model) => {
      for (const r of resolved) {
        if (!model.imports.some((i) => i.name === r.name)) {
          model.imports.push({ name: r.name, path: chooseImportPath(model, r.paths) });
        }
      }
      for (const imp of carriedImports) {
        if (!model.imports.some((i) => i.name === imp.name)) model.imports.push(imp);
      }
      if (carried.statements.length) {
        model.extraFrontmatter = withStatements(model.extraFrontmatter, carried.statements);
      }
      if (selId) {
        const sel = findNodeById(model.nodes, selId);
        if (sel && acceptsChildren(sel)) {
          if (!Array.isArray(sel.children)) sel.children = [];
          sel.children.push(clone);
          return model;
        }
        const found = findParentList(model, selId);
        if (found) {
          found.list.splice(found.index + 1, 0, clone);
          return model;
        }
      }
      model.nodes.push(clone);
      return model;
    }, true);

    // Pasted outside the loop it was copied from? Its bindings would throw.
    mutateModel((model) => {
      const landed = findNodeById(model.nodes, clone.id);
      if (!landed) return model;
      const inScope = loopVarsAt(model.nodes, clone.id);
      const lost = (clip.vars || []).filter((v) => !inScope.includes(v));
      const removed = stripLostBindings(landed, lost);
      if (removed) {
        showToast(
          `Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(', ')}.`,
          'info'
        );
      }
      return model;
    }, true);
    setSelectedId(clone.id);
    const brought = [...carriedImports.map((i) => i.name), ...carried.statements.map((s) => s.name)];
    if (brought.length) {
      showToast(
        `Brought ${brought.map((n) => `\`${n}\``).join(', ')} across from the page it was copied from.`,
        'info'
      );
    }
  }, [mutateModel, insertables, resolveImportPath, showToast]);

  // ----------------------------------------------------------------
  // Insert palette (⌘F / ⌘E) — quick-add components, tags, loops, …
  // ----------------------------------------------------------------

  // ⌘J / ⌃` toggle the terminal dock, the two bindings people already have in
  // their fingers. Both carry a modifier, so they still work while a text field
  // or the terminal itself has focus — unlike the rail's bare-letter shortcuts.
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const isToggle =
        (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') ||
        (e.ctrlKey && !e.metaKey && !e.altKey && e.key === '`');
      if (!isToggle) return;
      e.preventDefault();
      setTermOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [insertOpen, setInsertOpen] = useState(false);

  // Open requests from the app menu (⌘E accelerator) and from canvas
  // Interface sound. The menu owns the setting, so the app reads it once on
  // load and takes the menu's word for it afterwards; nothing in here decides
  // to make a noise on its own.
  useEffect(() => {
    let live = true;
    window.avb.settings?.().then((s) => {
      if (live) setSoundEnabled(!!s?.sound);
    });
    const off = window.avb.onMenu('sound', (on) => setSoundEnabled(!!on));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  // iframes (which forward ⌘F/⌘E when they hold keyboard focus).
  useEffect(() => {
    const openIfEditable = () => {
      if (pageStateRef.current.pageState?.editable && !inPreviewRef.current) {
        setInsertOpen(true);
      }
    };
    const offMenu = window.avb.onMenu('insert', openIfEditable);
    const onMsg = (e) => {
      if (e.data?.type !== 'avb:shortcut') return;
      if (e.data.name === 'insert') openIfEditable();
      // Arrow keys pressed while the canvas iframe holds focus: replay them
      // on the app window so tree navigation behaves the same whether the
      // selection was made on the canvas or in the navigator.
      else if (e.data.name === 'arrow' && e.data.key) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: e.data.key, bubbles: true, cancelable: true })
        );
      }
      // Delete / ⌘D from the canvas. Replayed on the document rather than
      // handled here so they go through the same guards as a keypress in the
      // app — one definition of what those keys do, and the handler's own
      // "am I typing in a field" check still sees a non-field target.
      else if (e.data.name === 'key' && e.data.key) {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: e.data.key,
            metaKey: !!e.data.meta,
            ctrlKey: !!e.data.meta,
            shiftKey: !!e.data.shift,
            bubbles: true,
            cancelable: true,
          })
        );
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      offMenu();
      window.removeEventListener('message', onMsg);
    };
  }, []);

  // Where a new node goes — see insertTarget.js. The rule lives there so the
  // "why did that land next to the section instead of in it?" answer can be
  // read, and tested, without a running app.
  const insertTargetFor = useCallback(
    (model, selId, item) => placeInsert(model, selId, item, insertables),
    [insertables]
  );

  const insertItem = useCallback(
    (item) => {
      setInsertOpen(false);
      const state = pageStateRef.current.pageState;
      if (!state?.editable) return;
      const target = insertTargetFor(state.model, selectedIdRef.current, item);

      if (item.type === 'component') {
        addComponent(item.name, target);
        return;
      }

      // <Image>/<Picture> need `import { … } from 'astro:assets'` — a named
      // import of a virtual module, so there is no file path to resolve the
      // way a project component's is.
      if (item.type === 'astroAsset') {
        const assetId = newId();
        mutateModel((model) => {
          if (!model.imports.some((i) => i.name === item.name && !i.typeOnly)) {
            model.imports.push({
              name: item.name,
              imported: item.name,
              path: ASTRO_ASSETS_MODULE,
              named: true,
            });
          }
          insertIntoModel(
            model,
            // Self-closing, and already valid: Astro throws on an <Image>
            // with no src, so a bare one would swap the canvas for a stack
            // trace the moment it landed. See PLACEHOLDER_PROPS.
            {
              id: assetId,
              kind: 'component',
              name: item.name,
              props: { ...PLACEHOLDER_PROPS },
              children: null,
            },
            target
          );
          return model;
        }, true);
        setSelectedId(assetId);
        return;
      }

      const id = newId();
      let node = null;
      if (item.type === 'element') {
        const placeholder = DEFAULT_TEXT[item.tag];
        node = {
          id,
          kind: 'element',
          name: item.tag,
          props: {},
          children: VOID_ELEMENTS.has(item.tag)
            ? null
            : placeholder
              ? [{ id: newId(), kind: 'text', value: placeholder }]
              : [],
        };
      } else if (item.type === 'map') {
        // No source until one is picked in the props panel. An empty literal
        // renders nothing; a placeholder name would throw "x is not defined"
        // and take the preview down the moment the loop lands on the page.
        node = { id, kind: 'map', head: '[].map((item) => (', children: [] };
      } else if (item.type === 'cond') {
        // `true` until a real test is typed: the then branch renders, so the
        // condition is visible on the canvas the moment it lands.
        //
        // Just the then. Most conditions never want an else, and one that does
        // is a switch away in the props panel — where turning it back off
        // brings the markup home rather than dropping it. Until then there is
        // nothing to choose between, so the tree shows what is inside the
        // condition directly (see branches.js) instead of a row saying "then".
        node = {
          id,
          kind: 'cond',
          op: '&&',
          test: 'true',
          children: [{ id: newId(), kind: 'branch', name: 'then', children: [] }],
        };
      } else if (item.type === 'comment') {
        node = { id, kind: 'comment', value: ' Comment ' };
      } else if (item.type === 'text') {
        node = { id, kind: 'text', value: 'Text' };
      } else if (item.type === 'expr') {
        node = { id, kind: 'expr', value: '{/* code */}' };
      } else if (item.type === 'doctype') {
        node = { id, kind: 'raw-line', value: '<!doctype html>' };
      } else if (item.type === 'style' || item.type === 'script') {
        node = { id, kind: 'raw', name: item.type, props: {}, inner: '' };
      }
      if (!node) return;
      mutateModel((model) => {
        insertIntoModel(model, node, target);
        return model;
      }, true);
      setSelectedId(id);
    },
    [insertTargetFor, addComponent, mutateModel]
  );

  // True while the CMS covers the canvas: the page-editing shortcuts below
  // would act on a selection the user can't see.
  const cmsOpenRef = useRef(false);
  cmsOpenRef.current = leftTab === 'cms' && (!!cmsRel || !!contentName);

  // Keyboard: ⌘Z undoes, ⇧⌘Z / ⌘Y redoes (app-wide, even inside fields —
  // field edits live in the same history); Delete/Backspace removes, ⌘C
  // copies, ⌘D duplicates, ⌘V pastes — unless the user is typing in a field.
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;

      // Undo/redo take priority over native field undo so history stays
      // consistent no matter where focus is. Handled before the CMS check
      // below and without requiring an open page: the stack also holds CSS,
      // CMS and asset changes, which are undoable from anywhere.
      if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        const h = historyRef.current;
        const wantsRedo = e.key.toLowerCase() === 'y' || e.shiftKey;
        if (!(wantsRedo ? h.future : h.past).length) return; // let the field's own undo have it
        e.preventDefault();
        if (wantsRedo) void redo();
        else void undo();
        return;
      }

      if (cmsOpenRef.current) return;

      // ⌘F / ⌘E open the insert palette (works from anywhere except the
      // code editor, which keeps its own find).
      if (mod && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'e')) {
        if (!pageStateRef.current.pageState?.editable) return;
        const el = e.target;
        if (el instanceof HTMLElement && el.closest('.cm-editor')) return;
        e.preventDefault();
        setInsertOpen(true);
        return;
      }

      // ⌘⇧A makes a component out of the selection: the Components panel opens
      // with the naming dialog up, the same thing its create button does.
      // Before the "am I typing" guard, so it works wherever focus happens to
      // be — it acts on the selected element, not on the field.
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        if (!pageStateRef.current.pageState?.editable) return;
        if (!selectedIdRef.current || selectedIdRef.current === 'frontmatter') return;
        const el = e.target;
        if (el instanceof HTMLElement && el.closest('.cm-editor')) return;
        e.preventDefault();
        setLeftTab('components');
        setCreateRequest((n) => n + 1);
        return;
      }

      // ⌘Enter goes straight to the class field: Settings tab, Settings group
      // open, caret in the class input. Before the "am I typing" guard below,
      // so it also works from another field in the panel.
      if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        if (!selectedIdRef.current) return;
        const el = e.target;
        if (el instanceof HTMLElement && el.closest('.cm-editor')) return;
        e.preventDefault();
        setRightTab('settings');
        setClassFocus((n) => n + 1);
        return;
      }

      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)
      ) {
        return;
      }
      const state = pageStateRef.current.pageState;
      if (!state?.editable) return;
      const selId = selectedIdRef.current;
      const hasNodeSel = !!selId && selId !== 'frontmatter';

      // Enter opens the floating editor for a selection that has one
      // (frontmatter, <style>, <script>) — same as its "Edit code" button.
      // Not gated on hasNodeSel: frontmatter is exactly one of these.
      if (!mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        // On a focused control Enter means "activate this", not "open the
        // selection" — leave those alone (including the Edit code button
        // itself, which would otherwise fire twice).
        if (t instanceof HTMLElement && t.closest('button, a, [role="button"]')) return;
        if (openCodeWindowRef.current?.()) e.preventDefault();
        return;
      }

      // S / D swap the right panel — plain keys, so they only fire outside
      // fields (the check above) and never collide with ⌘D (duplicate).
      if (!mod && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        setRightTab('style');
        return;
      }
      if (!mod && !e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        setRightTab('settings');
        return;
      }

      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (!hasNodeSel) return;
        e.preventDefault();
        removeNode(selId);
      } else if (mod && e.key.toLowerCase() === 'c') {
        // Let native copy win when actual text is selected.
        if (!hasNodeSel || String(window.getSelection() || '')) return;
        e.preventDefault();
        copyNode(selId);
      } else if (mod && e.key.toLowerCase() === 'd') {
        if (!hasNodeSel) return;
        e.preventDefault();
        duplicateNode(selId);
      } else if (mod && e.key.toLowerCase() === 'v') {
        if (!nodeClipboardRef.current) return;
        e.preventDefault();
        pasteNode();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [removeNode, copyNode, duplicateNode, pasteNode, undo, redo]);

  // Application-menu shortcuts: on macOS the native menu consumes ⌘Z/⌘C/⌘V
  // before the DOM sees them, so those arrive here via IPC instead. Copy and
  // paste route to the focused text field when one is active, otherwise to
  // the selected node.
  useEffect(() => {
    const inEditable = () => {
      const el = document.activeElement;
      return (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      );
    };
    const offs = [
      // ⌘Z is a menu accelerator, so the key never reaches the page: whatever
      // this decides is the only undo there is.
      //
      // Typing has its own, and the field is the only thing that knows what was
      // typed — a rename half-finished in a text box is not an entry on the
      // app's stack. So a field gets its own undo handed back to it.
      //
      // Everything else is the app's. It used to run only while a page was open
      // and the CMS was closed, which left every view that ISN'T a page unable
      // to undo anything it had recorded: the variables panel, the assets
      // panel, the CMS itself. A command carries its own inverse and needs no
      // page — and a snapshot without one is dropped rather than applied, which
      // undo already does.
      window.avb.onMenu('undo', () => {
        if (inEditable()) {
          window.avb.nativeUndo?.();
          return;
        }
        undo();
      }),
      window.avb.onMenu('redo', () => {
        if (inEditable()) {
          window.avb.nativeRedo?.();
          return;
        }
        redo();
      }),
      window.avb.onMenu('copy', () => {
        if (inEditable() || String(window.getSelection() || '')) {
          window.avb.nativeCopy();
          return;
        }
        const selId = selectedIdRef.current;
        if (selId && pageStateRef.current.pageState?.editable && !cmsOpenRef.current) {
          copyNode(selId);
        }
      }),
      window.avb.onMenu('paste', () => {
        if (inEditable()) {
          window.avb.nativePaste();
          return;
        }
        if (nodeClipboardRef.current && pageStateRef.current.pageState?.editable && !cmsOpenRef.current) {
          pasteNode();
        }
      }),
      // ⇧⌘C — the selection's file:line trail, for pasting into an AI chat.
      // Copies markup coordinates, not markup: ⌘C already does the node.
      window.avb.onMenu('copySelection', async () => {
        // The lines are read off the file on disk, and typing is saved on a
        // 300 ms debounce — land the pending edit first or they're one edit old.
        await flushSave();
        const res = await window.avb.copySelection({
          projectPath: projectRef.current?.path,
          keys: selectionKeysRef.current,
        });
        if (res?.ok) showToast('Selection copied — paste it into your AI chat.');
        else showToast('Nothing selected to copy.', 'error');
      }),
      // File ▸ AI Connection — where the MCP endpoint, the token and any
      // startup failure are shown. Read fresh every time it opens: the server
      // starts alongside the window and may not have been up on the last look.
      window.avb.onMenu('mcp', async () => {
        setMcpStatus((await window.avb.mcpStatus()) || { running: false, error: null });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [undo, redo, copyNode, pasteNode, flushSave, showToast]);

  // ----------------------------------------------------------------
  // Interactive preview mode — browse the site inside the app; on exit,
  // the editor follows whichever page was navigated to.
  // ----------------------------------------------------------------

  const enterPreview = useCallback(() => {
    if (!devUrl) return;
    // Whatever the canvas is showing — which for a dynamic page is one entry's
    // URL, not its pattern. Opening /blog/[...id] asks the dev server for a
    // route no page produces, and it answers with the site's 404, while the
    // URL field (built from the same entry) went on claiming otherwise.
    const path =
      livePathRef.current ||
      routeToPath(pageStateRef.current.currentPage?.route || '/', trailingSlash);
    previewPathRef.current = path;
    setPreviewSrc(devUrl + path);
    setInPreview(true);
  }, [devUrl, trailingSlash]);

  const exitPreview = useCallback(() => {
    setInPreview(false);
    const raw = previewPathRef.current;
    if (!raw) return;
    let p = raw.split('?')[0].split('#')[0];
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    const page = scan.pages.find((pg) => pg.route === (p || '/'));
    if (page && page.path !== pageStateRef.current.currentPage?.path) {
      selectPage(page);
    }
  }, [scan.pages, selectPage]);

  // Track navigation inside the preview iframe (the preload posts
  // avb:navigated from every loaded frame).
  useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.type !== 'avb:navigated' || !inPreviewRef.current) return;
      const ifr = previewIframeRef.current;
      if (ifr && e.source === ifr.contentWindow) {
        previewPathRef.current = e.data.path;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Escape exits preview mode.
  useEffect(() => {
    // Escape leaves either kind of looking-not-working. An older version takes
    // precedence: it is the one covering everything, so it is the one Escape
    // is about while it is up.
    if (!inPreview && !previewRef) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (previewRef) exitCommitPreview();
        else exitPreview();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, exitPreview, previewRef, exitCommitPreview]);

  // Escape backs out of a drilled-into component, one level at a time.
  useEffect(() => {
    if (inPreview || editStack.length < 2) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      // Let fields, menus, and dialogs consume their own Escape first.
      if (
        t instanceof HTMLElement &&
        (t.closest('input, textarea, select, [contenteditable="true"]') ||
          t.closest('.modal-overlay, .dd-popup, .insert-overlay, .code-window'))
      ) {
        return;
      }
      e.preventDefault();
      closeComponent();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, editStack.length, closeComponent]);

  // The route list is written by the dev server as it resolves its routes, so
  // it is read once the server is up — and again after a rescan, since adding
  // a page of your own changes what the list holds.
  useEffect(() => {
    if (!project || devStatus !== 'on') {
      setInjectedRoutes([]);
      return;
    }
    let live = true;
    window.avb
      .injectedRoutes({ projectPath: project.path })
      .then((r) => live && setInjectedRoutes(r?.routes || []))
      .catch(() => live && setInjectedRoutes([]));
    return () => {
      live = false;
    };
  }, [project, devStatus, scan.pages.length]);

  // A dynamic page ([slug].astro) has a route pattern, not a URL. Ask the dev
  // server which concrete paths its getStaticPaths produces, so the canvas can
  // show one of them instead of a 404. Static pages never reach the fetch.
  useEffect(() => {
    const entry = editStack[0] || currentPage;
    const route = entry?.route;
    if (!project || !entry || !route?.includes('[') || devStatus !== 'on' || !devUrl) {
      setDynamicPaths([]);
      return undefined;
    }
    let live = true;
    window.avb
      .dynamicPaths({ projectPath: project.path, pagePath: entry.path, devUrl })
      .then((r) => {
        if (!live) return;
        setDynamicPaths(r?.entries || []);
        // Keep showing the same entry across reloads where we can — the
        // params are what identify it, not its position in the list.
        setDynamicIndex((i) => (i < (r?.entries || []).length ? i : 0));
        if (r?.error) setDynamicError(r.error);
        else setDynamicError(null);
      })
      .catch(() => live && setDynamicPaths([]));
    return () => {
      live = false;
    };
    // Frontmatter rather than the whole pageState: getStaticPaths lives there,
    // and depending on the model would re-run a collection query on every
    // keystroke in the page body.
  }, [project, editStack, currentPage, devStatus, devUrl, pageState?.model?.extraFrontmatter]);

  // What one entry of each collection this file reads actually holds — the
  // sample values the binding picker shows beside a field's name. Only the dev
  // server can run the project's loaders, so without one the picker falls back
  // to whatever the source alone says.
  useEffect(() => {
    setCollectionSamples({});
    sampleAskedRef.current = new Set();
  }, [project?.path]);
  useEffect(() => {
    if (!project?.path) return undefined;
    let live = true;
    window.avb
      .contentCollections?.(project.path)
      .then((r) => live && setCollections(r?.collections || []))
      .catch(() => {});
    const off = window.avb.onCmsChanged?.(() => {
      window.avb
        .contentCollections?.(project.path)
        .then((r) => live && setCollections(r?.collections || []))
        .catch(() => {});
    });
    return () => {
      live = false;
      off?.();
    };
  }, [project?.path]);
  useEffect(() => {
    if (!devUrl || devStatus !== 'on') return undefined;
    const frontmatter = pageState?.model?.extraFrontmatter || '';
    // The entry on the canvas, which is what a reference in this file resolves
    // AGAINST — this post's author, not the collection's first.
    const props =
      currentPage?.kind === 'component' ? null : dynamicPaths[dynamicIndex]?.props || null;
    const wanted = [
      ...collectionsInScope(frontmatter).map((name) => ({ key: name, name })),
      ...referencesInScope(frontmatter, props).map((r) => ({
        key: r.key,
        name: r.collection,
        id: r.id,
      })),
    ].filter((w) => !(w.key in collectionSamples));
    if (!wanted.length) return undefined;
    let live = true;
    Promise.all(
      wanted.map((w) =>
        window.avb
          .sampleEntry({ devUrl, name: w.name, id: w.id })
          .then((r) => [w.key, r?.entry || null])
      )
    )
      .then((pairs) => {
        if (live) setCollectionSamples((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [
    pageState?.model?.extraFrontmatter,
    devUrl,
    devStatus,
    collectionSamples,
    dynamicPaths,
    dynamicIndex,
    currentPage,
  ]);

  // Takes back the queries it wrote, once the page stops using them: delete the
  // last chip reading a collection and its `const … = await getCollection(…)`
  // goes too, rather than leaving a query fetching content for nobody.
  //
  // Three things keep this safe. Only queries carrying Stacki's own marker are
  // considered, so a hand-written one is never touched. "Used" is tested
  // against the whole node tree as text, which over-detects rather than
  // under-detects — the wrong answer here is deleting something live. And it
  // waits for a pause in typing, because a half-typed name reads as unused.
  useEffect(() => {
    const current = pageState?.model;
    if (!current?.extraFrontmatter?.includes(QUERY_MARK)) return undefined;
    const timer = setTimeout(() => {
      const focused = document.activeElement;
      if (focused?.closest?.('.props-field, .rich-content, .bind-input, .expr-input, .attr-editor'))
        return;
      const fm = current.extraFrontmatter || '';
      const markup = JSON.stringify(current.nodes || []);
      const dead = markedQueries(fm).filter((q) => {
        const word = new RegExp(`\\b${q.name}\\b`);
        const elsewhere = fm.slice(0, q.start) + fm.slice(q.end);
        return !word.test(elsewhere) && !word.test(markup);
      });
      if (!dead.length) return;
      mutateModel((m) => {
        let next = m.extraFrontmatter || '';
        for (const q of dead) next = removeMarkedQuery(next, q.name);
        m.extraFrontmatter = next;
        // The import goes with the last query that needed it — but only when
        // nothing else in the file mentions it, so an import someone else put
        // there and still uses stays put.
        if (!/\bgetCollection\b/.test(next) && !/\bgetCollection\b/.test(JSON.stringify(m.nodes || []))) {
          m.imports = m.imports.filter(
            (i) => !(i.name === 'getCollection' && i.path === 'astro:content')
          );
        }
        return m;
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [pageState?.model, mutateModel]);

  // The welcome screen's thumbnails are taken in the main process now, from
  // the project's home page rendered in a window of its own (see
  // electron/thumbs.js). Photographing this window was what put the editor's
  // own panels — and whatever page and scroll position the user left — into
  // the picture that is supposed to show the site.


  // The comment sitting directly above a node. The navigator folds it into
  // that node's row rather than giving it one of its own, and the props panel
  // edits it there — so a section's label and its note stay together.
  const commentAbove = (model, nodeId) => {
    if (!model || !nodeId) return null;
    const found = findParentList(model, nodeId);
    if (!found || found.index === 0) return null;
    const prev = found.list[found.index - 1];
    return prev && prev.kind === 'comment' ? prev : null;
  };

  // Write (or clear) that comment. Empty text removes the node entirely, so
  // clearing the field doesn't leave `<!---->` behind.
  const setComment = useCallback(
    (nodeId, text) => {
      mutateModel(
        (model) => {
          const found = findParentList(model, nodeId);
          if (!found) return model;
          const { list, index } = found;
          const prev = index > 0 ? list[index - 1] : null;
          const existing = prev && prev.kind === 'comment' ? prev : null;
          const body = String(text ?? '').trim();
          if (!body) {
            if (existing) list.splice(index - 1, 1);
            return model;
          }
          // The parser keeps the raw text between the delimiters, so it is
          // padded to serialize as `<!-- text -->` the way a hand-written one
          // reads — and a note written as a divider keeps its rule, to the
          // same width, so a column of them stays lined up.
          const value = noteValue(existing?.value, body);
          if (existing) existing.value = value;
          else list.splice(index, 0, { id: newId(), kind: 'comment', value });
          return model;
        },
        false,
        `comment:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Typing a bare class in the style panel's selector box puts it on the
  // element too — a rule for a class the element doesn't carry would never
  // apply. Where it goes depends on how the element's classes are written: a
  // plain `class`, a `class:list`, a template literal (see classAttr.js). An
  // element whose class is some other expression is code we would have to
  // understand to extend, so that one is said out loud rather than dropped.
  const addClassToNode = useCallback(
    (nodeId, className) => {
      let refused = null;
      mutateModel((model) => {
        const result = ops.addClass(model, { nodeId, className });
        if (!result.ok) refused = result.message;
        return model;
      }, true);
      if (refused) showToast(refused);
    },
    [mutateModel, showToast]
  );

  const setProp = useCallback(
    (nodeId, propName, value, immediate = false) => {
      mutateModel(
        (model) => {
          ops.setProp(model, { nodeId, name: propName, value });
          return model;
        },
        immediate,
        `prop:${nodeId}:${propName}`
      );
    },
    [mutateModel]
  );

  // Several props in one edit, so picking an image and getting its width and
  // height back is a single undo rather than three.
  const setProps = useCallback(
    (nodeId, patch, immediate = true) => {
      mutateModel(
        (model) => {
          ops.setProps(model, { nodeId, patch });
          return model;
        },
        immediate,
        `props:${nodeId}:${Object.keys(patch).join(',')}`
      );
    },
    [mutateModel]
  );

  // Writes an asset pick into a prop. The root decides the form:
  //
  //   public/  served as-is → a URL string, src="/hero.png"
  //   src/     built and optimised → an ESM import, src={hero}
  //
  // The src/ form is the one Astro wants for <Image>: it carries the file's
  // real dimensions, so nothing has to be typed in and MissingImageDimension
  // can't happen. An element gets `hero.src` instead — a plain <img> needs the
  // URL out of the imported object, not the object.
  const setAssetProp = useCallback(
    async (nodeId, propName, picked) => {
      const { pageState: state, currentPage: page } = pageStateRef.current;
      if (!state?.editable || !page || !picked?.rel) return;
      const withoutRoot = picked.rel.split('/').slice(1).join('/');
      if (picked.root !== 'src') {
        setProp(nodeId, propName, { type: 'string', value: '/' + withoutRoot }, true);
        return;
      }
      const abs = picked.abs || `${projectRef.current?.path}/${picked.rel}`;
      const paths = await window.avb.importPathFor({
        pagePath: page.path,
        targetPath: abs,
        projectPath: projectRef.current?.path,
      });
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        if (!node) return model;
        const spec = chooseImportPath(model, paths);
        // Reuse the binding if this file is already imported — importing the
        // same asset twice under two names is just noise.
        let local = (model.imports || []).find((i) => !i.named && i.path === spec)?.name;
        if (!local) {
          const base = withoutRoot.split('/').pop().replace(/\.[^.]+$/, '');
          let candidate = base.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1') || 'asset';
          const taken = new Set((model.imports || []).map((i) => i.name));
          let n = 2;
          while (taken.has(candidate)) candidate = `${base}${n++}`;
          local = candidate;
          model.imports.push({ name: local, path: spec });
        }
        if (!node.props) node.props = {};
        node.props[propName] = {
          type: 'expr',
          value: node.kind === 'element' ? `${local}.src` : local,
        };
        // Picking a second image over a first leaves the first one's import
        // behind with nothing pointing at it.
        pruneImports(model);
        return model;
      }, true);
    },
    [mutateModel, setProp]
  );

  // Renames an attribute in place, preserving its value and position.
  const renameProp = useCallback(
    (nodeId, oldName, newName) => {
      mutateModel((model) => {
        ops.renameProp(model, { nodeId, from: oldName, to: newName });
        return model;
      }, true);
    },
    [mutateModel]
  );

  // Switches a plain element's tag. Attributes that belonged to the old
  // tag's built-in schema but aren't valid for the new one are dropped
  // (loading="eager" on img → div); global, data-* and aria-* attributes
  // and anything custom stay.
  // Renaming a node's tag can change what kind of node it is. Astro decides
  // that by case: `<div>` is an element, `<AstroLogo>` is a component — and a
  // component is only real if something in the frontmatter provides it, so a
  // capitalised name is only accepted when it names a project component or an
  // existing import. Typing `div` over a component turns it back.
  const changeNodeKind = useCallback(
    async (nodeId, newTag) => {
      const name = String(newTag || '').trim();
      if (!/^[A-Z][\w$]*$/.test(name)) return false;
      const state = pageStateRef.current.pageState;
      if (!state?.editable) return false;
      const already = (state.model.imports || []).some((i) => i.name === name);
      const comp = insertables.find((c) => c.name === name);
      const asset = ASTRO_ASSETS.some((a) => a.name === name);
      if (!already && !comp && !asset) return false; // nothing provides it
      const paths = comp && !already ? await resolveImportPath(comp.path) : null;
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        if (!node || node.name === name) return model;
        if (!model.imports.some((i) => i.name === name)) {
          if (paths) model.imports.push({ name, path: chooseImportPath(model, paths) });
          else if (asset) {
            model.imports.push({ name, imported: name, path: ASTRO_ASSETS_MODULE, named: true });
          }
        }
        // Attributes that belonged to the old element's tag mean nothing to a
        // component; class, data- and aria- carry over the way they do for a
        // tag change.
        if (node.kind === 'element') {
          const oldNames = new Set(getElementSchema(node.name).map((f) => f.name));
          for (const attr of Object.keys(node.props || {})) {
            if (oldNames.has(attr) && !GLOBAL_ATTRS.has(attr) && !/^(data-|aria-)/.test(attr)) {
              delete node.props[attr];
            }
          }
        }
        node.kind = 'component';
        node.name = name;
        delete node.dynamicTag;
        node.astroAsset = asset || undefined;
        if (node.children === null) node.children = [];
        pruneImports(model);
        return model;
      }, true);
      return true;
    },
    [insertables, mutateModel, resolveImportPath]
  );

  const changeElementTag = useCallback(
    (nodeId, newTag) => {
      mutateModel((model) => {
        ops.setTag(model, { nodeId, tag: newTag });
        return model;
      }, true);
    },
    [mutateModel]
  );

  // `renames` (loop editor only) carries the variable names this edit is
  // changing, so references below the node follow along. A rename touches
  // many nodes at once, so it saves immediately and gets its own history
  // entry instead of coalescing with the keystrokes around it.
  // `immediate` skips the typing coalesce for an edit that arrives already committed
  // (the style panel writing a <style> block): waiting 300 ms there just delays the
  // canvas, since the next keystroke it was batching with never comes.
  const setNodeText = useCallback(
    (nodeId, value, renames, immediate = false) => {
      const renaming = (renames || []).some((r) => r.from && r.to && r.from !== r.to);
      mutateModel(
        (model) => {
          // `replaceBinding` because this IS the field showing the expression:
          // a person editing `{post.title}` in the props panel can see what
          // they are typing over. The Agent API passes it only when an agent
          // has said in as many words that it means to replace a binding.
          ops.setText(model, { nodeId, value, renames, replaceBinding: true });
          return model;
        },
        renaming || immediate,
        renaming ? undefined : `text:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Replaces the page frontmatter: default imports are re-extracted so the
  // model's import list (used for palettes, pruning, chunk resolution) stays
  // in sync with the edited code.
  const setFrontmatter = useCallback(
    (code) => {
      mutateModel(
        (model) => {
          const importRe = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g;
          const imports = [];
          let extra = code;
          let m;
          while ((m = importRe.exec(code)) !== null) {
            imports.push({ name: m[1], path: m[2] });
            extra = extra.replace(m[0], '');
          }
          model.imports = imports;
          model.extraFrontmatter = extra.trim();
          return model;
        },
        false,
        'frontmatter'
      );
    },
    [mutateModel]
  );

  // Adds or removes a condition's else branch. Removing keeps the markup that
  // was in it — it moves to the then branch rather than being deleted — so the
  // button can't quietly throw work away.
  const toggleElseBranch = useCallback(
    (nodeId, want) => {
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node || node.kind !== 'cond') return model;
          const kids = node.children || (node.children = []);
          if (!kids[0]) kids[0] = { id: newId(), kind: 'branch', name: 'then', children: [] };
          if (want && kids.length < 2) {
            kids[1] = { id: newId(), kind: 'branch', name: 'else', children: [] };
            node.op = '?';
          } else if (!want && kids.length > 1) {
            const rescued = kids[1].children || [];
            kids.length = 1;
            kids[0].children = [...(kids[0].children || []), ...rescued];
            node.op = '&&';
          }
          return model;
        },
        true,
        undefined
      );
    },
    [mutateModel]
  );

  // Replaces the frontmatter's non-import code (its declarations), leaving the
  // import list alone. What the props panel edits when you open the source
  // behind a `{data}` prop — the imports aren't in play there, so they don't
  // need re-extracting.
  const setExtraFrontmatter = useCallback(
    (code) => {
      mutateModel(
        (model) => {
          model.extraFrontmatter = code;
          return model;
        },
        false,
        'frontmatter'
      );
    },
    [mutateModel]
  );

  // Sets the text content of a component (single text child convenience).
  // Where each node's loose text last sat, so emptying the Content field and
  // typing again restores its place rather than appending.
  const textSlotRef = useRef({});

  const setNodeContent = useCallback(
    (nodeId, value) => {
      mutateModel(
        (model) => {
          const result = ops.setText(model, {
            nodeId,
            value,
            replaceBinding: true,
            // Where this node's loose text last sat, so emptying the Content
            // field and typing again restores its place rather than appending.
            slotHint: textSlotRef.current[nodeId],
          });
          if (Number.isInteger(result.textSlot)) textSlotRef.current[nodeId] = result.textSlot;
          return model;
        },
        false,
        `content:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Replaces a node's inline children wholesale (rich Content field edits).
  // Nodes arrive from the editor without ids — assign fresh ones.
  const setNodeInline = useCallback(
    (nodeId, kids) => {
      const withIds = (list) =>
        list.map((n) => ({
          ...n,
          id: newId(),
          ...(Array.isArray(n.children) ? { children: withIds(n.children) } : {}),
        }));
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node || node.kind === 'text') return model;
          node.children = withIds(kids);
          return model;
        },
        false,
        `content:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Set/replace/remove the `layout:` key in a markdown page's YAML
  // frontmatter, leaving every other key and its formatting alone. The
  // frontmatter text stays the single source of truth — editing it by hand in
  // the frontmatter editor and picking a layout here write to the same place.
  const withLayoutField = (frontmatter, layoutPath) => {
    const fm = frontmatter ?? '';
    if (/^[ \t]*layout[ \t]*:/m.test(fm)) {
      return layoutPath
        ? fm.replace(/^[ \t]*layout[ \t]*:.*$/m, `layout: ${layoutPath}`)
        : fm.replace(/^[ \t]*layout[ \t]*:.*(\n|$)/m, '');
    }
    if (!layoutPath) return fm;
    // First, so it reads as the page's frame rather than one field among many.
    return fm ? `layout: ${layoutPath}\n${fm}` : `layout: ${layoutPath}`;
  };

  const isMarkdownFormatRef = useRef(false);
  isMarkdownFormatRef.current = pageState?.model?.format === 'md' || pageState?.model?.format === 'mdx';

  const layoutSeq = useRef(0);
  const changeLayout = useCallback(
    async (layoutName) => {
      const seq = ++layoutSeq.current;
      // A markdown page has no wrapper node to swap — Astro reads its layout
      // from the `layout:` frontmatter key, as a path relative to the file.
      // Same picker, different place to write the answer.
      if (isMarkdownFormatRef.current) {
        const layout = layoutName ? scan.layouts.find((l) => l.name === layoutName) : null;
        if (layoutName && !layout) return;
        // A file-relative path, not an alias: `layout:` is resolved by Astro
        // against the page, and every project has that whether or not it has
        // configured `@/…`.
        const rel = layout ? (await resolveImportPath(layout.path)).relative : null;
        if (seq !== layoutSeq.current) return;
        mutateModel((model) => {
          model.extraFrontmatter = withLayoutField(model.extraFrontmatter, rel);
          model.layoutPath = rel;
          return model;
        }, true);
        return;
      }
      if (!layoutName) {
        // Unwrap: replace the wrapper node with its children.
        mutateModel((model) => {
          const found = findParentList(model, 'layout');
          if (found) {
            const node = found.list[found.index];
            const kids = Array.isArray(node.children) ? node.children : [];
            found.list.splice(found.index, 1, ...kids);
          }
          pruneImports(model);
          return model;
        }, true);
        setSelectedId((id) => (id === 'layout' ? null : id));
        return;
      }
      const layout = scan.layouts.find((l) => l.name === layoutName);
      if (!layout) return;
      const paths = await resolveImportPath(layout.path);
      if (seq !== layoutSeq.current) return; // superseded by a newer change
      mutateModel((model) => {
        const existing = findNodeById(model.nodes, 'layout');
        if (existing) {
          existing.name = layout.name;
        } else {
          // No wrapper yet — wrap the whole page in the new layout.
          model.nodes = [
            { id: 'layout', kind: 'component', name: layout.name, props: {}, children: model.nodes },
          ];
        }
        if (!model.imports.some((i) => i.name === layout.name)) {
          model.imports.push({
            name: layout.name,
            path: chooseImportPath(model, paths),
          });
        }
        pruneImports(model);
        return model;
      }, true);
    },
    [scan.layouts, mutateModel, resolveImportPath]
  );

  // ----------------------------------------------------------------
  // Page management
  // ----------------------------------------------------------------

  const createPage = useCallback(
    async (name, layoutName) => {
      const layout = scan.layouts.find((l) => l.name === layoutName) || null;
      try {
        const { pagePath } = await window.avb.createPage({
          projectPath: project.path,
          name,
          layout,
        });
        const result = await rescan(project.path);
        const page = result.pages.find((p) => p.path === pagePath);
        if (page) selectPage(page);
        showToast(`Created ${name}.astro`, 'success');
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, scan.layouts, rescan, selectPage, showToast]
  );

  const deletePage = useCallback(
    async (page) => {
      if (
        !(await confirmDialog({
          title: `Delete ${page.name}?`,
          body: 'This removes the file from disk. It can be brought back from History if it was saved in a version.',
          confirmLabel: 'Delete page',
          danger: true,
        }))
      ) {
        return;
      }
      await window.avb.deletePage(page.path);
      const result = await rescan(project.path);
      if (currentPage?.path === page.path) {
        const next = result.pages[0] || null;
        if (next) selectPage(next);
        else {
          setCurrentPage(null);
          setPageState(null);
        }
      }
      showToast(`Deleted ${page.name}`, 'success');
    },
    [project, currentPage, rescan, selectPage, showToast]
  );

  // Moves/renames a page (drag between folders, inline rename). `to` is the
  // new path relative to src/pages including the extension.
  const movePageTo = useCallback(
    async (page, to) => {
      try {
        const { newPath } = await window.avb.movePage({
          projectPath: project.path,
          from: page.path,
          to,
        });
        const result = await rescan(project.path);
        if (pageStateRef.current.currentPage?.path === page.path) {
          const np = result.pages.find((p) => p.path === newPath);
          if (np) selectPage(np);
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, rescan, selectPage, showToast]
  );

  // Creates an (empty) folder with a placeholder name; the panel opens an
  // inline rename right after. Returns the created folder's name.
  const createPageFolder = useCallback(async () => {
    const existing = new Set(scan.pageFolders || []);
    let name = 'new-folder';
    for (let i = 2; existing.has(name); i++) name = `new-folder-${i}`;
    try {
      await window.avb.createPageFolder({ projectPath: project.path, dir: name });
      await rescan(project.path);
      return name;
    } catch (err) {
      showToast(cleanError(err), 'error');
      return null;
    }
  }, [project, scan, rescan, showToast]);

  const renamePageFolder = useCallback(
    async (from, to) => {
      try {
        await window.avb.renamePageFolder({ projectPath: project.path, from, to });
        const result = await rescan(project.path);
        // Re-select the current page if it lived inside the renamed folder.
        const cur = pageStateRef.current.currentPage;
        if (cur && !result.pages.some((p) => p.path === cur.path)) {
          const newName = cur.name.startsWith(from + '/')
            ? to + cur.name.slice(from.length)
            : null;
          const np = newName && result.pages.find((p) => p.name === newName);
          if (np) selectPage(np);
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, rescan, selectPage, showToast]
  );

  const deletePageFolder = useCallback(
    async (dir, pageCount) => {
      const inside = pageCount
        ? `the ${pageCount} page${pageCount === 1 ? '' : 's'} inside it and `
        : '';
      if (
        !(await confirmDialog({
          title: `Delete the folder “${dir}”?`,
          body: `This removes ${inside}the folder from disk.`,
          confirmLabel: 'Delete folder',
          danger: true,
        }))
      ) {
        return;
      }
      try {
        await window.avb.deletePageFolder({ projectPath: project.path, dir });
        const result = await rescan(project.path);
        const cur = pageStateRef.current.currentPage;
        if (cur && !result.pages.some((p) => p.path === cur.path)) {
          const next = result.pages[0] || null;
          if (next) selectPage(next);
          else {
            setCurrentPage(null);
            setPageState(null);
          }
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, rescan, selectPage, showToast]
  );

  // ----------------------------------------------------------------
  // Selection helpers
  // ----------------------------------------------------------------

  const model = pageState?.editable ? pageState.model : null;

  // The frontmatter as one editable code block (imports + everything else,
  // matching how the file is serialized).
  const frontmatterCode = model
    ? [
        ...model.imports.map((i) => `import ${i.name} from '${i.path}';`),
        ...(model.extraFrontmatter ? ['', model.extraFrontmatter] : []),
      ].join('\n')
    : '';

  // One entry of a collection, asked for when someone opens it in the picker.
  // The ref is what stops a row that has no answer from asking again forever.
  const requestCollectionSample = (name) => {
    if (!name || !devUrl || devStatus !== 'on') return;
    if (sampleAskedRef.current.has(name)) return;
    sampleAskedRef.current.add(name);
    window.avb
      .sampleEntry({ devUrl, name })
      .then((r) => setCollectionSamples((prev) => ({ ...prev, [name]: r?.entry || null })))
      .catch(() => {});
  };

  // Binding to a collection this page doesn't read yet: the query that fetches
  // it is written here, and the binding then names it like any other value.
  // A query already targeting that collection is reused — one page asking the
  // same content twice is a page doing the same work twice.
  const ensureCollectionQuery = (collection) => {
    const fm = model?.extraFrontmatter || '';
    const existing = queriesInScope(fm).get(collection);
    if (existing) return existing;
    const name = autoQueryName(collection, namesInScope(fm, model?.imports));
    mutateModel((m) => {
      if (!m.imports.some((i) => i.name === 'getCollection' && i.path === 'astro:content')) {
        m.imports.push({
          name: 'getCollection',
          imported: 'getCollection',
          path: 'astro:content',
          quote: "'",
          named: true,
        });
      }
      const cur = m.extraFrontmatter || '';
      const gap = cur && !cur.endsWith('\n') ? '\n' : '';
      // No trailing newline: the serializer ends the line, and one added here
      // would be left behind as a blank line when the query is taken back.
      m.extraFrontmatter = `${cur}${gap}const ${name} = await getCollection('${collection}'); // ${QUERY_MARK}`;
      return m;
    });
    return name;
  };

  const selectedNode =
    model && selectedId
      ? selectedId === 'frontmatter'
        ? { id: 'frontmatter', kind: 'frontmatter', value: frontmatterCode }
        : findNodeById(model.nodes, selectedId)
      : null;
  // What the Components panel's create button would act on: the name to suggest
  // for the selected element, or why there's nothing to make a component from.
  const createFrom = useMemo(() => {
    if (!pageState?.editable) return { reason: 'Open a page to make components from it.' };
    if (!selectedNode) return { reason: 'Select an element on the canvas first.' };
    const node = selectedNode;
    if (node.kind === 'text' || node.kind === 'expr') {
      return { reason: 'Select the element around this, not the text itself.' };
    }
    if (node.kind === 'frontmatter') return { reason: 'Select an element on the canvas first.' };
    if (node.id === 'layout') return { reason: 'A layout is already a component of its own.' };
    if (node.kind !== 'element' && node.kind !== 'component') {
      return { reason: 'Select an element on the canvas first.' };
    }
    // Its first class is the name it already goes by — `.project-card` is a
    // better guess at a component name than `Div`. The tag is the fallback.
    const first = namesIn(node.props?.class)[0] || namesIn(node.props?.['class:list'])[0] || '';
    return {
      name: toComponentName(first) || toComponentName(node.name) || 'Component',
      label: `<${node.name}>`,
      // The page values it reads, which the new component can take as props.
      props: propsNeededFor(model, node),
    };
  }, [pageState?.editable, selectedNode, model, propsNeededFor]);

  // Rendered classes describe one element, and the canvas can only say what the
  // NEW selection's are a frame or two later. Two ways to spend that gap, and
  // both used to be wrong in one direction:
  //
  //   clear at once   the selector field empties and then refills, so every
  //                   click on the canvas flickers through a blank panel.
  //   keep the old    the field is briefly wrong rather than briefly empty,
  //                   which is steadier to look at — but if the report never
  //                   comes (an element the page doesn't render has no classes
  //                   to report) the wrong ones would sit there for good.
  //
  // So: keep the old ones, and only fall back to empty if nothing has arrived
  // by the time the gap stops being a gap. In practice the report lands first
  // and the timer never fires.
  useEffect(() => {
    if (classesForRef.current === selectedId) return undefined;
    const t = setTimeout(() => setSelectedClasses((prev) => (prev.length ? [] : prev)), 600);
    return () => clearTimeout(t);
  }, [selectedId, classesTick]);

  const layoutNode = model ? findNodeById(model.nodes, 'layout') : null;
  // The page may import its layout under any local name (e.g. `import Layout
  // from '../layouts/BaseLayout.astro'`) — resolve the wrapper back to a
  // scanned layout file name for display, pickers, and schema lookup.
  const currentLayoutName = (() => {
    // Markdown names its layout by path in frontmatter rather than wrapping
    // the page in a node, so the picker reads it from there.
    if (isMarkdownFormatRef.current) {
      // Read back out of the frontmatter text, not a cached field: editing
      // that text by hand has to move the picker too.
      const m = (model?.extraFrontmatter || '').match(/^[ \t]*layout[ \t]*:[ \t]*(.+?)[ \t]*$/m);
      const base = m?.[1].replace(/^['"]|['"]$/g, '').split('/').pop()?.replace(/\.astro$/i, '');
      return base && scan.layouts.some((l) => l.name === base) ? base : '';
    }
    if (!layoutNode) return '';
    const imp = (model.imports || []).find((i) => i.name === layoutNode.name);
    const base = imp?.path.split('/').pop()?.replace(/\.astro$/i, '');
    if (base && scan.layouts.some((l) => l.name === base)) return base;
    return layoutNode.name;
  })();
  // A component whose Props extends HTMLAttributes<"tag"> also accepts that
  // element's built-in attributes — merge them in after its own props.
  const schemaFor = (entry) => {
    if (!entry) return [];
    const own = entry.schema || [];
    const ownNames = new Set(own.map((f) => f.name));
    const inherited = entry.extendsTag
      ? getElementSchema(entry.extendsTag).filter((f) => !ownNames.has(f.name))
      : [];
    // A component that spreads `...rest` passes class straight through to
    // whatever it renders, so styling one is a normal thing to want — give it
    // the same class field an element has rather than making the user add it
    // by hand in Attributes.
    const passesClass =
      entry.hasRest &&
      !own.some((f) => /^class(Name|es)?$/i.test(f.name)) &&
      !inherited.some((f) => f.name === 'class');
    return [
      ...own,
      ...(passesClass ? [{ name: 'class', type: 'string', optional: true }] : []),
      ...inherited,
    ];
  };
  // Every element takes a class, and it's the field people reach for most —
  // but it lives in the global attributes, not in any tag's own schema, so it
  // only appeared once something had already set one. Given first place, right
  // under the tag, on anything that renders an element.
  const withClassField = (fields) =>
    fields.some((f) => f.name === 'class')
      ? fields
      : [{ name: 'class', type: 'string', optional: true }, ...fields];

  const selectedSchema =
    selectedNode && selectedNode.kind !== 'text'
      ? selectedId === 'layout'
        ? schemaFor(scan.layouts.find((l) => l.name === currentLayoutName))
        : selectedNode.kind === 'element'
          ? withClassField(getElementSchema(selectedNode.name))
          : selectedNode.dynamicTag
            ? // `<Tag>` from `const Tag = tag` renders a real element, so it
              // takes a class the same way one does.
              withClassField([])
          : schemaFor(
              selectedNode.astroAsset
                ? astroAssetDef(selectedNode.name)
                : insertables.find((c) => c.name === selectedNode.name)
            )
      : [];

  // Slots offered by the selected node's parent (the component or layout the
  // node is slotted into) — turns the `slot` attribute into a dropdown.
  let slotOptions = null;
  if (model && selectedNode && selectedId !== 'layout') {
    const parent = findParentNode(model.nodes, selectedId);
    if (parent) {
      if (parent.id === 'layout') {
        slotOptions = scan.layouts.find((l) => l.name === currentLayoutName)?.slots || null;
      } else if (parent.kind === 'component') {
        slotOptions = insertables.find((c) => c.name === parent.name)?.slots || null;
      }
    }
  }

  // In-scope data at the selection: the file's frontmatter declarations and
  // imports, plus the item/index variables of every enclosing loop. Feeds the
  // loop editor's source list and the content editor's expression chips.
  const loopContext =
    model && selectedNode
      ? {
          frontmatter: model.extraFrontmatter || '',
          imports: model.imports || [],
          ancestorHeads: (ancestorChain(model.nodes, selectedId) || [])
            .slice(0, -1)
            .filter((n) => n.kind === 'map')
            .map((n) => n.head),
        }
      : null;

  // What the instance being edited is given.
  //
  // A component opened from the canvas is being looked at in one place, with
  // one set of props — and the panel knew them only by name and type, so a
  // field showing `{heading}` could not say what heading was. The instance
  // says: it is in the file this one was opened from, at the focused path, and
  // the page's own scope is what its expressions come to.
  const [instanceProps, setInstanceProps] = useState(null);
  const focusOf = currentPage?.kind === 'component' ? currentPage.focusPath : null;
  const hostFile = editStack.length > 1 ? editStack[0] : null;
  useEffect(() => {
    if (!focusOf || !hostFile?.path) { setInstanceProps(null); return undefined }
    let dropped = false;
    void (async () => {
      try {
        const read = await window.avb.readPage(hostFile.path);
        const hostModel = read?.model;
        if (dropped || !hostModel) return;
        const trail = String(focusOf).split('|').pop().split('.').map(Number);
        const instance = nodeAtPath(hostModel.nodes, trail);
        if (!instance) { setInstanceProps(null); return }
        // The scope at the instance: the file's frontmatter, and the loops
        // around it — `project` inside `projects.map(…)` is what its props are
        // written against.
        const chain = ancestorChain(hostModel.nodes, instance.id) || [];
        setInstanceProps(
          resolveInstanceProps(instance, {
            frontmatter: hostModel.extraFrontmatter || '',
            imports: hostModel.imports || [],
            ancestorHeads: chain.slice(0, -1).filter((n) => n.kind === 'map').map((n) => n.head),
            collectionSamples,
            collections,
          })
        );
      } catch {
        if (!dropped) setInstanceProps(null);
      }
    })();
    return () => { dropped = true };
  }, [focusOf, hostFile?.path, collectionSamples, collections]);

  // Link settings (href fields): pages to link to and the ids on this page
  // that anchor links can target.
  const sectionIds = [];
  if (model) {
    const walkIds = (list) =>
      list.forEach((n) => {
        const idv = n.props?.id;
        if (idv && idv.type === 'string' && idv.value) sectionIds.push(idv.value);
        if (Array.isArray(n.children)) walkIds(n.children);
      });
    walkIds(model.nodes);
  }
  const linkContext = { pages: scan.pages, sectionIds };

  // A class the source can't resolve — `class:list={["button_wrap", …]}` —
  // leaves a node named after its tag, or after a variable in the case of a
  // dynamic `<Tag>`. The page reports what each node rendered with, so the
  // breadcrumb and the canvas chip can say the same thing the navigator does.
  const liveLabel = (n, fromSource) => {
    if (fromSource && fromSource !== n.name) return fromSource;
    const live = liveClassesById?.get(n.id);
    return live?.length ? live[0] : fromSource;
  };

  // What the Tag field offers: every HTML tag, the project's components,
  // Astro's own, and anything this page's frontmatter already imports — which
  // is how `<AstroLogo />` from an imported .svg becomes reachable.
  // Each option carries what it is, so the list can wear the same icons the
  // insert palette does — a tag, a component, a layout, one of Astro's.
  const tagOptions = React.useMemo(() => {
    const out = [];
    const seen = new Set();
    const add = (name, kind) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push({ name, kind });
    };
    for (const t of HTML_TAGS) add(t, 'element');
    for (const c of insertables) add(c.name, c.isLayout ? 'layout' : 'component');
    for (const a of ASTRO_ASSETS) add(a.name, 'astroAsset');
    for (const i of model?.imports || []) add(i.name, 'component');
    return out;
  }, [insertables, model]);

  // Breadcrumb trail for the canvas toolbar: page → ancestors → selection.
  const crumbLabel = (n) => {
    if (n.id === 'layout') return currentLayoutName || n.name;
    switch (n.kind) {
      case 'text':
        return 'text';
      case 'comment':
        return 'comment';
      case 'expr':
        return 'code';
      case 'map': {
        const at = n.head.indexOf('.map');
        return at > 0 ? n.head.slice(0, at + 4) : 'loop';
      }
      case 'cond':
        return `if ${n.test}`;
      case 'branch':
        return n.name === 'else' ? 'else' : 'then';
      case 'element':
      case 'raw':
        // First class wins; fall back to the bare tag when the element has
        // none. Reads `class:list` too, so a component's inner elements are
        // named the same way the navigator names them.
        return liveLabel(n, elementLabel(n));
      default:
        // `<Tag>` from `const Tag = tag` renders a real element and its name
        // is a variable, so the class it rendered with names it better.
        if (n.dynamicTag) return liveLabel(n, elementLabel(n));
        return n.name;
    }
  };
  // Floating code window target value: page frontmatter, a raw node's inner
  // content, or a text file from public/ (loaded into fileText).
  const isFileWin = codeWin?.kind === 'file';
  const codeWinNode =
    codeWin && !isFileWin && codeWin.targetId !== 'frontmatter' && model
      ? findNodeById(model.nodes, codeWin.targetId)
      : null;
  const codeWinValue = !codeWin
    ? null
    : isFileWin
      ? fileText
      : codeWin.targetId === 'frontmatter'
        ? model
          ? frontmatterCode
          : null
        : codeWinNode?.inner ?? null;

  // Returns whether the selection actually has a code editor, so the Enter
  // shortcut below knows whether it handled the key.
  const openCodeWindow = () => {
    if (!selectedNode) return false;
    if (selectedNode.kind === 'frontmatter') {
      setCodeWin({ targetId: 'frontmatter', title: 'Frontmatter', language: 'javascript' });
      return true;
    }
    if (selectedNode.kind === 'raw') {
      setCodeWin({
        targetId: selectedNode.id,
        title: `<${selectedNode.name}>`,
        language: selectedNode.name === 'style' ? 'css' : 'javascript',
      });
      return true;
    }
    return false;
  };
  // Read by the keydown effect, which is set up long before this exists.
  openCodeWindowRef.current = openCodeWindow;

  // Opens a public/ text file in the floating editor.
  const openAssetFile = useCallback(
    async ({ rel, name }) => {
      try {
        const { text } = await window.avb.readAssetText({ projectPath: project.path, rel });
        setFileText(text);
        setCodeWin({
          kind: 'file',
          rel,
          title: name,
          language: /\.css$/i.test(name) ? 'css' : 'javascript',
        });
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, showToast]
  );

  // Opens the file an imported symbol is defined in, on its declaration —
  // `{FOOTER_LINKS}` on the page, the array itself in src/consts.ts. Values
  // declared in this file's own frontmatter never come here: those are edited
  // in place, in the panel (see the props panel's source popup).
  const openSymbolFile = useCallback(
    async (name) => {
      if (!project) return false;
      const imp = findImportOf(frontmatterCode, name);
      if (!imp) return false;
      const stack = editStackRef.current;
      const fromFile = stack[stack.length - 1]?.path || currentPage?.path;
      if (!fromFile) return false;
      try {
        const r = await window.avb.readSymbolSource({
          projectPath: project.path,
          fromFile,
          spec: imp.spec,
          name,
        });
        if (!r?.ok) {
          showToast(
            r?.reason === 'too-large'
              ? 'That file is too large to edit in the app.'
              : `Couldn't find where ${name} is defined (${imp.spec}).`,
            'error'
          );
          return false;
        }
        setFileText(r.text);
        setCodeWin({
          kind: 'file',
          area: 'src',
          rel: r.rel,
          title: r.rel,
          language: /\.css$/i.test(r.rel) ? 'css' : 'javascript',
          revealLine: r.line,
        });
        return true;
      } catch (err) {
        showToast(cleanError(err), 'error');
        return false;
      }
    },
    [project, frontmatterCode, currentPage, showToast]
  );

  // File edits stream to disk (debounced) — the dev server picks them up.
  const fileSaveTimer = useRef(null);
  const setAssetFileText = useCallback(
    (text) => {
      setFileText(text);
      if (!codeWin || codeWin.kind !== 'file') return;
      const { rel, area } = codeWin;
      // Source files live anywhere in the project; assets are rooted in public/.
      const write = area === 'src' ? window.avb.writeSourceText : window.avb.writeAssetText;
      clearTimeout(fileSaveTimer.current);
      fileSaveTimer.current = setTimeout(() => {
        write({ projectPath: project.path, rel, text }).catch((err) =>
          showToast(`Save failed: ${cleanError(err)}`, 'error')
        );
      }, 300);
    },
    [codeWin, project, showToast]
  );

  // Close the window if its target disappears (page switch, node deleted).
  useEffect(() => {
    if (codeWin && !isFileWin && codeWinValue === null) setCodeWin(null);
  }, [codeWin, isFileWin, codeWinValue]);

  const editedRel =
    editStack.length > 1 && project?.path
      ? editStack[editStack.length - 1].path.replace(project.path + '/', '')
      : null;

  // The reported classes, keyed by node id — same walk as the render report,
  // so a path only has to be resolved once.
  const liveClassesById = React.useMemo(
    () =>
      nodeClasses && model
        ? classesByNodeId(nodeClasses, model.nodes, editedRel ? `${editedRel}|` : '')
        : null,
    [nodeClasses, model, editedRel]
  );

  // The file being edited, relative to src/ — how the CMS addresses a page's
  // own data (`pages/index.astro#rotatingWords`).
  const openFileSrcRel = (() => {
    const p = editStack[editStack.length - 1]?.path || currentPage?.path;
    if (!p || !project?.path) return null;
    const rel = p.startsWith(project.path + '/') ? p.slice(project.path.length + 1) : p;
    return rel.startsWith('src/') ? rel.slice(4) : rel;
  })();

  // A marker path may arrive namespaced (src/…/Card.astro|0.1). The index trail
  // after the pipe is what addresses a node in the open file's tree.
  const trailOf = (p) => String(p).split('|').pop().split('.').map(Number);
  // An edit renumbers paths, so a report from before it describes nodes that
  // have since moved. Drop it and show nothing until the page has re-rendered
  // and said so again — a marker on the wrong row is worse than none.
  useEffect(() => {
    setRenderedPaths(null);
    setNodeStates(null);
    setNodeClasses(null);
  }, [model]);

  // What the spacing box is pointing at, drawn over the selected element on the
  // canvas — see spacingBands.js.
  const [spacingHover, setSpacingHover] = useState(null);

  // The trail to any node in the open file. Taken as a function rather than
  // built for the selection alone because a comment is left on whatever was
  // clicked, which is not necessarily what is selected — and its breadcrumbs
  // have to be made the same way, or the review would record a description of
  // its target that Stacki itself would not recognise later.
  const crumbsFor = (id) => {
    const out = [];
    if (currentPage) out.push({ id: null, label: currentPage.name.replace(/\.(astro|md)$/i, '') });
    if (model && id === 'frontmatter') {
      out.push({ id: 'frontmatter', label: 'Frontmatter' });
    } else if (model && id) {
      const chain = ancestorChain(model.nodes, id) || [];
      // A then has no row in the navigator, so the trail doesn't name it either —
      // "if command › then › hero-command" said "then" to no one (see
      // branches.js).
      out.push(
        ...chain
          .filter((n, i) => n !== thenBranch(chain[i - 1]))
          .map((n) => ({ id: n.id, label: crumbLabel(n) }))
      );
    }
    return out;
  };
  const crumbs = crumbsFor(selectedId);

  // Canvas outlines: nodes are addressed by their index path in the tree
  // (matching the marker paths the dev server's plugin injects).
  // While a component is open the tree is that component's file, not the
  // page, so ask in that file's namespace — the plugin marks every .astro
  // under src with one. The canvas still shows the page, where those markers
  // appear once per instance, so every instance outlines.
  // Which nodes put nothing on the page, as ids. A node counts as rendering if
  // it rendered something itself OR anything under it did: a layout wraps
  // <html>, so its own markers are split across <head> and <body> and never
  // pair up, but its children measure fine — without the ancestor closure it
  // would read as empty. Everything left over really did produce nothing,
  // including nodes inside a component that never evaluated its slot, whose
  // markers were never emitted at all.
  const emptyNodeIds = React.useMemo(() => {
    if (!renderedPaths || !model) return null;
    const prefix = editedRel ? `${editedRel}|` : '';
    const live = new Set();
    for (const p of renderedPaths) {
      const local = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
      const parts = local.split('.');
      for (let i = parts.length; i > 0; i--) live.add(parts.slice(0, i).join('.'));
    }
    // Only kinds where "renders nothing" is a fact about the page. A comment,
    // the frontmatter row or a doctype line never renders and saying so on
    // every one of them would be noise.
    const MARKABLE = new Set(['element', 'component', 'map']);
    // …and neither <Fragment> nor <slot> ever puts an element on the page, so
    // there is nothing for the page to report about them and nothing to carry
    // their path. What they hold answers for them: children of either are
    // marked, and a live child makes its ancestors live. `<Fragment set:html>`
    // has no children to speak up, which is exactly the case where the panel
    // cannot tell — and saying "renders nothing" is the wrong half to guess.
    const answers = (n) => MARKABLE.has(n.kind) && rendersOwnElement(n);
    const ids = new Set();
    // An inline run — words with <a>, <strong>, <span> among them — is written
    // as one line, and markers inside it would render as spaces, so nothing in
    // there carries one. The page therefore says nothing about those nodes,
    // which is not the same as saying they rendered nothing: `unmarked` keeps
    // a link sitting in a sentence from being reported as invisible.
    const walk = (list, trail, unmarked) => {
      list.forEach((n, i) => {
        const t = [...trail, i];
        if (!unmarked && answers(n) && !live.has(t.join('.'))) ids.add(n.id);
        if (Array.isArray(n.children)) walk(n.children, t, unmarked || isInlineRun(n.children));
      });
    };
    walk(model.nodes, [], false);
    return ids;
  }, [renderedPaths, model, editedRel]);

  // The reported paths as node ids, so the navigator can mark rows without
  // knowing anything about index paths.
  const stateIds = React.useMemo(() => {
    const empty = { hidden: new Set(), inert: new Set() };
    if (!nodeStates || !model) return empty;
    const prefix = editedRel ? `${editedRel}|` : '';
    const local = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
    const byPath = new Map();
    const walk = (list, trail) => {
      list.forEach((n, i) => {
        const t = [...trail, i];
        byPath.set(t.join('.'), n.id);
        if (Array.isArray(n.children)) walk(n.children, t);
      });
    };
    walk(model.nodes, []);
    const ids = (paths) => {
      const set = new Set();
      for (const p of paths || []) {
        const id = byPath.get(local(p));
        if (id) set.add(id);
      }
      return set;
    };
    return { hidden: ids(nodeStates.hidden), inert: ids(nodeStates.inert) };
  }, [nodeStates, model, editedRel]);

  const pathFor = (id) => {
    if (!model || !id) return null;
    const trail = pathOfNode(model.nodes, id);
    if (!trail) return null;
    const path = trail.join('.');
    return editedRel ? `${editedRel}|${path}` : path;
  };
  // The right panel stays on whichever tab the user picked, whatever gets
  // selected next. (S / D switch it by hand.)

  // What ⇧⌘C copies: the route an editor would take to reach the selection —
  // the page, the instance of each component drilled into on the way down,
  // then the node itself — so an agent reading it lands on the markup the user
  // is looking at, not on some other use of the same component. With nothing
  // selected the open file alone still says where the user is.
  //
  // Deliberately "<file>#<index path>" rather than a marker path: a marker is
  // namespaced only when it names a component, and every entry here needs to
  // say which file it belongs to. The file is the one open at that level of the
  // stack, so it's read from the stack rather than parsed out of the key.
  // Through a ref because the menu handler is bound long before this is in scope.
  const relOf = (abs) =>
    abs && project?.path ? abs.replace(project.path + '/', '') : null;
  const openRel = relOf(currentPage?.path);
  // The doors on the way down: one key per component drilled into, in the file
  // above it. The same for every node in the open file, so it is worked out
  // once and the leaf is added per node.
  const hostKeys = !openRel
    ? []
    : editStack
        .slice(1)
        .map((entry, i) => {
          const host = relOf(editStack[i].path);
          return entry.hostKey && host ? `${host}#${trailOf(entry.hostKey).join('.')}` : null;
        })
        .filter(Boolean);
  // Taken as a function of a node rather than of the selection, because Visual
  // Review anchors a comment to what was CLICKED, and the one thing that must
  // not happen is a review inventing its own idea of where a node is. Same
  // keys, same builder, whether they end up on the clipboard, in an MCP
  // snapshot or in a review anchor.
  // The sibling run at every level down to a node — the evidence that lets a
  // review tell its own slot apart from the neighbour that inherits the index
  // when something is inserted above it. Same trail keysFor walks, so the two
  // can never describe different nodes.
  const peersFor = (id) => {
    if (!model || !id || id === 'frontmatter') return null;
    const trail = pathOfNode(model.nodes, id);
    return trail ? peerPath(model.nodes, trail) : null;
  };
  const keysFor = (id) => {
    if (!openRel) return [];
    if (id === 'frontmatter') return [...hostKeys, `${openRel}#frontmatter`];
    const trail = model && id ? pathOfNode(model.nodes, id) : null;
    return [...hostKeys, trail ? `${openRel}#${trail.join('.')}` : `${openRel}#`];
  };
  selectionKeysRef.current = keysFor(selectedId);

  // Position the Style/Settings highlight: on tab change, when the panel first
  // appears, and whenever the tab strip's width changes.
  useLayoutEffect(() => {
    const measure = () => {
      const el = rightTabRefs.current[rightTab];
      setRightTabInd(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    const strip = rightTabRefs.current[rightTab]?.parentElement;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [rightTab, pageState?.editable]);

  const overlayInfo = (p) => {
    if (!model || !p) return null;
    const n = nodeAtPath(model.nodes, trailOf(p));
    if (!n) return null;
    const label = n.id === 'layout' ? currentLayoutName || n.name : crumbLabel(n);
    // A dynamic tag renders an element, so it shouldn't wear the component
    // colour on the canvas either.
    const kind =
      n.kind === 'component' && !n.dynamicTag
        ? 'component'
        : n.kind === 'map' || n.kind === 'cond' || n.kind === 'branch'
          ? 'map'
          : 'element';
    // The tag drives the overlay's icon, so it matches the Navigator row.
    const tag = n.kind === 'element' || n.kind === 'raw' ? n.name : null;
    return {
      label,
      kind,
      tag,
      astroAsset: !!n.astroAsset,
      dynamicTag: !!n.dynamicTag,
      nodeKind: n.kind,
      isLayout: n.id === 'layout',
      bound: kind === 'element' && isDataBound(n),
    };
  };

  // ----------------------------------------------------------------
  // MCP — what an agent can see
  //
  // Stacki's answer to "what is Marcell pointing at". The snapshot is built
  // from what the app already knows and pushed whenever it changes; the two
  // things only the live page can answer — an element's computed style, and
  // the geometry a screenshot is cropped from — are asked for when a tool is
  // actually called, because both cost a round trip to the canvas.
  //
  // Assembled during render into a ref rather than in an effect with a
  // dependency list: it is a function of a dozen pieces of state, several of
  // them derived a few lines above this, and a list that forgot one of them
  // would go stale in exactly the way that is hardest to notice.
  // ----------------------------------------------------------------
  const mcpPayloadRef = useRef(null);
  mcpPayloadRef.current = buildMcpPayload({
    project,
    // Which branch this is being said about. Carried on the payload rather
    // than fetched where it is needed, so a review records the branch that was
    // checked out at the moment it describes.
    branch: gitInfo?.branch || null,
    peers: peersFor(selectedId),
    currentPage,
    // A dynamic route is a pattern; the canvas is showing one entry of it.
    pageRoute: dynamicPaths[dynamicIndex]?.route || (editStack[0] || currentPage)?.route || null,
    editStack,
    selectedId,
    selectedNode,
    selectionKeys: selectionKeysRef.current,
    crumbs,
    selectedClasses,
    hidden: stateIds.hidden.has(selectedId),
    inert: stateIds.inert.has(selectedId),
    devStatus,
    canvas: canvasReport,
  });
  // Every render, deduped on what was last sent — the alternative is an IPC
  // call per keystroke.
  const mcpSentRef = useRef(null);
  useEffect(() => {
    const key = JSON.stringify(mcpPayloadRef.current);
    if (key === mcpSentRef.current) return;
    mcpSentRef.current = key;
    void window.avb.mcpPublish(mcpPayloadRef.current);
  });

  // Answered by the Visual Review section below; declared here because the
  // handler that reads it is registered above it.
  const focusReviewRef = useRef(null);
  // Same for the Agent API's commands, which are built at the end of the
  // component out of everything above them.
  const agentRunRef = useRef(null);

  // The path the canvas knows the selection by, for the computed-style query.
  const mcpSelPathRef = useRef(null);
  mcpSelPathRef.current = pathFor(selectedId);

  useEffect(() => {
    const answer = async ({ kind, params }) => {
      if (kind === 'styles') {
        const path = mcpSelPathRef.current;
        if (!path) return { computed: null };
        // The engine's own property list, which only a document can enumerate;
        // the main process names the essential ones and this adds the rest.
        const props =
          params?.detail === 'full'
            ? [...new Set([...(params.properties || []), ...Array.from(getComputedStyle(document.documentElement))])]
            : params?.properties || [];
        if (!props.length) return { computed: null };
        const reply = await queryCanvas(path, [], [], props);
        return { computed: reply?.computedProps || null };
      }
      if (kind === 'capture:begin') return beginCapture(params);
      if (kind === 'capture:end') return endCapture();
      // An agent asking Stacki to go and look at one of the user's comments.
      // Through a ref because this handler is bound once, long before the
      // navigation it calls is in scope.
      if (kind === 'review:focus') return focusReviewRef.current?.(params) ?? null;
      // And the Agent API's editor commands. One door, a fixed set of named
      // commands behind it, every one of them carried out through what the
      // panels already call — see src/agent/commands.js.
      if (kind === 'agent') return agentRunRef.current?.(params) ?? null;
      return null;
    };
    return window.avb.onMcpAsk(async (ask) => {
      let value = null;
      try {
        value = await answer(ask || {});
      } catch {
        value = null; // a question that cannot be answered is answered with nothing
      }
      void window.avb.mcpReply({ id: ask?.id, value });
    });
  }, []);


  // ----------------------------------------------------------------
  // Visual Review — the comments left on the rendered page
  //
  // A comment is a review thread: a message, a workflow status, and an anchor
  // to a source-backed node at a particular breakpoint. The ledger itself
  // lives in the main process (electron/review), because it is persistent
  // state and React is not a database. What lives here is everything that
  // needs the live app: which node a review resolves to right now, where its
  // pin sits, and — the operation the whole feature stands on — putting the
  // editor back the way it was so somebody, or something, can look at it.
  //
  // Two rules run through all of it:
  //
  //   A review's identity is the app's identity. Its anchor is built from the
  //   same payload the MCP snapshot is built from, its keys come from the same
  //   keysFor() ⇧⌘C uses, its breadcrumbs from the same crumbLabel the
  //   navigator draws with. There is no second idea of where a node is.
  //
  //   Nothing here guesses. When the anchor cannot be resolved the review says
  //   orphaned and points at nothing, and focus reports what it could not
  //   restore. A comment attached to the wrong element is worse than one
  //   attached to none, because nobody ever notices it.
  // ----------------------------------------------------------------

  const [reviewFilter, setReviewFilter] = useState('open');
  const [reviewScope, setReviewScope] = useState('project');
  const [allReviews, setAllReviews] = useState([]);
  // Read through a ref by openReview, which must not be rebuilt every time a
  // review changes — it is handed to the preview pane, and a new identity on
  // every keystroke in a thread would re-render the canvas with it.
  const allReviewsRef = useRef(allReviews);
  allReviewsRef.current = allReviews;
  const [reviewProblem, setReviewProblem] = useState(null);
  // SELECTION and PRESENTATION are two different things, and conflating them
  // is what made the old model unpredictable.
  //
  // `reviewSelectedId` is which review is the current one. It survives closing
  // the Inspector: coming back to the index leaves the row marked, the pin
  // marked, and a resolved review's normally-hidden marker still on the page —
  // because you are still looking at that review, you have just stopped
  // reading it. Deselecting is a separate, deliberate act.
  //
  // `reviewPresentation` is where it is being shown. Only two values, and
  // nothing about the content decides between them: 'index' is the list,
  // 'inspector' is the reader. Which one you get depends on what you clicked,
  // never on how long the conversation is.
  const [reviewSelectedId, setReviewSelectedId] = useState(null);
  const [reviewPresentation, setReviewPresentation] = useState('index');
  // What a pin is showing on hover or focus, and which cluster is asking.
  const [reviewPeek, setReviewPeek] = useState(null);
  const [reviewCluster, setReviewCluster] = useState(null);
  // One unsent reply per review, for this session only. Never written to the
  // project, never synced, never visible to an agent — it is UI state about
  // something somebody has not said yet.
  const [reviewDrafts, setReviewDrafts] = useState({});
  // How wide the reader should be, if there is room for it. A local preference:
  // it is about this person's screen, not about the project.
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    try {
      return clampInspector(Number(localStorage.getItem('stacki.inspectorWidth')) || INSPECTOR_DEFAULT);
    } catch {
      return INSPECTOR_DEFAULT;
    }
  });
  const [viewportW, setViewportW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const saveInspectorWidth = useCallback((w) => {
    const next = clampInspector(w);
    setInspectorWidth(next);
    try {
      localStorage.setItem('stacki.inspectorWidth', String(next));
    } catch {
      /* a preference that cannot be stored still applies for this session */
    }
  }, []);
  const [reviewBusyId, setReviewBusyId] = useState(null);
  const [reviewTick, setReviewTick] = useState(0);
  // Whether these comments are shared, with whom, and how the last catch-up
  // went. It rides along on every list read rather than being fetched
  // separately, so the panel and the reviews can never describe different
  // moments.
  const [reviewShared, setReviewShared] = useState(null);
  const [reviewSyncing, setReviewSyncing] = useState(false);
  const [pinsVisible, setPinsVisible] = useState(true);
  const [pinsHidden, setPinsHidden] = useState(0);
  // Which copy of a repeated node the canvas should light up. Sent as a
  // request with a tick rather than as a value, because asking for the same
  // copy a second time is a real ask (see PreviewPane).
  const [occRequest, setOccRequest] = useState(null);
  const [commentMode, commentDispatch] = useReducer(reviewModeReducer, initialReviewMode);
  const [draftBody, setDraftBody] = useState('');

  // The page the CANVAS is on, which is what a review is anchored to — drilling
  // into a component does not change which page is on screen.
  const reviewPageFile = relOf((editStack[0] || currentPage)?.path);
  const reviewPageRoute =
    dynamicPaths[dynamicIndex]?.route || (editStack[0] || currentPage)?.route || null;

  // Everything, once. The filters below are a view of it, so switching from
  // Open to All is instant and costs no round trip — and the pins, which are
  // not the panel's filter, read from the same list rather than fetching a
  // second one.
  useEffect(() => {
    if (!project) {
      setAllReviews([]);
      setReviewProblem(null);
      setReviewShared(null);
      return;
    }
    let alive = true;
    void (async () => {
      const result = await window.avb.reviewsList({ status: 'all', scope: 'project', detail: 'full', limit: 200 });
      if (!alive) return;
      setAllReviews(result?.reviews || []);
      setReviewProblem(result?.problem || null);
      setReviewShared(result?.shared || null);
    })();
    return () => {
      alive = false;
    };
  }, [project, reviewTick]);

  // The ledger changed — by this window, or by an agent through MCP. Both
  // arrive here, so a comment an agent resolves goes grey in the panel while
  // somebody is watching it.
  useEffect(() => window.avb.onReviewsChanged(() => setReviewTick((n) => n + 1)), []);

  const reviewById = useCallback((id) => allReviews.find((r) => r.id === id) || null, [allReviews]);

  // Where each review's node is in the file that is open right now.
  //
  // Only for reviews whose leaf key is in THIS file: a review on a component's
  // innards cannot be resolved from the page, and claiming either way about a
  // tree nobody has read would be a guess. Recomputed when the model changes,
  // which is what an edit, a reload or a drill-down already does — no polling,
  // no watcher, nothing on a timer.
  const reviewNodes = useMemo(() => {
    const out = new Map();
    if (!model || !openRel) return out;
    for (const r of allReviews) {
      const steps = anchorSteps(r.anchor);
      const leaf = steps[steps.length - 1];
      if (!leaf || leaf.file !== openRel) continue;
      out.set(r.id, resolveNode(model.nodes, leaf.indexPath, r.anchor?.fingerprint, { labelOf: crumbLabel }));
    }
    return out;
    // crumbLabel is rebuilt every render and is a pure function of the model
    // and the layout name, both of which are already here.
  }, [allReviews, model, openRel, currentLayoutName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the ledger what this file could and could not find. Only the changes,
  // and only where the answer is actually known — the store ignores a repeat,
  // so this settles after one pass instead of looping on its own notification.
  const anchorSyncRef = useRef('');
  useEffect(() => {
    if (!project || !model || !openRel || !allReviews.length) return;
    // Only when the tree in hand is the tree of the file being named. During a
    // navigation those disagree for a render, and judging an anchor then means
    // looking for a component's node in the page's document and concluding it
    // is gone — which orphaned perfectly good comments every time somebody
    // moved around.
    if (!modelOf(openRel)) return;
    const updates = [];
    for (const r of allReviews) {
      const health = checkAnchor(r.anchor, { file: openRel, nodes: model.nodes, labelOf: crumbLabel });
      if (health.state === 'unknown') continue;
      // A node that moved is still the same node; writing its new position back
      // is what keeps the anchor cheap and its reported file:line true.
      const moved = health.keys && health.keys.join() !== (r.anchor?.keys || []).join();
      if (health.state === r.anchorState && !moved) continue;
      updates.push({ id: r.id, anchorState: health.state, ...(moved ? { keys: health.keys } : {}) });
    }
    const key = JSON.stringify(updates);
    if (!updates.length || key === anchorSyncRef.current) return;
    anchorSyncRef.current = key;
    void window.avb.reviewsSyncAnchors(updates);
  }, [project, model, openRel, allReviews]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether a review belongs to the page the canvas is showing.
  const onReviewPage = (r) =>
    (reviewPageRoute && r.anchor?.page?.route === reviewPageRoute) ||
    (reviewPageFile && r.anchor?.page?.file === reviewPageFile);

  // What PreviewPane draws. One entry per review that belongs to the open file,
  // including the ones with nowhere to point — the panel says how many, and a
  // pin count that quietly disagrees with a list count reads as a bug.
  //
  // Every review on the PAGE gets a pin, not only the ones in the file that
  // happens to be open. The canvas renders the whole page — components and
  // all — and marks each file's nodes in its own namespace, so a comment left
  // three components deep is still addressable from here. Marking only what
  // the open file owns meant a pin appeared when you drilled into its
  // component and vanished again when you came out, which is the opposite of
  // what a marker on a page is for.
  //
  // Where the file IS open the resolved position is used, because that one
  // follows the node if it moved. Everywhere else the anchor's own key is the
  // best available answer: if the node has since moved the page reports no box
  // for it and it simply has no pin, which is where it was already.
  //
  // And one rule on top of all of that, which is what Shared Reviews added:
  // a marker is only drawn when the EVIDENCE for it travels. A review written
  // on another branch, or about a file this checkout does not have, gets a pin
  // only when the resolver identified its node by the marks it recorded —
  // never on a position that merely held. See src/reviewCheckout.js: a pin on
  // the wrong card is the one failure nobody ever notices.
  const withheldPins = new Set(allReviews.map((r) => r.id));
  const reviewItems = allReviews
    // `selected` is what brings a resolved review's marker back — for as long
    // as it is the one being read, and no longer. Everything else about which
    // pins are drawn is unchanged.
    .filter((r) => pinnable(r.status, reviewFilter, { selected: r.id === reviewSelectedId }) && onReviewPage(r))
    .map((r) => {
      // Where the file IS open the resolved position is used, because that one
      // follows the node if it moved. Everywhere else the anchor's own key is
      // the best available answer: if the node has since moved the page reports
      // no box for it and it simply has no pin — which is where it was already.
      const found = reviewNodes.get(r.id);
      const keys = r.anchor?.keys || [];
      // What this tree can actually say. `unverified` is the honest word for
      // "the file was never read"; the page reported a box at that key and
      // nothing has checked whether the node there is the right one.
      const confidence = found ? (found.id ? found.confidence : 'none') : 'unverified';
      const path = !mayPin(r, confidence)
        ? null
        : found
          ? found.id
            ? pathFor(found.id)
            : null
          : markerPathFor(keys[keys.length - 1], reviewPageFile);
      // A review has a marker on this render or it does not, and the thread is
      // told which — so it never says "Stacki found the same element here"
      // about a review whose page is not even open.
      if (path) withheldPins.delete(r.id);
      return {
        id: r.id,
        number: r.number ?? null,
        color: r.color || 'blue',
        path,
        occurrence: Number.isInteger(r.anchor?.occurrence) ? r.anchor.occurrence : null,
        pin: r.anchor?.pin || null,
        status: r.status,
        // Only a file that was actually read can call a review orphaned; one
        // that was not is left as whatever the ledger last recorded.
        anchorState: found && !found.id ? 'orphaned' : r.anchorState,
      };
    });

  // The reviews that have a marker on the canvas for this render. A thread
  // whose pin is right there does not also need to be spelled out inside the
  // list — the popover over the pin is already showing it.
  const pinnedReviewIds = new Set(reviewItems.map((r) => r.id));

  const reviewRows = allReviews
    .filter((r) => (reviewFilter === 'all' ? true : r.status === reviewFilter))
    .filter((r) => (reviewScope === 'page' ? onReviewPage(r) : true))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // --- doing something to one ----------------------------------------------

  /**
   * A method that is not on the bridge means this window is running against an
   * older main process. The renderer hot-reloads on save; the main process and
   * the preload do not, so during development a control can be wired to a
   * channel that does not exist yet — and a button that silently does nothing
   * is the worst possible way to find that out.
   */
  const needsRestart = () => {
    showToast('Stacki needs restarting before this will work.', 'error');
    return false;
  };

  const actOnReview = async (id, action, extra = {}) => {
    if (!window.avb.reviewsAct) return needsRestart();
    setReviewBusyId(id);
    try {
      // The same door an agent goes through, with `human` on the message. One
      // implementation of what "resolve" means, so the panel and MCP cannot
      // drift apart.
      const result = await window.avb.reviewsAct({ action, threadId: id, authorType: 'human', ...extra });
      if (!result?.ok) showToast(result?.message || 'That comment could not be changed.', 'error');
      setReviewTick((n) => n + 1);
    } catch (err) {
      // An IPC call that throws must not be a control that does nothing.
      showToast('That comment could not be changed.', 'error');
    } finally {
      setReviewBusyId(null);
    }
  };

  const recolorReview = async (id, color) => {
    const result = await window.avb.reviewsRecolor({ threadId: id, color });
    if (!result?.ok) showToast(result?.message || 'That colour could not be set.', 'error');
    setReviewTick((n) => n + 1);
  };

  // Rewording and pruning are a person tidying their own notes. Neither goes
  // through `reviewsAct` — there is no MCP action behind either of them, on
  // purpose: an agent that could rewrite the conversation is an agent whose
  // record of it means nothing.
  const editReviewMessage = async (id, messageId, message) => {
    if (!window.avb.reviewsEditMessage) return needsRestart();
    setReviewBusyId(id);
    try {
      const result = await window.avb.reviewsEditMessage({ threadId: id, messageId, message });
      if (!result?.ok) showToast(result?.message || 'That comment could not be edited.', 'error');
      setReviewTick((n) => n + 1);
    } catch (err) {
      showToast('That comment could not be edited.', 'error');
    } finally {
      setReviewBusyId(null);
    }
  };

  const deleteReviewMessage = async (id, messageId) => {
    if (!window.avb.reviewsRemoveMessage) return needsRestart();
    setReviewBusyId(id);
    try {
      const result = await window.avb.reviewsRemoveMessage({ threadId: id, messageId });
      if (!result?.ok) showToast(result?.message || 'That comment could not be deleted.', 'error');
      setReviewTick((n) => n + 1);
    } catch (err) {
      showToast('That comment could not be deleted.', 'error');
    } finally {
      setReviewBusyId(null);
    }
  };

  // --- sharing --------------------------------------------------------------
  //
  // Three moments talk to a server and no others: opening a shared project
  // (the main process does that one), pressing Sync, and coming back to the
  // window after a while. There is no poll and no socket — see
  // electron/review/sync.js for why that is a decision rather than a gap.
  const syncReviews = useCallback(
    async (reason = 'manual') => {
      if (!window.avb.reviewsSync) return needsRestart();
      setReviewSyncing(true);
      try {
        const result = await window.avb.reviewsSync({ reason });
        if (result?.shared) setReviewShared(result.shared);
        // A refusal that a person has to act on — a revoked credential, a
        // workspace that is gone — is said out loud. Everything else is
        // already in the panel's own line, where it belongs.
        if (result && result.ok === false && (result.code === 'unauthorized' || result.code === 'not_found')) {
          showToast(result.message || 'These shared comments could not be synchronised.', 'error');
        }
        setReviewTick((n) => n + 1);
        return result;
      } finally {
        setReviewSyncing(false);
      }
    },
    [showToast]
  );

  // Coming back to the window. Cheap and quiet: the main process throttles it,
  // so two visits a minute apart are one request, and a project that shares
  // nothing makes none at all.
  useEffect(() => {
    if (!project || !reviewShared?.enabled) return undefined;
    const onFocus = () => void syncReviews('focus');
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [project, reviewShared?.enabled, syncReviews]);

  const afterShareChange = (result) => {
    if (result?.shared) setReviewShared(result.shared);
    setReviewTick((n) => n + 1);
    return result;
  };

  const shareEnable = async (args) => {
    if (!window.avb.reviewsSharedEnable) return needsRestart();
    return afterShareChange(await window.avb.reviewsSharedEnable(args));
  };
  const shareJoin = async (args) => {
    if (!window.avb.reviewsSharedJoin) return needsRestart();
    return afterShareChange(await window.avb.reviewsSharedJoin(args));
  };
  const shareDisable = async () => {
    if (!window.avb.reviewsSharedDisable) return needsRestart();
    return afterShareChange(await window.avb.reviewsSharedDisable());
  };
  const shareInvite = async () => {
    if (!window.avb.reviewsSharedInvite) return needsRestart();
    return window.avb.reviewsSharedInvite({});
  };
  const renameSelf = async (displayName) => {
    if (!window.avb.reviewsSetIdentity) return needsRestart();
    const result = await window.avb.reviewsSetIdentity({ displayName });
    setReviewTick((n) => n + 1);
    return result;
  };

  const deleteReview = async (id) => {
    const result = await window.avb.reviewsRemove(id);
    if (!result?.ok) showToast(result?.message || 'That comment could not be deleted.', 'error');
    if (reviewSelectedId === id) {
      setReviewSelectedId(null);
      setReviewPresentation('index');
    }
    setReviewTick((n) => n + 1);
  };

  // --- leaving one ----------------------------------------------------------

  // A click on the canvas in comment mode. The selection, the open file and the
  // panel all stay exactly where they were: leaving a note should never cost
  // somebody the place they were working in.
  const takeCommentTarget = (hit) => {
    const node = hit?.path && model ? nodeAtPath(model.nodes, trailOf(hit.path)) : null;
    if (!node) {
      showToast(
        hit?.outside
          ? 'That belongs to another file — open it to comment on it.'
          : 'Stacki can’t name that piece of the page. Click the element itself.',
        'info'
      );
      return;
    }
    commentDispatch({
      type: 'target',
      target: {
        id: node.id,
        path: hit.path,
        occurrence: hit.occurrence,
        occurrenceCount: hit.occurrenceCount,
        pin: hit.pin,
        rect: hit.rect,
        // The composer opens where the click landed — the same coordinates the
        // pin will use once the comment exists, so the box appears on the thing
        // it is about rather than in the corner of the canvas.
        x: hit.point?.x,
        y: hit.point?.y,
        label: crumbLabel(node),
      },
    });
    setDraftBody('');
  };

  const submitComment = async () => {
    const target = commentMode.target;
    const body = draftBody.trim();
    if (!target || !body) return;
    const node = model ? findNodeById(model.nodes, target.id) : null;
    if (!node) {
      commentDispatch({ type: 'context-lost' });
      return;
    }
    // Built with the app's own payload builder, aimed at the clicked node
    // rather than the selected one. Everything after this — the keys, the
    // trail, the breadcrumbs, the clamps — is the same code path an agent's
    // `comment create` goes down, which is the whole reason a review and
    // get_context can never describe different things.
    const payload = buildMcpPayload({
      project,
      branch: gitInfo?.branch || null,
      peers: peersFor(target.id),
      currentPage,
      pageRoute: reviewPageRoute,
      editStack,
      selectedId: target.id,
      selectedNode: node,
      selectionKeys: keysFor(target.id),
      crumbs: crumbsFor(target.id),
      selectedClasses: liveClassesById?.get(target.id) || null,
      hidden: stateIds.hidden.has(target.id),
      inert: stateIds.inert.has(target.id),
      devStatus,
      canvas: {
        ...(canvasReport || {}),
        rect: target.rect || null,
        occurrence: target.occurrence ?? null,
        occurrenceCount: target.occurrenceCount ?? null,
      },
    });
    const result = await window.avb.reviewsAct({ action: 'create', message: body, pin: target.pin, payload });
    if (!result?.ok) {
      showToast(result?.message || 'That comment could not be saved.', 'error');
      return;
    }
    commentDispatch({ type: 'submitted' });
    setDraftBody('');
    setReviewTick((n) => n + 1);
    // What was just written is what you want to look at.
    openReviewRef.current?.(result.review?.id || null);
  };

  // --- going back to one ----------------------------------------------------

  /**
   * Go somewhere, and wait until the app is really there.
   *
   * `openFile` sets the current file BEFORE it reads it and the model AFTER,
   * so for one turn of the loop the app says it is showing a component while
   * still holding the page's tree. Waiting only for the filename walked
   * straight into that window: the drill was right, the file was right, and
   * the node was looked up in the wrong model — which came back as "your
   * element is gone" about an element that was plainly on screen.
   *
   * So the wait is for the file AND for a model that is not the one we left.
   */
  const goTo = async (rel, run) => {
    const left = pageStateRef.current.pageState?.model || null;
    await run();
    for (let i = 0; i < 60; i++) {
      const { currentPage: open, pageState: state } = pageStateRef.current;
      if (open && relOf(open.path) === rel && state?.model && state.model !== left) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return false;
  };

  /**
   * The tree of the file that is open right now, if it is the one expected.
   *
   * Both halves have to agree: the app naming a file is not the same as the
   * app holding that file's tree (see the stamp in openFile). A reader that
   * took the name for granted would resolve one document's positions against
   * another's.
   */
  const modelOf = (rel) => {
    const { currentPage: open, pageState: state } = pageStateRef.current;
    if (!open || relOf(open.path) !== rel) return null;
    if (!modelMatchesFile(state, open.path)) return null;
    return state.model;
  };

  // What the canvas last reported about the selection — read after a focus to
  // find out whether the copy it was asked for is on the page at all.
  const canvasReportRef = useRef(null);
  canvasReportRef.current = canvasReport;
  const settleOnOccurrence = async (want) => {
    for (let i = 0; i < 20; i++) {
      if (canvasReportRef.current?.occurrence === want) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return false;
  };

  /**
   * Put the editor back where this review was written, and say what could not
   * be put back.
   *
   * Reuses the navigation a person uses — selectPage, openComponent,
   * setSelectedId — rather than a second set of state that means the same
   * thing. Everything it reports is something it actually did.
   */
  const focusReview = async ({ threadId, anchor }) => {
    const restored = nothingRestored();
    // Filled in as the walk goes, so the ledger can be told where things
    // actually are now rather than where they were when the review was left.
    const drillTrails = [];
    let resolvedKeys = null;
    const plan = focusPlan(anchor, {
      pageFile: reviewPageFile,
      device,
      // Already inside a component: the page has to be reopened even when it is
      // the right page, because that is what the drill walks from.
      drilledIn: editStackRef.current.length > 1,
      // Whether there is a rendered page to put in front of anybody at all.
      previewReady: devStatus === 'on',
    });
    // Why a focus failed decides whether the ledger hears about it.
    //
    // "I could not identify the node" is a fact about the source and belongs on
    // the review. "The file had not finished opening" and "the app navigated
    // away underneath me" are facts about this moment — the preview starting,
    // a project still loading — and recording those as `orphaned` would let
    // merely LOOKING at a list of comments mark them all as lost. Reading must
    // not damage what it reads.
    const TRANSIENT = new Set(['not_open', 'moved_away']);
    // Filled in when the leaf resolves; 'none' until then, which is what an
    // unresolved anchor is.
    let leafConfidence = 'none';
    // What the pin rule is asked about. A review focus asks about the review;
    // an agent following a ref of its own asks about the ref, whose evidence
    // is the branch it was minted on against the branch checked out now —
    // exactly the comparison `divergent` makes, so it is made by the same
    // function rather than a second copy of the reasoning.
    const forPin = reviewById(threadId) || {
      anchorState: 'attached',
      checkout: {
        source: 'changed',
        sameBranch: !anchor?.branch || anchor.branch === (gitInfo?.branch ?? null),
        branch: gitInfo?.branch ?? null,
      },
    };
    const done = (state, reason) => ({
      anchorState: state,
      transient: state !== 'attached' && TRANSIENT.has(reason),
      restored,
      keys: state === 'attached' ? resolvedKeys : null,
      // HOW the node was identified, not merely whether it was. `positional`
      // means the slot held and nothing corroborated it — enough to look at,
      // and not enough to write through on a tree the anchor was not written
      // against. See src/reviewCheckout.js.
      confidence: leafConfidence,
      writable: state === 'attached' && mayPin(forPin, leafConfidence),
      note: focusNote({
        restored,
        anchorState: state,
        plan,
        reason,
        // What the canvas says the loop is now, so a copy that shifted under a
        // resized collection is reported rather than assumed.
        liveOccurrenceCount: canvasReportRef.current?.occurrenceCount ?? null,
      }),
    });

    // 1 — the page, first, because a component drill is an index path into it.
    if (plan.page.needed) {
      const page = (scan.pages || []).find((p) => relOf(p.path) === plan.page.file);
      if (!page) return done('orphaned', 'gone');
      if (!(await goTo(plan.page.file, () => selectPage(page)))) return done('orphaned', 'not_open');
    } else if (!modelOf(plan.page.file)) {
      return done('orphaned', 'not_open');
    }
    restored.page = true;

    // 2 — the breakpoint, before anything is measured. "Wrong on mobile" is a
    // different sentence at 375 and at 1440.
    if (plan.device.needed) setDevice(plan.device.key);
    restored.breakpoint = !plan.device.key || plan.device.restorable;

    // 3 — down through the components, each one resolved in the model that is
    // actually loaded rather than in one read from disk: a fresh parse invents
    // fresh ids, and the id has to be one this app is holding.
    for (const [i, drill] of plan.drills.entries()) {
      const host = modelOf(drill.hostFile);
      if (!host) return done('orphaned', 'not_open');
      const found = resolveNode(
        host.nodes || [],
        drill.indexPath,
        // A door is checked against the component it should open, so a review
        // does not survive its <Hero> being swapped for a <Banner>.
        { nodeKind: 'component', tag: drill.opens },
        { labelOf: crumbLabel }
      );
      if (!found.id) return done('orphaned', found.reason);
      drillTrails.push(found.trail.join('.'));
      const opened = await goTo(drill.componentFile, () =>
        openComponent(
          drill.opens,
          hostPathFor(drill.hostFile, found.trail, drill.hostIsPage),
          // Which copy of the outermost instance — the third card, not the first.
          i === 0 ? anchor?.instanceOccurrence ?? 0 : 0,
          drill.componentFile && project?.path ? `${project.path}/${drill.componentFile}` : null
        )
      );
      if (!opened) return done('orphaned', 'not_open');
    }
    restored.component = true;

    // 4 — the node itself.
    if (!plan.leaf) return done('orphaned', 'no_path');
    // Every drill above waited for the file it opened, so this is already the
    // open one — but a file that never became it is a different failure from a
    // node that is not in it, and an agent reading the note deserves to know
    // which.
    const leafModel = modelOf(plan.leaf.file);
    if (!leafModel) return done('orphaned', 'not_open');
    const leaf = resolveNode(leafModel.nodes || [], plan.leaf.indexPath, anchor?.fingerprint, {
      labelOf: crumbLabel,
    });
    if (!leaf.id) return done('orphaned', leaf.reason);
    leafConfidence = leaf.confidence;
    // The positions this walk actually used. Any of them may have moved since
    // the review was written, and the ledger takes the new ones.
    resolvedKeys = [
      ...plan.drills.map((d, i) => `${d.hostFile}#${drillTrails[i]}`),
      `${plan.leaf.file}#${leaf.trail.join('.')}`,
    ];
    setSelectedId(leaf.id);
    // The panel follows a review, so a person watching an agent work can see
    // which comment it is on. An agent following a ref of its own is not on a
    // comment, and yanking the panel there would be noise.
    if (threadId) setLeftTab('comments');
    restored.node = true;

    // 5 — and which copy of it, scrolled into view. The marker path is built
    // from the trail that was just resolved rather than from pathFor, which is
    // a render behind at this point.
    const trackPath = hostPathFor(plan.leaf.file, leaf.trail, plan.drills.length === 0);
    setOccRequest({ path: trackPath, occ: plan.occurrence ?? 0, tick: Date.now() });
    // The canvas answers with the copy it actually used. A node can report one
    // box for several places, and a copy that is no longer on the page must
    // not come back as restored — an agent that believed it would photograph
    // the first card and call it the third.
    // With no preview there is no box, nothing to scroll to and nothing to
    // photograph — so the copy was not restored however the arithmetic looks.
    restored.occurrence = !plan.previewReady
      ? false
      : plan.occurrence == null
        ? true
        : await settleOnOccurrence(plan.occurrence);

    // And confirm it stuck. Opening a project ends with the app's own
    // navigation — loadProject picks a page after the scan comes back — so a
    // focus that lands while that is still in flight can be quietly undone a
    // moment later. Reporting "restored" about a selection that has since been
    // replaced is exactly the silent lie this whole operation is written to
    // avoid, so it is checked rather than assumed.
    await new Promise((done_) => setTimeout(done_, 200));
    if (!modelOf(plan.leaf.file) || selectedIdRef.current !== leaf.id) {
      restored.node = false;
      restored.occurrence = false;
      return done('orphaned', 'moved_away');
    }

    if (threadId) setReviewSelectedId(threadId);
    return done('attached', null);
  };
  focusReviewRef.current = focusReview;

  // ----------------------------------------------------------------
  // The Agent API's window
  //
  // Everything an agent's editor commands need, as functions of the state
  // this render is holding. Not one line of it is a new way to change the
  // document: `commit` is mutateModel, `select` is setSelectedId, `undo` is
  // undo. What it adds is the ability to say all of it in one round trip, and
  // to answer for what happened afterwards.
  //
  // Assembled during render into a ref, for the same reason the MCP payload
  // is: it reads two dozen pieces of state, and a dependency list that forgot
  // one of them would go stale exactly where it is hardest to notice.
  // ----------------------------------------------------------------
  const agentAppRef = useRef(null);
  agentAppRef.current = {
    project: () => project,
    page: () => ({ file: reviewPageFile, route: reviewPageRoute }),
    openFile: () => openRel,
    model: () => model,
    editable: () => !!pageState?.editable && !inPreview && !previewRef,
    selectedId: () => selectedId,
    revision: () => docRevRef.current,
    // A hash of the tree, so two edits that arrive at the same revision number
    // (an undo walking back to where it started) are still told apart.
    digest: () => digestOfModel(pageState?.editable ? model : pageState?.source),
    crumbLabel,
    // The navigator's own trail for any node, not just the selection. A ref
    // minted for a child records this, and src/reviewAnchor.js reads it back —
    // two spellings of the same trail would be two nodes as far as it is
    // concerned.
    crumbsFor: (id) => crumbsFor(id).map((c) => c.label).filter(Boolean),
    pathFor,
    keysFor,
    peersFor,
    canvas: () => canvasReport,
    renderedClasses: () => selectedClasses,
    componentChain: () => editStack.map((e) => e?.name).filter(Boolean),
    breadcrumbs: (id) => (id === selectedId ? crumbs.map((c) => c?.label).filter(Boolean) : null),
    isHidden: (id) => stateIds.hidden.has(id),
    isInert: (id) => stateIds.inert.has(id),
    insertables: () => insertables,
    preview: () => ({ status: devStatus, url: devUrl || null, device, inPreview }),
    historyDepth: () => ({ past: historyRef.current.past.length, future: historyRef.current.future.length }),
    undo,
    redo,
    select: (id, occurrence) => {
      setSelectedId(id);
      if (Number.isInteger(occurrence)) {
        setOccRequest({ path: pathFor(id), occ: occurrence, tick: Date.now() });
      }
    },
    // A moment for the canvas to catch up, so a style read after a select is
    // asking about the element that is now selected.
    settle: () => new Promise((done) => setTimeout(done, 120)),
    focusAnchor: (anchor) => focusReview({ threadId: null, anchor }),
    /**
     * Put a write the main process carried out on the undo stack.
     *
     * The panels do this for exactly these operations — a CSS variable, a
     * content edit, an asset rename — because none of them touch the page
     * model, so without an entry ⌘Z would skip straight past them to the last
     * layout change. An agent's version of the same operation has to land in
     * the same place or the stack tells a story that leaves things out.
     *
     * The inverse is the panels' inverse. A content change is the bytes put
     * back; a rename or a move is the rename or the move read backwards. There
     * is no third kind, and something that does not fit one of them is not
     * recorded rather than recorded wrongly.
     */
    recordUndo: async ({ label, coalesceKey, restore }) => {
      if (!restore || !project?.path) return false;
      const put = async (which) => {
        if (restore.kind === 'files') {
          for (const [rel, pair] of Object.entries(restore.files || {})) {
            if (typeof pair?.[which] !== 'string') continue;
            await window.avb.writeSourceText({ projectPath: project.path, rel, text: pair[which] });
          }
        } else if (restore.kind === 'asset_rename') {
          const step = which === 'before' ? restore.back : restore.forward;
          await window.avb.renameAsset({ projectPath: project.path, rel: step.rel, newName: step.name });
        } else if (restore.kind === 'asset_move') {
          const step = which === 'before' ? restore.back : restore.forward;
          await window.avb.moveAsset({ projectPath: project.path, fromRel: step.fromRel, toDirRel: step.toDirRel });
        } else {
          return;
        }
        // The panels reload after their own undo for the same reason: the file
        // it rewrote may be the one on screen.
        setRefreshKey((k) => k + 1);
        await reloadOpenPageRef.current?.();
      };
      pushCommand({
        label: label || 'that change',
        coalesceKey: coalesceKey ?? null,
        undo: () => put('before'),
        redo: () => put('after'),
      });
      return true;
    },
    /**
     * Replace the open document's source, through the editor.
     *
     * The Agent API's raw source write used to go round the outside: write the
     * file, then tell the renderer to take it from disk again. That worked and
     * it threw the page's undo history away, because a reload describes a tree
     * nobody has a snapshot of. So an edit an agent made could not be taken
     * back, and neither could the three the person had made before it.
     *
     * This is the path the editor already has. `pushHistory` first, so ⌘Z has
     * somewhere to go; then the state, then the normal save. Two shapes,
     * because the app holds two:
     *
     *   a document Stacki models    the model is the truth and the file is
     *                               written from it, so the new text is parsed
     *                               and the model replaced. Undo restores the
     *                               previous MODEL, and saving writes it back
     *                               over the file — which is the original
     *                               source, arrived at the way everything else
     *                               here arrives at it.
     *
     *   a document it does not      `pageState.source` is the truth already.
     *                               This is exactly what the code editor does.
     */
    writeOpenSource: async (text) => {
      const { currentPage: page, pageState: state } = pageStateRef.current;
      if (!page || !state) return { ok: false, code: 'not_open', message: 'Stacki has no document open.' };
      const before = state.editable ? { kind: 'model', model: state.model } : { kind: 'source', source: state.source };
      if (!state.editable) {
        setRawSource(String(text));
        await new Promise((done) => setTimeout(done, 0));
        await flushSave();
        return { ok: true, editable: false, undoable: true, restored: before.kind };
      }
      // Parse it the way opening the file would, so what lands in the model is
      // what Stacki would have read.
      let parsed;
      try {
        parsed = await window.avb.parseSource({ pagePath: page.path, source: String(text) });
      } catch (err) {
        return { ok: false, code: 'unparsable', message: String(err?.message || err) };
      }
      if (!parsed || parsed.editable === false) {
        return {
          ok: false,
          code: 'unrepresentable',
          message:
            parsed?.reason ||
            'Stacki could not read that as a document. Nothing was changed — the file it has open would have ' +
              'become one it cannot edit.',
        };
      }
      pushHistory(null); // its own step: a source rewrite is not a typing burst
      docRevRef.current += 1;
      // Re-select the node at the same position, the way the file watcher does
      // after somebody edits the open file elsewhere. A reparse invents fresh
      // ids, so the old selection means nothing — but the POSITION still does,
      // and dropping the selection leaves the person looking at a canvas with
      // nothing chosen for a change they may not even have made.
      const trail = state.editable && selectedIdRef.current ? pathOfNode(state.model.nodes, selectedIdRef.current) : null;
      const landed = trail ? nodeAtPath(parsed.model?.nodes || [], trail)?.id ?? null : null;
      setPageState((s) => (s ? { ...s, ...parsed, file: page.path, dirty: true } : s));
      setSelectedId(landed);
      await new Promise((done) => setTimeout(done, 0));
      await flushSave();
      return { ok: true, editable: true, undoable: true, restored: before.kind };
    },
    // The open document changed on disk under the editor. Same reload the file
    // watcher does — see reloadOpenPageRef.
    reloadOpenPage: async () => {
      const done = await reloadOpenPageRef.current?.();
      await new Promise((settled) => setTimeout(settled, 0));
      return { ok: true, reloaded: !!done, file: openRel };
    },
    // Going into a component instance and coming back out: the app's own
    // openComponent and closeComponent, waited on. Both read the refs rather
    // than this render's state, because by the time they answer this render
    // is several behind.
    enter: async (id, occurrence) => {
      const state = pageStateRef.current.pageState;
      const node = state?.model ? findNodeById(state.model.nodes, id) : null;
      if (!node || node.kind !== 'component' || node.dynamicTag) {
        return { ok: false, code: 'not_component', message: 'That is not a component instance.' };
      }
      const before = state.model;
      const hostPath = pathFor(id);
      await openComponent(node.name, hostPath, Number.isInteger(occurrence) ? occurrence : 0, null);
      for (let i = 0; i < 60; i++) {
        const now = pageStateRef.current.pageState;
        if (now?.model && now.model !== before && selectedIdRef.current) {
          return { ok: true, id: selectedIdRef.current };
        }
        await new Promise((done) => setTimeout(done, 50));
      }
      return { ok: false, code: 'not_ready', message: `Stacki did not finish opening <${node.name}>.` };
    },
    exit: async () => {
      if (editStackRef.current.length < 2) {
        return { ok: false, code: 'at_top', message: 'Stacki is already at the page.' };
      }
      const before = pageStateRef.current.pageState?.model || null;
      await closeComponent();
      for (let i = 0; i < 60; i++) {
        const now = pageStateRef.current.pageState;
        if (now?.model && now.model !== before) return { ok: true };
        await new Promise((done) => setTimeout(done, 50));
      }
      return { ok: false, code: 'not_ready', message: 'Stacki did not finish leaving the component.' };
    },
    // Whether a ref resolved this way is good enough to write through. The
    // review pin rule, asked about the ref instead of a review.
    writableFor: (anchor, confidence) =>
      mayPin(
        {
          anchorState: 'attached',
          checkout: {
            source: 'changed',
            sameBranch: !anchor?.branch || anchor.branch === (gitInfo?.branch ?? null),
            branch: gitInfo?.branch ?? null,
          },
        },
        confidence
      ),
    /**
     * Apply a batch of operations as ONE change.
     *
     * One mutateModel, so one undo snapshot, so one ⌘Z. The operations were
     * already run against a copy by the caller and refused as a set if any of
     * them could not be done — this is the commit, and it saves before it
     * answers so whoever asked can read the file that resulted.
     */
    commit: async (operations, { label } = {}) => {
      let outcome = null;
      mutateModel((m) => {
        const run = applyOperations(m, operations, { insertables });
        outcome = run;
        return run.ok ? run.model : m;
      }, true);
      // A turn of the loop before anything is read back.
      //
      // `setPageState`'s updater is where the operations actually run, and
      // React decides when that is — sometimes inside the call above and
      // sometimes after it. Reading `outcome` straight away was right about
      // half the time, and the half it was wrong about reported a perfectly
      // good edit as a failure while quietly leaving it applied. Waiting is
      // also what lets flushSave see the new model, which it reads through the
      // ref React updates before effects run.
      await new Promise((done) => setTimeout(done, 0));
      if (!outcome?.ok) {
        return { ok: false, code: outcome?.code || 'failed', message: outcome?.message || 'That edit could not be applied.' };
      }
      if (outcome.selectId) setSelectedId(outcome.selectId);
      await flushSave();
      return { ok: true, selectedId: outcome.selectId || null, label: label || null };
    },
  };

  useEffect(() => {
    agentRunRef.current = createAgentCommands(() => agentAppRef.current);
    return () => {
      agentRunRef.current = null;
    };
  }, []);

  // From the panel or a pin: the same operation, plus saying so when it could
  // not be done — an agent gets that in its tool result, a person gets a toast.
  const focusReviewFromUi = async (review) => {
    const result = await focusReview({ threadId: review.id, anchor: review.anchor });
    if (result.note) showToast(result.note, result.anchorState === 'attached' ? 'info' : 'error');
    // Only a real resolution failure changes what the ledger believes.
    if (!result.transient && result.anchorState && result.anchorState !== review.anchorState) {
      void window.avb.reviewsSyncAnchors([{ id: review.id, anchorState: result.anchorState, keys: result.keys }]);
      setReviewTick((n) => n + 1);
    }
  };

  // --- the shortcuts --------------------------------------------------------

  const commentModeRef = useRef(commentMode);
  commentModeRef.current = commentMode;
  // Opening a review, from wherever.
  //
  // Both doors — a pin on the canvas and a row in the panel — have to decide
  // the reading density, and decide it the same way. Setting the id alone left
  // whatever density the LAST thread used in place, so a short comment opened
  // from its pin could appear docked in the panel because something long had
  // been read before it.
  /**
   * Open a review for reading.
   *
   * Every door into a review goes through here — a pin, a row, a choice from a
   * cluster — and every one of them lands in the same place. Nothing about the
   * review decides that: not its length, not its message count, not where it
   * was clicked from. The old model chose between two surfaces by counting
   * characters, which meant the same gesture did different things and the
   * reason was invisible.
   */
  const openReview = useCallback((id) => {
    setReviewSelectedId(id);
    setReviewPresentation(id ? 'inspector' : 'index');
    setReviewCluster(null);
    setReviewPeek(null);
  }, []);

  /** Out of the reader, back to the list — still on the same review. */
  const backToIndex = useCallback(() => setReviewPresentation('index'), []);

  // Reached from submitComment, which is declared above this. A ref rather
  // than a reorder: moving the declaration would mean moving everything it
  // closes over with it.
  const openReviewRef = useRef(null);
  openReviewRef.current = openReview;

  const reviewSelected = reviewSelectedId ? allReviews.find((r) => r.id === reviewSelectedId) || null : null;

  const reviewSelectedIdRef = useRef(reviewSelectedId);
  reviewSelectedIdRef.current = reviewSelectedId;
  const reviewPresentationRef = useRef(reviewPresentation);
  reviewPresentationRef.current = reviewPresentation;
  const reviewClusterRef = useRef(reviewCluster);
  reviewClusterRef.current = reviewCluster;

  /**
   * What the layout can afford.
   *
   * Recomputed from the window rather than stored, so a resized window is
   * simply a different answer to the same question.
   */
  const reviewShape = reviewLayout({
    viewportWidth: viewportW,
    preferredWidth: inspectorWidth,
    open: leftTab === 'comments' && reviewPresentation === 'inspector' && !!reviewSelectedId,
  });
  const canCommentRef = useRef(false);
  canCommentRef.current = !!project && !!devUrl && !inPreview;

  useEffect(() => {
    const onKey = (e) => {
      // Same guard the rest of the app uses, plus CodeMirror and the terminal:
      // a `c` typed into a shell must not put the canvas into comment mode.
      if (isTextEntry(e.target)) return;
      if (isCommentModeKey(e)) {
        if (!canCommentRef.current) return;
        e.preventDefault();
        // Turning it on shows the comments; turning it off leaves the panel
        // where it is, because closing a panel is not what Escape-from-a-mode
        // means.
        if (commentModeRef.current.phase === 'off') setLeftTab('comments');
        commentDispatch({ type: 'toggle' });
        return;
      }
      if (isPinToggleKey(e)) {
        if (!canCommentRef.current) return;
        e.preventDefault();
        setPinsVisible((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        // One rung at a time: out of the reader, then not that element, then
        // not commenting. A thread opened from its pin closes first, since
        // that is what is in the way.
        // One rung at a time, outermost first: the chooser, then the reader,
        // then the selection itself, then comment mode. Each Escape undoes the
        // last thing that happened rather than everything at once.
        if (reviewClusterRef.current) {
          e.preventDefault();
          setReviewCluster(null);
        } else if (reviewPresentationRef.current === 'inspector' && commentModeRef.current.phase === 'off') {
          e.preventDefault();
          setReviewPresentation('index');
        } else if (reviewSelectedIdRef.current && commentModeRef.current.phase === 'off') {
          // Still selected after leaving the reader, so a second Escape is what
          // clears it — and takes a temporarily-shown resolved marker with it.
          e.preventDefault();
          setReviewSelectedId(null);
        } else if (commentModeRef.current.phase !== 'off') {
          e.preventDefault();
          commentDispatch({ type: 'escape' });
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // A composer floating over a page nobody is on any more is the sort of thing
  // that only gets noticed by the person it happens to.
  useEffect(() => {
    commentDispatch({ type: 'context-lost' });
    setReviewSelectedId(null);
    setReviewPresentation('index');
    setReviewPeek(null);
    setReviewCluster(null);
  }, [reviewPageFile, project?.path]);

  // Drilling into a component is not leaving the page — the canvas still shows
  // it, and somebody who pressed C to comment on something deeper meant to
  // stay in comment mode. Only a draft aimed at the file just left has to go.
  useEffect(() => {
    commentDispatch({ type: 'file-changed' });
  }, [currentPage?.path]);

  const reviewDraft = isComposing(commentMode)
    ? {
        x: commentMode.target.x,
        y: commentMode.target.y,
        label: commentMode.target.label,
        breakpoint: canvasReport?.device || null,
        occurrence: commentMode.target.occurrence,
        occurrenceCount: commentMode.target.occurrenceCount,
        body: draftBody,
      }
    : null;

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  if (!project) {
    // welcome-mode floats the title bar over the start screen so the
    // interactive backdrop runs edge to edge, behind the window controls.
    return (
      <div className="app welcome-mode">
        <div className="titlebar">
          <span className="spacer" />
        </div>
        <WelcomeScreen onOpen={loadProject} setBusy={setBusy} showToast={showToast} />
        {busy && <BusyOverlay message={busy} />}
        {toast && <Toast toast={toast} />}
        <ConfirmHost />
      </div>
    );
  }

  // The canvas always renders the page — editing a component just dims
  // everything outside the instance being worked on.
  const pageEntry = editStack[0] || currentPage;
  const patternRoute = pageEntry?.route;
  const focusPath = currentPage?.kind === 'component' ? currentPage.focusPath : null;
  const focusOcc = currentPage?.kind === 'component' ? currentPage.focusOcc ?? 0 : 0;
  // The focus routes clicks either way; this says whether it also draws.
  const focusWhole = currentPage?.kind === 'component' && !!currentPage.focusWhole;
  // A dynamic page's route is a pattern, not a URL — /posts/[slug] is a 404.
  // Preview one of the entries it actually stands for; `dynamicEntry` is which.
  const dynamicEntry = dynamicPaths[dynamicIndex] || null;

  // What the binding picker shows: the names in scope, plus the DATA behind
  // them wherever the app can see it. Two sources, and between them a designer
  // gets real values rather than a list of identifiers:
  //   the entry on the canvas — getStaticPaths' props ARE Astro.props for a
  //     dynamic route, so `post.data.title` shows this post's actual title
  //   this file's own `interface Props` — no values, but every prop still says
  //     what it is, which is all a component outside a page can offer
  const editedEntry = insertables.find((c) => c.path === currentPage?.path) || null;
  const bindContext = loopContext && {
    ...loopContext,
    // A component's frontmatter is not the page's, so the page's entry is not
    // its data. What it does have is the instance it was opened from, whose
    // props are its Astro.props — the values it is rendering with right now.
    propsSample:
      currentPage?.kind === 'component' ? instanceProps : dynamicEntry?.props || null,
    propsSchema: schemaFor(editedEntry),
    collectionSamples,
    collections,
    // Opening a collection in the picker asks for one entry of it; nothing is
    // fetched for collections nobody looks at.
    onNeedSample: requestCollectionSample,
    // Picking from a collection this page doesn't read yet writes the query
    // that fetches it, and answers with the name it ended up under.
    ensureQuery: ensureCollectionQuery,
    // Stepping through a dynamic route's entries from inside the picker. It is
    // the SAME index the canvas renders against, so moving it previews the page
    // against other content and re-reads the sample values at once — which is
    // the point: you are checking a layout against real data, not one post.
    entryNav:
      dynamicPaths.length > 1
        ? {
            index: dynamicIndex,
            count: dynamicPaths.length,
            label: dynamicEntry?.label || '',
            onStep: (dir) =>
              setDynamicIndex(
                (i) => (i + dir + dynamicPaths.length) % dynamicPaths.length
              ),
          }
        : null,
  };
  // With no page selected and none to select — a project whose routes all come
  // from an integration, before one is picked — the dev server is still serving
  // a site. Show its root rather than an empty canvas: something running should
  // look like it is running.
  const rootFallback = !patternRoute && !scan.pages.length && devStatus === 'on' ? '/' : null;
  const pageRoute = dynamicEntry ? dynamicEntry.route : patternRoute || rootFallback;
  const pageUrlPath = pageRoute ? routeToPath(pageRoute, trailingSlash) : null;
  livePathRef.current = pageUrlPath;
  const liveUrl = devUrl && pageUrlPath ? devUrl + pageUrlPath : null;
  // The old version is served by its own dev server, on the same route the
  // editor is on, so switching in and out is a like-for-like comparison.
  const oldVersionUrl = previewInfo && pageUrlPath ? previewInfo.url + pageUrlPath : null;

  return (
    <div className="app">
      <div className="titlebar">
        <span className="app-title">{project.name}</span>
        <span className="spacer" />
        {editStack.length > 1 ? (
          <button
            className="page-switch-btn comp-back"
            title="Back (Esc)"
            onClick={closeComponent}
          >
            <ChevronLeftIcon size={13} />
            <span className="comp-back-sep" />
            <ElementComponentIcon size={13} />
            <span className="page-switch-label">{currentPage?.name}</span>
          </button>
        ) : (
          <PageSwitcher pages={scan.pages} currentPage={currentPage} onSelect={selectPage} />
        )}
        <div className="url-group">
          <span
            className={`status-dot ${devStatus === 'on' ? 'on' : devStatus === 'starting' ? 'starting' : 'off'}`}
            title={`Dev server: ${devStatus}`}
          />
          <button
            className="ghost"
            title="Reload preview"
            disabled={!liveUrl}
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <RefreshIcon size={13} />
          </button>
          {/* A real input, not a label: the URL is something you copy out and
              something you type a route into. Focus selects it all, so one
              click and ⌘C gets the whole thing. */}
          <input
            className="url"
            spellCheck={false}
            value={urlDraft ?? liveUrl ?? ''}
            placeholder={devStatus === 'starting' ? 'Starting Astro dev server…' : 'Preview offline'}
            readOnly={!liveUrl}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => setUrlDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setUrlDraft(null);
                e.currentTarget.blur();
                return;
              }
              if (e.key !== 'Enter') return;
              e.currentTarget.blur();
              goToUrl(e.currentTarget.value);
            }}
          />
          {/* Which entry of a dynamic route the canvas is showing. The template
              is what gets edited either way — this only changes the data it's
              rendered against. */}
          {patternRoute?.includes('[') && (
            <DynamicPicker
              entries={dynamicPaths}
              index={dynamicIndex}
              onPick={setDynamicIndex}
              error={dynamicError}
              pattern={patternRoute}
            />
          )}
        </div>
        <span className="spacer" />
        {/* Both ways of viewing the site, kept together. */}
        <div className="titlebar-actions">
          <button
            className={`titlebar-btn ${termOpen ? 'on' : ''}`}
            title={termOpen ? 'Hide terminal (⌘J)' : 'Show terminal (⌘J)'}
            onClick={() => setTermOpen((v) => !v)}
          >
            <TerminalIcon size={14} />
          </button>
          <button
            className="titlebar-btn"
            title="Open in browser"
            disabled={!liveUrl}
            onClick={() => window.avb.openExternal(liveUrl)}
          >
            <ExternalIcon size={14} />
          </button>
          {/* Two things put the canvas into a state you are looking at rather
              than working in — the interactive preview, and an older version —
              and this button is where both of them end. Lit for either, so it
              is never on while the only button that turns it off looks idle. */}
          <button
            className={`titlebar-btn preview-btn ${inPreview || previewRef ? 'on' : ''}`}
            title={
              previewRef
                ? 'Back to now (Esc)'
                : inPreview
                  ? 'Exit preview (Esc)'
                  : 'Preview the site'
            }
            disabled={!devUrl}
            onClick={() =>
              previewRef ? exitCommitPreview() : inPreview ? exitPreview() : enterPreview()
            }
          >
            <PreviewIcon size={15} />
          </button>
        </div>
        <GitChip
          project={project}
          showToast={showToast}
          flushSave={flushSave}
          onWorktreeChanged={reloadFromDisk}
        />
      </div>

      <div className="main">
        <LeftRail
          active={leftTab}
          onSelect={(id) => setLeftTab((t) => (t === id ? null : id))}
        />

        {/* `is-reading` is wider, and only while a review is docked in here.
            A 260px column is right for a list of comments and wrong for the
            conversation the list points at: at that measure a sentence about
            three files breaks into a column of fragments. The width belongs to
            the reading state rather than to the panel, so it goes back the
            moment somebody returns to the list. */}
        {leftTab && (
          <div
            className={`panel left${reviewShape.mode !== 'closed' ? ` is-inspector is-${reviewShape.mode}` : ''}`}
            style={reviewShape.mode !== 'closed' ? { width: reviewShape.width } : undefined}
          >
            {leftTab === 'pages' && (
              <PagesPanel
                scan={scan}
                currentPage={currentPage}
                injectedRoutes={injectedRoutes}
                onSelectRoute={selectRoute}
                onSelect={selectPage}
                onCreate={createPage}
                onDelete={deletePage}
                onRescan={() => rescan(project.path)}
                onMovePage={movePageTo}
                onCreateFolder={createPageFolder}
                onRenameFolder={renamePageFolder}
                onDeleteFolder={deletePageFolder}
              />
            )}
            {leftTab === 'navigator' && (
              <StructurePanel
                pageState={pageState}
                currentPage={currentPage}
                layouts={scan.layouts}
                currentLayoutName={currentLayoutName}
                selectedId={selectedId}
                emptyNodeIds={emptyNodeIds}
                hiddenNodeIds={stateIds.hidden}
                inertNodeIds={stateIds.inert}
                liveClassesById={liveClassesById}
                revealTick={revealTick}
                onSelect={setSelectedId}
                onHoverNode={setHoverNodeId}
                onOpenComponent={(name, id) => openComponent(name, pathFor(id))}
                onChangeLayout={changeLayout}
                onDropComponent={addComponent}
                onMoveNode={moveNode}
                onRemoveNode={removeNode}
                onCopyNode={copyNode}
                onDuplicateNode={duplicateNode}
                onPasteNode={pasteNode}
                hasClipboard={() => !!nodeClipboardRef.current}
                onRawChange={setRawSource}
              />
            )}
            {leftTab === 'components' && (
              <PalettePanel
                components={insertables}
                devUrl={devUrl}
                onInsert={(name) => addComponent(name, null)}
                onDragBegin={() => setLeftTab('navigator')}
                createFrom={createFrom}
                createRequest={createRequest}
                onCreateComponent={createComponentFromSelection}
                onUsage={componentUsage}
                pageInstances={pageInstancesOf}
                onSelectInstance={(id) => { setLeftTab('navigator'); setSelectedId(id) }}
                onOpenUsage={(entry) => {
                  // A page is opened as a page; a component or layout is drilled
                  // into, the same as opening one from the canvas.
                  const page = scan.pages.find((p) => p.path === entry.path);
                  if (page) { void selectPage(page); return }
                  const name = entry.rel.split('/').pop().replace(/\.astro$/, '');
                  void openComponent(name, undefined, 0, entry.path);
                }}
              />
            )}
            {leftTab === 'cms' && (
              <CmsPanel
                project={project}
                selectedRel={cmsRel}
                selectedContent={contentName}
                onSelectContent={(name) => {
                  setContentName(name);
                  if (name) {
                    setCmsRel(null);
                    setCmsSettings(false);
                  }
                }}
                currentFile={openFileSrcRel}
                refreshKey={cmsTick}
                onSelect={(r) => {
                  setCmsRel(r);
                  setCmsSettings(false);
                  if (r) setContentName(null);
                  // Closing a collection leaves nothing selected anywhere, so
                  // the right-hand panels show their empty state rather than
                  // the node that happened to be picked before.
                  if (!r) setSelectedId(null);
                }}
                onOpenSettings={(r) => {
                  setCmsRel(r);
                  setCmsSettings(true);
                }}
                showToast={showToast}
              />
            )}
            {leftTab === 'variables' && (
              <VariablesPanel project={project} selected={varsGroup} onSelect={setVarsGroup} />
            )}
            {/* One slot, two surfaces. The Inspector REPLACES the index
                rather than appearing beside or inside it, so there is never a
                list of comments wrapped around a conversation, and Back is a
                real return rather than a collapse. */}
            {leftTab === 'comments' && reviewPresentation === 'inspector' && reviewSelected && (
              <ReviewInspector
                review={reviewSelected}
                width={reviewShape.width}
                resizable={reviewShape.mode === 'docked'}
                onWidthChange={saveInspectorWidth}
                onBack={backToIndex}
                actorId={reviewShared?.identity?.actorId || null}
                pinned={!withheldPins?.has(reviewSelected.id)}
                busy={reviewBusyId === reviewSelected.id}
                reply={reviewDrafts[reviewSelected.id] || ''}
                onReplyChange={(text) =>
                  setReviewDrafts((d) => ({ ...d, [reviewSelected.id]: text }))
                }
                onAct={(action, extra) => {
                  // A posted reply is no longer unsent, so the draft goes.
                  if (action === 'reply') {
                    setReviewDrafts((d) => {
                      const next = { ...d };
                      delete next[reviewSelected.id];
                      return next;
                    });
                  }
                  return actOnReview(reviewSelected.id, action, extra);
                }}
                onFocus={() => focusReviewFromUi(reviewSelected)}
                onDelete={() => deleteReview(reviewSelected.id)}
                onColor={(c) => recolorReview(reviewSelected.id, c)}
                onEditMessage={(messageId, message) => editReviewMessage(reviewSelected.id, messageId, message)}
                onDeleteMessage={(messageId) => deleteReviewMessage(reviewSelected.id, messageId)}
              />
            )}
            {leftTab === 'comments' && !(reviewPresentation === 'inspector' && reviewSelected) && (
              <CommentsPanel
                reviews={reviewRows}
                status={reviewFilter}
                onStatus={setReviewFilter}
                scope={reviewScope}
                onScope={setReviewScope}
                selectedId={reviewSelectedId}
                onOpen={(id) => {
                  openReview(id);
                  // Choosing a comment from the list means "show me this" —
                  // reading it and finding it are the same act. An orphan has
                  // nowhere to go, so it just opens.
                  const picked = id ? reviewRows.find((r) => r.id === id) : null;
                  if (picked && picked.anchorState !== 'orphaned') void focusReviewFromUi(picked);
                }}
                onAct={actOnReview}
                onFocus={focusReviewFromUi}
                onDelete={deleteReview}
                onColor={recolorReview}
                onEditMessage={editReviewMessage}
                onDeleteMessage={deleteReviewMessage}
                busyId={reviewBusyId}
                problem={reviewProblem}
                shared={reviewShared}
                totalCount={allReviews.length}
                actorId={reviewShared?.identity?.actorId || null}
                withheldIds={withheldPins}
                // Which reviews have a marker on the canvas right now. The
                // panel needs it to know whether the thread is already being
                // shown somewhere: if it is, the row is just a row.
                pinnedIds={pinnedReviewIds}
                syncing={reviewSyncing}
                onSync={syncReviews}
                onShareEnable={shareEnable}
                onShareJoin={shareJoin}
                onShareDisable={shareDisable}
                onShareInvite={shareInvite}
                onRename={renameSelf}
                hiddenPins={pinsHidden}
                pinsVisible={pinsVisible}
                onTogglePins={() => setPinsVisible((v) => !v)}
                commenting={isCommenting(commentMode)}
                onToggleComment={() => commentDispatch({ type: 'toggle' })}
              />
            )}
            {leftTab === 'history' && (
              <HistoryPanel
                project={project}
                gitInfo={gitInfo}
                previewRef={previewRef}
                onRefreshGit={refreshGit}
                showToast={showToast}
                onOpenFile={(f) => {
                  // A page opens in the editor. Anything else has no canvas to
                  // show it on, so the row says where it is and does nothing —
                  // better than opening an empty editor onto a stylesheet.
                  const page = scan.pages.find((p) => p.path.endsWith(f.path));
                  if (page) selectPage(page);
                  else showToast(`${f.path} isn’t a page — nothing to open on the canvas.`, 'info');
                }}
                onPreviewCommit={previewCommit}
                onExitPreview={exitCommitPreview}
                onRestoreFile={async (commit, file) => {
                  if (
                    !(await confirmDialog({
                      title: `Put ${file.label} back?`,
                      body: `It goes back to how it was in “${commit.subject}”, and lands as an unsaved change — so you can look at it and undo it like any other edit.`,
                      confirmLabel: 'Put it back',
                    }))
                  ) {
                    return;
                  }
                  try {
                    const r = await window.avb.gitRestoreFile({
                      projectPath: project.path,
                      ref: commit.hash,
                      path: file.path,
                    });
                    if (r?.missing) {
                      showToast(r.message, 'error');
                      return;
                    }
                    await refreshGit();
                    await reloadFromDisk();
                    showToast(`${file.label} is back to how it was`, 'success');
                  } catch (err) {
                    showToast(cleanError(err), 'error');
                  }
                }}
                onRestoreProject={async (commit) => {
                  if (
                    !(await confirmDialog({
                      title: `Take everything back to “${commit.subject}”?`,
                      body:
                        'Anything you haven’t saved is put aside first, so nothing is lost. Your saved ' +
                        'history stays exactly as it is — this lands as a set of unsaved changes you can ' +
                        'look over, keep, or undo.',
                      confirmLabel: 'Take it back',
                    }))
                  ) {
                    return;
                  }
                  setBusy('Going back…');
                  try {
                    const r = await window.avb.gitRestoreProject({
                      projectPath: project.path,
                      ref: commit.hash,
                    });
                    await refreshGit();
                    await reloadFromDisk();
                    showToast(
                      r?.parked
                        ? 'The project is back — your unsaved work is waiting on this branch'
                        : 'The project is back to how it was',
                      'success'
                    );
                  } catch (err) {
                    showToast(cleanError(err), 'error');
                  } finally {
                    setBusy(null);
                  }
                }}
                onSwitchBranch={async (b) => {
                  // Same as the chip: try it, and only say something if git
                  // could not carry the work across. Parking is what the chip's
                  // dialog offers after that, not a thing done pre-emptively.
                  try {
                    const r = await window.avb.gitCheckout({ projectPath: project.path, branch: b });
                    if (r?.blocked) {
                      showToast(
                        `${gitInfo?.branch} and ${b} have different versions of ` +
                          `${r.files?.[0] || 'a file'} you have unsaved work in — switch from the branch button to decide what to do with it.`,
                        'error'
                      );
                      return;
                    }
                    await refreshGit();
                    await reloadFromDisk();
                    showToast(
                      r?.restored ? `Picked your changes back up on ${b}` : `Switched to ${b}`,
                      'success'
                    );
                  } catch (err) {
                    showToast(cleanError(err), 'error');
                  }
                }}
                onMergeBranch={(b) =>
                  mergeBranchAction({
                    projectPath: project.path,
                    branch: b,
                    into: gitInfo?.branch,
                    trunk: gitInfo?.trunk,
                    run: (fn) =>
                      fn()
                        .then(async () => {
                          await refreshGit();
                          await reloadFromDisk();
                        })
                        .catch((err) => showToast(cleanError(err), 'error')),
                    showToast,
                    // Both branches changed the same files. The chooser lives
                    // on the branch chip, so this points there rather than
                    // being a second, different answer to the same question.
                    onConflict: (r) =>
                      showToast(
                        `${r.from} and ${r.branch} both changed ` +
                          `${r.files.length === 1 ? r.files[0].path : `${r.files.length} files`}. ` +
                          'Open the branch button to choose which versions to keep.',
                        'info'
                      ),
                  })
                }
                onDeleteBranch={(b) =>
                  deleteBranchAction({
                    projectPath: project.path,
                    branch: b,
                    parked: (gitInfo?.parked || []).includes(b),
                    run: (fn) =>
                      fn()
                        .then(refreshGit)
                        .catch((err) => showToast(cleanError(err), 'error')),
                    showToast,
                  })
                }
              />
            )}
            {leftTab === 'assets' && (
              <AssetsPanel
                project={project}
                showToast={showToast}
                onOpenFile={openAssetFile}
                pick={assetPick}
                onPickCancel={endAssetPick}
                onRecordUndo={pushCommand}
              />
            )}
          </div>
        )}

        <div className="center">
          <PreviewPane
            spacingHover={spacingHover}
            devUrl={devUrl}
            devStatus={devStatus}
            devLog={devLog}
            devDiag={devDiag}
            route={pageUrlPath}
            refreshKey={refreshKey}
            crumbs={crumbs}
            onCrumb={(id) => setSelectedId(id)}
            onRefresh={() => setRefreshKey((k) => k + 1)}
            onRestart={() => startPreview(project.path)}
            pathScope={editedRel ? `${editedRel}|` : ''}
            selPath={pathFor(selectedId)}
            navHoverPath={pathFor(hoverNodeId)}
            overlayInfo={overlayInfo}
            focusPath={focusPath}
            focusOcc={focusOcc}
            focusWhole={focusWhole}
            device={device}
            onDevice={setDevice}
            onCanvasReport={setCanvasReport}
            commenting={wantsCanvasClick(commentMode)}
            pinsVisible={pinsVisible}
            reviewItems={reviewItems}
            reviewSelectedId={reviewSelectedId}
            reviewPeek={reviewPeek}
            reviewCluster={reviewCluster}
            onReviewPeek={setReviewPeek}
            onReviewCluster={setReviewCluster}
            reviewDraft={reviewDraft}
            reviewBusyId={reviewBusyId}
            reviewById={reviewById}
            onReviewOpen={(pin) => {
              // A pin, not an id: a marker can stand for several reviews and
              // the old code silently opened the first of them. Now one review
              // opens and a cluster asks which.
              if (!pin) {
                openReview(null);
                return;
              }
              if (pin.reviews.length > 1) {
                setReviewPeek(null);
                setReviewCluster(pin);
                return;
              }
              openReview(pin.reviews[0]);
              const picked = allReviewsRef.current.find((r) => r.id === pin.reviews[0]);
              if (picked && picked.anchorState !== 'orphaned') void focusReviewFromUi(picked);
            }}
            onPickFromCluster={(id) => {
              openReview(id);
              const picked = allReviewsRef.current.find((r) => r.id === id);
              if (picked && picked.anchorState !== 'orphaned') void focusReviewFromUi(picked);
            }}
            onReviewAct={actOnReview}
            onReviewFocus={focusReviewFromUi}
            onReviewDelete={deleteReview}
            onReviewColor={recolorReview}
            onReviewEditMessage={editReviewMessage}
            onReviewDeleteMessage={deleteReviewMessage}
            onReviewDraftChange={setDraftBody}
            onReviewDraftSubmit={submitComment}
            onReviewDraftCancel={() => commentDispatch({ type: 'escape' })}
            onReviewHidden={setPinsHidden}
            onCommentTarget={takeCommentTarget}
            occRequest={occRequest}
            onSelectPath={(p, info) => {
              // What the click MEANT — see canvasClick.js. The canvas answers
              // with a path or with null, and null has two causes that want
              // opposite things: a click the open file doesn't own, and a click
              // on something inside it the canvas couldn't name.
              const reveal = (node) => {
                if (!node) return;
                setSelectedId(node.id);
                // Selecting from the canvas jumps to the node in the tree.
                setLeftTab('navigator');
                setRevealTick((t) => t + 1);
              };
              const { kind } = canvasClickAction({
                path: p,
                outside: !!info?.outside,
                focusPath,
                scope: editedRel ? `${editedRel}|` : '',
              });
              // Anything transient over the canvas goes. The Inspector is a
              // panel and does not swallow clicks, so it stays where it is —
              // selecting an element while reading a review about it is a
              // perfectly reasonable thing to be doing.
              setReviewPeek(null);
              setReviewCluster(null);
              if (kind === 'nothing') return;
              if (kind === 'close') { closeComponent(); return; }
              if (kind === 'layout') { reveal(model && findNodeById(model.nodes, 'layout')); return; }
              reveal(model && nodeAtPath(model.nodes, trailOf(p)));
            }}
            onSelectedClasses={receiveClasses}
            onRenderedPaths={setRenderedPaths}
            onNodeStates={setNodeStates}
            onNodeClasses={setNodeClasses}
            onOpenPath={(p, occ) => {
              // Double-clicking a component on the canvas drills into it. With no
              // path the click landed on chrome the layout renders itself (nav,
              // footer) — that markup belongs to the layout, so open the layout,
              // matching what a single click there selects.
              if (!p) {
                if (layoutNode) openComponent(layoutNode.name, pathFor('layout'));
                return;
              }
              const n = model && nodeAtPath(model.nodes, trailOf(p));
              if (!n) return;
              // astro:assets components have no file behind them to open.
              if (n.kind === 'component' && !n.astroAsset) {
                openComponent(n.name, p, occ);
                return;
              }
              // Nothing to drill into. But a double-click on a paragraph asks
              // to edit its words — that's what the gesture means everywhere
              // else — so it goes where the words are: Settings, caret in
              // Content. Only where that field exists; on a wrapper full of
              // elements the double-click has nothing to offer and does
              // nothing, rather than opening a panel to say so.
              if (holdsInlineText(n)) {
                setRightTab('settings');
                setContentFocus((t) => t + 1);
              }
            }}
          />

          {/* The CMS edits content, not layout — it covers the canvas rather
              than replacing it, so the preview keeps its loaded page. */}
          {varsGroup && leftTab === 'variables' && (
            <VariablesView
              project={project}
              selected={varsGroup}
              hidden={leftTab !== 'variables'}
              showToast={showToast}
              onRecordUndo={pushCommand}
              onClose={() => setVarsGroup(null)}
            />
          )}

          {contentName && (
            <ContentView
              project={project}
              name={contentName}
              hidden={leftTab !== 'cms'}
              showToast={showToast}
              onSaved={() => setCmsTick((t) => t + 1)}
              onClose={() => setContentName(null)}
            />
          )}

          {cmsRel && (
            <CmsView
              project={project}
              rel={cmsRel}
              hidden={leftTab !== 'cms'}
              settings={cmsSettings}
              showToast={showToast}
              onRecordUndo={pushCommand}
              onSaved={() => setCmsTick((t) => t + 1)}
              onCloseSettings={() => setCmsSettings(false)}
              onDeleted={() => {
                setCmsRel(null);
                setCmsSettings(false);
              }}
              onClose={() => setCmsRel(null)}
            />
          )}
        </div>

        {inPreview && previewSrc && (
          <div className="preview-mode">
            <iframe ref={previewIframeRef} src={previewSrc} title="Site preview (interactive)" />
          </div>
        )}

        {/* An old version covers the canvas rather than replacing what it
            points at. The editing canvas draws outlines from the model, and
            the model is read from the files on disk — which are the CURRENT
            ones. Pointed at an old server it would draw this version's boxes
            over that version's page: every outline in the wrong place, and
            every click editing a file that isn't what's on screen. An overlay
            cannot do that, because there is nothing to click. */}
        {oldVersionUrl && (
          <div className="preview-mode old-version">
            <div className="preview-banner">
              <span className="preview-banner-text">
                You’re looking at <strong>{previewInfo.subject}</strong> — how the site was{' '}
                {relativeTime(previewInfo.when)}. This is a look, not a place to work.
              </span>
              <button className="preview-banner-exit" onClick={exitCommitPreview}>
                Back to now
              </button>
            </div>
            <iframe src={oldVersionUrl} title="An earlier version of the site" />
          </div>
        )}

        {/* Style/Settings gives way before the canvas does.

            It is what somebody uses to FIX the feedback they just read, so it
            is the third thing protected, not the first — but a 300px canvas is
            not somewhere you can work, and this can be brought back with one
            click while a crushed canvas cannot. See src/reviewLayout.js. */}
        {pageState?.editable && !previewRef && !reviewShape.propsVisible && (
          <button
            className="props-reveal"
            title="Show Style and Settings"
            onClick={() => setReviewPresentation('index')}
          >
            Style
          </button>
        )}
        {pageState?.editable && !previewRef && reviewShape.propsVisible && (
          <div className="panel right">
            <div className="right-tabs">
              {rightTabInd && <span className="right-tabs-indicator" style={rightTabInd} />}
              {[
                { id: 'style', label: 'Style' },
                { id: 'settings', label: 'Settings' },
              ].map((t) => (
                <button
                  key={t.id}
                  ref={(el) => (rightTabRefs.current[t.id] = el)}
                  className={rightTab === t.id ? 'on' : ''}
                  onClick={() => setRightTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {rightTab === 'style' && (
              <StylePanel
                project={project}
                model={model}
                node={selectedNode}
                device={device}
                onWriteStyleNode={(nodeId, css, immediate) => {
                  // Editing a component: a <style> block of the PAGE is not in
                  // the model this writes into, and mutating nothing would look
                  // like a save. Report it instead — the panel holds the edit
                  // and writes it when the component closes.
                  const model = pageStateRef.current.pageState?.model;
                  if (!model || !findNodeById(model.nodes, nodeId)) return false;
                  setNodeText(nodeId, css, undefined, immediate || 'live');
                  return true;
                }}
                onSelectNode={setSelectedId}
                onRecordUndo={pushCommand}
                onAddClass={(name) => addClassToNode(selectedId, name)}
                onSpacingHover={setSpacingHover}
                pathOf={pathFor}
                renderedClasses={selectedClasses}
                projectClasses={projectClasses}
                historyTick={historyTick}
                openFilePath={editStack[editStack.length - 1]?.path || currentPage?.path || null}
              />
            )}
            <div style={{ display: rightTab === 'settings' ? 'contents' : 'none' }}>
            <PropsPanel
              node={selectedNode}
              focusClass={classFocus}
              focusContent={contentFocus}
              isLayout={selectedId === 'layout'}
              layouts={scan.layouts}
              currentLayoutName={currentLayoutName}
              onChangeLayout={changeLayout}
              schema={selectedSchema}
              slotOptions={slotOptions}
              // Whether this component takes default slot content — the same
              // test used to decide what an insert or paste can go inside.
              takesSlotText={
                selectedNode?.kind === 'component' &&
                (insertables.find((c) => c.name === selectedNode.name)?.slots || []).includes(
                  'default'
                )
              }
              loopContext={loopContext}
              bindContext={bindContext}
              linkContext={linkContext}
              projectClasses={projectClasses}
              allowAttrs={
                selectedNode?.kind === 'element' ||
                // A dynamic tag renders a real element, so it takes attributes
                // even though it has no component file behind it.
                !!selectedNode?.dynamicTag ||
                (selectedNode?.kind === 'component' &&
                  !!insertables.find((c) => c.name === selectedNode.name)?.hasRest)
              }
              comment={noteText(commentAbove(model, selectedId)?.value)}
              onSetComment={(text) => setComment(selectedId, text)}
              onSetProp={(propName, value, immediate) =>
                setProp(selectedId, propName, value, immediate)
              }
              onSetProps={(nodeId, patch) => setProps(nodeId, patch)}
              onSetAssetProp={(nodeId, propName, picked) =>
                setAssetProp(nodeId, propName, picked)
              }
              onRenameProp={(oldName, newName) => renameProp(selectedId, oldName, newName)}
              // A capital is a component name; anything else is a tag. The
              // component path answers whether the name resolves, so the
              // field can put the old value back when it doesn't.
              onChangeTag={(tag) =>
                /^[A-Z]/.test(tag)
                  ? changeNodeKind(selectedId, tag)
                  : changeElementTag(selectedId, tag)
              }
              tagOptions={tagOptions}
              onSetText={(value, renames) =>
                selectedId === 'frontmatter'
                  ? setFrontmatter(value)
                  : setNodeText(selectedId, value, renames)
              }
              onSetContent={(value) => setNodeContent(selectedId, value)}
              onSetInline={(kids) => setNodeInline(selectedId, kids)}
              onOpenCode={openCodeWindow}
              onSetFrontmatter={setExtraFrontmatter}
              frontmatterSource={frontmatterCode}
              onOpenSymbol={openSymbolFile}
              onToggleElse={(want) => toggleElseBranch(selectedId, want)}
              projectPath={project.path}
              filePath={editStack[editStack.length - 1]?.path || currentPage?.path || null}
            />
            </div>
          </div>
        )}
      </div>

      {/* Below `.main`, so it spans the full window rather than being boxed in
          by the panels. Always mounted but inert until opened: it spawns no
          shell until then, and once open it hides rather than unmounting, so
          toggling it doesn't discard the scrollback — see TerminalDock. */}
      <TerminalDock
        projectPath={project.path}
        open={termOpen}
        onClose={() => setTermOpen(false)}
      />

      {codeWin && codeWinValue !== null && (
        <CodeWindow
          title={codeWin.title}
          language={codeWin.language}
          value={codeWinValue}
          editorKey={isFileWin ? `file:${codeWin.rel}` : codeWin.targetId}
          revealLine={codeWin.revealLine}
          onChange={(value) =>
            isFileWin
              ? setAssetFileText(value)
              : codeWin.targetId === 'frontmatter'
                ? setFrontmatter(value)
                : setNodeText(codeWin.targetId, value)
          }
          onClose={() => setCodeWin(null)}
        />
      )}

      {insertOpen && (
        <InsertSearch
          components={insertables}
          allowSlot={currentPage?.kind === 'component'}
          onInsert={insertItem}
          onClose={() => setInsertOpen(false)}
        />
      )}

      {busy && <BusyOverlay message={busy} />}
      {toast && <Toast toast={toast} />}
      <ConfirmHost />
      {mcpStatus && <McpDialog status={mcpStatus} onClose={() => setMcpStatus(null)} />}
    </div>
  );
}


function BusyOverlay({ message }) {
  return (
    <div className="busy-overlay">
      <div className="spinner" />
      <div>{message}</div>
    </div>
  );
}

function Toast({ toast }) {
  return <div className={`toast ${toast.kind}`}>{toast.msg}</div>;
}

