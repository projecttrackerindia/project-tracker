/**
 * What a choice of people and billing period costs. The same arithmetic as the server (it is the server that charges): per-person price times people,
 * a volume discount for bigger teams, a discount for paying a year at once, the two together capped. Used to show the price while the person chooses.
 */
export interface VolumeTier { minSeats: number; percent: number }
export interface PricingPolicy { annualDiscountPercent: number; volumeTiers: VolumeTier[]; maxTotalDiscountPercent: number; trialSeats: number; trialAiCredits: number; maxSeats: number }

/** The published offer, used until the server's own numbers arrive. */
export const DEFAULT_POLICY: PricingPolicy = {
  annualDiscountPercent: 20, maxTotalDiscountPercent: 30, trialSeats: 5, trialAiCredits: 100, maxSeats: 5000,
  volumeTiers: [{ minSeats: 10, percent: 10 }, { minSeats: 25, percent: 15 }, { minSeats: 100, percent: 20 }],
};

export type Period = 'monthly' | 'yearly';

export interface Quote {
  seats: number; period: Period; listPerSeatMonthly: number; volumePercent: number; annualPercent: number; totalPercent: number;
  effectivePerSeatMonthly: number; chargePerCycle: number; cycleMonths: number; listTotalPerCycle: number; savedPerCycle: number;
}

const round = (n: number, digits: number) => { const f = 10 ** digits; return Math.round((n + Number.EPSILON) * f) / f; };

export function volumePercent(policy: PricingPolicy, seats: number) {
  return policy.volumeTiers.filter((t) => seats >= t.minSeats).reduce((m, t) => Math.max(m, t.percent), 0);
}

export function quote(policy: PricingPolicy, unit: number, perSeat: boolean, seatsWanted: number, period: Period): Quote {
  const seats = perSeat ? Math.min(Math.max(Math.floor(seatsWanted) || 1, 1), policy.maxSeats) : 1;
  const volume = perSeat ? volumePercent(policy, seats) : 0;
  const annual = period === 'yearly' ? policy.annualDiscountPercent : 0;
  const total = Math.min(policy.maxTotalDiscountPercent, volume + annual);
  const months = period === 'yearly' ? 12 : 1;
  const list = unit * seats * months;
  const charge = total === 0 ? round(list, 2) : round(list * (100 - total) / 100, 0);
  return { seats, period, listPerSeatMonthly: unit, volumePercent: volume, annualPercent: annual, totalPercent: total,
    effectivePerSeatMonthly: round(charge / months / seats, 2), chargePerCycle: charge, cycleMonths: months, listTotalPerCycle: list, savedPerCycle: list - charge };
}
