import type { ReactNode } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { useStore } from "../../store";

export function Section({
  id, title, children, modified, onReset, defaultOpen = true, extra,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
  modified?: boolean;
  onReset?: () => void;
  defaultOpen?: boolean;
  extra?: ReactNode;
}) {
  const open = useStore((s) => s.sectionsOpen[id] ?? defaultOpen);
  const setOpen = useStore((s) => s.setSectionOpen);
  return (
    <div className="section">
      <button className="section-head" onClick={() => setOpen(id, !open)}>
        <ChevronRight size={14} className={`chev${open ? " open" : ""}`} />
        <span className="grow">{title}</span>
        {extra}
        {modified && !onReset && <span className="section-mod" />}
        {modified && onReset && (
          <span
            className="section-reset"
            role="button"
            data-tip="이 항목 초기화"
            data-tip-pos="left"
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
          >
            <RotateCcw size={13} />
          </span>
        )}
      </button>
      {open && <div className="section-content">{children}</div>}
    </div>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  tip?: string;
}

export function Segmented<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? "on" : ""}
          disabled={o.disabled}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  on, onChange, label, desc, disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  desc?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className={`toggle${on ? " on" : ""}`}
      style={disabled ? { opacity: 0.4, pointerEvents: "none" } : undefined}
      role="switch"
      aria-checked={on}
      tabIndex={0}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onChange(!on);
        }
      }}
    >
      <span className="sw" />
      <div>
        <div className="tl">{label}</div>
        {desc && <div className="td">{desc}</div>}
      </div>
    </div>
  );
}

export function ColorField({
  value, onChange, onCommit,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: () => void;
}) {
  return (
    <div className="color-input">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
      />
      <input
        type="text"
        defaultValue={value}
        key={value}
        maxLength={7}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          let v = e.target.value.trim();
          if (!v.startsWith("#")) v = "#" + v;
          if (/^#[0-9a-fA-F]{6}$/.test(v)) {
            onChange(v.toLowerCase());
            onCommit?.();
          } else e.target.value = value;
        }}
      />
    </div>
  );
}
