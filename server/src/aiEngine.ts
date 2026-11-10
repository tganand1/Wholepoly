import type { Account, AppState, Candidate, Config, Market } from './types.js';
import type { Level } from './trading.js';
import { buy, feeFor } from './trading.js';
import { parseAiJson } from './ai.js';

export type AiHttp = (url: string, init?: RequestInit) => Promise<Response>;
export type CandidateBook = { asks: Level[]; liquidity: number; bestAskSize: number; spread: number };
export type CandidateSource = (market: Market) => Promise<CandidateBook>;
const day = (now: Date) => now.toISOString().slice(0, 10);

export const scanCandidates = async (markets: Market[], source: CandidateSource, now = new Date(), minPrice = .8, maxPrice = .85, minHours = 2, maxHours = 30, maxSpread = .02, minLiquidity = 2000): Promise<Candidate[]> => {
  const found: Candidate[] = [];
  for (const market of markets) {
    if (!market.tradable || market.outcomes.length !== 2) continue;
    const hours = (Date.parse(market.endDate) - now.getTime()) / 3_600_000;
    if (hours < minHours || hours > maxHours) continue;
    const book = await source(market); const ask = book.asks[0];
    if (!ask || ask.price < minPrice || ask.price > maxPrice || book.spread > maxSpread || book.liquidity < minLiquidity || book.bestAskSize < 1) continue;
    const outcome = market.outcomes.find(o => o.price >= minPrice && o.price <= maxPrice)?.name ?? market.outcomes[0].name;
    found.push({ id: `${market.id}:${outcome}`, marketId: market.id, question: market.question, outcome, price: ask.price, category: market.category, flags: [], selected: false, endDate: market.endDate });
  }
  return found.sort((a, b) => b.price - a.price).slice(0, 25);
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).find(Boolean) ?? '';
  if (typeof value === 'object' && value !== null) { const record = value as Record<string, unknown>; return extractText(record.text) || extractText(record.parts) || extractText(record.content) || extractText(record.candidates); }
  return '';
};

export class GeminiPicker {
  constructor(private readonly config: Config, private readonly http: AiHttp = fetch) {}
  async score(candidates: Candidate[], state: AppState, now = new Date()): Promise<Candidate[]> {
    const key = day(now); const used = state.ai.calls[key] ?? 0; const max = this.config.aiMaxCallsPerDay ?? 6;
    if (!this.config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured');
    if (!this.config.geminiModel) throw new Error('GEMINI_MODEL is not configured');
    if (used >= max) throw new Error('AI call cap reached for today');
    state.ai.calls[key] = used + 1;
    const response = await this.http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.geminiModel)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.geminiApiKey }, body: JSON.stringify({ generationConfig: { temperature: .2, responseMimeType: 'application/json' }, contents: [{ parts: [{ text: 'You estimate probabilities. Return ONLY JSON with id, probability, confidence, risk_flags, and note. If you have no real information beyond price, use price with low confidence. Do not claim unknown recent events.\n' + JSON.stringify(candidates) }]}] }) });
    if (response.status === 429) { state.ai.calls[key] = max; throw new Error('Gemini rate limit; AI stopped for today'); }
    if (!response.ok) throw new Error(`Gemini request failed: ${response.status}`);
    const scored = parseAiJson(extractText(await response.json())); const byId = new Map(scored.map(item => [item.id, item]));
    return candidates.map(candidate => { const result = byId.get(candidate.id); return result ? { ...candidate, probability: result.probability, confidence: result.confidence === 'high' || result.confidence === 'medium' ? result.confidence : 'low', flags: result.risk_flags } : { ...candidate, flags: ['invalid_ai_item'] }; });
  }
}

export const selectCandidates = (candidates: Candidate[], account: Account, now = new Date(), maxBets = 10, maxCategory = 3, maxEvent = 1, minEdge = .05, feeRate = .07, slippageBps = 50, betUsd = 10, profitLock = 20, lossLimit = 15): Candidate[] => {
  const today = account.dailyRealized[day(now)] ?? 0; if (today >= profitLock || today <= -lossLimit) return [];
  const categoryCounts = new Map<string, number>(); const eventCounts = new Map<string, number>();
  return candidates.filter(candidate => { const fee = feeFor(1, candidate.price, feeRate); const slip = candidate.price * slippageBps / 10000; const edge = (candidate.probability ?? candidate.price) - candidate.price - fee - slip; if (edge < minEdge || candidate.confidence === 'low' || candidate.flags.some(f => ['ambiguous_resolution', 'resolution_source_unclear', 'event_may_already_be_decided'].includes(f))) return false; const event = candidate.eventId ?? candidate.marketId; if ((categoryCounts.get(candidate.category) ?? 0) >= maxCategory || (eventCounts.get(event) ?? 0) >= maxEvent || account.cash < betUsd) return false; categoryCounts.set(candidate.category, (categoryCounts.get(candidate.category) ?? 0) + 1); eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1); return true; }).slice(0, maxBets).map(candidate => ({ ...candidate, selected: true }));
};

export const brierScore = (candidates: Candidate[]): number | undefined => { const resolved = candidates.filter(c => c.resolved && c.result !== undefined && c.probability !== undefined); return resolved.length ? resolved.reduce((sum, c) => sum + (c.probability! - c.result!) ** 2, 0) / resolved.length : undefined; };

export const runAi = async (state: AppState, config: Config, source: CandidateSource, http: AiHttp = fetch, now = new Date()): Promise<Candidate[]> => {
  if (!config.aiEnabled) throw new Error('AI is disabled'); if (state.ai.paused || state.ai.circuitBroken) throw new Error('AI is paused');
  const scanned = await scanCandidates(state.markets, source, now); const scored = await new GeminiPicker(config, http).score(scanned, state, now); state.ai.candidates.push(...scored);
  const selected = selectCandidates(scored, state.accounts.ai, now, config.aiMaxBetsPerRun ?? 10, config.aiMaxPerCategory ?? 3, config.aiMaxPerEvent ?? 1, config.aiMinEdge ?? .05, config.feeRate, config.slippageBps, config.aiBetUsd ?? 10, config.aiDailyProfitLock ?? 20, config.aiDailyLossLimit ?? 15);
  for (const candidate of selected) { const market = state.markets.find(m => m.id === candidate.marketId); if (!market) continue; try { const book = await source(market); const rate = config.feeOverrides[market.category] ?? config.feeRate; buy(state.accounts.ai, market, candidate.outcome, config.aiBetUsd ?? 10, book.asks[0]?.price ?? candidate.price, book.asks, now, rate, config.slippageBps); } catch { candidate.flags.push('paper_order_failed'); candidate.selected = false; } }
  state.ai.lastRunDay = day(now); return scored;
};
