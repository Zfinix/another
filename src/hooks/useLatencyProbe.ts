import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cleanError } from "../lib/errors";

const TRIALS = 12;
const WARMUP_TRIALS = 1;
const DETECT_TIMEOUT_MS = 1500;
const SETTLE_MS = 600;
const SHOW_TOUCHES_SETTLE_MS = 500;
const REGION_PX = 16;
const CHANGE_THRESHOLD = 25;
const PROBE_Y = 0.015;
const PROBE_XS = [0.35, 0.5, 0.65];

export interface LatencyResult {
  medianMs: number;
  p90Ms: number;
  minMs: number;
  samples: number;
  misses: number;
}

interface UseLatencyProbeOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  frameDrawnRef: React.MutableRefObject<(() => void) | null>;
  native: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sampleRegion(canvas: HTMLCanvasElement, x: number, y: number): Uint8ClampedArray | null {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
  const left = Math.max(0, Math.min(canvas.width - REGION_PX, Math.round(x * canvas.width - REGION_PX / 2)));
  const top = Math.max(0, Math.min(canvas.height - REGION_PX, Math.round(y * canvas.height - REGION_PX / 2)));
  return ctx.getImageData(left, top, REGION_PX, REGION_PX).data;
}

function meanDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return total / (a.length / 4) / 3;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function useLatencyProbe({ canvasRef, frameDrawnRef, native }: UseLatencyProbeOptions) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LatencyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  const waitForChange = useCallback((x: number, y: number, baseline: Uint8ClampedArray) => {
    return new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        frameDrawnRef.current = null;
        resolve(null);
      }, DETECT_TIMEOUT_MS);
      frameDrawnRef.current = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const now = sampleRegion(canvas, x, y);
        if (now && meanDiff(baseline, now) > CHANGE_THRESHOLD) {
          clearTimeout(timer);
          frameDrawnRef.current = null;
          resolve(performance.now());
        }
      };
    });
  }, [canvasRef, frameDrawnRef]);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    let previousShowTouches: boolean | null = null;
    const latencies: number[] = [];
    let misses = 0;
    try {
      previousShowTouches = await invoke<boolean>("set_show_touches", { enabled: true });
      await sleep(SHOW_TOUCHES_SETTLE_MS);
      for (let i = 0; i < TRIALS + WARMUP_TRIALS; i++) {
        if (native) {
          const x = PROBE_XS[i % PROBE_XS.length];
          const seen = await invoke<number>("native_latency_probe", { x, y: PROBE_Y }).catch(() => null);
          if (i >= WARMUP_TRIALS) {
            if (seen === null) misses++;
            else latencies.push(seen);
          }
          await sleep(SETTLE_MS);
          continue;
        }
        const canvas = canvasRef.current;
        if (!canvas) throw new Error("No video on screen");
        const x = PROBE_XS[i % PROBE_XS.length];
        const baseline = sampleRegion(canvas, x, PROBE_Y);
        if (!baseline) throw new Error("No video on screen");
        const changed = waitForChange(x, PROBE_Y, baseline);
        const started = performance.now();
        await invoke("send_touch", { action: "down", x, y: PROBE_Y });
        const seen = await changed;
        await invoke("send_touch", { action: "up", x, y: PROBE_Y });
        if (i >= WARMUP_TRIALS) {
          if (seen === null) misses++;
          else latencies.push(seen - started);
        }
        await sleep(SETTLE_MS);
      }
      if (latencies.length === 0) throw new Error("The tap never showed up on screen");
      latencies.sort((a, b) => a - b);
      const next: LatencyResult = {
        medianMs: percentile(latencies, 50),
        p90Ms: percentile(latencies, 90),
        minMs: latencies[0],
        samples: latencies.length,
        misses,
      };
      setResult(next);
      invoke("log_perf", { stats: { latencyProbe: next, renderer: native ? "native" : "web", latencies } }).catch(() => { });
    } catch (e) {
      setError(cleanError(e));
    } finally {
      frameDrawnRef.current = null;
      if (previousShowTouches !== null) {
        invoke("set_show_touches", { enabled: previousShowTouches }).catch(() => { });
      }
      runningRef.current = false;
      setRunning(false);
    }
  }, [canvasRef, frameDrawnRef, waitForChange, native]);

  return { running, result, error, run };
}
