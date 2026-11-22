import type pg from 'pg';
import type { Config } from './config.js';
import { LearningService, type MemoryGateway, type Pack } from './learning.js';
import { mekoMemoryGateway } from './integrations/meko.js';
import { localMemoryGateway } from './integrations/local-memory.js';

export function createLearning(pool: pg.Pool, config: Config, scopeConfirmed = false) {
  if (config.MEMORY_STORE === 'local') {
    return new LearningService(pool, { confirmed: localMemoryGateway(), risk: localMemoryGateway() }, config.MEKO_TIMEOUT_MS, scopeConfirmed);
  }
  if (!config.MEKO_API_KEY) return undefined;
  const packs: Partial<Record<Pack, MemoryGateway>> = {};
  if (config.MEKO_DATAPACK_ID) packs.confirmed = mekoMemoryGateway(config.MEKO_API_KEY, config.MEKO_DATAPACK_ID);
  if (config.MEKO_RISK_SIGNALS_DATAPACK_ID) packs.risk = mekoMemoryGateway(config.MEKO_API_KEY, config.MEKO_RISK_SIGNALS_DATAPACK_ID);
  return new LearningService(pool, packs, config.MEKO_TIMEOUT_MS, scopeConfirmed);
}
