import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./extra.css";
import "./portfolio-extra.css";
type Outcome = { name: string; price: number };
type Market = {
  id: string;
  slug: string;
  question: string;
  description: string;
  category: string;
  outcomes: Outcome[];
  volume: number;
  endDate: string;
  tradable: boolean;
};
type Fill = { outcome: string; side: string; price: number; at: string };
type Position = {
  marketId: string;
  slug?: string;
  question: string;
  outcome: string;
  shares: number;
  averagePrice: number;
  cost?: number;
  status: string;
  realizedPnl?: number;
};
type Account = {
  id: string;
  cash: number;
  positions: Position[];
  ledger?: Fill[];
};
type Response = { markets: Market[]; error?: string; hasMore: boolean };
type LiveQuote = { slug: string; question: string; outcomes: Outcome[] };
type BotState = {
  enabled: boolean;
  status: string;
  maxHoursToResolution: number;
  scannedMarkets: number;
  scanSummary: { marketsScanned: number; closedExpired: number; tooFarAway: number; outsidePrice: number; thinBook: number; wideSpread: number; candidatesFound: number; dominantFilter: string };
  candidates: Array<{ marketId: string; question: string; category: string; outcome: string; price: number; spread: number; score: number; reason: string; selected: boolean; endDate: string }>;
  positions: Array<{ marketId: string; question: string; outcome: string; entryPrice: number; livePrice: number; shares: number; unrealizedPnl: number }>;
  activity: Array<{ at: string; message: string }>;
  tradesToday: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  cash: number;
  openPositions: number;
  totalInvested: number;
  lastError?: string;
};
const categories = [
  "Trending",
  "Politics",
  "Sports",
  "Crypto",
  "Finance",
  "Economy",
  "Tech",
  "AI",
  "Culture",
  "Weather",
  "Other",
];
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : `${response.status} ${response.statusText}`,
    );
  return body as T;
}
const money = (value: number) => `$${value.toFixed(2)}`;
const cents = (value: number) => `${Math.round(value * 100)}c`;
function App() {
  const [tab, setTab] = React.useState<"markets" | "ai" | "portfolio" | "bot">(
    "markets",
  );
  const [markets, setMarkets] = React.useState<Market[]>([]);
  const [category, setCategory] = React.useState("Trending");
  const [query, setQuery] = React.useState("");
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [live, setLive] = React.useState<LiveQuote[]>([]);
  const [selected, setSelected] = React.useState<Market | null>(null);
  const [bot, setBot] = React.useState<BotState | null>(null);
  const loadMarkets = React.useCallback(
    async (next = 1, append = false) => {
      if (next === 1) setLoading(true);
      try {
        const result = await api<Response>(
          `/api/markets?page=${next}&pageSize=100&q=${encodeURIComponent(query)}&category=${category === "Trending" ? "All" : encodeURIComponent(category)}`,
        );
        setMarkets((previous) =>
          append ? [...previous, ...result.markets] : result.markets,
        );
        setHasMore(result.hasMore);
        setPage(next);
        setError(result.error ?? "");
      } catch (reason) {
        if (!append) setMarkets([]);
        setError(
          reason instanceof Error ? reason.message : "Unable to load markets",
        );
      } finally {
        setLoading(false);
      }
    },
    [category, query],
  );
  const loadAccounts = React.useCallback(
    () =>
      Promise.all(
        ["manual", "bot", "ai"].map((id) =>
          api<Account>(`/api/market-accounts/${id}`),
        ),
      )
        .then(setAccounts)
        .catch(() => setAccounts([])),
    [],
  );
  React.useEffect(() => {
    void loadMarkets();
    void loadAccounts();
    void api<Record<string, number>>("/api/markets/categories")
      .then(setCounts)
      .catch(() => undefined);
    const events = new EventSource("/events");
    events.addEventListener("market_update", () => {
      void loadMarkets();
      void api<Record<string, number>>("/api/markets/categories")
        .then(setCounts)
        .catch(() => undefined);
    });
    events.addEventListener("market_account_update", () => void loadAccounts());
    const timer = window.setInterval(() => {
      if (events.readyState !== EventSource.OPEN) {
        void loadMarkets();
        void loadAccounts();
      }
    }, 2000);
    return () => {
      events.close();
      window.clearInterval(timer);
    };
  }, [loadMarkets, loadAccounts]);
  React.useEffect(() => {
    const poll = window.setInterval(() => {
      void api<LiveQuote[]>("/api/crypto-live")
        .then(setLive)
        .catch(() => undefined);
    }, 2000);
    void api<LiveQuote[]>("/api/crypto-live")
      .then(setLive)
      .catch(() => undefined);
    return () => window.clearInterval(poll);
  }, []);
  React.useEffect(() => { void api<BotState>("/api/bot/status").then(setBot).catch(() => undefined); const events = new EventSource("/events"); const onBot = (event: MessageEvent) => setBot(JSON.parse(event.data) as BotState); events.addEventListener("bot_status", onBot); return () => events.close(); }, []);
  const manual = accounts.find((account) => account.id === "manual");
  const positions =
    manual?.positions.reduce(
      (sum, position) =>
        sum + (position.cost ?? position.averagePrice * position.shares),
      0,
    ) ?? 0;
  return (
    <div className="app-shell">
      <Header
        query={query}
        setQuery={setQuery}
        positions={positions}
        cash={manual?.cash ?? 0}
        tab={tab}
        setTab={setTab}
      />
      <CategoryBar active={category} setActive={setCategory} counts={counts} />
      <Ticker accounts={accounts} />
      {selected ? (
        <DetailPage
          market={selected}
          close={() => setSelected(null)}
          refresh={loadAccounts}
        />
      ) : tab === "markets" ? (
        <Markets
          markets={markets}
          live={live}
          loading={loading}
          error={error}
          hasMore={hasMore}
          loadMore={() => void loadMarkets(page + 1, true)}
          select={setSelected}
        />
      ) : tab === "ai" ? (
        <AiPage />
      ) : tab === "bot" ? (
        <BotPage state={bot} refresh={() => api<BotState>("/api/bot/status").then(setBot)} />
      ) : (
        <Portfolio accounts={accounts} refresh={loadAccounts} />
      )}
    </div>
  );
}
function Header(p: {
  query: string;
  setQuery: (value: string) => void;
  positions: number;
  cash: number;
  tab: "markets" | "ai" | "portfolio" | "bot";
  setTab: (value: "markets" | "ai" | "portfolio" | "bot") => void;
}) {
  return (
    <header className="site-header">
      <button className="wordmark" onClick={() => p.setTab("markets")}>
        <span className="mark-dot" />
        Paperline
      </button>
      <div className="header-search">
        <span aria-hidden="true">Search</span>
        <input
          value={p.query}
          onChange={(event) => p.setQuery(event.target.value)}
          placeholder="Search markets, events, outcomes"
        />
      </div>
      <div className="header-values">
        <button onClick={() => p.setTab("portfolio")}>
          <small>In positions</small>
          <strong>{money(p.positions)}</strong>
        </button>
        <button onClick={() => p.setTab("portfolio")}>
          <small>Cash</small>
          <strong>{money(p.cash)}</strong>
        </button>
        <button className="leaderboard">Leaderboard</button>
      </div>
      <nav className="main-tabs">
        <button
          className={p.tab === "markets" ? "active" : ""}
          onClick={() => p.setTab("markets")}
        >
          Markets
        </button>
        <button className={p.tab === "bot" ? "active" : ""} onClick={() => p.setTab("bot")}>Bot</button>
        <button
          className={p.tab === "ai" ? "active" : ""}
          onClick={() => p.setTab("ai")}
        >
          AI Picks
        </button>
        <button
          className={p.tab === "portfolio" ? "active" : ""}
          onClick={() => p.setTab("portfolio")}
        >
          Portfolio
        </button>
      </nav>
    </header>
  );
}
function BotPage({ state, refresh }: { state: BotState | null; refresh: () => void }) {
  const action = async (path: string) => { await api<BotState>(path, { method: "POST" }).then(refresh).catch(() => undefined); };
  const reset = async () => { if (window.confirm("Close all bot positions and restore the starting $100?")) await action("/api/bot/reset"); };
  if (!state) return <main className="content"><div className="loading">Loading bot status...</div></main>;
  return <main className="content bot-page"><div className="page-heading"><div><span className="eyebrow">BOT</span><h1>Market scanner <i>pilot.</i></h1></div><div className="ai-actions"><button className="primary-button" onClick={() => void action(state.enabled ? "/api/bot/stop" : "/api/bot/start")}>{state.enabled ? "Stop bot" : "Start bot"}</button><button onClick={refresh}>Refresh</button><button className="reset-bot" onClick={() => void reset()}>Reset bot account</button></div></div>
    <div className="portfolio-summary"><div><small>Bot status</small><strong>{state.status.replaceAll("_", " ")}</strong><span>Scanning {state.scannedMarkets} markets · max {state.maxHoursToResolution}h to resolution</span></div><div><small>Cash left</small><strong>{money(state.cash)}</strong><span>{state.openPositions} / 10 open positions</span></div><div><small>Total invested</small><strong>{money(state.totalInvested)}</strong><span>{state.tradesToday} trades · {money(state.realizedPnl)} realized</span></div></div>
    <div className="portfolio-card bot-live"><div className="section-title"><h2>Top candidates</h2><span>80–85c entry range · max 10</span></div><div className="scan-summary">Scan: {state.scanSummary.marketsScanned} markets · closed/expired {state.scanSummary.closedExpired} · outside price {state.scanSummary.outsidePrice} · thin book {state.scanSummary.thinBook} · wide spread {state.scanSummary.wideSpread} · candidates {state.scanSummary.candidatesFound}</div><div className="bot-candidates">{state.candidates.length===0?<div className="empty-state">No qualifying candidates in the latest scan.</div>:state.candidates.map((candidate,index)=><div className="bot-candidate" key={`${candidate.marketId}-${candidate.outcome}`}><b>#{index+1}</b><div><strong>{candidate.question}</strong><small>{candidate.category} · {candidate.outcome} · {cents(candidate.price)} · spread {cents(candidate.spread)}</small><small>{candidate.reason}</small></div><em>{candidate.score.toFixed(3)}</em></div>)}</div></div>
    <div className="portfolio-card"><div className="section-title"><h2>Open positions</h2><span>{state.positions.length} / 10</span></div><div className="bot-candidates">{state.positions.length===0?<div className="empty-state">No open bot positions.</div>:state.positions.map((position)=><div className="bot-candidate" key={`${position.marketId}-${position.outcome}`}><b>{position.outcome}</b><div><strong>{position.question}</strong><small>Entry {cents(position.entryPrice)} · Live {cents(position.livePrice)} · {position.shares.toFixed(2)} shares</small></div><em className={position.unrealizedPnl>=0?'profit':'down'}>{money(position.unrealizedPnl)}</em></div>)}</div></div>
    <div className="portfolio-card"><div className="section-title"><h2>Activity log</h2><span>Last {state.activity.length}</span></div><div className="bot-log">{state.activity.map((item,index)=><div key={`${item.at}-${index}`}><small>{new Date(item.at).toLocaleTimeString()}</small><span>{item.message}</span></div>)}</div>{state.lastError ? <div className="error">{state.lastError}</div> : null}</div>
  </main>;
}
function CategoryBar(p: {
  active: string;
  setActive: (value: string) => void;
  counts: Record<string, number>;
}) {
  return (
    <div className="category-bar">
      {categories.map((item) => (
        <button
          className={p.active === item ? "category active" : "category"}
          onClick={() => p.setActive(item)}
          key={item}
        >
          {item}
          {item !== "Trending" && <em>{p.counts[item] ?? 0}</em>}
        </button>
      ))}
    </div>
  );
}
function Ticker({ accounts }: { accounts: Account[] }) {
  const fills = accounts
    .flatMap((account) =>
      (account.ledger ?? []).map((fill) => ({ ...fill, account: account.id })),
    )
    .slice(-12)
    .reverse();
  return (
    <div className="trade-ticker">
      <span className="ticker-label">LATEST PAPER TRADES</span>
      {fills.length === 0 ? (
        <span className="ticker-empty">No paper trades yet</span>
      ) : (
        fills.map((fill, index) => (
          <span className="ticker-item" key={`${fill.at}-${index}`}>
            <b
              className={
                fill.outcome.toLowerCase().includes("no") ||
                fill.outcome.toLowerCase().includes("down")
                  ? "down"
                  : "up"
              }
            >
              {fill.side.toLowerCase()} {fill.outcome}
            </b>{" "}
            {cents(fill.price)} Â· {fill.account}
          </span>
        ))
      )}
    </div>
  );
}
function Markets(p: {
  markets: Market[];
  live: LiveQuote[];
  loading: boolean;
  error: string;
  hasMore: boolean;
  loadMore: () => void;
  select: (market: Market) => void;
}) {
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">PAPER MARKETS</span>
          <h1>
            Trade your <i>point of view.</i>
          </h1>
        </div>
        <button
          className="primary-button"
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>
      </div>
      <div className="subchips">
        <button className="subchip active">Next 3 hours</button>
        <button className="subchip">Politics</button>
        <button className="subchip">Elections</button>
        <button className="subchip">Popular</button>
      </div>
      <LiveCrypto quotes={p.live} />
      {p.error && <div className="error">{p.error}</div>}
      {p.loading ? (
        <div className="loading-grid">
          {[1, 2, 3, 4, 5, 6].map((item) => (
            <div className="skeleton" key={item} />
          ))}
        </div>
      ) : p.markets.length === 0 ? (
        <div className="empty-state">
          <h2>No markets found</h2>
          <p>Try another category or search.</p>
        </div>
      ) : (
        <>
          <div className="market-grid">
            {p.markets.map((market) => (
              <MarketCard market={market} key={market.id} select={p.select} />
            ))}
          </div>
          {p.hasMore && (
            <button className="loadMore" onClick={p.loadMore}>
              Load more
            </button>
          )}
        </>
      )}
    </main>
  );
}
function LiveCrypto({ quotes }: { quotes: LiveQuote[] }) {
  const selected = quotes
    .filter((item) => /bitcoin|btc|ethereum|eth/i.test(item.question))
    .slice(0, 4);
  return (
    <section className="live-crypto">
      <div className="live-crypto-heading">
        <div>
          <span className="eyebrow">LIVE CRYPTO</span>
          <h2>
            Up or down, <i>right now.</i>
          </h2>
        </div>
        <span className="live-dot">LIVE · CLOB</span>
      </div>
      {selected.length === 0 ? (
        <p className="muted-copy">
          No live Bitcoin or Ethereum windows are available.
        </p>
      ) : (
        <div className="crypto-row">
          {selected.map((item) => (
            <div className="crypto-card" key={item.slug}>
              <small>{item.question}</small>
              <strong>closes soon</strong>
              <div>
                {item.outcomes.map((outcome) => (
                  <span
                    className={
                      /down|no/i.test(outcome.name)
                        ? "crypto-down"
                        : "crypto-up"
                    }
                    key={outcome.name}
                  >
                    {outcome.name} {cents(outcome.price)}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
function MarketCard({
  market,
  select,
}: {
  market: Market;
  select: (market: Market) => void;
}) {
  const first = market.outcomes[0];
  const second = market.outcomes[1];
  return (
    <article className="market-card" onClick={() => select(market)}>
      <div className="market-card-top">
        <span className="market-icon">
          {market.category === "Crypto" ? "BTC" : market.category.slice(0, 1)}
        </span>
        <span className="market-category">{market.category}</span>
        <span className="market-window">
          {market.endDate
            ? `closes ${new Date(market.endDate).toLocaleDateString()}`
            : "open"}
        </span>
      </div>
      <div className="market-title-row">
        <h2>{market.question}</h2>
        <strong>{first ? Math.round(first.price * 100) : 0}%</strong>
      </div>
      <div className="outcome-buttons">
        <button
          className="outcome-up"
          onClick={(event) => {
            event.stopPropagation();
            select(market);
          }}
        >
          {first?.name ?? "Yes"} <b>{first ? cents(first.price) : "-"}</b>
        </button>
        <button
          className="outcome-down"
          onClick={(event) => {
            event.stopPropagation();
            select(market);
          }}
        >
          {second?.name ?? "No"} <b>{second ? cents(second.price) : "-"}</b>
        </button>
      </div>
      <div className="market-meta">
        <span>Volume {money(market.volume)}</span>
        <span>{market.tradable ? "Paper tradable" : "View only"}</span>
      </div>
    </article>
  );
}
function DetailPage({
  market,
  close,
  refresh,
}: {
  market: Market;
  close: () => void;
  refresh: () => void;
}) {
  const [side, setSide] = React.useState<"BUY" | "SELL">("BUY");
  const [outcome, setOutcome] = React.useState(market.outcomes[0]?.name ?? "");
  const [amount, setAmount] = React.useState(25);
  const [detail, setDetail] =
    React.useState<{
      orderBook: Record<
        string,
        {
          asks?: Array<{ price: number; size: number }>;
          bids?: Array<{ price: number; size: number }>;
        }
      >;
    }> |
    (null > null);
  const [message, setMessage] = React.useState("");
  const selected =
    market.outcomes.find((item) => item.name === outcome) ?? market.outcomes[0];
  const book = detail?.orderBook[outcome];
  const price =
    side === "BUY"
      ? (book?.asks?.[0]?.price ?? selected?.price ?? 0)
      : (book?.bids?.[0]?.price ?? selected?.price ?? 0);
  const shares = price > 0 ? amount / price : 0;
  React.useEffect(() => {
    void api<{
      orderBook: Record<
        string,
        {
          asks?: Array<{ price: number; size: number }>;
          bids?: Array<{ price: number; size: number }>;
        }
      >;
    }>(`/api/markets/${market.slug}`)
      .then(setDetail)
      .catch((reason) =>
        setMessage(
          reason instanceof Error ? reason.message : "Order book unavailable",
        ),
      );
  }, [market.slug]);
  const submit = async () => {
    try {
      const url = `/api/market-accounts/manual/${side === "BUY" ? "buy" : "sell"}`;
      const body =
        side === "BUY"
          ? { slug: market.slug, outcome, amount, limitPrice: price }
          : { slug: market.slug, outcome, shares, limitPrice: price };
      await api(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setMessage(`${side} order filled with paper money`);
      refresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Trade failed");
    }
  };
  return (
    <main className="content detail-page">
      <button className="back-button" onClick={close}>
        Back to markets
      </button>
      <div className="detail-layout">
        <section className="detail-main">
          <div className="detail-kicker">
            <span className="market-icon">
              {market.category === "Crypto" ? "BTC" : market.category.slice(0, 1)}
            </span>
            <span>{market.category}</span>
          </div>
          <h1>{market.question}</h1>
          <div className="detail-stats">
            <strong>{Math.round((selected?.price ?? 0) * 100)}%</strong>
            <span>
              probability
              <br />
              Volume {money(market.volume)} Â·{" "}
              {market.endDate
                ? new Date(market.endDate).toLocaleString()
                : "open"}
            </span>
          </div>
          <div className="time-tabs">
            <button className="active">1H</button>
            <button>6H</button>
            <button>1D</button>
            <button>1W</button>
            <button>1M</button>
            <button>ALL</button>
          </div>
          <div className="price-chart">
            <div className="chart-line green" />
            <div className="chart-line red" />
            <span className="chart-label green-label">
              {cents(selected?.price ?? 0)}
            </span>
            <span className="chart-label red-label">
              {cents(1 - (selected?.price ?? 0))}
            </span>
          </div>
        </section>
        <aside className="trade-panel">
          <div className="trade-tabs">
            <button
              className={side === "BUY" ? "active" : ""}
              onClick={() => setSide("BUY")}
            >
              Buy
            </button>
            <button
              className={side === "SELL" ? "active" : ""}
              onClick={() => setSide("SELL")}
            >
              Sell
            </button>
          </div>
          <div className="trade-outcomes">
            {market.outcomes.map((item) => (
              <button
                className={outcome === item.name ? "selected" : ""}
                onClick={() => setOutcome(item.name)}
                key={item.name}
              >
                {item.name}
                <b>{cents(item.price)}</b>
              </button>
            ))}
          </div>
          <label className="amount-label">
            {side === "BUY" ? "Amount" : "Shares"}
            <input
              type="number"
              value={amount}
              onChange={(event) => setAmount(Number(event.target.value))}
            />
          </label>
          <div className="quick-amounts">
            <button onClick={() => setAmount(5)}>+$5</button>
            <button onClick={() => setAmount(25)}>+$25</button>
            <button onClick={() => setAmount(50)}>+$50</button>
            <button onClick={() => setAmount(100)}>+$100</button>
            <button onClick={() => setAmount(100)}>Max</button>
          </div>
          <div className="trade-estimate">
            <span>
              Estimated shares <b>{shares.toFixed(2)}</b>
            </span>
            <span>
              To win <b>{money(Math.max(0, shares - amount))}</b>
            </span>
          </div>
          <button
            className="confirm-trade"
            onClick={() => void submit()}
            disabled={!market.tradable || price <= 0}
          >
            {side === "BUY" ? "Buy" : "Sell"} {outcome}
          </button>
          {message && <p className="trade-message">{message}</p>}
        </aside>
      </div>
    </main>
  );
}
function AiPage() {
  const [state, setState] = React.useState<Record<string, unknown>>({});
  const [message, setMessage] = React.useState("");
  const refresh = () =>
    api<Record<string, unknown>>("/api/ai")
      .then(setState)
      .catch((reason) =>
        setMessage(reason instanceof Error ? reason.message : "AI unavailable"),
      );
  React.useEffect(refresh, []);
  const action = async (path: string) => {
    try {
      await api(path, { method: "POST" });
      setMessage("Updated");
      refresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "AI action failed");
    }
  };
  const candidates = Array.isArray(state.candidates)
    ? (state.candidates as Array<Record<string, unknown>>)
    : [];
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">AI PICKS</span>
          <h1>
            Probability, <i>not prophecy.</i>
          </h1>
        </div>
        <div className="ai-actions">
          <button
            className="primary-button"
            onClick={() => void action("/api/ai/run")}
          >
            Run now
          </button>
          <button onClick={() => void action("/api/ai/pause")}>Pause</button>
          <button onClick={() => void action("/api/ai/resume")}>Resume</button>
        </div>
      </div>
      {message && <div className="error">{message}</div>}
      <div className="portfolio-summary">
        <div>
          <small>Calls today</small>
          <strong>{JSON.stringify(state.calls ?? {})}</strong>
        </div>
        <div>
          <small>Brier score</small>
          <strong>
            {String(
              (state.stats as Record<string, unknown> | undefined)?.brier ??
                "-",
            )}
          </strong>
        </div>
        <div>
          <small>Status</small>
          <strong>{state.paused ? "Paused" : "Running"}</strong>
        </div>
      </div>
      <div className="portfolio-card">
        <div className="section-title">
          <h2>Scored candidates</h2>
          <button onClick={refresh}>Refresh</button>
        </div>
        {candidates.length === 0 ? (
          <div className="empty-state">No AI candidates scored today.</div>
        ) : (
          candidates.map((item) => (
            <div className="position-row" key={String(item.id)}>
              <div>
                <b>{String(item.question)}</b>
                <small>
                  {String(item.outcome)} Â· {String(item.category)}
                </small>
              </div>
              <span>
                {item.probability === undefined
                  ? "-"
                  : `${Math.round(Number(item.probability) * 100)}%`}
              </span>
              <strong>{item.selected ? "BET" : "SKIPPED"}</strong>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
function Portfolio({
  accounts,
  refresh,
}: {
  accounts: Account[];
  refresh: () => void;
}) {
  const [accountId, setAccountId] = React.useState("manual");
  const [view, setView] = React.useState("Positions");
  const [search, setSearch] = React.useState("");
  const [message, setMessage] = React.useState("");
  const account = accounts.find((item) => item.id === accountId);
  const positions = (account?.positions ?? []).filter((position) =>
    position.question.toLowerCase().includes(search.toLowerCase()),
  );
  const inPositions = (account?.positions ?? []).reduce(
    (sum, position) =>
      sum + (position.cost ?? position.averagePrice * position.shares),
    0,
  );
  const value = inPositions + (account?.cash ?? 0);
  const sell = async (position: Position) => {
    const quantity = window.prompt("Shares to sell", String(position.shares));
    if (!quantity || !position.slug) return;
    try {
      await api(`/api/market-accounts/${accountId}/sell`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: position.slug,
          outcome: position.outcome,
          shares: Number(quantity),
          limitPrice: 1,
        }),
      });
      setMessage("Sell order filled");
      refresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Sell failed");
    }
  };
  return (
    <main className="content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">PORTFOLIO</span>
          <h1>
            Your paper <i>portfolio.</i>
          </h1>
        </div>
        <button className="primary-button" onClick={refresh}>
          Refresh
        </button>
      </div>
      <div className="portfolio-summary">
        <div>
          <small>Portfolio value</small>
          <strong>{money(value)}</strong>
          <span className="profit">Paper ledger value</span>
        </div>
        <div>
          <small>In positions</small>
          <strong>{money(inPositions)}</strong>
        </div>
        <div>
          <small>Cash</small>
          <strong>{money(account?.cash ?? 0)}</strong>
        </div>
      </div>
      <div className="portfolio-card">
        <div className="section-title">
          <div className="account-switcher">
            {accounts.map((item) => (
              <button
                className={accountId === item.id ? "selected" : ""}
                onClick={() => setAccountId(item.id)}
                key={item.id}
              >
                {item.id}
              </button>
            ))}
          </div>
          <input
            className="portfolio-search"
            placeholder="Search positions"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="portfolio-tabs">
          {["Positions", "P&L", "History"].map((item) => (
            <button
              className={view === item ? "active" : ""}
              onClick={() => setView(item)}
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
        {message && <div className="trade-message">{message}</div>}
        {view !== "Positions" ? (
          <div className="empty-state">
            {view} history will populate from the account ledger.
          </div>
        ) : positions.length === 0 ? (
          <div className="empty-state">No open paper positions yet.</div>
        ) : (
          positions.map((position) => (
            <div
              className="position-row"
              key={`${position.marketId}-${position.outcome}`}
            >
              <div>
                <b>{position.question}</b>
                <small>
                  {position.outcome} Â· {position.shares.toFixed(2)} shares
                </small>
                <div className="progress">
                  <span />
                </div>
              </div>
              <span>{cents(position.averagePrice)} avg to now</span>
              <strong>
                {money(
                  position.cost ?? position.averagePrice * position.shares,
                )}
              </strong>
              <button
                className="sell-button"
                onClick={() => void sell(position)}
              >
                Sell
              </button>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);





