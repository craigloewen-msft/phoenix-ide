import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  buildTranscriptLayout,
  type TranscriptLayout,
  type TranscriptRange,
} from '../conversation/virtualTranscriptLayout';
import './VirtualTranscript.css';

export interface VirtualTranscriptRange {
  startIndex: number;
  endIndex: number;
}

export interface VirtualTranscriptPhysicalSnapshot {
  /** Inclusive rows mounted in the DOM, including overscan-only rows. */
  renderedRange: VirtualTranscriptRange | null;
  /** Inclusive rows with positive-area intersection with the viewport. */
  visibleRange: VirtualTranscriptRange | null;
  viewportTop: number;
  layoutRevision: number;
  targetIndex?: number;
  targetOffset?: number | null;
  targetMeasured?: boolean;
}

export type VirtualTranscriptRangeChange = VirtualTranscriptPhysicalSnapshot;

export interface VirtualTranscriptAnchor {
  index: number;
  key: string;
  offset: number;
}

export interface VirtualTranscriptHandle {
  scrollToIndex(index: number, align: 'start' | 'end', viewportStartOffset?: number): void;
  scrollToTail(): void;
  captureVisibleAnchor(): VirtualTranscriptAnchor | null;
  preserveViewportOnNextItemsChange(): void;
  measureOffsetForIndex(index: number): number | null;
  measureOffsetForIndexAtSnapshot(index: number, snapshot: VirtualTranscriptPhysicalSnapshot): number | null;
  layoutRevision(): number;
  physicalSnapshot(targetIndex?: number): VirtualTranscriptPhysicalSnapshot;
}

export interface VirtualTranscriptProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  header?: ReactNode;
  empty?: ReactNode;
  overscan?: number;
  initialTail?: boolean;
  estimatedExtent: number | ((item: T, index: number) => number);
  className?: string;
  scrollerId?: string;
  scrollerRef?: (element: HTMLDivElement | null) => void;
  onRangeChange?: (snapshot: VirtualTranscriptRangeChange) => void;
  onTotalExtentChange?: (totalExtent: number) => void;
  onPinnedChange?: (pinned: boolean) => void;
}

interface PhysicalStore<T> {
  items: readonly T[];
  keys: string[];
  getKey: (item: T, index: number) => string;
  estimatedExtent: VirtualTranscriptProps<T>['estimatedExtent'];
  measuredExtents: Map<string, number>;
  headerExtent: number;
  layout: TranscriptLayout;
  range: TranscriptRange | null;
  viewportTop: number;
  viewportExtent: number;
  overscan: number;
  activeAnchor: VirtualTranscriptAnchor | null;
  scroller: HTMLDivElement | null;
  headerElement: HTMLDivElement | null;
  rowElements: Map<string, HTMLDivElement>;
  resizeObserver: ResizeObserver | null;
  initialTailPending: boolean;
  preservedViewport: { top: number; firstKey: string | null } | null;
  pinned: boolean;
  revision: number;
}

interface StorePublisher<T> {
  store: PhysicalStore<T>;
  publish: () => void;
}

const DEFAULT_ESTIMATED_EXTENT = 1;
const PINNED_EPSILON = 1;
// A row's extent is discoverable only while it is mounted, so the layout reaches
// its fixed point by iterating: measure the mounted rows, relayout, mount
// whatever the new layout reveals. Each iteration is a React update scheduled
// from the commit phase, and React destroys the tree once 50 of those nest. This
// caps how many iterations may nest before the remainder is deferred to the next
// frame, which converges a frame later instead of tearing the transcript down.
// Ordinary convergence takes a handful of iterations, so the cap is unreachable
// except for content whose measured height keeps changing.
const MAX_NESTED_RELAYOUT_ROUNDS = 16;

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeRange(range: TranscriptRange | null): VirtualTranscriptRange | null {
  return range ? { startIndex: range.startIndex, endIndex: range.endIndex } : null;
}

function computeVisibleRange<T>(store: PhysicalStore<T>): TranscriptRange | null {
  const viewportStart = Math.max(store.viewportTop, store.headerExtent);
  const viewportEnd = Math.min(store.viewportTop + store.viewportExtent, totalPhysicalExtent(store));
  const clippedExtent = viewportEnd - viewportStart;
  if (clippedExtent <= 0) return null;
  return store.layout.rangeForViewport({
    viewportOffset: viewportStart - store.headerExtent,
    viewportExtent: clippedExtent,
    overscanExtent: 0,
  });
}

