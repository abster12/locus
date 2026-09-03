type LocusMarkProps = {
  className?: string;
  decorative?: boolean;
};

export function LocusMark({ className = "", decorative = false }: LocusMarkProps) {
  return (
    <svg
      className={`locus-mark ${className}`.trim()}
      viewBox="0 0 64 64"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : "Locus"}
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="9">
        <path d="M27 11H21c-5.5 0-10 4.5-10 10v6" />
        <path d="M37 11h6c5.5 0 10 4.5 10 10v6" />
        <path d="M11 37v6c0 5.5 4.5 10 10 10h6" />
        <path d="M53 37v6c0 5.5-4.5 10-10 10h-6" />
      </g>
      <circle className="locus-mark-point" cx="32" cy="32" r="6" />
    </svg>
  );
}

export function BrandLockup() {
  return (
    <div className="brand-lockup" aria-label="Locus">
      <LocusMark decorative />
      <span className="wordmark" aria-hidden="true">Locus</span>
    </div>
  );
}
