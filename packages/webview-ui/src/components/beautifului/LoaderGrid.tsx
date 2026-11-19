export type LoaderGridVariant = 'Drive' | 'Dots' | 'Orbit';

const CHEVRON_DELAYS: readonly (number | null)[] = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT_DELAYS: readonly (number | null)[] = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<
  LoaderGridVariant,
  { readonly delays: readonly (number | null)[]; readonly dur: number; readonly round: boolean }
> = {
  Drive: { delays: CHEVRON_DELAYS, dur: 650, round: false },
  Dots: { delays: CHEVRON_DELAYS, dur: 650, round: true },
  Orbit: { delays: ORBIT_DELAYS, dur: 950, round: false },
};

/** Beautiful UI Loading State 3×3 像素网格加载指示器（Drive / Dots / Orbit）。 */
export function LoaderGrid({
  variant,
  round = false,
  className = '',
}: {
  readonly variant?: LoaderGridVariant;
  readonly round?: boolean;
  readonly className?: string;
}) {
  const resolvedVariant: LoaderGridVariant = variant ?? (round ? 'Dots' : 'Drive');
  const pattern = PATTERNS[resolvedVariant];
  return (
    <span
      aria-hidden
      data-variant={resolvedVariant}
      className={`grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px] ${className}`}
    >
      {pattern.delays.map((delay, index) => (
        <span
          key={index}
          className={`size-[4px] bg-ink ${pattern.round ? 'rounded-full' : 'rounded-[1px]'}`}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? 'none' : `pixel-on ${pattern.dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}
