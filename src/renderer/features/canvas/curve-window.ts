import { createContext } from 'react';

export interface CurveWindow { windowMs: number; endMs?: number }
export const CurveWindowContext = createContext<(id: string, window: CurveWindow | undefined) => void>(() => undefined);
