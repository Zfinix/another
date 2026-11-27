import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/lib/icons";

export interface SelectOption<T> {
  value: T;
  label: string;
}

interface CellSelectProps<T> {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  icon?: { name: IconName; tone: string };
  disabled?: boolean;
}

export function CellSelect<T extends string | number>({ label, value, options, onChange, icon, disabled }: CellSelectProps<T>) {
  const current = options.find((o) => o.value === value);
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectPrimitive.Trigger className={icon ? "row row--icon" : "row"} render={<button type="button" />} style={{ cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.4 : 1 }}>
        <span>
          {icon && <span className={`gi logo ${icon.tone}`}><Icon name={icon.name} /></span>}
          {label}
        </span>
        <span className="value">
          {current?.label ?? ""}
          <Icon name="updown" size="sm" />
        </span>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner side="bottom" align="end" sideOffset={6} alignItemWithTrigger={false} className="z-100 outline-none">
          <SelectPrimitive.Popup className="glass menu rise" style={{ minWidth: 200 }}>
            <SelectPrimitive.List className="flex flex-col gap-0.5 outline-none">
              {options.map((o) => (
                <SelectPrimitive.Item key={String(o.value)} value={o.value} className="item">
                  <SelectPrimitive.ItemText className="flex-1">{o.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator>
                    <Icon name="done" style={{ color: "var(--live)" }} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
