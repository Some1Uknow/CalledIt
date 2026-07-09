import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}

type Session = {
  user: { id: string; displayName: string };
  sessionToken: string;
};

type PoolResponse = {
  pool: {
    id: string;
    status: "open" | "locked" | "live" | "resolved" | "cancelled";
    fixture: { homeTeam: string; awayTeam: string; kickoffAt: string | null };
  };
  participantCount: number;
  score: Score | null;
};

type Score = {
  homeGoals: number;
  awayGoals: number;
  matchStatus?: string | null;
  matchClock?: string | null;
};

type LeaderboardEntry = {
  rank: number;
  displayName: string;
  predictedHomeGoals: number;
  predictedAwayGoals: number;
  distance: number;
};

type LeaderboardResponse = {
  hidden: boolean;
  participantCount?: number;
  score?: Score;
  leaderboard: LeaderboardEntry[];
};

type ResultResponse = {
  finalScore: { homeGoals: number; awayGoals: number };
  winners: LeaderboardEntry[];
  leaderboard: LeaderboardEntry[];
};

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function routeState() {
  const match = window.location.pathname.match(/^\/pool\/([^/]+)(?:\/([^/]+))?/);
  const params = new URLSearchParams(window.location.search);
  return {
    poolId: match?.[1] ?? "",
    view: match?.[2] ?? "home",
    invite: params.get("invite") ?? ""
  };
}

async function api<T>(path: string, session: Session, invite: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.sessionToken}`,
      "x-pool-invite": invite,
      ...(init?.headers ?? {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body as T;
}

function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) {
      setError("Open this link inside Telegram to continue.");
      return;
    }
    fetch(`${apiBase}/api/auth/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData })
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? "Telegram auth failed");
        setSession(body as Session);
      })
      .catch((authError) => setError(authError instanceof Error ? authError.message : "Telegram auth failed"));
  }, []);

  return { session, error };
}

function App() {
  const route = useMemo(routeState, []);
  const { session, error: authError } = useSession();
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [result, setResult] = useState<ResultResponse | null>(null);
  const [receipt, setReceipt] = useState<unknown>(null);
  const [homeGoals, setHomeGoals] = useState(0);
  const [awayGoals, setAwayGoals] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!route.poolId || !route.invite) {
      setError("This pool link is missing its invite token.");
      return;
    }
    if (!session) return;
    api<PoolResponse>(`/api/pools/${route.poolId}`, session, route.invite)
      .then(setPool)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Could not load pool"));
  }, [route.poolId, route.invite, session]);

  useEffect(() => {
    if (!session || !pool) return;
    if (route.view === "live" || route.view === "home") {
      api<LeaderboardResponse>(`/api/pools/${route.poolId}/leaderboard`, session, route.invite)
        .then(setLeaderboard)
        .catch(() => undefined);
    }
    if (route.view === "result") {
      api<ResultResponse>(`/api/pools/${route.poolId}/result`, session, route.invite)
        .then(setResult)
        .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Result is not ready"));
    }
    if (route.view === "receipt") {
      api<{ receipt: unknown }>(`/api/pools/${route.poolId}/receipt`, session, route.invite)
        .then((body) => setReceipt(body.receipt))
        .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Receipt is not ready"));
    }
  }, [pool, route.invite, route.poolId, route.view, session]);

  async function submitPrediction() {
    if (!session) return;
    setError(null);
    await api(`/api/pools/${route.poolId}/predictions`, session, route.invite, {
      method: "POST",
      body: JSON.stringify({ predictedHomeGoals: homeGoals, predictedAwayGoals: awayGoals })
    });
    setSubmitted(true);
  }

  if (authError || error) return <Shell><Status title="Cannot open pool" text={authError ?? error ?? ""} /></Shell>;
  if (!session || !pool) return <Shell><Status title="Loading" text="Preparing your CalledIt room." /></Shell>;

  return (
    <Shell>
      <header className="match">
        <div>
          <p className="label">CalledIt</p>
          <h1>{pool.pool.fixture.homeTeam} <span>vs</span> {pool.pool.fixture.awayTeam}</h1>
        </div>
        <div className="status">{pool.pool.status}</div>
      </header>

      {route.view === "predict" ? (
        <section className="panel">
          <p className="label">Your call</p>
          <div className="score-picker">
            <Stepper label={pool.pool.fixture.homeTeam} value={homeGoals} setValue={setHomeGoals} />
            <div className="divider">:</div>
            <Stepper label={pool.pool.fixture.awayTeam} value={awayGoals} setValue={setAwayGoals} />
          </div>
          <button className="primary" onClick={submitPrediction} disabled={submitted || pool.pool.status !== "open"}>
            {submitted ? "Prediction locked" : "Lock prediction"}
          </button>
        </section>
      ) : route.view === "result" ? (
        <section className="panel">
          <p className="label">Final</p>
          <div className="final">{result ? `${result.finalScore.homeGoals} - ${result.finalScore.awayGoals}` : "Pending"}</div>
          <Leaderboard rows={result?.leaderboard ?? []} />
        </section>
      ) : route.view === "receipt" ? (
        <section className="panel">
          <p className="label">Receipt</p>
          <pre>{JSON.stringify(receipt, null, 2)}</pre>
        </section>
      ) : (
        <section className="panel">
          <p className="label">Room</p>
          <div className="metric"><strong>{pool.participantCount}</strong><span>predictions locked</span></div>
          <Leaderboard rows={leaderboard?.leaderboard ?? []} hidden={leaderboard?.hidden} />
          <nav>
            <a href={`/pool/${route.poolId}/predict?invite=${encodeURIComponent(route.invite)}`}>Predict</a>
            <a href={`/pool/${route.poolId}/live?invite=${encodeURIComponent(route.invite)}`}>Leaderboard</a>
            <a href={`/pool/${route.poolId}/result?invite=${encodeURIComponent(route.invite)}`}>Result</a>
            <a href={`/pool/${route.poolId}/receipt?invite=${encodeURIComponent(route.invite)}`}>Receipt</a>
          </nav>
        </section>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}

function Status({ title, text }: { title: string; text: string }) {
  return <section className="panel"><p className="label">{title}</p><h1>{text}</h1></section>;
}

function Stepper({ label, value, setValue }: { label: string; value: number; setValue: (value: number) => void }) {
  return (
    <div className="stepper">
      <span>{label}</span>
      <button aria-label={`Decrease ${label}`} onClick={() => setValue(Math.max(0, value - 1))}>-</button>
      <strong>{value}</strong>
      <button aria-label={`Increase ${label}`} onClick={() => setValue(Math.min(9, value + 1))}>+</button>
    </div>
  );
}

function Leaderboard({ rows, hidden }: { rows: LeaderboardEntry[]; hidden?: boolean }) {
  if (hidden) return <p className="empty">Leaderboard unlocks when predictions lock.</p>;
  if (rows.length === 0) return <p className="empty">No leaderboard rows yet.</p>;
  return (
    <ol className="leaderboard">
      {rows.map((row) => (
        <li key={`${row.rank}-${row.displayName}`}>
          <span>{row.rank}. {row.displayName}</span>
          <strong>{row.predictedHomeGoals}-{row.predictedAwayGoals}</strong>
        </li>
      ))}
    </ol>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
