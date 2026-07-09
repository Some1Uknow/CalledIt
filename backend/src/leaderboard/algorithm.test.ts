import { describe, expect, it } from "vitest";
import { rankPredictions } from "./algorithm.js";
import type { Prediction } from "../db/types.js";

const base = {
  id: "prediction",
  poolId: "pool",
  userId: "user",
  finalDistance: null,
  rank: null
};

describe("rankPredictions", () => {
  it("sorts by score distance and keeps shared ranks for ties", () => {
    const predictions: Prediction[] = [
      {
        ...base,
        id: "a",
        userId: "a",
        displayName: "A",
        predictedHomeGoals: 2,
        predictedAwayGoals: 1,
        submittedAt: "2026-01-01T00:00:01.000Z"
      },
      {
        ...base,
        id: "b",
        userId: "b",
        displayName: "B",
        predictedHomeGoals: 1,
        predictedAwayGoals: 0,
        submittedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        ...base,
        id: "c",
        userId: "c",
        displayName: "C",
        predictedHomeGoals: 3,
        predictedAwayGoals: 2,
        submittedAt: "2026-01-01T00:00:02.000Z"
      }
    ];

    const ranked = rankPredictions(predictions, 2, 1);

    expect(ranked.map((entry) => [entry.displayName, entry.distance, entry.rank])).toEqual([
      ["A", 0, 1],
      ["B", 2, 2],
      ["C", 2, 2]
    ]);
    expect(ranked[0].exact).toBe(true);
  });
});
