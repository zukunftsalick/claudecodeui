import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { XcodeCloudBuildRun, XcodeCloudProduct, XcodeCloudWorkflow } from '@/shared/types';

// Builds in progress change every few seconds; finished ones rarely.
const ACTIVE_POLL_MS = 15_000;
const IDLE_POLL_MS = 60_000;
const SELECTED_PRODUCT_STORAGE_KEY = 'xcode-cloud:selected-product';

const readStoredProductId = (): string | null => {
  try {
    return localStorage.getItem(SELECTED_PRODUCT_STORAGE_KEY);
  } catch {
    return null;
  }
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Loads Xcode Cloud data for the Builds tab: whether a key is set up, the
 * products, and the chosen product's workflows and builds, refreshing builds
 * while the tab is visible (faster while one is running).
 */
export function useXcodeCloud(isVisible: boolean) {
  // null until the server says whether an App Store Connect key is set up.
  const [configured, setConfigured] = useState<boolean | null>(null);
  // Xcode Cloud products for the key; the picker's options.
  const [products, setProducts] = useState<XcodeCloudProduct[]>([]);
  // The product being shown; remembered per browser.
  const [productId, setProductId] = useState<string | null>(readStoredProductId);
  // The shown product's workflows, each with a Start build button.
  const [workflows, setWorkflows] = useState<XcodeCloudWorkflow[]>([]);
  // The shown product's recent builds, newest first.
  const [buildRuns, setBuildRuns] = useState<XcodeCloudBuildRun[]>([]);
  // True while the first load for a product is in flight.
  const [loading, setLoading] = useState(false);
  // The last load error, shown above the list; cleared by the next success.
  const [error, setError] = useState<string | null>(null);
  // When the build list last refreshed, shown as "updated ... ago".
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const buildRunsRef = useRef(buildRuns);
  buildRunsRef.current = buildRuns;

  // Key status and products, once per mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await readApiJson<{ configured: boolean }>(await api.xcodeCloud.status());
        if (cancelled) return;
        setConfigured(status.configured);
        if (!status.configured) return;
        const result = await readApiJson<{ products: XcodeCloudProduct[] }>(await api.xcodeCloud.products());
        if (cancelled) return;
        setProducts(result.products);
        setProductId((current) => (
          current && result.products.some((product) => product.id === current) ? current : result.products[0]?.id ?? null
        ));
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshBuildRuns = useCallback(async (id: string) => {
    const result = await readApiJson<{ buildRuns: XcodeCloudBuildRun[] }>(await api.xcodeCloud.buildRuns(id));
    setBuildRuns(result.buildRuns);
    setLastUpdated(Date.now());
    setError(null);
  }, []);

  // Workflows and builds whenever the product changes.
  useEffect(() => {
    if (!productId) return undefined;
    try {
      localStorage.setItem(SELECTED_PRODUCT_STORAGE_KEY, productId);
    } catch {
      // Storage unavailable: the choice just isn't remembered.
    }
    let cancelled = false;
    setLoading(true);
    setWorkflows([]);
    setBuildRuns([]);
    (async () => {
      try {
        const [workflowResult] = await Promise.all([
          readApiJson<{ workflows: XcodeCloudWorkflow[] }>(await api.xcodeCloud.workflows(productId)),
          refreshBuildRuns(productId),
        ]);
        if (!cancelled) setWorkflows(workflowResult.workflows);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId, refreshBuildRuns]);

  // Keep builds fresh while the tab is on screen.
  useEffect(() => {
    if (!isVisible || !productId) return undefined;
    let timer: number | null = null;
    let cancelled = false;
    const schedule = () => {
      const anyActive = buildRunsRef.current.some((run) => run.executionProgress !== 'COMPLETE');
      timer = window.setTimeout(tick, anyActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    const tick = async () => {
      if (!document.hidden) {
        try {
          await refreshBuildRuns(productId);
        } catch (loadError) {
          if (!cancelled) setError(errorMessage(loadError));
        }
      }
      if (!cancelled) schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isVisible, productId, refreshBuildRuns]);

  const startBuild = useCallback(async (body: Parameters<typeof api.xcodeCloud.startBuild>[0]) => {
    await readApiJson(await api.xcodeCloud.startBuild(body));
    if (productId) await refreshBuildRuns(productId);
  }, [productId, refreshBuildRuns]);

  const refresh = useCallback(async () => {
    if (!productId) return;
    try {
      await refreshBuildRuns(productId);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, [productId, refreshBuildRuns]);

  return {
    configured,
    products,
    product: products.find((product) => product.id === productId) ?? null,
    setProductId,
    workflows,
    buildRuns,
    loading,
    error,
    lastUpdated,
    startBuild,
    refresh,
  };
}
