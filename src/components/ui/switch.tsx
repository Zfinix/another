import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}

export function Switch({ checked, onCheckedChange, disabled, label }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className="switch"
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      aria-label={label}
    >
      <SwitchPrimitive.Thumb data-thumb="" />
    </SwitchPrimitive.Root>
  );
}
