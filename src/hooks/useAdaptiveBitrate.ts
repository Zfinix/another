import { useState, useRef, useEffect, useCallback } from "react";
import type { Settings } from "../types";
import { ADAPTIVE_TIERS } from "../types";

const TIER_NAMES = ["Low", "Low+", "Medium", "Medium+", "High", "Ultra"];
const DEGRADED_THRESHOLD_MS = 2000;
const STABLE_THRESHOLD_MS = 10000;
const COOLDOWN_MS = 5000;
const DOWNGRADE_COOLDOWN_MS = 3000;
const SEVERE_LAG_MS = 600;
const SEVERE_DEGRADED_MS = 1000;
const SEVERE_STEP = 2;
const LAG_DEGRADED_MS = 250;
const LAG_STABLE_MS = 80;
const QUEUE_HIGH = 5;
const QUEUE_LOW = 2;
const FAILED_UPGRADE_WINDOW_MS = 15000;
const BLOCK_MIN_MS = 30000;
const BLOCK_MAX_MS = 300000;

interface UseAdaptiveBitrateOptions {
  enabled: boolean;
  decoder: React.RefObject<VideoDecoder | null>;
  currentSettings: Settings;
  onTierChange: (newSettings: Settings) => void;
  native?: boolean;
}

export interface AdaptiveMetrics {
  fps: number;
  lagMs: number;
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
  const nativeRef = useRef(!!opts.native);
  nativeRef.current = !!opts.native;
  const [tierIndex, setTierIndex] = useState(() => findClosestTier(currentSettings));
  const [metrics, setMetrics] = useState<AdaptiveMetrics>({
    fps: 0,
    lagMs: 0,
    queueSize: 0,
    tierName: TIER_NAMES[findClosestTier(currentSettings)],
    tierIndex: findClosestTier(currentSettings),
  });

  const frameCount = useRef(0);
  const lagBaseline = useRef<number | null>(null);
  const lastPts = useRef(-1);
  const minLag = useRef(Infinity);
  const lastUpgradeAt = useRef(0);
  const blockedTier = useRef<number | null>(null);
  const blockedUntil = useRef(0);
  const blockMs = useRef(BLOCK_MIN_MS);
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

  const nativeSample = useCallback((fps: number, lagMinMs: number) => {
    frameCount.current += fps;
    if (lagMinMs < minLag.current) minLag.current = lagMinMs;
  }, []);

  const packetReceived = useCallback((ptsUs: number) => {
    const offset = performance.now() - ptsUs / 1000;
    if (lagBaseline.current === null || ptsUs < lastPts.current || offset < lagBaseline.current) {
      lagBaseline.current = offset;
    }
    lastPts.current = ptsUs;
    const lag = offset - lagBaseline.current;
    if (lag < minLag.current) minLag.current = lag;
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
      const webDecoderReady = decoder.current?.state === "configured";
      if (!nativeRef.current && !webDecoderReady) return;

      const now = Date.now();
      const fps = frameCount.current;
      frameCount.current = 0;
      const lagMs = Number.isFinite(minLag.current) ? Math.round(minLag.current) : 0;
      minLag.current = Infinity;

      if (fps === 0) return;

      if (now - lastChangeAt.current < DOWNGRADE_COOLDOWN_MS) {
        degradedSince.current = null;
        stableSince.current = null;
        setMetrics({
          fps,
          lagMs,
          queueSize: decoder.current?.decodeQueueSize ?? 0,
          tierName: TIER_NAMES[tierRef.current],
          tierIndex: tierRef.current,
        });
        return;
      }

      const queueSize = decoder.current?.decodeQueueSize ?? 0;
      const currentTier = tierRef.current;

      setMetrics({
        fps,
        lagMs,
        queueSize,
        tierName: TIER_NAMES[currentTier],
        tierIndex: currentTier,
      });

      const hasEnoughFrames = fps > 5;
      if (!hasEnoughFrames) return;

      const isDegraded = lagMs > LAG_DEGRADED_MS || queueSize > QUEUE_HIGH;
      const isSevere = lagMs > SEVERE_LAG_MS;
      const isStable = lagMs < LAG_STABLE_MS && queueSize < QUEUE_LOW;

      if (isDegraded) {
        stableSince.current = null;
        if (degradedSince.current === null) {
          degradedSince.current = now;
        } else if (
          now - degradedSince.current > (isSevere ? SEVERE_DEGRADED_MS : DEGRADED_THRESHOLD_MS) &&
          currentTier > 0
        ) {
          if (now - lastUpgradeAt.current < FAILED_UPGRADE_WINDOW_MS) {
            blockedTier.current = currentTier;
            blockedUntil.current = now + blockMs.current;
            blockMs.current = Math.min(blockMs.current * 2, BLOCK_MAX_MS);
          }
          const newTier = Math.max(0, currentTier - (isSevere ? SEVERE_STEP : 1));
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
          currentTier < ADAPTIVE_TIERS.length - 1 &&
          !(blockedTier.current === currentTier + 1 && now < blockedUntil.current)
        ) {
          const newTier = currentTier + 1;
          const tier = ADAPTIVE_TIERS[newTier];
          lastUpgradeAt.current = now;
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
    packetReceived,
    nativeSample,
    disableAdaptive,
  };
}