function buildPhysicalSnapshot<T>(store: PhysicalStore<T>, targetIndex?: number): VirtualTranscriptPhysicalSnapshot {
  const visibleRange = computeVisibleRange(store);
  const baseSnapshot = {
    renderedRange: normalizeRange(store.range),
    visibleRange: normalizeRange(visibleRange),
    viewportTop: store.viewportTop,
    layoutRevision: store.revision,
  } satisfies Omit<VirtualTranscriptPhysicalSnapshot, 'targetIndex' | 'targetOffset' | 'targetMeasured'>;
  if (targetIndex === undefined) return baseSnapshot;
  const offset = itemPhysicalOffset(store, targetIndex);
  return {
    ...baseSnapshot,
    targetIndex,
    targetOffset: offset === undefined ? null : offset - store.viewportTop,
    targetMeasured: store.measuredExtents.has(store.keys[targetIndex] ?? ''),
  };
}

function synchronizedPhysicalSnapshot<T>(store: PhysicalStore<T>, targetIndex?: number): VirtualTranscriptPhysicalSnapshot {
  store.viewportTop = store.scroller?.scrollTop ?? store.viewportTop;
  store.viewportExtent = store.scroller?.clientHeight ?? store.viewportExtent;
  recompute(store);
  return buildPhysicalSnapshot(store, targetIndex);
}

function measureOffsetForIndexInStore<T>(store: PhysicalStore<T>, index: number): number | null {
  const snapshot = synchronizedPhysicalSnapshot(store, index);
  return snapshot.targetIndex === index ? snapshot.targetOffset ?? null : null;
}

interface ResolvedPhysicalKeys {
  keys: string[];
  duplicateKeys: string[];
}

function resolvePhysicalKeys<T>(
  items: readonly T[],
  getKey: (item: T, index: number) => string,
): ResolvedPhysicalKeys {
  const semanticKeys = items.map(getKey);
  const reservedKeys = new Set(semanticKeys);
  const allocatedKeys = new Set<string>();
  const occurrences = new Map<string, number>();
  const duplicateKeys = new Set<string>();
  const keys = semanticKeys.map((semanticKey) => {
    const occurrence = occurrences.get(semanticKey) ?? 0;
    occurrences.set(semanticKey, occurrence + 1);
    if (occurrence === 0) {
      allocatedKeys.add(semanticKey);
      return semanticKey;
    }

    duplicateKeys.add(semanticKey);
    let discriminator = occurrence;
    let physicalKey = `${semanticKey}\u0000duplicate:${discriminator}`;
    while (reservedKeys.has(physicalKey) || allocatedKeys.has(physicalKey)) {
      discriminator += 1;
      physicalKey = `${semanticKey}\u0000duplicate:${discriminator}`;
    }
    allocatedKeys.add(physicalKey);
    return physicalKey;
  });
  return { keys, duplicateKeys: [...duplicateKeys] };
}

function measuredExtentMean<T>(store: PhysicalStore<T>): number | null {
  if (store.measuredExtents.size === 0) return null;
  let total = 0;
  for (const extent of store.measuredExtents.values()) total += extent;
  const mean = total / store.measuredExtents.size;
  return mean > 0 ? mean : null;
}

function estimatedExtentForKey<T>(store: PhysicalStore<T>) {
  // A scalar `estimatedExtent` carries no per-row information, so it is only a
  // seed for rows never yet measured; a caller-supplied function does carry
  // per-row information and is always authoritative. Refining the seed with the
  // mean of what has been measured is what bounds convergence: a row is measured
  // only while mounted, so every correction to the layout costs one nested
  // React update, and a seed that stays wrong drags the rendered window across
  // the list a screenful per round. Long transcripts then exceed React's nested
  // update limit and the whole tree is torn down mid-conversation.
  const adaptiveExtent = typeof store.estimatedExtent === 'function' ? null : measuredExtentMean(store);
  return (_key: string, index: number) => {
    if (adaptiveExtent !== null) return adaptiveExtent;
    const item = store.items[index];
    if (item === undefined) return DEFAULT_ESTIMATED_EXTENT;
    return typeof store.estimatedExtent === 'function'
      ? store.estimatedExtent(item, index)
      : store.estimatedExtent;
  };
}

