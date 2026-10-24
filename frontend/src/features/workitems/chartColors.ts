import { useMemo } from 'react';
import { useUi } from '../../stores/ui';

/** The chart's colours from the theme (an SVG fill attribute cannot read a CSS variable itself). */
export function useChartColors() {
  const theme = useUi((s) => s.theme);
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
    return {
      open: v('--chart-open', '#0071E3'), late: v('--chart-late', '#E5484D'), done: v('--chart-done', '#1A9F4B'), violet: v('--chart-violet', '#5E5CE6'),
      orange: v('--chart-orange', '#F08A00'), grid: v('--chart-grid', '#F0F0F3'), axis: v('--ds-text-4', '#86868B'), label: v('--ds-text-3', '#6E6E73'), name: v('--ds-text-2', '#424245'),
    };
  }, [theme]);   // eslint-disable-line react-hooks/exhaustive-deps
}
