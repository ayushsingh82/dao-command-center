/** Price path: a steep run-up, a drawdown, then flat. Deterministic. Ported from House Money's simulation. */
export function pricePath(upSteps = 24, downSteps = 12, tailSteps = 20, start = 1, peak = 4, dropPct = 0.4): number[] {
  const out: number[] = [];
  for (let i = 1; i <= upSteps; i++) out.push(start + ((peak - start) * i) / upSteps);
  for (let j = 1; j <= downSteps; j++) out.push(peak * Math.pow(1 - dropPct, j / downSteps));
  const last = out[out.length - 1]!;
  for (let k = 0; k < tailSteps; k++) out.push(last);
  return out;
}
