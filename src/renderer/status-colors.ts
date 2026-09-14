import type { Status } from '../shared/types';

const PALETTE = [
  '#2563a6',
  '#8749a8',
  '#087f5b',
  '#b45309',
  '#be3a52',
  '#4f46a5',
  '#0e7490',
  '#6b6617',
  '#985130',
  '#7b3572',
  '#315975',
  '#436832',
];

/** Retains colors as statuses appear or disappear during polling and editing. */
export class StatusColors {
  private colors = new Map<string, string>();

  include(statuses: Status[]): ReadonlyMap<string, string> {
    for (const status of [...statuses].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      if (this.colors.has(status.id)) continue;
      const index = this.colors.size;
      const used = new Set(this.colors.values());
      const preferred =
        status.category === 'done'
          ? '#087f5b'
          : status.category === 'new'
            ? '#2563a6'
            : '#b45309';
      this.colors.set(
        status.id,
        (!used.has(preferred)
          ? preferred
          : PALETTE.find((color) => !used.has(color))) ??
          `hsl(${((index - PALETTE.length) * 137.508) % 360} 52% 34%)`,
      );
    }
    return this.colors;
  }
}
