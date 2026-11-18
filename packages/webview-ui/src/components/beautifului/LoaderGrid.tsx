const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

/** Beautiful UI LoadingState 3×3 像素网格波纹加载指示器。 */
export function LoaderGrid({ round = false, className = '' }: { round?: boolean; className?: string }) {
  return (
    <span aria-hidden className={`grid shrink-0 grid-cols-[repeat(3,3.5px)] gap-[1.5px] ${className}`}>
      {CHEVRON_DELAYS.map((delay, index) => (
        <span
          key={index}
          className={`size-[3.5px] bg-ink ${round ? 'rounded-full' : 'rounded-[1px]'}`}
          style={{
            opacity: 0.15,
            animation: `pixel-on 650ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}
