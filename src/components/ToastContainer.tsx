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
            "px-[18px] py-2 rounded-lg text-xs font-medium max-w-[340px] text-center backdrop-blur-2xl animate-in fade-in slide-in-from-bottom-2 duration-250",
            t.type === "error" && "bg-red-400/95 text-white",
            t.type === "info" && "bg-surface text-foreground border border-border"
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