function buildStoreLayout<T>(store: PhysicalStore<T>): TranscriptLayout {
  return buildTranscriptLayout({
    keys: store.keys,
    estimatedExtent: estimatedExtentForKey(store),
    measuredExtents: store.measuredExtents,
  });
}

function totalPhysicalExtent<T>(store: PhysicalStore<T>): number {
  return store.headerExtent + store.layout.totalExtent;
}

function rowViewportOffset<T>(store: PhysicalStore<T>): number {
  return Math.max(0, store.viewportTop - store.headerExtent);
}

function itemPhysicalOffset<T>(store: PhysicalStore<T>, index: number): number | undefined {
  const item = store.layout.itemAt(index);
  return item ? store.headerExtent + item.offset : undefined;
}

function itemPhysicalEnd<T>(store: PhysicalStore<T>, index: number): number | undefined {
  const item = store.layout.itemAt(index);
  return item ? store.headerExtent + item.end : undefined;
}

function computePinned<T>(store: PhysicalStore<T>): boolean {
  const maxScrollTop = Math.max(0, totalPhysicalExtent(store) - store.viewportExtent);
  return maxScrollTop - store.viewportTop <= PINNED_EPSILON;
}

function computeRange<T>(store: PhysicalStore<T>): TranscriptRange | null {
  return store.layout.rangeForViewport({
    viewportOffset: rowViewportOffset(store),
    viewportExtent: store.viewportExtent,
    overscanExtent: store.overscan,
  });
}

function setScrollerScrollTop<T>(store: PhysicalStore<T>, nextTop: number): void {
  const scroller = store.scroller;
  const maxScrollTop = Math.max(0, totalPhysicalExtent(store) - store.viewportExtent);
  const scrollTop = Math.max(0, Math.min(nextTop, maxScrollTop));
  store.viewportTop = scrollTop;
  if (scroller && scroller.scrollTop !== scrollTop) {
    scroller.scrollTop = scrollTop;
  }
}

function captureTopAnchor<T>(store: PhysicalStore<T>): VirtualTranscriptAnchor | null {
  if (store.layout.count === 0) return null;
  const index = store.layout.indexAtOffset(rowViewportOffset(store));
  const unit = store.layout.itemAt(index);
  if (!unit) return null;
  return {
    index,
    key: unit.key,
    offset: store.headerExtent + unit.offset - store.viewportTop,
  };
}

function applyAnchor<T>(store: PhysicalStore<T>, anchor: VirtualTranscriptAnchor | null): void {
  if (!anchor) {
    setScrollerScrollTop(store, store.viewportTop);
    return;
  }
  const nextOffset = store.layout.offsetForKey(anchor.key);
  if (nextOffset === undefined) {
    setScrollerScrollTop(store, store.viewportTop);
    return;
  }
  setScrollerScrollTop(store, store.headerExtent + nextOffset - anchor.offset);
}

function recompute<T>(store: PhysicalStore<T>): void {
  store.layout = buildStoreLayout(store);
  store.range = computeRange(store);
  store.pinned = computePinned(store);
  store.revision += 1;
}

function measureElementExtent(element: Element): number {
  return clampNonNegative(element.getBoundingClientRect().height);
}

function updateMeasuredExtent<T>(store: PhysicalStore<T>, key: string, nextExtent: number): boolean {
  if (store.measuredExtents.get(key) === nextExtent) return false;
  store.measuredExtents.set(key, nextExtent);
  return true;
}

function applyPhysicalChange<T>(store: PhysicalStore<T>, anchor: VirtualTranscriptAnchor | null, wasPinned: boolean): void {
  store.layout = buildStoreLayout(store);
  if (store.scroller && (wasPinned || store.initialTailPending)) {
    store.initialTailPending = false;
    setScrollerScrollTop(store, totalPhysicalExtent(store));
  } else if (!store.initialTailPending) {
    applyAnchor(store, anchor);
  }
  store.activeAnchor = anchor;
  recompute(store);
}

