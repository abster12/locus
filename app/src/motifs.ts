export const MOTIFS: Record<string, string> = {
  torii: `<circle cx="60" cy="22" r="12"/><path d="M32 30 Q60 20 88 30"/><path d="M40 42 H80"/><path d="M44 72 V33 M76 72 V33"/><path d="M16 74 q7-7 14 0 t14 0 t14 0 t14 0 t14 0"/>`,
  arch: `<path d="M34 72 V44 Q34 20 60 20 Q86 20 86 44 V72"/><path d="M44 72 V48 Q44 32 60 32 Q76 32 76 48 V72"/><path d="M24 72 H96"/><circle cx="60" cy="11" r="4"/>`,
  peaks: `<path d="M12 70 L38 28 L52 50 L70 18 L104 70"/><circle cx="92" cy="14" r="7"/><path d="M14 78 H102"/>`,
  palms: `<path d="M46 72 q3-22 0-34"/><path d="M46 38 q-14-9-23-3 M46 38 q1-16 13-19 M46 38 q15-4 21 7"/><path d="M80 72 q2-14 0-22"/><path d="M80 50 q-10-6-17-2 M80 50 q2-10 11-11"/><circle cx="24" cy="16" r="7"/><path d="M14 72 H100"/>`,
  boat: `<path d="M20 54 q40 16 80 0 l-10 14 H30 z"/><path d="M62 54 V20"/><path d="M62 20 q26 11 15 32"/><path d="M14 80 q8-7 16 0 t16 0 t16 0 t16 0 t16 0"/>`,
  plane: `<path d="M18 52 L102 20 L66 80 L52 58 z"/><path d="M52 58 L102 20"/>`,
  bowl: `<path d="M30 44 h60 q0 22 -30 22 q-30 0 -30 -22 z"/><path d="M44 36 q-4-6 0-13 M60 36 q-4-6 0-13 M76 36 q-4-6 0-13"/><path d="M22 74 H98"/>`,
  pulse: `<path d="M14 52 h20 l9-18 11 32 9-14 h23"/><circle cx="60" cy="52" r="40"/>`,
  term: `<rect x="22" y="22" width="76" height="52" rx="4"/><path d="M34 36 l11 9 -11 9"/><path d="M54 56 h22"/>`,
  clip: `<rect x="30" y="24" width="60" height="52" rx="4"/><path d="M48 18 h24 v12 h-24 z"/><path d="M40 46 l9 9 17-18"/>`,
  coin: `<circle cx="60" cy="50" r="26"/><path d="M60 36 v28 M51 43 q9-7 18 0 M51 57 q9 7 18 0"/>`,
  book: `<path d="M60 30 q-16-10-34-6 v42 q18-4 34 6 q16-10 34-6 V24 q-18-4-34 6 z"/><path d="M60 30 v42"/>`,
  camera: `<rect x="24" y="32" width="72" height="42" rx="5"/><circle cx="60" cy="53" r="12"/><path d="M46 32 l7-9 h14 l7 9"/>`,
  heart: `<path d="M60 72 q-28-17-28-36 q0-13 13-13 q11 0 15 11 q4-11 15-11 q13 0 13 13 q0 19-28 36 z"/>`,
  spark: `<path d="M60 14 v18 M60 64 v18 M14 60 h18 M68 60 h18 M30 30 l12 12 M78 78 l-12-12 M90 30 l-12 12 M42 78 l-12-12"/>`,
  page: `<rect x="32" y="16" width="56" height="62" rx="3"/><path d="M42 30 h36 M42 40 h36 M42 50 h24"/>`,
  photo: `<rect x="18" y="22" width="84" height="56" rx="4"/><circle cx="40" cy="38" r="6"/><path d="M22 70 l22-22 14 14 12-12 28 20"/>`,
};

function svg(name: string, className: string, strokeWidth: number): string {
  const inner = MOTIFS[name] || MOTIFS.page || "";
  const cls = className ? ` class="${className}"` : "";
  return `<svg${cls} viewBox="0 0 120 92" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export function motif(name: string): string {
  return svg(name, "motif", 2.6);
}

export function motifIcon(name: string): string {
  return svg(name, "", 4);
}
