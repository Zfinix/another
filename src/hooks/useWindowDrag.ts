import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DRAG_STRIP_PX = 52;
const INTERACTIVE = "button,a,input,textarea,select,label,canvas,[role=button],[role=slider],[role=tab],[role=menuitem],[role=option],[role=dialog],[data-no-drag]";

/** Lets the empty top strip of the window move it, and double-clicking there zoom it, like a native title bar. */
export function useWindowDrag() {
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.clientY > DRAG_STRIP_PX || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (!target || target.closest(INTERACTIVE)) return;
      const win = getCurrentWindow();
      if (e.detail === 2) {
        win.toggleMaximize().catch(() => { });
        return;
      }
      win.startDragging().catch(() => { });
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, []);
}