function handleResizeEntries<T>({ store, publish }: StorePublisher<T>, entries: ResizeObserverEntry[]): void {
  let physicalChanged = false;
  let viewportChanged = false;
  const anchor = store.pinned ? null : (store.activeAnchor ?? captureTopAnchor(store));
  const wasPinned = store.pinned;

  for (const entry of entries) {
    const target = entry.target;
    const entryHeight = clampNonNegative(entry.contentRect.height);
    if (target === store.scroller) {
      const nextExtent = entryHeight || store.scroller?.clientHeight || 0;
      if (store.viewportExtent !== nextExtent) {
        store.viewportExtent = clampNonNegative(nextExtent);
        viewportChanged = true;
      }
      const nextTop = store.scroller?.scrollTop ?? store.viewportTop;
      if (store.viewportTop !== nextTop) {
        store.viewportTop = nextTop;
        viewportChanged = true;
      }
      continue;
    }

    if (target === store.headerElement) {
      const nextExtent = entryHeight || measureElementExtent(target);
      if (store.headerExtent !== nextExtent) {
        store.headerExtent = nextExtent;
        physicalChanged = true;
      }
      continue;
    }

    if (target instanceof HTMLElement) {
      const key = target.dataset['virtualKey'];
      if (!key) continue;
      const nextExtent = entryHeight || measureElementExtent(target);
      physicalChanged = updateMeasuredExtent(store, key, nextExtent) || physicalChanged;
    }
  }

  if (physicalChanged) {
    applyPhysicalChange(store, anchor, wasPinned);
    publish();
    return;
  }

  if (viewportChanged) {
    recompute(store);
    publish();
  }
}

function ensureResizeObserver<T>(store: PhysicalStore<T>, publish: () => void): ResizeObserver | null {
  if (store.resizeObserver) return store.resizeObserver;
  if (typeof ResizeObserver === 'undefined') return null;
  store.resizeObserver = new ResizeObserver((entries) => handleResizeEntries({ store, publish }, entries));
  return store.resizeObserver;
}

function observeElement<T>(store: PhysicalStore<T>, publish: () => void, element: Element): void {
  ensureResizeObserver(store, publish)?.observe(element);
}

function unobserveElement<T>(store: PhysicalStore<T>, element: Element | null): void {
  if (element) store.resizeObserver?.unobserve(element);
}

function createStore<T>(props: VirtualTranscriptProps<T>): PhysicalStore<T> {
  const resolvedKeys = resolvePhysicalKeys(props.items, props.getKey);
  const keys = resolvedKeys.keys;
  const store: PhysicalStore<T> = {
    items: props.items,
    keys,
    getKey: props.getKey,
    estimatedExtent: props.estimatedExtent,
    measuredExtents: new Map(),
    headerExtent: 0,
    layout: buildTranscriptLayout({ keys: [], estimatedExtent: DEFAULT_ESTIMATED_EXTENT }),
    range: null,
    viewportTop: 0,
    viewportExtent: 0,
    overscan: clampNonNegative(props.overscan ?? 0),
    activeAnchor: null,
    scroller: null,
    headerElement: null,
    rowElements: new Map(),
    resizeObserver: null,
    initialTailPending: props.initialTail ?? true,
    preservedViewport: null,
    pinned: true,
    revision: 0,
  };
  recompute(store);
  return store;
}

