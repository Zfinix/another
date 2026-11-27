import { useState } from "react";
import { cn } from "@/lib/utils";
import { useBrandLogo } from "@/lib/brands";
import googleLogo from "../assets/google.svg";
import androidLogo from "../assets/android.svg";

interface DeviceTileProps {
  maker: string;
  size?: "sm" | "lg";
  off?: boolean;
}

const OFFLINE: Record<string, string> = { google: googleLogo, android: androidLogo };

export function DeviceTile({ maker, size = "sm", off }: DeviceTileProps) {
  const logo = useBrandLogo(maker);
  const [failed, setFailed] = useState<string | null>(null);
  const dark = document.documentElement.classList.contains("t-dark");
  const remote = logo ? (dark ? logo.dark : logo.light) : null;
  const src = remote && failed !== remote ? remote : OFFLINE[maker] ?? androidLogo;
  const isAndroid = src === androidLogo || maker === "android";

  return (
    <span className={cn("gi logo", size === "lg" && "gi--lg", off && "gi--off")}>
      <img
        src={src}
        alt=""
        draggable={false}
        onError={() => remote && setFailed(remote)}
        style={isAndroid ? { width: "72%", height: "72%", objectFit: "contain" } : { width: "60%", height: "60%", objectFit: "contain" }}
      />
    </span>
  );
}
