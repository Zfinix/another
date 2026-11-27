import { useState, useCallback } from "react";
import type { Toast, ToastOptions, ToastType } from "../types";

let toastId = 0;
const TOAST_MS = 4000;
const TOAST_WITH_ACTION_MS = 6000;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, type: ToastType = "error", options: ToastOptions = {}) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type, ...options }]);
    setTimeout(() => dismissToast(id), options.action ? TOAST_WITH_ACTION_MS : TOAST_MS);
  }, [dismissToast]);

  return { toasts, showToast, dismissToast };
}
