import { useId } from 'react';

/**
 * HisabKitab mark: an open khata (ledger book) shaped like a chat bubble, with
 * the owner's ✓. Same geometry as public/brand/hisabkitab-mark.svg (the source
 * of truth); inlined so it inherits layout and needs no extra request. The mask
 * id is per-instance because the mark renders more than once per page.
 */
export function LogoMark({ className = 'h-8 w-8' }: { className?: string }) {
  const id = `hk-cut-${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 100 100" className={className} role="img" aria-label="HisabKitab">
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <path fill="#fff" d="M16 20H84Q92 20 92 28V72Q92 80 84 80C70 80 58 83 52 92H48C42 83 32 80 30 80L15 95V80Q8 80 8 72V28Q8 20 16 20Z" />
          <g fill="#fff" stroke="#000" strokeWidth="4.5" strokeLinejoin="round">
            <path d="M17 9C31 7 43 11 50 19V87C42 79 30 75 17 75Z" />
            <path d="M83 9C69 7 57 11 50 19V87C58 79 70 75 83 75Z" />
          </g>
          <path fill="none" stroke="#000" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" d="M30 47L44 60L71 33" />
        </mask>
      </defs>
      <rect width="100" height="100" fill="#F68B1F" mask={`url(#${id})`} />
      <path fill="none" stroke="#FDB813" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" d="M30 47L44 60L71 33" />
    </svg>
  );
}
