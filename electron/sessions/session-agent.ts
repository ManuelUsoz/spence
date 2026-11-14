import { Context, Layer } from 'effect';
import type { AgentId } from '../../src/shared/agents/agents.rpc';
import { catalog, type CatalogEntry } from '../agents/catalog';
import { claude } from '../agents/claude/claude';
import { e2eBin, e2eFakeAgent } from '../agents/e2e-agent';

/** The Agents available to Sessions: the multi-Agent Catalog in production, or the fake Agent under default e2e. */
export interface AgentCatalogShape {
  readonly entries: ReadonlyArray<CatalogEntry>;
  readonly get: (id: AgentId) => CatalogEntry | undefined;
  readonly fallbackId: AgentId;
}

export const makeAgentCatalog = (
  entries: ReadonlyArray<CatalogEntry>,
  fallbackId: AgentId = entries[0]?.id ?? claude.id,
): AgentCatalogShape => ({
  entries,
  get: (id) => entries.find((entry) => entry.id === id),
  fallbackId,
});

export class AgentCatalog extends Context.Service<AgentCatalog, AgentCatalogShape>()(
  'sessions/AgentCatalog',
) {}

/** The live Agent Catalog: `[e2eFakeAgent]` under standard e2e, or the full `catalog` otherwise. */
export const layerAgentCatalogLive = Layer.succeed(
  AgentCatalog,
  e2eBin !== undefined && process.env['SPENCE_E2E_CATALOG'] !== '1'
    ? makeAgentCatalog([e2eFakeAgent], e2eFakeAgent.id)
    : makeAgentCatalog(catalog, claude.id),
);
