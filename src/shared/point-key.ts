/** A definition can be reused by many slaves; runtime values identify the instance. */
export const pointKey = (slaveId: string | null | undefined, pointId: string): string => slaveId ? `${slaveId}::${pointId}` : pointId;
