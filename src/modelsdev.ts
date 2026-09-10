/**
 * Per-token prices from models.dev.
 *
 * The public catalog is fetched explicitly by `sonata catalog update`, cached
 * under the user's config directory, and never committed to this repository.
 * Only hand-written synthetic fixtures are checked in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Rates } from './config.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODELS_DEV_ATTRIBUTION = 'Prices from models.dev — https://models.dev';

export interface ModelsDevCache {
  fetchedAt: string;
  /** provider id -> model id -> USD-per-million-token rates */
  providers: Record<string, Record<string, Rates>>;
}

export function modelsDevPath(home: string): string {
  return join(home, '.config', 'sonata', 'models-dev.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Extract usable base rates; long-context and tier rates require request size. */
export function normalizeModelsDev(doc: unknown): ModelsDevCache['providers'] {
  if (!isRecord(doc)) return {};
  const providers: ModelsDevCache['providers'] = {};
  for (const [providerId, rawProvider] of Object.entries(doc)) {
    if (providerId === '' || !isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
    const models: Record<string, Rates> = {};
    for (const [modelId, rawModel] of Object.entries(rawProvider.models)) {
      if (modelId === '' || !isRecord(rawModel) || !isRecord(rawModel.cost)) continue;
      const cost = rawModel.cost;
      const rates: Rates = {};
      if (validRate(cost.input)) rates.input = cost.input;
      if (validRate(cost.output)) rates.output = cost.output;
      if (validRate(cost.cache_read)) rates.cachedInput = cost.cache_read;
      if (validRate(cost.cache_write)) rates.cacheWrite = cost.cache_write;
      if (Object.keys(rates).length > 0) models[modelId] = rates;
    }
    if (Object.keys(models).length > 0) providers[providerId] = models;
  }
  return providers;
}

export function loadModelsDev(home: string): ModelsDevCache | undefined {
  const path = modelsDevPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as ModelsDevCache;
    if (typeof doc.fetchedAt !== 'string') return undefined;
    if (!isRecord(doc.providers) || !providersAreValid(doc.providers)) return undefined;
    return doc;
  } catch {
    return undefined;
  }
}

const RATE_KEYS: ReadonlySet<string> = new Set(['input', 'cachedInput', 'cacheWrite', 'output']);

/** Reject records that `costOf` would otherwise silently treat as zero. */
function providersAreValid(providers: Record<string, Record<string, Rates>>): boolean {
  if (Object.keys(providers).length === 0) return false;
  for (const [providerId, models] of Object.entries(providers)) {
    if (providerId === '' || !isRecord(models) || Object.keys(models).length === 0) return false;
    for (const [modelId, rates] of Object.entries(models)) {
      if (modelId === '' || !isRecord(rates)) return false;
      const entries = Object.entries(rates);
      if (entries.length === 0) return false;
      for (const [key, value] of entries) {
        if (!RATE_KEYS.has(key) || !validRate(value)) return false;
      }
    }
  }
  return true;
}
