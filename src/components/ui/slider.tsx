import { useRef } from "react";

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function SliderRow({ label, value, min, max, step, format, onChange, disabled }: SliderRowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const percent = ((value - min) / (max - min)) * 100;

  const fromPointer = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const next = clamp(min + ((clientX - rect.left) / rect.width) * (max - min));
    if (next !== value) onChange(next);
  };

  return (
    <div
      ref={ref}
      className="row slider"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={format(value)}
      aria-disabled={disabled}
      style={disabled ? { opacity: 0.4, pointerEvents: "none" } : undefined}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientX);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onChange(clamp(value + step)); }
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onChange(clamp(value - step)); }
      }}
    >
      <span className="fill" style={{ width: `${percent}%` }} />
      <span>{label}</span>
      <span className="value" style={{ fontVariantNumeric: "tabular-nums" }}>{format(value)}</span>
    </div>
  );
}
