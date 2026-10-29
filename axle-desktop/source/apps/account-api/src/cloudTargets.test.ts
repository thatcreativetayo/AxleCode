import { describe, expect, it } from "vite-plus/test";

import type { CloudEnvironment } from "./cloudConfig.ts";
import { validateCloudModel } from "./cloudTargets.ts";

const environment: CloudEnvironment = {
  environmentId: "linux-standard",
  repositoryHosts: ["github.com"],
  providerModels: [
    { providerInstanceId: "axle-default", model: "axle/glm-5.3" },
    { providerInstanceId: "anthropic-default", model: "claude-sonnet-4-5" },
  ],
  maxConcurrentJobs: 4,
  limits: {
    maxDurationSeconds: 3_600,
    maxEvents: 100,
    cpuMillis: 4_000,
    memoryMb: 8_192,
    diskMb: 20_480,
    networkPolicy: "restricted",
  },
};

describe("validateCloudModel", () => {
  it("accepts an exactly configured pair", () => {
    expect(() =>
      validateCloudModel(environment, "anthropic-default", "claude-sonnet-4-5"),
    ).not.toThrow();
  });

  it("accepts any Axle catalog slug for an Axle provider", () => {
    expect(() => validateCloudModel(environment, "axle-default", "axle/gemma-4")).not.toThrow();
  });

  it("rejects unknown models and providers", () => {
    expect(() => validateCloudModel(environment, "axle-default", "not-axle")).toThrow();
    expect(() => validateCloudModel(environment, "anthropic-default", "axle/gemma-4")).toThrow();
    expect(() => validateCloudModel(environment, "missing", "axle/gemma-4")).toThrow();
  });
});
