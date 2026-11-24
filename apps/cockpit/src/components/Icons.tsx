import type { SVGProps } from "react";

/** Self-contained 24×24 stroke icon set — zero icon fonts, zero CDNs. */
const PATHS = {
  sun: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
  moon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z",
  gauge: "M12 14l4-4M3.5 17a9 9 0 1 1 17 0M12 14a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 15V9a4 4 0 0 1 4-4h6M18 9v6a4 4 0 0 1-4 4H8",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3Z",
  shieldCheck: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3Zm-3.5 9 2.5 2.5 4.5-5",
  sync: "M20 11a8 8 0 0 0-14.3-4.9L4 8m0-4v4h4m-4 5a8 8 0 0 0 14.3 4.9L20 16m0 4v-4h-4",
  copy: "M9 9h10v12H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  check: "M5 12.5l4.5 4.5L19 7.5",
  play: "M7 4.5v15l12-7.5-12-7.5Z",
  rollback: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  diff: "M12 3v8m-4-4h8M8 17h8M5 21h14a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1Z",
  plus: "M12 5v14M5 12h14",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  clock: "M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  branch: "M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0a9 9 0 0 1-9 9",
  box: "M21 8 12 3 3 8m18 0v8l-9 5m9-13-9 5m0 8-9-5V8m9 13v-8M3 8l9 5",
  terminal: "M4 17l6-5-6-5m8 12h8",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
  radio: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm-4.2 3.2a6 6 0 0 1 0-8.4m8.4 0a6 6 0 0 1 0 8.4M5 19a10 10 0 0 1 0-14m14 0a10 10 0 0 1 0 14",
  flask: "M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10",
  alert: "M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  x: "M6 6l12 12M18 6 6 18",
  hourglass: "M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4",
  file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Brand mark: a reticle over a rising pace curve. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="brand-mark">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--brand-bg)" stroke="var(--line-strong)" />
      <path d="M6 23 C 11 22, 13 12, 18 12 S 24 8, 26 7" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="18" cy="12" r="3.4" fill="none" stroke="var(--ok)" strokeWidth="1.6" />
      <path d="M18 6.5v2.2M18 15.3v2.2M12.5 12h2.2M21.3 12h2.2" stroke="var(--ok)" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6 25.5h20" stroke="var(--danger)" strokeWidth="1.4" strokeDasharray="2 2" opacity="0.8" />
    </svg>
  );
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b1118"/><path d="M6 23C11 22 13 12 18 12S24 8 26 7" fill="none" stroke="#7cc4ff" stroke-width="2.4" stroke-linecap="round"/><circle cx="18" cy="12" r="3.4" fill="none" stroke="#3ddc97" stroke-width="1.8"/><path d="M6 25.5h20" stroke="#ff5d5d" stroke-width="1.4" stroke-dasharray="2 2"/></svg>`;