function VirtualTranscriptInner<T>(
  props: VirtualTranscriptProps<T>,
  ref: React.ForwardedRef<VirtualTranscriptHandle>,
) {
  const {
    items,
    getKey,
    renderItem,
    header,
    empty,
    overscan = 0,
    estimatedExtent,
    className,
    scrollerId,
    scrollerRef,
    onRangeChange,
    onTotalExtentChange,
    onPinnedChange,
  } = props;
  const storeRef = useRef<PhysicalStore<T> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStore(props);
  }
  const store = storeRef.current;
  const resolvedPhysicalKeys = useMemo(
    () => resolvePhysicalKeys(items, getKey),
    [getKey, items],
  );
  const duplicateKeySignature = JSON.stringify(resolvedPhysicalKeys.duplicateKeys);
  const lastReportedDuplicateKeySignature = useRef('[]');
  const [, publishRevision] = useReducer((revision: number) => revision + 1, 0);

  if (
    store.items !== items ||
    store.getKey !== getKey ||
    store.estimatedExtent !== estimatedExtent ||
    store.overscan !== clampNonNegative(overscan)
  ) {
    const anchor = store.pinned ? null : captureTopAnchor(store);
    const wasPinned = store.pinned;
    store.items = items;
    store.getKey = getKey;
    store.keys = resolvedPhysicalKeys.keys;
    store.estimatedExtent = estimatedExtent;
    store.overscan = clampNonNegative(overscan);
    const presentKeys = new Set(store.keys);
    for (const key of store.measuredExtents.keys()) {
      if (!presentKeys.has(key)) store.measuredExtents.delete(key);
    }
    applyPhysicalChange(store, anchor, wasPinned);
  }

  // Depth of the current measure→relayout chain. The flag is cleared during
  // render, so only a publish issued from the commit phase of that render — a
  // row ref reporting a new measurement — is still set when the layout effect
  // below runs. A commit that measures nothing new ends the chain, which is what
  // keeps independent publishes (a scroll, then a resize) from accumulating.
  const chainDepth = useRef(0);
  const publishedDuringCommit = useRef(false);
  const deferredPublishHandle = useRef(0);
  publishedDuringCommit.current = false;

  const publish = useCallback(() => {
    if (chainDepth.current >= MAX_NESTED_RELAYOUT_ROUNDS) {
      if (deferredPublishHandle.current !== 0) return;
      deferredPublishHandle.current = requestAnimationFrame(() => {
        deferredPublishHandle.current = 0;
        chainDepth.current = 0;
        publishRevision();
      });
      return;
    }
    publishedDuringCommit.current = true;
    publishRevision();
  }, []);

  // Runs after every commit, and after the row refs of that commit have
  // attached, so it observes whether the commit extended the chain.
  useLayoutEffect(() => {
    if (publishedDuringCommit.current) {
      chainDepth.current += 1;
      return;
    }
    chainDepth.current = 0;
  });

  useEffect(() => () => {
    if (deferredPublishHandle.current !== 0) cancelAnimationFrame(deferredPublishHandle.current);
    deferredPublishHandle.current = 0;
  }, []);

  useEffect(() => {
    if (duplicateKeySignature === lastReportedDuplicateKeySignature.current) return;
    lastReportedDuplicateKeySignature.current = duplicateKeySignature;
    if (resolvedPhysicalKeys.duplicateKeys.length === 0) return;
    console.error('[VirtualTranscript] duplicate semantic keys quarantined', {
      duplicateKeys: resolvedPhysicalKeys.duplicateKeys,
    });
  }, [duplicateKeySignature, resolvedPhysicalKeys]);

  const rowRefCallbacks = useRef(new Map<string, (element: HTMLDivElement | null) => void>());

  const getRowRef = useCallback((key: string) => {
    let callback = rowRefCallbacks.current.get(key);
    if (callback) return callback;
    callback = (element: HTMLDivElement | null) => {
      const current = storeRef.current;
      if (!current) return;
      const previous = current.rowElements.get(key) ?? null;
      if (previous && previous !== element) {
        unobserveElement(current, previous);
        current.rowElements.delete(key);
      }
      if (!element) return;
      current.rowElements.set(key, element);
      const anchor = current.pinned ? null : (current.activeAnchor ?? captureTopAnchor(current));
      const wasPinned = current.pinned;
      const changed = updateMeasuredExtent(current, key, measureElementExtent(element));
      observeElement(current, publish, element);
      if (changed) {
        applyPhysicalChange(current, anchor, wasPinned);
        publish();
      }
    };
    rowRefCallbacks.current.set(key, callback);
    return callback;
  }, [publish]);

  const headerCallback = useCallback((element: HTMLDivElement | null) => {
    const current = storeRef.current;
    if (!current) return;
    if (current.headerElement && current.headerElement !== element) {
      unobserveElement(current, current.headerElement);
    }
    current.headerElement = element;
    const anchor = current.pinned ? null : captureTopAnchor(current);
    const wasPinned = current.pinned;
    const nextExtent = element ? measureElementExtent(element) : 0;
    const changed = current.headerExtent !== nextExtent;
    current.headerExtent = nextExtent;
    if (element) observeElement(current, publish, element);
    if (changed) {
      applyPhysicalChange(current, anchor, wasPinned);
      publish();
    }
  }, [publish]);

  const scrollerCallback = useCallback((element: HTMLDivElement | null) => {
    const current = storeRef.current;
    if (!current) return;
    if (current.scroller && current.scroller !== element) {
      unobserveElement(current, current.scroller);
    }
    current.scroller = element;
    if (element) {
      current.viewportTop = element.scrollTop;
      current.viewportExtent = element.clientHeight;
      observeElement(current, publish, element);
      if (current.initialTailPending && current.layout.count > 0) {
        current.initialTailPending = false;
        setScrollerScrollTop(current, totalPhysicalExtent(current));
      }
    }
    recompute(current);
    scrollerRef?.(element);
  }, [publish, scrollerRef]);


  useLayoutEffect(() => {
    const current = storeRef.current;
    if (!current) return;
    const nextKeys = resolvedPhysicalKeys.keys;
    const preserved = current.preservedViewport;
    const prefixInserted = preserved !== null
      && preserved.firstKey !== null
      && nextKeys.indexOf(preserved.firstKey) > 0;
    if (prefixInserted) {
      current.preservedViewport = null;
      current.viewportTop = preserved.top;
    }
    const anchor = prefixInserted || current.pinned ? null : captureTopAnchor(current);
    const wasPinned = !prefixInserted && current.pinned;
    current.items = items;
    current.getKey = getKey;
    current.keys = nextKeys;
    current.estimatedExtent = estimatedExtent;
    current.overscan = clampNonNegative(overscan);
    const presentKeys = new Set(current.keys);
    for (const key of current.measuredExtents.keys()) {
      if (!presentKeys.has(key)) current.measuredExtents.delete(key);
    }
    applyPhysicalChange(current, anchor, wasPinned);
    publish();
  }, [estimatedExtent, getKey, items, overscan, publish, resolvedPhysicalKeys]);

  // Element identity is owned by the ref callbacks; this effect owns only the
  // ResizeObserver subscription. React invokes a ref callback again only when the
  // element or the callback identity changes, so anything this cleanup tears down
  // is never rebuilt by the refs alone. StrictMode's simulated remount runs the
  // cleanup while the elements stay mounted, so tearing down element identity here
  // would detach the store from its scroller for good: scroll events and resize
  // measurements stop reaching it, the rendered range freezes wherever it was, and
  // the viewport lands inside a spacer with no rows in it. Re-observing what the
  // store still references keeps this effect symmetric with its cleanup.
  useLayoutEffect(() => {
    const current = storeRef.current;
    if (current) {
      if (current.scroller) observeElement(current, publish, current.scroller);
      if (current.headerElement) observeElement(current, publish, current.headerElement);
      for (const element of current.rowElements.values()) {
        observeElement(current, publish, element);
      }
    }
    return () => {
      current?.resizeObserver?.disconnect();
      if (current) current.resizeObserver = null;
    };
  }, [publish]);

  useLayoutEffect(() => {
    onRangeChange?.(buildPhysicalSnapshot(store));
  }, [onRangeChange, store, store.range, store.revision]);

  const totalExtent = totalPhysicalExtent(store);
  const pinned = store.pinned;

  useLayoutEffect(() => {
    onTotalExtentChange?.(totalExtent);
  }, [onTotalExtentChange, totalExtent]);

  useLayoutEffect(() => {
    onPinnedChange?.(pinned);
  }, [onPinnedChange, pinned]);

  useImperativeHandle(ref, () => ({
    scrollToIndex(index, align, viewportStartOffset = 0) {
      const current = storeRef.current;
      if (!current) return;
      const unit = current.layout.itemAt(index);
      if (!unit) return;
      const physicalOffset = current.headerExtent + unit.offset;
      const physicalEnd = current.headerExtent + unit.end;
      const target = align === 'end'
        ? physicalEnd - current.viewportExtent + viewportStartOffset
        : physicalOffset - viewportStartOffset;
      current.activeAnchor = { index, key: unit.key, offset: physicalOffset - target };
      setScrollerScrollTop(current, target);
      recompute(current);
      publish();
    },
    scrollToTail() {
      const current = storeRef.current;
      if (!current) return;
      current.activeAnchor = null;
      setScrollerScrollTop(current, totalPhysicalExtent(current));
      recompute(current);
      publish();
    },
    captureVisibleAnchor() {
      const current = storeRef.current;
      if (!current) return null;
      current.viewportTop = current.scroller?.scrollTop ?? current.viewportTop;
      const anchor = captureTopAnchor(current);
      current.activeAnchor = anchor;
      recompute(current);
      publish();
      return anchor;
    },
    preserveViewportOnNextItemsChange() {
      const current = storeRef.current;
      if (!current) return;
      current.preservedViewport = {
        top: current.scroller?.scrollTop ?? current.viewportTop,
        firstKey: current.keys[0] ?? null,
      };
      current.activeAnchor = null;
    },
    measureOffsetForIndex(index) {
      const current = storeRef.current;
      if (!current) return null;
      return measureOffsetForIndexInStore(current, index);
    },
    measureOffsetForIndexAtSnapshot(index, snapshot) {
      if (snapshot.targetIndex !== index) return null;
      return snapshot.targetOffset ?? null;
    },
    layoutRevision() {
      return storeRef.current?.revision ?? 0;
    },
    physicalSnapshot(targetIndex) {
      const current = storeRef.current;
      return current
        ? synchronizedPhysicalSnapshot(current, targetIndex)
        : {
            renderedRange: null,
            visibleRange: null,
            viewportTop: 0,
            layoutRevision: 0,
            ...(targetIndex === undefined ? {} : { targetIndex, targetOffset: null, targetMeasured: false }),
          };
    },
  }), [publish]);

  const handleScroll = useCallback(() => {
    const current = storeRef.current;
    if (!current?.scroller) return;
    current.viewportTop = current.scroller.scrollTop;
    if (current.preservedViewport) current.preservedViewport.top = current.viewportTop;
    current.viewportExtent = current.scroller.clientHeight;
    current.activeAnchor = captureTopAnchor(current);
    recompute(current);
    publish();
  }, [publish]);

  const range = store.range;
  const visibleItems = range
    ? items.slice(range.startIndex, range.endIndex + 1)
    : [];
  const topSpacer = range ? store.layout.itemAt(range.startIndex)?.offset ?? 0 : 0;
  const rangePhysicalEnd = range ? itemPhysicalEnd(store, range.endIndex) ?? store.headerExtent : store.headerExtent;
  const bottomSpacer = range
    ? Math.max(0, totalPhysicalExtent(store) - rangePhysicalEnd)
    : Math.max(0, totalPhysicalExtent(store) - store.headerExtent);
  const rootClassName = className ? `virtual-transcript ${className}` : 'virtual-transcript';

  return (
    <div
      ref={scrollerCallback}
      id={scrollerId}
      className={rootClassName}
      style={{ overflowAnchor: 'none' }}
      onScroll={handleScroll}
    >
      <div className="virtual-transcript__inner" style={{ height: totalExtent }}>
        {header ? (
          <div ref={headerCallback} className="virtual-transcript__header" data-virtual-header="true">
            {header}
          </div>
        ) : null}
        {items.length === 0 ? (
          <div className="virtual-transcript__empty">{empty}</div>
        ) : (
          <>
            <div className="virtual-transcript__spacer" style={{ height: topSpacer }} />
          {visibleItems.map((item, offset) => {
            const index = (range?.startIndex ?? 0) + offset;
            const key = store.keys[index]!;
            return (
              <div
                key={key}
                ref={getRowRef(key)}
                className="virtual-transcript__row"
                data-virtual-index={index}
                data-virtual-key={key}
              >
                {renderItem(item, index)}
              </div>
            );
          })}
            <div className="virtual-transcript__spacer" style={{ height: bottomSpacer }} />
          </>
        )}
      </div>
    </div>
  );
}

export const VirtualTranscript = forwardRef(VirtualTranscriptInner) as <T>(
  props: VirtualTranscriptProps<T> & { ref?: React.ForwardedRef<VirtualTranscriptHandle> },
) => ReturnType<typeof VirtualTranscriptInner>;
