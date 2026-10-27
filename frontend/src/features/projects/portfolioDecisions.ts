import { useState } from 'react';
import { agentApi } from '../../api/endpoints';
import { invalidateWorkspace } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { portfolioApi, type DecisionOption, type PortfolioDecision, type PortfolioFilter } from './portfolioApi';
import { dayMonth, errText } from './projectParts';
import type { PortfolioBrief } from '../ai/aiApi';

/** One row of "Decisions this week": a forecast decision from the board, or a ranked project at risk that has none yet. */
export interface DecisionItem {
  projectId: string; key: string; name: string; due: string | null; forecast: string | null; why: string; slipDays: number;
  decision: PortfolioDecision | null; acceptOpt: DecisionOption | null; changes: string[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Decisions first (one per project), then the ranked projects in trouble that have no decision; de-duplicated by project id. */
export function decisionItems(decisions: PortfolioDecision[], brief: PortfolioBrief): DecisionItem[] {
  const seen = new Map<string, DecisionItem>();
  for (const d of decisions) {
    if (seen.has(d.projectId)) continue;
    const acceptOpt = d.options.find((o) => o.kind === 'accept_date') ?? null;
    const forecast = acceptOpt?.finish ?? d.finish ?? null;
    const changes = [...d.causes.map(cap), ...d.options.filter((o) => o.kind !== 'accept_date').map((o) => `${o.title}: ${o.effect}`)];
    seen.set(d.projectId, {
      projectId: d.projectId, key: d.key, name: d.name, due: d.dueDate, forecast, slipDays: d.slipDays, decision: d, acceptOpt,
      why: d.causes.length ? `${d.causes.slice(0, 2).map(cap).join('. ')}.` : d.headline, changes,
    });
  }
  for (const r of brief.ranked) {
    if (r.score < 2 || seen.has(r.projectId)) continue;
    seen.set(r.projectId, {
      projectId: r.projectId, key: r.key, name: r.name, due: r.dueDate, forecast: r.projectedFinish, slipDays: r.projectedSlipDays ?? r.delayedDays,
      decision: null, acceptOpt: null, why: r.reasons[0] ?? `${r.level} risk.`, changes: r.reasons,
    });
  }
  return [...seen.values()];
}

/** Accept (propose and approve the new date at once) and Propose (leave the date proposal for approval), shared by cards and slides. */
export function useDecisionActions(item: DecisionItem, filter: PortfolioFilter) {
  const wid = useWorkspaceId();
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<'accepted' | 'proposed' | null>(null);
  const refresh = () => { for (const k of ['portfolio', 'projects', 'project', 'agent', 'inbox']) void invalidateWorkspace(wid, k); };
  const d = item.decision;
  const propose = async (optionId: string) => {
    if (!d) return;
    setBusy(optionId);
    try { const r = await portfolioApi.apply(d.projectId, optionId, filter); toast(r.message); if (optionId === item.acceptOpt?.id) setDone('proposed'); refresh(); }
    catch (e) { toast(errText(e, 'Could not propose it.'), 'error'); }
    finally { setBusy(null); }
  };
  const accept = async () => {
    if (!d || !item.acceptOpt) return;
    setBusy('accept');
    try {
      let ids: string[] = [];
      if (d.waitingProposals === 0) ids = (await portfolioApi.apply(d.projectId, item.acceptOpt.id, filter)).findingIds ?? [];
      if (ids.length === 0) ids = (await agentApi.findings(d.projectId, 'proposed')).items.filter((f) => f.kind === 'Decision' && f.newStatus === 'project_due').map((f) => f.id);
      if (ids.length === 0) throw new Error('There is no date to accept any more. The board is refreshed.');
      for (const id of ids) {
        const r = await agentApi.approve(id);
        if (r.status === 'Failed') throw new Error(r.error ?? 'The new date could not be set.');
      }
      setDone('accepted');
      toast(`${d.key} is now due ${dayMonth(item.forecast)}. The team was told.`);
    } catch (e) { toast(errText(e, e instanceof Error ? e.message : 'Could not accept the new date.'), 'error'); }
    finally { setBusy(null); refresh(); }
  };
  const canAct = !isGuest && !!d && !!item.acceptOpt && !!item.forecast;
  return { busy, done, propose, accept, canAct, waiting: d?.waitingProposals ?? 0 };
}

