import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@/lib/utils";

interface AppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  label?: string;
  top?: number;
}

export function AppDialog({ open, onOpenChange, children, className, style, label, top = 96 }: AppDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="scrim" />
        <div className="fixed inset-x-0 bottom-0 z-50 flex items-start justify-center px-6 pb-6 pointer-events-none" style={{ top }}>
          <DialogPrimitive.Popup
            aria-label={label}
            className={cn("window window--solid rise pointer-events-auto outline-none max-h-full", className)}
            style={style}
          >
            {children}
          </DialogPrimitive.Popup>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const DialogTitle = DialogPrimitive.Title;
export const DialogClose = DialogPrimitive.Close;
