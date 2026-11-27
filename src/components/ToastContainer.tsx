import { cn } from "@/lib/utils";
import type { Toast } from "../types";

interface ToastContainerProps {
  toasts: Toast[];
}

export function ToastContainer({ toasts }: ToastContainerProps) {
  return (
    <div className="fixed bottom-14 left-1/2 -translate-x-1/2 flex flex-col gap-2 z-100 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "px-3.5 py-2 rounded-[10px] text-[12px] leading-[1.45] max-w-[min(340px,calc(100vw-32px))] text-center backdrop-blur-xl border shadow-(--float-shadow) animate-in fade-in slide-in-from-bottom-2 duration-200",
            t.type === "error" && "bg-popover/95 border-danger/40 text-danger",
            t.type === "info" && "bg-popover/95 border-border text-foreground"
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
