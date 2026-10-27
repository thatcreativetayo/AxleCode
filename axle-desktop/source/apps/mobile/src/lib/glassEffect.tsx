import type { ComponentType } from "react";
import { View } from "react-native";

import type { GlassViewProps } from "expo-glass-effect";

import { isExpoGo } from "./expoGo";

type NativeGlassEffect = typeof import("expo-glass-effect");

/**
 * `expo-glass-effect` resolves its native module at module scope. Keep the
 * import lazy so Expo Go can use the existing opaque fallback surfaces.
 */
const nativeGlassEffect: NativeGlassEffect | null = isExpoGo()
  ? null
  : (require("expo-glass-effect") as NativeGlassEffect);

export function isGlassEffectAPIAvailable(): boolean {
  if (!nativeGlassEffect) {
    return false;
  }
  try {
    return nativeGlassEffect.isGlassEffectAPIAvailable();
  } catch {
    return false;
  }
}

function GlassViewFallback({
  glassEffectStyle: _glassEffectStyle,
  tintColor: _tintColor,
  isInteractive: _isInteractive,
  colorScheme: _colorScheme,
  style,
  ...props
}: GlassViewProps) {
  return <View {...props} style={style} />;
}

export const GlassView: ComponentType<GlassViewProps> =
  nativeGlassEffect?.GlassView ?? (GlassViewFallback as ComponentType<GlassViewProps>);
