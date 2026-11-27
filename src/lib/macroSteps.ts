import type { MacroTimedEvent } from "@/types";
import type { IconName } from "@/lib/icons";

export interface MacroStep {
  icon: IconName;
  text: string;
  target: string;
}

const TAP_MAX_MOVE = 24;
const LONG_PRESS_MS = 500;
const SHOWN_WAIT_MS = 1000;

const BUTTON_NAMES: Record<string, { text: string; icon: IconName }> = {
  home: { text: "Press Home", icon: "homeOn" },
  back: { text: "Press Back", icon: "backOn" },
  recents: { text: "Open recent apps", icon: "recentsOn" },
  power: { text: "Press Power", icon: "powerOn" },
  volume_up: { text: "Turn the volume up", icon: "volumeUp" },
  volume_down: { text: "Turn the volume down", icon: "volumeDown" },
};

function point(x: number, y: number) {
  return `${Math.round(x)}, ${Math.round(y)}`;
}

function seconds(ms: number) {
  return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** Turns raw recorded input into the readable steps shown in the Macros view. */
export function macroSteps(events: MacroTimedEvent[]): MacroStep[] {
  const steps: MacroStep[] = [];
  let lastEnd: number | null = null;
  let i = 0;

  const pushWait = (at: number) => {
    if (lastEnd !== null && at - lastEnd >= SHOWN_WAIT_MS) {
      steps.push({ icon: "wait", text: "Wait", target: seconds(at - lastEnd) });
    }
  };

  while (i < events.length) {
    const { timestamp_ms: at, event } = events[i];
    if (event.type === "wait") {
      steps.push({ icon: "wait", text: "Wait", target: seconds(event.ms) });
      lastEnd = at + event.ms;
      i++;
      continue;
    }
    pushWait(at);
    if (event.type === "touch" && event.action === "down") {
      let j = i + 1;
      while (j < events.length && events[j].event.type === "touch" && (events[j].event as { action: string }).action !== "up") j++;
      const end = events[Math.min(j, events.length - 1)];
      const endEvent = end.event.type === "touch" ? end.event : event;
      const moved = Math.hypot(endEvent.x - event.x, endEvent.y - event.y);
      const held = end.timestamp_ms - at;
      if (moved > TAP_MAX_MOVE) {
        steps.push({ icon: "tap", text: "Swipe", target: `${point(event.x, event.y)} to ${point(endEvent.x, endEvent.y)}` });
      } else {
        steps.push({ icon: "tap", text: held >= LONG_PRESS_MS ? "Long press" : "Tap", target: point(event.x, event.y) });
      }
      lastEnd = end.timestamp_ms;
      i = j + 1;
      continue;
    }
    if (event.type === "text") {
      steps.push({ icon: "edit", text: "Type text", target: `"${event.text}"` });
    } else if (event.type === "button") {
      const known = BUTTON_NAMES[event.button];
      steps.push({ icon: known?.icon ?? "tap", text: known?.text ?? `Press ${event.button}`, target: "" });
    } else if (event.type === "key" && event.action !== "up") {
      steps.push({ icon: "options", text: "Press a key", target: `keycode ${event.keycode}` });
    } else if (event.type === "scroll") {
      const target = point(event.x, event.y);
      const previous = steps[steps.length - 1];
      if (!(previous?.text === "Scroll" && previous.target === target)) {
        steps.push({ icon: "updown", text: "Scroll", target });
      }
    }
    lastEnd = at;
    i++;
  }
  return steps;
}
