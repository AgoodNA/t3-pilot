import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Tone } from "../format";
import { Icon, type IconName } from "./Icons";

export function Pill({ tone = "neutral", icon, pulse, solid, title, children, className = "" }: {
  tone?: Tone; icon?: IconName; pulse?: boolean; solid?: boolean; title?: string; children: ReactNode; className?: string;
}) {
  return (
    <span className={`pill tone-${tone}${solid ? " solid" : ""} ${className}`} title={title}>
      {pulse ? <span className="pulse-dot" aria-hidden="true" /> : icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export function Panel({ eyebrow, title, icon, actions, children, className = "", id }: {
  eyebrow?: string; title: ReactNode; icon?: IconName; actions?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  return (
    <section className={`panel ${className}`} id={id}>
      <header className="panel-head">
        <div className="panel-titles">
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h2 className="panel-title">{icon ? <Icon name={icon} size={16} /> : null}{title}</h2>
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  tone?: Tone;
  hint?: string;
}

export function Segmented<T extends string>({ options, value, onChange, size = "md", label, disabled }: {
  options: SegmentOption<T>[]; value: T; onChange: (value: T) => void; size?: "sm" | "md"; label: string; disabled?: boolean;
}) {
  return (
    <div className={`segmented size-${size}`} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value} type="button" role="radio" aria-checked={option.value === value} title={option.hint}
          className={`segment${option.value === value ? ` active tone-${option.tone ?? "accent"}` : ""}`}
          disabled={disabled} onClick={() => option.value !== value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`toggle${checked ? " on" : ""}`} onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

/** Horizontal remaining-% meter with the reserve-floor marker line. */
export function Meter({ label, value, floor, sublabel, color }: {
  label: string; value: number | null; floor: number; sublabel?: ReactNode; color: string;
}) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, value));
  const state = value === null ? "na" : value <= floor ? "locked" : value <= floor + 10 ? "near" : "ok";
  return (
    <div className={`meter meter-${state}`}>
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value num">{value === null ? "N/A" : `${value.toFixed(1)}%`}</span>
      </div>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
        <div className="meter-floor-zone" style={{ width: `${floor}%` }} />
        <div className="meter-fill" style={{ width: `${width}%`, ["--fill" as string]: color }} />
        <div className="meter-floor" style={{ left: `${floor}%` }} title={`${floor}% Emergency Reserve Shield`} />
        {[25, 50, 75].map((tick) => <span key={tick} className="meter-tick" style={{ left: `${tick}%` }} />)}
      </div>
      {sublabel ? <div className="meter-sub">{sublabel}</div> : null}
    </div>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: Tone; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <span className="stat-label">{label}</span>
      <span className={`stat-value num${tone ? ` text-${tone}` : ""}`}>{value}</span>
    </div>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button" className="btn btn-ghost btn-xs"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        }
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={13} />
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ title, code, lang }: { title: string; code: string; lang?: string }) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-title"><Icon name="file" size={12} />{title}</span>
        <span className="code-tools">{lang ? <span className="code-lang">{lang}</span> : null}<CopyButton text={code} /></span>
      </div>
      <pre className="code"><code>{code}</code></pre>
    </div>
  );
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="inline-error" role="alert"><Icon name="alert" size={14} />{message}</div>;
}
