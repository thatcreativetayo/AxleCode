import type { CloudEnvironmentSummary } from "@axle/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultProviderModel,
  ensureProviderModel,
  filterRepositoriesByHosts,
  hostsAllowBranchTracking,
  humanizeIdentifier,
  isPinnedSourceRef,
  isValidSourceRef,
  mergeAxleCatalogModels,
  modelsForProvider,
  providersForEnvironment,
  repositoryFullNameFromUrl,
  repositoryUrlForFullName,
} from "./cloudTargets.logic";

const environment: CloudEnvironmentSummary = {
  environmentId: "linux-standard",
  repositoryHosts: ["github.com"],
  providerModels: [
    { providerInstanceId: "anthropic-default", model: "claude-sonnet-4-5" },
    { providerInstanceId: "anthropic-default", model: "claude-opus-4-1" },
    { providerInstanceId: "openai-default", model: "gpt-5-codex" },
  ],
};

const repositories = [
  { nameWithOwner: "example/project", url: "https://github.com/example/project", isPrivate: false },
  { nameWithOwner: "example/private", url: "https://github.com/example/private", isPrivate: true },
  {
    nameWithOwner: "example/gitlab-mirror",
    url: "https://gitlab.com/example/project",
    isPrivate: false,
  },
];

describe("cloud target helpers", () => {
  it("parses GitHub repository URLs with or without .git", () => {
    expect(repositoryFullNameFromUrl("https://github.com/example/project.git")).toBe(
      "example/project",
    );
    expect(repositoryFullNameFromUrl("https://github.com/example/project")).toBe("example/project");
    expect(repositoryFullNameFromUrl("https://gitlab.com/example/project")).toBeNull();
    expect(repositoryFullNameFromUrl("not a url")).toBeNull();
    expect(repositoryUrlForFullName("example/project")).toBe("https://github.com/example/project");
  });

  it("keeps only repositories on hosts the environment accepts", () => {
    expect(
      filterRepositoriesByHosts(repositories, ["github.com"]).map((repo) => repo.nameWithOwner),
    ).toEqual(["example/project", "example/private"]);
    expect(filterRepositoriesByHosts(repositories, [])).toHaveLength(3);
  });

  it("lists unique providers and their allowed models in config order", () => {
    expect(providersForEnvironment(environment)).toEqual(["anthropic-default", "openai-default"]);
    expect(modelsForProvider(environment, "anthropic-default")).toEqual([
      "claude-sonnet-4-5",
      "claude-opus-4-1",
    ]);
    expect(modelsForProvider(environment, "missing")).toEqual([]);
    expect(providersForEnvironment(null)).toEqual([]);
  });

  it("defaults and repairs provider/model selections", () => {
    expect(defaultProviderModel(environment)).toEqual({
      providerInstanceId: "anthropic-default",
      model: "claude-sonnet-4-5",
    });
    expect(ensureProviderModel(environment, "openai-default", "gpt-5-codex")).toEqual({
      providerInstanceId: "openai-default",
      model: "gpt-5-codex",
    });
    expect(ensureProviderModel(environment, "openai-default", "claude-sonnet-4-5")).toEqual({
      providerInstanceId: "openai-default",
      model: "gpt-5-codex",
    });
    expect(ensureProviderModel(environment, "retired", "")).toEqual({
      providerInstanceId: "anthropic-default",
      model: "claude-sonnet-4-5",
    });
  });

  it("adds the live Axle catalog to Axle-gateway providers only", () => {
    const withAxle: CloudEnvironmentSummary = {
      ...environment,
      providerModels: [
        ...environment.providerModels,
        { providerInstanceId: "axle-default", model: "axle/glm-5.3" },
      ],
    };
    const merged = mergeAxleCatalogModels([withAxle], [{ id: "glm-5.3" }, { id: "gemma-4" }])[0]!;
    expect(modelsForProvider(merged, "axle-default")).toEqual(["axle/glm-5.3", "axle/gemma-4"]);
    expect(modelsForProvider(merged, "anthropic-default")).toEqual([
      "claude-sonnet-4-5",
      "claude-opus-4-1",
    ]);
    expect(mergeAxleCatalogModels([environment], [{ id: "gemma-4" }])[0]).toBe(environment);
  });

  it("recognizes refs and pinned commits", () => {
    expect(isPinnedSourceRef("a".repeat(40))).toBe(true);
    expect(isPinnedSourceRef("A".repeat(64))).toBe(true);
    expect(isPinnedSourceRef("main")).toBe(false);
    expect(isValidSourceRef("release/2026.10")).toBe(true);
    expect(isValidSourceRef("bad ref")).toBe(false);
    expect(isValidSourceRef("")).toBe(false);
    expect(hostsAllowBranchTracking(["github.com"])).toBe(true);
    expect(hostsAllowBranchTracking(["gitlab.com"])).toBe(false);
  });

  it("humanizes environment and provider ids for labels", () => {
    expect(humanizeIdentifier("linux-standard")).toBe("Linux standard");
    expect(humanizeIdentifier("anthropic_default")).toBe("Anthropic default");
    expect(humanizeIdentifier("axle")).toBe("Axle");
  });
});
