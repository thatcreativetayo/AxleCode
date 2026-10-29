import { describe, expect, it } from "vite-plus/test";

import {
  PLUGINS,
  getPluginById,
  replacePluginTokensWithNames,
  searchPlugins,
  serializePluginToken,
} from "./pluginCatalog";

describe("plugin catalog", () => {
  it("contains the active integrations and the inactive Gmail placeholder", () => {
    expect(PLUGINS.map((plugin) => plugin.id)).toEqual([
      "github",
      "jira",
      "notion",
      "gmail",
      "slack",
      "sentry",
      "figma",
    ]);
    expect(PLUGINS.find((plugin) => plugin.id === "gmail")?.inactive).toBe(true);
  });

  it("serializes stable inline tokens and resolves their display names", () => {
    expect(serializePluginToken("github")).toBe("@plugin:github");
    expect(replacePluginTokensWithNames("Review this with @plugin:github.")).toBe(
      "Review this with GitHub.",
    );
    expect(replacePluginTokensWithNames("Keep @plugin:unknown untouched")).toBe(
      "Keep @plugin:unknown untouched",
    );
  });

  it("searches names, descriptions, and keywords", () => {
    expect(searchPlugins("monitor")[0]?.id).toBe("sentry");
    expect(searchPlugins("atlassian")[0]?.id).toBe("jira");
    expect(searchPlugins("design")[0]?.id).toBe("figma");
    expect(getPluginById("discord")).toBeNull();
  });

  it("excludes inactive plugins from autocomplete results", () => {
    expect(searchPlugins("mail")).toEqual([]);
  });
});
