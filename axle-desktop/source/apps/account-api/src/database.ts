// @effect-diagnostics globalDate:off
import type { Db } from "mongodb";

import type { AccountApiConfig } from "./config.ts";
import type { AccountPrincipal } from "./auth.ts";
import { AccountDeviceConflictError, AccountSessionAccessError } from "./errors.ts";
import { ensureMongoIndexes, isDuplicateKeyError, mongoDatabase } from "./mongo.ts";

export interface AccountProfile {
  readonly userId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountStats {
  readonly totalTurns: number;
  readonly totalThreads: number;
  readonly totalInputTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalReasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly totalToolUses: number;
  readonly totalCostUsd: string;
  readonly mostUsedProvider: string | null;
  readonly mostUsedModel: string | null;
  readonly lastActiveAt: string | null;
}

export interface AccountDevice {
  readonly deviceId: string;
  readonly label: string | null;
  readonly deviceType: string;
  readonly platform: string | null;
  readonly osVersion: string | null;
  readonly appVersion: string | null;
  readonly browser: string | null;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
}

export interface AccountSession {
  readonly sessionId: string;
  readonly deviceId: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
}

export interface AccountSnapshot {
  readonly profile: AccountProfile;
  readonly stats: AccountStats;
  readonly devices: ReadonlyArray<AccountDevice>;
  readonly sessions: ReadonlyArray<AccountSession>;
}

export interface AccountDeviceInput {
  readonly deviceId: string;
  readonly label?: string;
  readonly deviceType?: string;
  readonly platform?: string;
  readonly osVersion?: string;
  readonly appVersion?: string;
  readonly browser?: string;
}

export interface UsageEventInput {
  readonly eventId: string;
  readonly deviceId?: string;
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly provider?: string;
  readonly providerInstanceId?: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly costUsd?: number;
  readonly occurredAt: string;
}

interface ProfileDoc {
  _id: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface StatsDoc {
  _id: string;
  totalTurns: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalReasoningOutputTokens: number;
  totalTokens: number;
  totalToolUses: number;
  totalCostUsd: number;
  mostUsedProvider: string | null;
  mostUsedModel: string | null;
  lastActiveAt: Date | null;
  updatedAt: Date;
}

interface DeviceDoc {
  _id: string;
  userId: string;
  label: string | null;
  deviceType: string;
  platform: string | null;
  osVersion: string | null;
  appVersion: string | null;
  browser: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
}

interface SessionDoc {
  _id: string;
  userId: string;
  deviceId: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

interface UsageModelDoc {
  _id: unknown;
  userId: string;
  provider: string;
  model: string;
  turnCount: number;
  totalTokens: number;
  lastUsedAt: Date;
}

export function createAccountDatabase(
  config: AccountApiConfig,
  db: Db = mongoDatabase(config.mongodbUri),
) {
  const migrate = async (): Promise<void> => {
    await ensureMongoIndexes(db);
  };

  const ensureAccount = async (userId: string): Promise<void> => {
    // Upsert-if-missing on both roots; never rewrites live rows. The SQL
    // version committed these two inserts in one transaction, but they are
    // independent defaults and each is idempotent, so ordering is irrelevant.
    await Promise.all([
      db.collection<ProfileDoc>("axle_account_profiles").updateOne(
        { _id: userId },
        {
          $setOnInsert: {
            displayName: null,
            avatarUrl: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      ),
      db.collection<StatsDoc>("axle_account_stats").updateOne(
        { _id: userId },
        {
          $setOnInsert: {
            totalTurns: 0,
            totalInputTokens: 0,
            totalCachedInputTokens: 0,
            totalOutputTokens: 0,
            totalReasoningOutputTokens: 0,
            totalTokens: 0,
            totalToolUses: 0,
            totalCostUsd: 0,
            mostUsedProvider: null,
            mostUsedModel: null,
            lastActiveAt: null,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      ),
    ]);
  };

  const touchSession = async (principal: AccountPrincipal): Promise<void> => {
    if (!principal.sessionId) return;
    const sessions = db.collection<SessionDoc>("axle_account_sessions");
    const now = new Date();
    const issuedAt = principal.issuedAt ?? null;
    const expiresAt = principal.expiresAt ?? null;
    try {
      await sessions.updateOne(
        { _id: principal.sessionId },
        {
          $setOnInsert: {
            userId: principal.userId,
            deviceId: null,
            issuedAt,
            expiresAt,
            lastSeenAt: now,
            revokedAt: null,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // A concurrent first touch owns the row; the conditional update below
      // decides whether this principal is allowed to keep it.
      if (!isDuplicateKeyError(error)) throw error;
    }
    const claims: Record<string, unknown> = { lastSeenAt: now };
    if (issuedAt) claims.issuedAt = issuedAt;
    if (expiresAt) claims.expiresAt = expiresAt;
    const accepted = await sessions.findOneAndUpdate(
      { _id: principal.sessionId, userId: principal.userId, revokedAt: null },
      { $set: claims },
      { returnDocument: "after" },
    );
    if (!accepted) throw new AccountSessionAccessError();
  };

  const getAccount = async (userId: string): Promise<AccountSnapshot> => {
    await ensureAccount(userId);
    const [profile, stats, deviceDocs, sessionDocs, threadIds, mostUsedRows] = await Promise.all([
      db.collection<ProfileDoc>("axle_account_profiles").findOne({ _id: userId }),
      db.collection<StatsDoc>("axle_account_stats").findOne({ _id: userId }),
      db
        .collection<DeviceDoc>("axle_account_devices")
        .find({ userId })
        .sort({ lastSeenAt: -1 })
        .toArray(),
      db
        .collection<SessionDoc>("axle_account_sessions")
        .find({ userId })
        .sort({ lastSeenAt: -1 })
        .toArray(),
      db
        .collection("axle_account_usage_events")
        .distinct("threadId", { userId, threadId: { $ne: null } }),
      db
        .collection<UsageModelDoc>("axle_account_usage_models")
        .find({ userId })
        .sort({ turnCount: -1, totalTokens: -1, lastUsedAt: -1 })
        .limit(1)
        .toArray(),
    ]);
    if (!profile || !stats) {
      throw new Error("Account profile initialization failed.");
    }
    const mostUsedModel = mostUsedRows[0];

    return {
      profile: {
        userId: String(profile._id),
        displayName: nullableString(profile.displayName),
        avatarUrl: nullableString(profile.avatarUrl),
        createdAt: timestamp(profile.createdAt),
        updatedAt: timestamp(profile.updatedAt),
      },
      stats: {
        totalTurns: toCount(stats.totalTurns),
        totalThreads: threadIds.filter((value) => typeof value === "string").length,
        totalInputTokens: toCount(stats.totalInputTokens),
        totalCachedInputTokens: toCount(stats.totalCachedInputTokens),
        totalOutputTokens: toCount(stats.totalOutputTokens),
        totalReasoningOutputTokens: toCount(stats.totalReasoningOutputTokens),
        totalTokens: toCount(stats.totalTokens),
        totalToolUses: toCount(stats.totalToolUses),
        totalCostUsd: String(stats.totalCostUsd ?? 0),
        mostUsedProvider: nullableString(mostUsedModel?.provider),
        mostUsedModel: nullableString(mostUsedModel?.model),
        lastActiveAt: timestampOrNull(stats.lastActiveAt),
      },
      devices: deviceDocs.map((row) => ({
        deviceId: String(row._id),
        label: nullableString(row.label),
        deviceType: String(row.deviceType),
        platform: nullableString(row.platform),
        osVersion: nullableString(row.osVersion),
        appVersion: nullableString(row.appVersion),
        browser: nullableString(row.browser),
        lastSeenAt: timestamp(row.lastSeenAt),
        revokedAt: timestampOrNull(row.revokedAt),
      })),
      sessions: sessionDocs.map((row) => ({
        sessionId: String(row._id),
        deviceId: nullableString(row.deviceId),
        issuedAt: timestampOrNull(row.issuedAt),
        expiresAt: timestampOrNull(row.expiresAt),
        lastSeenAt: timestamp(row.lastSeenAt),
        revokedAt: timestampOrNull(row.revokedAt),
      })),
    };
  };

  const updateProfile = async (
    userId: string,
    input: { readonly displayName?: string | null; readonly avatarUrl?: string | null },
  ): Promise<void> => {
    await ensureAccount(userId);
    // COALESCE semantics from the SQL upsert: null/undefined leave the stored
    // value untouched; only a concrete string writes.
    const claims: Record<string, unknown> = { updatedAt: new Date() };
    if (input.displayName != null) claims.displayName = input.displayName;
    if (input.avatarUrl != null) claims.avatarUrl = input.avatarUrl;
    await db
      .collection<ProfileDoc>("axle_account_profiles")
      .updateOne({ _id: userId }, { $set: claims });
  };

  const upsertDevice = async (userId: string, input: AccountDeviceInput): Promise<void> => {
    await ensureAccount(userId);
    const devices = db.collection<DeviceDoc>("axle_account_devices");
    const now = new Date();
    try {
      await devices.updateOne(
        { _id: input.deviceId },
        {
          $setOnInsert: {
            userId,
            label: input.label ?? null,
            deviceType: input.deviceType ?? "unknown",
            platform: input.platform ?? null,
            osVersion: input.osVersion ?? null,
            appVersion: input.appVersion ?? null,
            browser: input.browser ?? null,
            lastSeenAt: now,
            createdAt: now,
            revokedAt: null,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
    // device_type is always overwritten (matching the SQL excluded row), while
    // metadata keeps the stored value when the new registration omits it.
    const claims: Record<string, unknown> = {
      deviceType: input.deviceType ?? "unknown",
      lastSeenAt: now,
    };
    if (input.label != null) claims.label = input.label;
    if (input.platform != null) claims.platform = input.platform;
    if (input.osVersion != null) claims.osVersion = input.osVersion;
    if (input.appVersion != null) claims.appVersion = input.appVersion;
    if (input.browser != null) claims.browser = input.browser;
    const accepted = await devices.findOneAndUpdate(
      { _id: input.deviceId, userId, revokedAt: null },
      { $set: claims },
      { returnDocument: "after" },
    );
    if (!accepted) throw new AccountDeviceConflictError();
  };

  const recordUsageEvent = async (userId: string, input: UsageEventInput): Promise<boolean> => {
    const provider = input.provider?.trim() || "unknown";
    const model = input.model.trim();
    if (!input.eventId.trim() || !model) {
      throw new Error("Usage event ID and model are required.");
    }
    const occurredAt = new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error("Usage event timestamp is invalid.");
    }
    const values = {
      inputTokens: nonNegativeCount(input.inputTokens),
      cachedInputTokens: nonNegativeCount(input.cachedInputTokens),
      outputTokens: nonNegativeCount(input.outputTokens),
      reasoningOutputTokens: nonNegativeCount(input.reasoningOutputTokens),
      totalTokens: nonNegativeCount(input.totalTokens),
      toolUses: nonNegativeCount(input.toolUses),
      costUsd: input.costUsd === undefined ? 0 : Math.max(0, input.costUsd),
    };

    await ensureAccount(userId);
    try {
      await db.collection("axle_account_usage_events").insertOne({
        userId,
        eventId: input.eventId.trim(),
        deviceId: input.deviceId ?? null,
        environmentId: input.environmentId ?? null,
        threadId: input.threadId ?? null,
        turnId: input.turnId ?? null,
        provider,
        providerInstanceId: input.providerInstanceId ?? null,
        model,
        ...values,
        occurredAt,
      });
    } catch (error) {
      // The unique (userId, eventId) index makes replays exact no-ops: the
      // second delivery must not touch the daily/model/stat aggregates.
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }

    const usageDate = occurredAt.toISOString().slice(0, 10);
    const increments = {
      turnCount: 1,
      inputTokens: values.inputTokens,
      cachedInputTokens: values.cachedInputTokens,
      outputTokens: values.outputTokens,
      reasoningOutputTokens: values.reasoningOutputTokens,
      totalTokens: values.totalTokens,
      toolUses: values.toolUses,
      costUsd: values.costUsd,
    };
    await Promise.all([
      db
        .collection("axle_account_usage_daily")
        .updateOne(
          { userId, usageDate },
          { $inc: increments, $setOnInsert: { userId, usageDate } },
          { upsert: true },
        ),
      db.collection("axle_account_usage_models").updateOne(
        { userId, provider, model },
        {
          $inc: { turnCount: 1, totalTokens: values.totalTokens },
          $max: { lastUsedAt: occurredAt },
          $setOnInsert: { userId, provider, model },
        },
        { upsert: true },
      ),
      db.collection<StatsDoc>("axle_account_stats").updateOne(
        { _id: userId },
        {
          $inc: {
            totalTurns: 1,
            totalInputTokens: values.inputTokens,
            totalCachedInputTokens: values.cachedInputTokens,
            totalOutputTokens: values.outputTokens,
            totalReasoningOutputTokens: values.reasoningOutputTokens,
            totalTokens: values.totalTokens,
            totalToolUses: values.toolUses,
            totalCostUsd: values.costUsd,
          },
          $max: { lastActiveAt: occurredAt },
          $set: { updatedAt: new Date() },
        },
      ),
    ]);
    return true;
  };

  return {
    migrate,
    ensureAccount,
    touchSession,
    getAccount,
    updateProfile,
    upsertDevice,
    recordUsageEvent,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function timestampOrNull(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return timestamp(value) || null;
}

function toCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function nonNegativeCount(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.floor(value));
}
