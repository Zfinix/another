import { Icon } from "@/components/Icon";
import type { Toast } from "../types";

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-100 flex flex-col gap-2 w-[min(400px,calc(100vw-32px))] pointer-events-none" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="glass toast rise pointer-events-auto" style={t.detail ? { alignItems: "flex-start" } : undefined}>
          {t.type === "error" ? (
            <Icon name="error" size="lg" style={{ color: "var(--rec)", marginTop: t.detail ? 2 : 0 }} />
          ) : (
            <Icon name="done" size="lg" style={{ color: t.type === "success" ? "var(--live)" : "var(--muted)" }} />
          )}
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            {t.message}
            {t.detail && <span className="meta" style={{ fontWeight: 400 }}>{t.detail}</span>}
          </span>
          {t.action && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                t.action?.run();
                onDismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
