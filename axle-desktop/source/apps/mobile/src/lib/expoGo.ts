import Constants from "expo-constants";

let cachedIsExpoGo: boolean | null = null;

/**
 * Whether this JS bundle is running inside the Expo Go client.
 *
 * Expo Go only contains a fixed set of native modules, so optional native
 * integrations (liquid glass, nitro markdown, the custom composer, live
 * activities, OTA updates, ...) must not be evaluated or rendered there.
 *
 * `isRunningInExpoGo()` is the authoritative check: it looks for the ExpoGo
 * native module. We load it lazily so importing this helper never pulls the
 * Expo runtime into tests or non-Expo bundles. `appOwnership` is kept as a
 * fallback for older Expo Go versions where the ExpoGo module is absent.
 *
 * Do not use `executionEnvironment === "storeClient"` here: dev clients also
 * report `storeClient`, and they must keep using their native modules.
 */
export function isExpoGo(): boolean {
  if (cachedIsExpoGo !== null) {
    return cachedIsExpoGo;
  }

  let result = false;
  try {
    const expo = require("expo") as typeof import("expo");
    result = expo.isRunningInExpoGo();
  } catch {
    result = false;
  }

  if (!result) {
    result = Constants.appOwnership === "expo";
  }

  cachedIsExpoGo = result;
  return result;
}
