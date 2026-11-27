import type { ConnectionDef, PointDef, SlaveDef } from './model';
import type { RawType } from './mapping';
import { canReadPoint, canWritePoint } from './point-access';
import { ScriptBlockError, type ScriptPointRef } from './master-script';

export interface ScriptPointTarget { connection: ConnectionDef; slave: SlaveDef; point: PointDef }
type Access = 'read' | 'write';
export interface ScriptPointUse { blockId: string; ref: ScriptPointRef; access: Access | 'range' | 'ordered' }

export function resolveScriptPoint<T extends ScriptPointTarget>(target: T | undefined, ref: ScriptPointRef, access: Access) {
  if (!target || target.connection.role === 'slave' || target.slave.id !== ref.slaveId || target.point.id !== ref.pointId)
    throw new Error(`积木绑定的主站点位已失效，请重新选择${access === 'read' ? '可读点位' : '可写点位'}`);
  const { connection, slave, point } = target;
  const label = `${connection.name} / ${slave.name} (Unit ${slave.unitId}) / ${point.name}`;
  if (!slave.enabled) throw new Error(`${label} · 从站已停用`);
  if (access === 'read' && !canReadPoint(point)) throw new Error(`${label} · 点位为只写`);
  if (access === 'write' && !canWritePoint(point)) throw new Error(`${label} · 点位为只读`);
  return { target, label, type: point.mapping.rawType };
}

export function checkScriptPoints(uses: readonly ScriptPointUse[], resolve: (ref: ScriptPointRef, access: Access) => { label: string; type: RawType }) {
  for (const { blockId, ref, access } of uses) {
    try {
      const { type, label } = resolve(ref, access === 'write' ? 'write' : 'read');
      if (type === 'Bool' || type === 'String') {
        if (access === 'range') throw new Error(`${label} 需要使用数值点位`);
        if (access === 'ordered') throw new Error(`${label} 支持等于和不等于比较`);
      }
    } catch (error) {
      throw new ScriptBlockError(error instanceof Error ? error.message : String(error), blockId);
    }
  }
}
