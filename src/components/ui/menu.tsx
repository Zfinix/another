import { Menu } from "@base-ui/react/menu";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/lib/icons";

interface PopupProps {
  children: React.ReactNode;
  width?: number;
  side?: "top" | "bottom" | "left" | "right" | "inline-end";
  align?: "start" | "center" | "end";
  context?: boolean;
}

export function MenuPopup({ children, width, side = "bottom", align = "start", context }: PopupProps) {
  const Parts = context ? ContextMenu : Menu;
  return (
    <Parts.Portal>
      <Parts.Positioner side={side} align={align} sideOffset={6} className="z-100 outline-none">
        <Parts.Popup className="glass menu rise" style={width ? { width } : undefined}>
          {children}
        </Parts.Popup>
      </Parts.Positioner>
    </Parts.Portal>
  );
}

interface ItemProps {
  icon?: IconName;
  label: string;
  keys?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  trailing?: React.ReactNode;
  closeOnClick?: boolean;
}

export function MenuItem({ icon, label, keys, danger, disabled, onClick, trailing, closeOnClick = true }: ItemProps) {
  return (
    <Menu.Item className={danger ? "item danger" : "item"} disabled={disabled} onClick={onClick} closeOnClick={closeOnClick}>
      {icon && <Icon name={icon} />}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {keys && <span className="kbd">{keys}</span>}
      {trailing}
    </Menu.Item>
  );
}

export function MenuSeparator() {
  return <Menu.Separator className="menu-sep" />;
}

interface SubmenuProps {
  icon: IconName;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}

export function MenuSubmenu({ icon, label, children, disabled }: SubmenuProps) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="item" disabled={disabled}>
        <Icon name={icon} />
        <span className="flex-1 min-w-0 truncate">{label}</span>
        <Icon name="chevron" size="sm" style={{ color: "var(--muted)" }} />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner side="inline-end" align="start" sideOffset={4} className="z-100 outline-none">
          <Menu.Popup className="glass menu rise">{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

export { Menu, ContextMenu };
