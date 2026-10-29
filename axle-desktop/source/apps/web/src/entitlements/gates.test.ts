import { describe, expect, it } from "vite-plus/test";
import type { CloudEntitlements } from "@axle/contracts";

import {
  cloudJobsLocked,
  pluginLockedForPlan,
  pullRequestReviewsLocked,
  scheduledTasksLimit,
} from "./gates";

const free: CloudEntitlements = {
  planId: "free",
  cloudJobsEnabled: false,
  monthlyCredits: 20,
  maxConcurrentJobs: 1,
  features: { scheduledTasksMax: 2, pullRequestReviews: false, teamSharing: false },
};

const pro: CloudEntitlements = {
  planId: "pro",
  cloudJobsEnabled: true,
  monthlyCredits: 500,
  maxConcurrentJobs: 4,
  features: { scheduledTasksMax: 50, pullRequestReviews: true, teamSharing: false },
};

describe("entitlement gates", () => {
  it("locks nothing when no plan was positively resolved", () => {
    expect(cloudJobsLocked(null)).toBe(false);
    expect(pullRequestReviewsLocked(null)).toBe(false);
    expect(scheduledTasksLimit(null)).toBeNull();
  });

  it("locks Pro features on the Free plan", () => {
    expect(cloudJobsLocked(free)).toBe(true);
    expect(pullRequestReviewsLocked(free)).toBe(true);
    expect(scheduledTasksLimit(free)).toBe(2);
  });

  it("unlocks everything on Pro", () => {
    expect(cloudJobsLocked(pro)).toBe(false);
    expect(pullRequestReviewsLocked(pro)).toBe(false);
    expect(scheduledTasksLimit(pro)).toBe(50);
  });

  it("keeps GitHub free and locks the other plugins on the Free plan", () => {
    expect(pluginLockedForPlan(free, "github")).toBe(false);
    for (const pluginId of ["jira", "notion", "gmail", "slack", "sentry", "figma"]) {
      expect(pluginLockedForPlan(free, pluginId)).toBe(true);
    }
  });

  it("unlocks every plugin on Pro and fails open without a resolved plan", () => {
    expect(pluginLockedForPlan(pro, "jira")).toBe(false);
    expect(pluginLockedForPlan(null, "jira")).toBe(false);
  });
});
