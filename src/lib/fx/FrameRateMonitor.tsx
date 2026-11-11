"use client";

/**
 * Mounted inside the r3f Canvas: feeds every rendered frame to the sampler in
 * `./frameRate` and calls `onDecline` once when the frame rate stays low.
 */

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";

import { createFrameRateSampler } from "./frameRate";

export function FrameRateMonitor({ onDecline }: { onDecline: () => void }) {
  const sampler = useRef(createFrameRateSampler());
  const callback = useRef(onDecline);
  useEffect(() => {
    callback.current = onDecline;
  }, [onDecline]);

  useFrame(() => {
    if (sampler.current.frame(performance.now())) callback.current();
  });
  return null;
}
