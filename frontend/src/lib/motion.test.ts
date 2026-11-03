import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { duration, durationMs, ease, gentleSpring, itemVariants, presets, spring, staggerDelay, STAGGER_CAP, STAGGER_S, t } from './motion';

describe('motion tokens', () => {
  it('uses the agreed durations, all at or under 340ms', () => {
    expect(durationMs).toEqual({ micro: 120, standard: 200, emphasised: 280, sheet: 340 });
    for (const k of Object.keys(durationMs) as (keyof typeof durationMs)[]) expect(duration[k]).toBeCloseTo(durationMs[k] / 1000);
    for (const tr of Object.values(t)) if ('duration' in tr && tr.duration !== undefined) expect(tr.duration).toBeLessThanOrEqual(0.34);
  });

  it('has standard, decelerate and accelerate easings with no overshoot', () => {
    expect(ease.standard).toEqual([0.2, 0, 0, 1]);
    for (const b of Object.values(ease)) for (const y of [b[1], b[3]]) { expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1); }
  });

  it('has one gentle spring that does not visibly overshoot', () => {
    expect(gentleSpring).toMatchObject({ type: 'spring', stiffness: 420, damping: 38 });
    const zeta = gentleSpring.damping / (2 * Math.sqrt(gentleSpring.stiffness * gentleSpring.mass));
    expect(zeta).toBeGreaterThan(0.9);   // overshoot under 0.2%
    expect(spring.snappy).toBe(gentleSpring); expect(spring.panel).toBe(gentleSpring); expect(spring.gentle).toBe(gentleSpring);
  });

  it('staggers lists at most 30ms apart and only the first six items', () => {
    expect(STAGGER_S).toBeLessThanOrEqual(0.03);
    expect(STAGGER_CAP).toBe(6);
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(5)).toBeCloseTo(0.15);
    expect(staggerDelay(40)).toBeCloseTo(staggerDelay(5));
    const show = itemVariants.show as (i: number) => { transition: { delay: number } };
    expect(show(100).transition.delay).toBeCloseTo(0.15);
  });

  it('keeps presets small: 0.98 scale, 8px slide, no height animation', () => {
    expect(presets.fadeScale.initial.scale).toBe(0.98);
    expect(presets.slideUp.initial.y).toBe(8);
    expect(Math.abs(presets.panel.initial.x)).toBeLessThanOrEqual(24);
    expect(JSON.stringify(itemVariants.exit)).not.toMatch(/height/);
  });

  it('mirrors the tokens as CSS variables', () => {
    const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
    for (const [k, v] of Object.entries({ micro: 120, standard: 200, emphasised: 280, sheet: 340 })) expect(css).toContain(`--motion-${k}: ${v}ms`);
    expect(css).toContain('--ease-standard: cubic-bezier(.2, 0, 0, 1)');
  });
});
