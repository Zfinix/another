import { useState, useRef, useEffect, useCallback } from "react";
import type { Settings } from "../types";
import { ADAPTIVE_TIERS } from "../types";

const TIER_NAMES = ["Low", "Low+", "Medium", "Medium+", "High", "Ultra"];
const DEGRADED_THRESHOLD_MS = 2000;
const STABLE_THRESHOLD_MS = 10000;
const COOLDOWN_MS = 5000;
const FPS_DEGRADE_RATIO = 0.8;
const FPS_STABLE_RATIO = 0.95;
const QUEUE_HIGH = 5;
const QUEUE_LOW = 2;

interface UseAdaptiveBitrateOptions {
  enabled: boolean;
  decoder: React.RefObject<VideoDecoder | null>;
  currentSettings: Settings;
  onTierChange: (newSettings: Settings) => void;
}

export interface AdaptiveMetrics {
  fps: number;
  queueSize: number;
  tierName: string;
  tierIndex: number;
}

function findClosestTier(settings: Settings): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ADAPTIVE_TIERS.length; i++) {
    const dist = Math.abs(ADAPTIVE_TIERS[i].video_bit_rate - settings.video_bit_rate);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function useAdaptiveBitrate(opts: UseAdaptiveBitrateOptions) {
  const { enabled, decoder, currentSettings, onTierChange } = opts;
  const [tierIndex, setTierIndex] = useState(() => findClosestTier(currentSettings));
  const [metrics, setMetrics] = useState<AdaptiveMetrics>({
    fps: 0,
    queueSize: 0,
    tierName: TIER_NAMES[findClosestTier(currentSettings)],
    tierIndex: findClosestTier(currentSettings),
  });

  const frameCount = useRef(0);
  const degradedSince = useRef<number | null>(null);
  const stableSince = useRef<number | null>(null);
  const lastChangeAt = useRef(0);
  const manualOverride = useRef(false);
  const tierRef = useRef(tierIndex);
  const settingsRef = useRef(currentSettings);
  const onTierChangeRef = useRef(onTierChange);

  useEffect(() => {
    tierRef.current = tierIndex;
    settingsRef.current = currentSettings;
    onTierChangeRef.current = onTierChange;
  });

  const frameReceived = useCallback(() => {
    frameCount.current++;
  }, []);

  useEffect(() => {
    if (enabled) {
      manualOverride.current = false;
      const initial = findClosestTier(currentSettings);
      setTierIndex(initial);
      tierRef.current = initial;
      degradedSince.current = null;
      stableSince.current = null;
      lastChangeAt.current = Date.now();
      frameCount.current = 0;
    }
  }, [enabled, currentSettings]);

  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      if (manualOverride.current) return;
      if (!decoder.current || decoder.current.state !== "configured") return;

      const now = Date.now();
      const fps = frameCount.current;
      frameCount.current = 0;

      if (fps === 0) return;

      if (now - lastChangeAt.current < COOLDOWN_MS) {
        degradedSince.current = null;
        stableSince.current = null;
        setMetrics({
          fps,
          queueSize: decoder.current?.decodeQueueSize ?? 0,
          tierName: TIER_NAMES[tierRef.current],
          tierIndex: tierRef.current,
        });
        return;
      }

      const queueSize = decoder.current?.decodeQueueSize ?? 0;
      const currentTier = tierRef.current;
      const targetFps = settingsRef.current.max_fps;
      const fpsRatio = targetFps > 0 ? fps / targetFps : 1;

      setMetrics({
        fps,
        queueSize,
        tierName: TIER_NAMES[currentTier],
        tierIndex: currentTier,
      });

      const hasEnoughFrames = fps > 5;
      const isDegraded = hasEnoughFrames && (fpsRatio < FPS_DEGRADE_RATIO || queueSize > QUEUE_HIGH);
      const isStable = hasEnoughFrames && fpsRatio > FPS_STABLE_RATIO && queueSize < QUEUE_LOW;

      if (isDegraded) {
        stableSince.current = null;
        if (degradedSince.current === null) {
          degradedSince.current = now;
        } else if (
          now - degradedSince.current > DEGRADED_THRESHOLD_MS &&
          now - lastChangeAt.current > COOLDOWN_MS &&
          currentTier > 0
        ) {
          const newTier = currentTier - 1;
          const tier = ADAPTIVE_TIERS[newTier];
          setTierIndex(newTier);
          tierRef.current = newTier;
          lastChangeAt.current = now;
          degradedSince.current = null;
          onTierChangeRef.current({
            ...settingsRef.current,
            max_size: tier.max_size,
            max_fps: tier.max_fps,
            video_bit_rate: tier.video_bit_rate,
          });
        }
      } else if (isStable) {
        degradedSince.current = null;
        if (stableSince.current === null) {
          stableSince.current = now;
        } else if (
          now - stableSince.current > STABLE_THRESHOLD_MS &&
          now - lastChangeAt.current > COOLDOWN_MS &&
          currentTier < ADAPTIVE_TIERS.length - 1
        ) {
          const newTier = currentTier + 1;
          const tier = ADAPTIVE_TIERS[newTier];
          setTierIndex(newTier);
          tierRef.current = newTier;
          lastChangeAt.current = now;
          stableSince.current = null;
          onTierChangeRef.current({
            ...settingsRef.current,
            max_size: tier.max_size,
            max_fps: tier.max_fps,
            video_bit_rate: tier.video_bit_rate,
          });
        }
      } else {
        degradedSince.current = null;
        stableSince.current = null;
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [enabled, decoder]);

  const disableAdaptive = useCallback(() => {
    manualOverride.current = true;
  }, []);

  return {
    tierIndex,
    metrics,
    frameReceived,
    disableAdaptive,
  };
}
