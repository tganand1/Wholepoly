import type {
  AppState,
  BotCandidate,
  BotState,
  Config,
  Market,
} from "./types.js";
import type { ClobClient } from "./clob.js";
import type { JsonStore } from "./storage.js";
import { buy, reconcile, sell, type Level } from "./trading.js";
import { GeminiPicker } from "./aiEngine.js";

type BotConfig = Config & {
  botEnabled: boolean;
  botMinPrice: number;
  botMaxPrice: number;
  botMaxPositions: number;
  botTradeUsd: number;
  botTp: number;
  botSlUsd: number;
  botScanSeconds: number;
  botMaxHoursToResolution: number;
};
type Quote = {
  outcome: string;
  price: number;
  bid: number;
  asks: Level[];
  bids: Level[];
};
export class MomentumBot {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastPersist = 0;
  private lastScanAt = 0;
  private history = new Map<string, number[]>();
  private readonly config: BotConfig;
  constructor(
    private readonly state: AppState,
    config: Config,
    private readonly clob: ClobClient,
    private readonly store: JsonStore,
    private readonly publish: (event: string, data: unknown) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.config = {
      ...config,
      botEnabled: config.botEnabled ?? true,
      botMinPrice: config.botMinPrice ?? 0.8,
      botMaxPrice: config.botMaxPrice ?? 0.85,
      botMaxPositions: config.botMaxPositions ?? 10,
      botTradeUsd: config.botTradeUsd ?? 10,
      botTp: config.botTp ?? 0.99,
      botSlUsd: config.botSlUsd ?? 3,
      botScanSeconds: config.botScanSeconds ?? 60,
      botMaxHoursToResolution: config.botMaxHoursToResolution ?? 30,
    };
    this.state.bot.activity = this.state.bot.activity.filter(
      (item) => !/^Scanning BTC|^Trigger armed/.test(item.message),
    );
    this.state.bot.enabled = this.config.botEnabled;
    this.state.bot.maxHoursToResolution = this.config.botMaxHoursToResolution;
  }
  start(): void {
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), 250);
      this.timer.unref();
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async setRunning(enabled: boolean): Promise<void> {
    this.bot.enabled = enabled;
    if (!enabled) this.bot.status = "STOPPED";
    await this.persist();
  }
  private get bot(): BotState {
    return this.state.bot;
  }
  private log(message: string): void {
    if (
      this.bot.activity[0]?.message === message &&
      Date.now() - Date.parse(this.bot.activity[0].at) < 1000
    )
      return;
    this.bot.activity.unshift({ at: this.now().toISOString(), message });
    this.bot.activity = this.bot.activity.slice(0, 100);
  }
  private async persist(): Promise<void> {
    this.state.seq += 1;
    await this.store.save(this.state);
    this.lastPersist = Date.now();
    this.publish("bot_status", this.bot);
  }
  private async quotes(market: Market): Promise<Quote[]> {
    const result: Quote[] = [];
    for (const outcome of market.outcomes) {
      if (!outcome.tokenId) continue;
      const book = await this.clob.book(outcome.tokenId);
      const ask = book.asks[0];
      const bid = book.bids[0];
      if (ask && bid)
        result.push({
          outcome: outcome.name,
          price: ask.price,
          bid: bid.price,
          asks: book.asks,
          bids: book.bids,
        });
    }
    return result;
  }
  private score(market: Market, quote: Quote, now: Date): number {
    const key = `${market.id}:${quote.outcome}`;
    const samples = [...(this.history.get(key) ?? []), quote.price].slice(-6);
    this.history.set(key, samples);
    const average =
      samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance =
      samples.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      samples.length;
    const stability = Math.max(0, 1 - Math.sqrt(variance) * 20);
    const liquidity = Math.min(1, market.liquidity / 10000);
    const volume = Math.min(1, market.volume / 100000);
    const spread = Math.max(0, 1 - (quote.price - quote.bid) / 0.05);
    const hours = Math.max(
      0,
      (Date.parse(market.endDate) - now.getTime()) / 3_600_000,
    );
    return (
      liquidity * 0.3 +
      volume * 0.2 +
      spread * 0.2 +
      Math.min(1, hours / 48) * 0.15 +
      stability * 0.15
    );
  }
  private async scan(now: Date): Promise<BotCandidate[]> {
    const counts = {
      marketsScanned: this.state.markets.length,
      closedExpired: 0,
      tooFarAway: 0,
      outsidePrice: 0,
      thinBook: 0,
      wideSpread: 0,
      candidatesFound: 0,
    };
    const candidates: BotCandidate[] = [];
    for (let start = 0; start < this.state.markets.length; start += 20) {
      await Promise.all(
        this.state.markets.slice(start, start + 20).map(async (market) => {
          const end = Date.parse(market.endDate);
          if (!market.tradable || end <= now.getTime() || market.outcomes.some((o) => o.price === 0 || o.price === 1)) {
            counts.closedExpired += 1;
            return;
          }
          if (!market.endDate || !Number.isFinite(end)) { counts.tooFarAway += 1; return; }
          if ((end - now.getTime()) / 3_600_000 > this.config.botMaxHoursToResolution) { counts.tooFarAway += 1; return; }
          try {
            const quotes = await this.quotes(market);
            const matching = quotes.filter(
              (quote) =>
                quote.price >= this.config.botMinPrice &&
                quote.price <= this.config.botMaxPrice,
            );
            if (!matching.length) {
              counts.outsidePrice += 1;
              return;
            }
            const liquid = matching.filter(
              (quote) => quote.asks[0].size >= 1 && quote.bids[0].size >= 1,
            );
            if (!liquid.length) {
              counts.thinBook += 1;
              return;
            }
            const tight = liquid.filter(
              (quote) => quote.price - quote.bid <= 0.05,
            );
            if (!tight.length) {
              counts.wideSpread += 1;
              return;
            }
            for (const quote of tight) {
              candidates.push({
                marketId: market.id,
                slug: market.slug,
                question: market.question,
                category: market.category,
                outcome: quote.outcome,
                price: quote.price,
                spread: quote.price - quote.bid,
                score: this.score(market, quote, now),
                reason: "Liquidity, volume, spread, time, and stability score",
                selected: false,
                endDate: market.endDate,
              });
            }
          } catch {
            counts.thinBook += 1;
          }
        }),
      );
    }
    counts.candidatesFound = candidates.length;
    const filters: Array<[string, number]> = [
      ["closed/expired", counts.closedExpired],
      ["too far away", counts.tooFarAway],
      ["price", counts.outsidePrice],
      ["thin book", counts.thinBook],
      ["wide spread", counts.wideSpread],
    ];
    const dominantFilter =
      filters.sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
    this.bot.scannedMarkets = counts.marketsScanned;
    this.bot.scanSummary = { ...counts, dominantFilter };
    this.log(
      `Scan: ${counts.marketsScanned} markets; closed/expired ${counts.closedExpired}; too far away ${counts.tooFarAway}; outside ${this.config.botMinPrice.toFixed(2)}-${this.config.botMaxPrice.toFixed(2)} ${counts.outsidePrice}; thin book ${counts.thinBook}; wide spread ${counts.wideSpread}; candidates ${counts.candidatesFound}${counts.candidatesFound === 0 ? `; most removed by ${dominantFilter}` : ""}`,
    );
    const shortlist = candidates.sort((a, b) => b.score - a.score).slice(0, 25);
    if (
      shortlist.length &&
      this.config.geminiApiKey &&
      this.config.geminiModel
    ) {
      try {
        const ai = await new GeminiPicker(this.config).score(
          shortlist.map((c) => ({
            id: `${c.marketId}:${c.outcome}`,
            marketId: c.marketId,
            question: c.question,
            outcome: c.outcome,
            price: c.price,
            category: c.category,
            flags: [],
            selected: false,
            endDate: c.endDate,
          })),
          this.state,
          now,
        );
        const byId = new Map(ai.map((c) => [c.id, c]));
        for (const candidate of shortlist) {
          const scored = byId.get(`${candidate.marketId}:${candidate.outcome}`);
          if (scored?.probability !== undefined)
            candidate.score +=
              Math.max(0, scored.probability - candidate.price) * 0.5;
          candidate.reason = scored?.flags?.length
            ? `Gemini: ${scored.flags.join(", ")}`
            : "Score plus Gemini shortlist review";
        }
        shortlist.sort((a, b) => b.score - a.score);
      } catch (error) {
        this.log(
          `Gemini unavailable; using score alone (${error instanceof Error ? error.message : "error"})`,
        );
      }
    }
    const top = shortlist
      .slice(0, this.config.botMaxPositions)
      .map((candidate) => ({ ...candidate, selected: true }));
    this.bot.candidates = top;
    return top;
  }
  private async exitPositions(now: Date): Promise<void> {
    const account = this.state.accounts.bot;
    this.bot.positions = [];
    for (const position of account.positions.filter(
      (p) => p.status === "OPEN",
    )) {
      const market = this.state.markets.find((m) => m.id === position.marketId);
      const outcome = market?.outcomes.find((o) => o.name === position.outcome);
      if (!market || !outcome?.tokenId) continue;
      try {
        const book = await this.clob.book(outcome.tokenId);
        const bid = book.bids[0];
        if (!bid) continue;
        const pnl =
          (bid.price - position.averagePrice) * position.shares - position.fee;
        this.bot.positions.push({
          marketId: position.marketId,
          question: market.question,
          outcome: position.outcome,
          entryPrice: position.averagePrice,
          livePrice: bid.price,
          shares: position.shares,
          unrealizedPnl: pnl,
        });
        if (bid.price < this.config.botTp && pnl > -this.config.botSlUsd)
          continue;
        const before = position.averagePrice * position.shares + position.fee;
        const fill = sell(
          account,
          market,
          position.outcome,
          position.shares,
          1,
          book.bids,
          this.config.feeRate,
          this.config.slippageBps,
          now,
        );
        reconcile(account);
        const realized = fill.total - before;
        this.bot.realizedPnl += realized;
        this.bot.tradesToday += 1;
        if (realized >= 0) this.bot.wins += 1;
        else this.bot.losses += 1;
        this.log(
          `Sold ${position.outcome} ${market.question}: ${bid.price >= this.config.botTp ? "TAKE PROFIT" : "STOP LOSS"} ${realized.toFixed(2)}`,
        );
        await this.persist();
      } catch (error) {
        this.log(
          `Exit skipped ${market.question}: ${error instanceof Error ? error.message : "error"}`,
        );
      }
    }
    this.bot.positions = this.bot.positions.filter((view) =>
      account.positions.some(
        (position) =>
          position.status === "OPEN" &&
          position.marketId === view.marketId &&
          position.outcome === view.outcome,
      ),
    );
  }
  private async invest(candidates: BotCandidate[], now: Date): Promise<void> {
    const account = this.state.accounts.bot;
    const open = () => account.positions.filter((p) => p.status === "OPEN");
    for (const candidate of candidates) {
      if (open().length >= this.config.botMaxPositions) break;
      if (account.cash < this.config.botTradeUsd) {
        this.log(
          `Skipped ${candidate.question}: cash below $${this.config.botTradeUsd}`,
        );
        break;
      }
      if (open().some((p) => p.marketId === candidate.marketId)) {
        this.log(`Skipped ${candidate.question}: already invested`);
        continue;
      }
      const market = this.state.markets.find(
        (m) => m.id === candidate.marketId,
      );
      const outcome = market?.outcomes.find(
        (o) => o.name === candidate.outcome,
      );
      if (!market || !outcome?.tokenId) continue;
      try {
        const book = await this.clob.book(outcome.tokenId);
        buy(
          account,
          market,
          candidate.outcome,
          this.config.botTradeUsd,
          1,
          book.asks,
          now,
          this.config.feeRate,
          this.config.slippageBps,
        );
        reconcile(account);
        this.log(
          `Bought ${candidate.outcome} $${this.config.botTradeUsd}: ${candidate.question}`,
        );
        await this.persist();
      } catch (error) {
        candidate.reason = `Skipped: ${error instanceof Error ? error.message : "order failed"}`;
        this.log(`${candidate.reason} ${candidate.question}`);
      }
    }
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      const account = this.state.accounts.bot;
      this.bot.cash = account.cash;
      this.bot.openPositions = account.positions.filter(
        (p) => p.status === "OPEN",
      ).length;
      this.bot.totalInvested = account.positions
        .filter((p) => p.status === "OPEN")
        .reduce((sum, p) => sum + p.cost + p.fee, 0);
      if (!this.bot.enabled) {
        this.bot.status = "STOPPED";
        return;
      }
      if (this.bot.circuitBroken) {
        this.bot.status = "PAUSED_BY_CIRCUIT_BREAKER";
        return;
      }
      if (this.bot.realizedPnl <= -(this.config.aiDailyLossLimit ?? 15)) {
        this.bot.circuitBroken = true;
        this.bot.status = "PAUSED_BY_CIRCUIT_BREAKER";
        this.log("Paused by circuit breaker: daily loss limit reached");
        await this.persist();
        return;
      }
      await this.exitPositions(now);
      if (
        !this.lastScanAt ||
        now.getTime() - this.lastScanAt >= this.config.botScanSeconds * 1000
      ) {
        this.lastScanAt = now.getTime();
        this.bot.status = "SCANNING";
        const candidates = await this.scan(now);
        await this.invest(candidates, now);
        this.log(
          `Scanning ${this.bot.scannedMarkets} markets; ${candidates.length} candidates, ${this.bot.openPositions}/${this.config.botMaxPositions} positions`,
        );
      }
      this.bot.openPositions = account.positions.filter(
        (p) => p.status === "OPEN",
      ).length;
      this.bot.cash = account.cash;
      this.bot.totalInvested = account.positions
        .filter((p) => p.status === "OPEN")
        .reduce((sum, p) => sum + p.cost + p.fee, 0);
      this.bot.status = "SCANNING";
    } catch (error) {
      this.bot.lastError =
        error instanceof Error ? error.message : "Bot tick failed";
      this.log(`Bot error: ${this.bot.lastError}`);
      await this.persist();
    } finally {
      if (Date.now() - this.lastPersist >= 1000) await this.persist();
      this.busy = false;
    }
  }
}
