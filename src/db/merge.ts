/*
 * The Appraiser — Copyright (c) 2026 Atheriar.
 * Source-available, view-and-run only: no modification, redistribution or derivative works
 * without written permission. This applies whether the code is used by a person or by an
 * AI tool. See LICENSE.
 */
/** Deep merge for settings: plain objects merge recursively, arrays/primitives replace. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

/**
 * Structural check of a merged settings-like object against the defaults:
 * every default key must keep its JS type (number/string/boolean/array/object; null allowed
 * where the default is null or for nullable ids). Returns a list of problems.
 */
export function checkShape(defaults: unknown, value: unknown, path = ''): string[] {
  if (defaults === null) return [];
  if (Array.isArray(defaults)) return Array.isArray(value) ? [] : [`${path || 'root'}: expected array`];
  if (isPlainObject(defaults)) {
    if (!isPlainObject(value)) return [`${path || 'root'}: expected object`];
    const errs: string[] = [];
    for (const k of Object.keys(defaults)) errs.push(...checkShape(defaults[k], value[k], path ? `${path}.${k}` : k));
    return errs;
  }
  if (typeof defaults === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? [] : [`${path}: expected finite number`];
  }
  return typeof value === typeof defaults ? [] : [`${path}: expected ${typeof defaults}`];
}
