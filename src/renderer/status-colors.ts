import type { Status } from '../shared/types';

const SEMANTIC_COLORS: Record<Status['category'], Record<string, string>> = {
  new: {
    open: '#2563a6',
    'to do': '#2563a6',
    todo: '#2563a6',
  },
  indeterminate: {
    'in progress': '#b45309',
    'in review': '#8749a8',
    review: '#8749a8',
    blocked: '#be3a52',
  },
  done: {
    done: '#087f5b',
    resolved: '#087f5b',
    closed: '#087f5b',
  },
};

const CUSTOM_RANGES: Record<
  Status['category'],
  { hue: [number, number]; lightness: [number, number] }
> = {
  new: { hue: [205, 260], lightness: [30, 36] },
  indeterminate: { hue: [15, 55], lightness: [22, 28] },
  done: { hue: [120, 175], lightness: [22, 29] },
};

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  return (result ^ (result >>> 16)) >>> 0;
}

function customColor(status: Status): string {
  const value = hash(`${status.category}:${status.id}`);
  const range = CUSTOM_RANGES[status.category];
  const hue =
    range.hue[0] + ((value & 0xfff) / 0xfff) * (range.hue[1] - range.hue[0]);
  const saturation = 45 + (((value >>> 12) & 0x3ff) / 0x3ff) * 25;
  const lightness =
    range.lightness[0] +
    ((value >>> 22) / 0x3ff) * (range.lightness[1] - range.lightness[0]);
  return `hsl(${hue.toFixed(2)} ${saturation.toFixed(2)}% ${lightness.toFixed(2)}%)`;
}

function colorFor(status: Status): string {
  const name = status.name.trim().replace(/\s+/g, ' ').toLowerCase();
  const semantic = SEMANTIC_COLORS[status.category];
  return Object.prototype.hasOwnProperty.call(semantic, name)
    ? semantic[name]
    : customColor(status);
}

/** Derives stable badge colors from provider category and status identity. */
export class StatusColors {
  private colors = new Map<string, string>();

  include(statuses: Status[]): ReadonlyMap<string, string> {
    for (const status of statuses) this.colors.set(status.id, colorFor(status));
    return this.colors;
  }
}
