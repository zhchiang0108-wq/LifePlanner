export type Slot = { start: number; end: number };

// 時段採用 [start, end)，相接的邊界不算重疊。
export function overlaps(first: Slot, second: Slot): boolean {
  return first.start < second.end && second.start < first.end;
}
