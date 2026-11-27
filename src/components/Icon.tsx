import { cn } from "@/lib/utils";
import { icons, type IconName } from "@/lib/icons";

interface IconProps {
  name: IconName;
  size?: "sm" | "md" | "lg";
  className?: string;
  style?: React.CSSProperties;
  label?: string;
}

export function Icon({ name, size = "md", className, style, label }: IconProps) {
  return (
    <svg
      className={cn("fi", size === "sm" && "fi--sm", size === "lg" && "fi--lg", className)}
      viewBox="0 0 20 20"
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={icons[name]} />
    </svg>
  );
}
