import { isExpoGo } from "../lib/expoGo";

type AgentActivityModule = typeof import("./AgentActivity");
type AgentActivityWidget = AgentActivityModule["default"];

let cachedAgentActivity: AgentActivityWidget | null | undefined;

/**
 * `AgentActivity` pulls in `expo-widgets` and `@expo/ui/swift-ui`, both of
 * which require native modules during module evaluation. Expo Go cannot load
 * them, so resolve the widget lazily and return null there.
 */
export function getAgentActivity(): AgentActivityWidget | null {
  if (cachedAgentActivity !== undefined) {
    return cachedAgentActivity;
  }

  if (isExpoGo()) {
    cachedAgentActivity = null;
    return null;
  }

  try {
    cachedAgentActivity = (require("./AgentActivity") as AgentActivityModule).default;
  } catch {
    cachedAgentActivity = null;
  }
  return cachedAgentActivity;
}
