import type { Prediction } from "../db/types.js";

export type RankedPrediction = Prediction & {
  distance: number;
  exact: boolean;
  rank: number;
};

export function distance(
  prediction: Pick<Prediction, "predictedHomeGoals" | "predictedAwayGoals">,
  homeGoals: number,
  awayGoals: number
) {
  return Math.abs(prediction.predictedHomeGoals - homeGoals) + Math.abs(prediction.predictedAwayGoals - awayGoals);
}

export function rankPredictions(predictions: Prediction[], homeGoals: number, awayGoals: number): RankedPrediction[] {
  const sorted = predictions
    .map((prediction) => ({
      ...prediction,
      distance: distance(prediction, homeGoals, awayGoals),
      exact: prediction.predictedHomeGoals === homeGoals && prediction.predictedAwayGoals === awayGoals,
      rank: 0
    }))
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
    });

  let previousDistance: number | null = null;
  let currentRank = 0;
  return sorted.map((prediction, index) => {
    if (prediction.distance !== previousDistance) {
      currentRank = index + 1;
      previousDistance = prediction.distance;
    }
    return { ...prediction, rank: currentRank };
  });
}
