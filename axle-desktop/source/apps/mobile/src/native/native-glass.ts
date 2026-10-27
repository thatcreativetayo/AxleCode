import { Platform } from "react-native";

import { isLiquidGlassSupported } from "../lib/liquidGlass";
import { supportsNativeLiquidGlass } from "../lib/native-glass-capability";

export const NATIVE_LIQUID_GLASS_SUPPORTED = supportsNativeLiquidGlass(
  Platform.OS,
  isLiquidGlassSupported,
);
