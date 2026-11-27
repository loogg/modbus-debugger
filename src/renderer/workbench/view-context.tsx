import { createContext, useContext, useEffect, useId } from 'react';
import type { ViewSelection } from '../../shared/workbench';

export interface ViewEnvironment {
  openTarget?(module: 'canvas' | 'scripts', selection: Partial<ViewSelection>): void;
  document: Document;
  portalRoot: HTMLElement;
  active: boolean;
  guards: Map<string, () => boolean>;
}
export const ViewEnvironmentContext = createContext<ViewEnvironment | null>(null);
export const useViewEnvironment = () => useContext(ViewEnvironmentContext);
export const useViewDocument = () => useViewEnvironment()?.document ?? document;
export const useViewWindow = () => useViewDocument().defaultView ?? window;
export const usePortalRoot = () => useViewEnvironment()?.portalRoot;
export const useViewActive = () => useViewEnvironment()?.active ?? true;

/** A dirty view may move freely, but cannot be discarded without a decision. */
export function useDirtyGuard(dirty: boolean) {
  const environment = useViewEnvironment();
  const id = useId();
  useEffect(() => {
    environment?.guards.set(id, () => dirty);
    return () => { environment?.guards.delete(id); };
  }, [environment, id, dirty]);
}
