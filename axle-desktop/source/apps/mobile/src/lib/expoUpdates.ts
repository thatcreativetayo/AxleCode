import { isExpoGo } from "./expoGo";

export interface ExpoUpdatesInfo {
  readonly isEnabled: boolean;
  readonly isEmbeddedLaunch: boolean;
  readonly updateId: string | null;
}

const EXPO_GO_UPDATES_INFO: ExpoUpdatesInfo = {
  isEnabled: false,
  isEmbeddedLaunch: true,
  updateId: null,
};

/**
 * Expo Go does not run OTA updates for the project bundle, and `expo-updates`
 * requires its native module during module evaluation. Read the status lazily
 * and fall back to "embedded" outside a native update-enabled build.
 */
export function getExpoUpdatesInfo(): ExpoUpdatesInfo {
  if (isExpoGo()) {
    return EXPO_GO_UPDATES_INFO;
  }

  try {
    const Updates = require("expo-updates") as typeof import("expo-updates");
    return {
      isEnabled: Updates.isEnabled,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      updateId: Updates.updateId ?? null,
    };
  } catch {
    return EXPO_GO_UPDATES_INFO;
  }
}
