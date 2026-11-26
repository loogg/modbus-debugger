import type { LuaSource } from '../../../domain/script-lua-source';

export interface ScriptPreview {
  source: LuaSource | null;
  issue: { message: string; blockId?: string } | null;
}
