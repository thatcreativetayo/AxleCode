import type { ComponentType } from "react";
import { View } from "react-native";

import type { LiquidGlassViewProps } from "@callstack/liquid-glass";

import { isExpoGo } from "./expoGo";

type NativeLiquidGlass = typeof import("@callstack/liquid-glass");

/**
 * `@callstack/liquid-glass` evaluates a TurboModule at module scope, which
 * throws in Expo Go. Load it only for native builds; Expo Go falls through to
 * the existing tinted View surfaces.
 */
const nativeLiquidGlass: NativeLiquidGlass | null = isExpoGo()
  ? null
  : (require("@callstack/liquid-glass") as NativeLiquidGlass);

export const isLiquidGlassSupported = Boolean(nativeLiquidGlass?.isLiquidGlassSupported);

function LiquidGlassFallback({
  effect: _effect,
  interactive: _interactive,
  tintColor: _tintColor,
  colorScheme: _colorScheme,
  style,
  ...props
}: LiquidGlassViewProps) {
  return <View {...props} style={style} />;
}

export const LiquidGlassView: ComponentType<LiquidGlassViewProps> =
  nativeLiquidGlass?.LiquidGlassView ??
  (LiquidGlassFallback as ComponentType<LiquidGlassViewProps>);
