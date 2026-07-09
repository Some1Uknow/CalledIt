export type PoolStatus = "open" | "locked" | "live" | "resolved" | "cancelled";
export type PoolMode = "live" | "replay";

export type Fixture = {
  id: string;
  txlineFixtureId: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string | null;
  status: string;
  rawTxlineJson: unknown;
};

export type Prediction = {
  id: string;
  poolId: string;
  userId: string;
  displayName: string;
  predictedHomeGoals: number;
  predictedAwayGoals: number;
  submittedAt: string;
  finalDistance: number | null;
  rank: number | null;
};

export type ScoreState = {
  homeGoals: number;
  awayGoals: number;
  matchStatus?: string | null;
  matchClock?: string | null;
};
