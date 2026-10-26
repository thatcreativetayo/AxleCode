import { setManagedRelaySession } from "@axle/client-runtime/relay";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  clearPluginSession,
  createAnonymousPluginSession,
  createPluginSession,
  loadPersistedPluginSessionToken,
  loadPluginSessionToken,
  retryPendingPluginSessionRevocation,
  syncPluginSessionToServer,
} from "../components/plugins/pluginApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { pollDesktopSignIn } from "./desktopSignInPoll";
import {
  axleWorkerBaseUrl,
  claimClerkDesktopSignIn,
  clerkAuthFrameUrl,
  clerkAuthOrigin,
  clerkCallbackUrl,
  clerkExternalAuthUrl,
  exchangeClerkBrowserCode,
  isClerkFrameMessage,
  restoreClerkSession,
  setActiveClerkTokenReader,
  type ClerkBrowserExchange,
  type ClerkFrameMessage,
  type ClerkSession,
  type ClerkUser,
} from "./clerkRuntime";

type AccountState =
  | { readonly status: "loading"; readonly user: null; readonly session: null }
  | {
      readonly status: "signed-out";
      readonly user: null;
      readonly session: null;
      readonly pluginSessionReady: boolean;
      readonly pluginError: string | null;
    }
  | {
      readonly status: "signed-in";
      readonly user: ClerkUser;
      readonly session: ClerkSession;
      readonly pluginSessionReady: boolean;
      readonly pluginError: string | null;
    }
  | {
      readonly status: "error";
      readonly user: null;
      readonly session: null;
      readonly error: string;
    };

interface AccountContextValue {
  readonly account: AccountState;
  /** Opens the system browser at the Axle sign-in page. */
  readonly signIn: () => void;
  /** Clears the local account and best-effort revokes the server session. */
  readonly signOut: () => void;
  /** Connects an extra sign-in provider to the signed-in account. */
  readonly linkProvider: (providerId: string) => Promise<void>;
}

const NO_ACCOUNT_ACTIONS = {
  signIn: () => undefined,
  signOut: () => undefined,
  linkProvider: async () => undefined,
} as const;

const AccountContext = createContext<AccountContextValue>({
  account: {
    status: "loading",
    user: null,
    session: null,
  },
  ...NO_ACCOUNT_ACTIONS,
});
const TOKEN_REQUEST_TIMEOUT_MS = 5_000;
const EXTERNAL_AUTH_POLL_INTERVAL_MS = 1_000;
const EXTERNAL_AUTH_TIMEOUT_MS = 5 * 60_000;
let tokenRequestSequence = 0;

function tokenExpiresWithin(token: string, seconds: number): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const json = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
    const exp = (JSON.parse(json) as { readonly exp?: unknown }).exp;
    return typeof exp !== "number" || exp <= Math.floor(Date.now() / 1000) + seconds;
  } catch {
    return true;
  }
}

export function useAccountState(): AccountState {
  return useContext(AccountContext).account;
}

/** Sign-in and sign-out entry points for account UI. */
export function useAccountActions(): Pick<
  AccountContextValue,
  "signIn" | "signOut" | "linkProvider"
> {
  const { signIn, signOut, linkProvider } = useContext(AccountContext);
  return { signIn, signOut, linkProvider };
}

function makeRequestId(): string {
  tokenRequestSequence += 1;
  return `clerk-token-${tokenRequestSequence}`;
}

export function AccountAuthProvider({ children }: { readonly children: ReactNode }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const latestTokenRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const pluginSessionIdRef = useRef<string | null>(null);
  const pendingTokenRequestsRef = useRef(
    new Map<
      string,
      { readonly resolve: (token: string | null) => void; readonly timeout: number }
    >(),
  );
  const pendingExternalStateRef = useRef<string | null>(null);
  const appliedExternalStateRef = useRef<string | null>(null);
  const externalSessionRef = useRef(false);
  const restoringSessionRef = useRef(true);
  const signInRef = useRef<() => void>(() => undefined);
  const signOutRef = useRef<() => void>(() => undefined);
  const linkProviderRef = useRef<(providerId: string) => Promise<void>>(async () => undefined);
  const [state, setState] = useState<AccountState>({
    status: "loading",
    user: null,
    session: null,
  });

  const readToken = useCallback(async (): Promise<string | null> => {
    const frameWindow = iframeRef.current?.contentWindow;
    let frameToken: string | null = null;
    if (frameWindow) {
      const requestId = makeRequestId();
      frameToken = await new Promise<string | null>((resolve) => {
        const timeout = window.setTimeout(() => {
          pendingTokenRequestsRef.current.delete(requestId);
          resolve(null);
        }, TOKEN_REQUEST_TIMEOUT_MS);
        pendingTokenRequestsRef.current.set(requestId, { resolve, timeout });
        frameWindow.postMessage(
          { source: "axle-clerk-host", type: "request-token", requestId },
          clerkAuthOrigin(),
        );
      });
    }
    if (frameToken && !tokenExpiresWithin(frameToken, 15)) {
      latestTokenRef.current = frameToken;
      return frameToken;
    }

    const savedPluginSessionToken = loadPluginSessionToken();
    if (savedPluginSessionToken) {
      const restored = await restoreClerkSession(savedPluginSessionToken).catch(() => null);
      if (restored) {
        latestTokenRef.current = restored.token;
        activeSessionIdRef.current = restored.sessionId;
        return restored.token;
      }
    }
    return frameToken ?? latestTokenRef.current;
  }, []);

  useEffect(() => {
    let active = true;
    let releaseFrameReadiness: (() => void) | null = null;
    const frameReadiness = new Promise<void>((resolve) => {
      releaseFrameReadiness = resolve;
    });
    const signalFrameReadiness = () => {
      releaseFrameReadiness?.();
      releaseFrameReadiness = null;
    };
    void retryPendingPluginSessionRevocation();
    const createGuestSession = async () => {
      try {
        await createAnonymousPluginSession();
        if (active && activeSessionIdRef.current === null) {
          setState({
            status: "signed-out",
            user: null,
            session: null,
            pluginSessionReady: true,
            pluginError: null,
          });
        }
      } catch (error: unknown) {
        if (active && activeSessionIdRef.current === null) {
          setState({
            status: "signed-out",
            user: null,
            session: null,
            pluginSessionReady: false,
            pluginError:
              error instanceof Error ? error.message : "Plugin session could not be created.",
          });
        }
      }
    };

    const clearAccount = () => {
      if (externalSessionRef.current || restoringSessionRef.current) return;
      latestTokenRef.current = null;
      activeSessionIdRef.current = null;
      pluginSessionIdRef.current = null;
      setActiveClerkTokenReader(null);
      setManagedRelaySession(appAtomRegistry, null);
      if (active) {
        setState({
          status: "signed-out",
          user: null,
          session: null,
          pluginSessionReady: false,
          pluginError: null,
        });
      }
      void clearPluginSession()
        .catch(() => undefined)
        .then(createGuestSession);
    };

    const applySession = (
      message: Extract<ClerkFrameMessage, { readonly type: "session" }>,
      options: { readonly existingPluginSessionToken?: string | null } = {},
    ) => {
      latestTokenRef.current = message.token;
      activeSessionIdRef.current = message.sessionId;
      const user: ClerkUser = {
        id: message.user.id,
        primaryEmailAddress: message.user.email ? { emailAddress: message.user.email } : null,
      };
      const session: ClerkSession = {
        id: message.sessionId,
        getToken: readToken,
      };
      const alreadyReady = pluginSessionIdRef.current === message.sessionId;

      setActiveClerkTokenReader(readToken);
      setManagedRelaySession(appAtomRegistry, {
        accountId: user.id,
        readAccountToken: readToken,
      });
      setState({
        status: "signed-in",
        user,
        session,
        pluginSessionReady: alreadyReady,
        pluginError: null,
      });

      if (alreadyReady) {
        void loadPersistedPluginSessionToken()
          .then((sessionToken) =>
            sessionToken ? syncPluginSessionToServer(sessionToken) : undefined,
          )
          .catch(() => undefined);
        return;
      }
      void (
        options.existingPluginSessionToken
          ? syncPluginSessionToServer(options.existingPluginSessionToken)
          : createPluginSession(message.token)
      )
        .then(() => {
          if (!active || activeSessionIdRef.current !== message.sessionId) return;
          pluginSessionIdRef.current = message.sessionId;
          setState({
            status: "signed-in",
            user,
            session,
            pluginSessionReady: true,
            pluginError: null,
          });
        })
        .catch((error: unknown) => {
          if (!active || activeSessionIdRef.current !== message.sessionId) return;
          setState({
            status: "signed-in",
            user,
            session,
            pluginSessionReady: false,
            pluginError:
              error instanceof Error ? error.message : "Plugin session could not be created.",
          });
        });
    };

    const finishExternalSignIn = (result: ClerkBrowserExchange, state: string) => {
      appliedExternalStateRef.current = state;
      pendingExternalStateRef.current = null;
      externalSessionRef.current = true;
      applySession({
        source: "axle-clerk-frame",
        type: "session",
        token: result.token,
        sessionId: result.sessionId,
        user: result.user,
      });
    };

    // The browser page cannot always hand its custom-scheme callback back to the
    // app (dev builds and fresh Linux installs have no scheme handler), so the app
    // also waits for the same one-time code here. Both paths are single-use: the
    // first one to arrive signs the user in and the other finds nothing.
    const pollExternalSignIn = async (
      state: string,
      options: {
        /** Sign-in results are stale once a session exists; connecting is not. */
        readonly abandonWhenSignedIn: boolean;
        readonly failureMessage: string;
      },
    ) => {
      const outcome = await pollDesktopSignIn({
        state,
        claim: (value) => claimClerkDesktopSignIn(value),
        delay: (milliseconds) =>
          new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)),
        now: () => Date.now(),
        intervalMs: EXTERNAL_AUTH_POLL_INTERVAL_MS,
        timeoutMs: EXTERNAL_AUTH_TIMEOUT_MS,
        isAbandoned: () =>
          !active ||
          pendingExternalStateRef.current !== state ||
          (options.abandonWhenSignedIn && activeSessionIdRef.current !== null),
      });
      if (!active) return;
      if (outcome.outcome === "signed-in") {
        finishExternalSignIn(outcome.session, state);
        return;
      }
      if (outcome.outcome !== "timed-out") return;
      pendingExternalStateRef.current = null;
      setState({
        status: "error",
        user: null,
        session: null,
        error: options.failureMessage,
      });
    };

    const startExternalAuth = () => {
      const openExternal = window.desktopBridge?.openExternal;
      if (typeof openExternal !== "function") {
        setState({
          status: "error",
          user: null,
          session: null,
          error: "Browser sign-in is only available in Axle Desktop.",
        });
        return;
      }
      const state = window.crypto.randomUUID();
      pendingExternalStateRef.current = state;
      void openExternal(clerkExternalAuthUrl(state))
        .then((opened) => {
          if (opened === false) throw new Error("Axle could not open the default browser.");
          void pollExternalSignIn(state, {
            abandonWhenSignedIn: true,
            failureMessage: "Sign-in was not completed in the browser. Try again from Axle.",
          });
        })
        .catch((error: unknown) => {
          pendingExternalStateRef.current = null;
          setState({
            status: "error",
            user: null,
            session: null,
            error:
              error instanceof Error ? error.message : "Axle could not open the default browser.",
          });
        });
    };

    // Exposed to the app as `signIn` / `signOut`. Sign-in always runs in the
    // system browser: the broker frame is invisible by design, so it can launch
    // the flow but never host a clickable form.
    signInRef.current = startExternalAuth;
    signOutRef.current = () => {
      externalSessionRef.current = false;
      restoringSessionRef.current = false;
      clearAccount();
    };

    // Connect an additional provider to the account that is already signed in.
    // The worker hands back a provider consent URL, and the callback it embeds
    // lands on the same `handleExternalCallback` path as a normal sign-in.
    const startProviderLink = async (providerId: string) => {
      const openExternal = window.desktopBridge?.openExternal;
      if (typeof openExternal !== "function") {
        throw new Error("Connecting another sign-in method requires Axle Desktop.");
      }
      const token = await readToken();
      if (!token) throw new Error("Sign in to Axle before connecting another sign-in method.");
      const state = window.crypto.randomUUID();
      const response = await fetch(`${axleWorkerBaseUrl()}/v1/auth/link/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          redirectUri: clerkCallbackUrl(),
          state,
        }),
      });
      const value = (await response.json().catch(() => null)) as {
        readonly authorizeUrl?: unknown;
        readonly error?: unknown;
      } | null;
      if (!response.ok || typeof value?.authorizeUrl !== "string") {
        throw new Error(
          typeof value?.error === "string"
            ? value.error
            : "Axle could not start connecting that account.",
        );
      }
      pendingExternalStateRef.current = state;
      const opened = await openExternal(value.authorizeUrl);
      if (opened === false) {
        pendingExternalStateRef.current = null;
        throw new Error("Axle could not open the default browser.");
      }
      // The connected account is attached server-side; the app only needs the
      // same completion signal it uses for sign-in.
      void pollExternalSignIn(state, {
        abandonWhenSignedIn: false,
        failureMessage: "Connecting that account was not completed in the browser. Try again.",
      });
    };
    linkProviderRef.current = startProviderLink;

    const handleExternalCallback = (callbackUrl: string) => {
      let parsed: URL;
      try {
        parsed = new URL(callbackUrl);
      } catch {
        return;
      }
      const code = parsed.searchParams.get("code");
      const callbackState = parsed.searchParams.get("state");
      // The background poll may have already collected this exact sign-in; the
      // deep link then carries a code that is spent, which is not an error.
      if (callbackState !== null && appliedExternalStateRef.current === callbackState) return;
      const expectedState = pendingExternalStateRef.current;
      if (
        parsed.pathname !== "/clerk-callback" ||
        !code ||
        !callbackState ||
        !expectedState ||
        callbackState !== expectedState
      ) {
        setState({
          status: "error",
          user: null,
          session: null,
          error: "The browser sign-in callback was invalid or expired.",
        });
        return;
      }
      pendingExternalStateRef.current = null;
      void exchangeClerkBrowserCode(code)
        .then((result) => {
          if (result.state !== expectedState) {
            throw new Error("The browser sign-in state did not match the request.");
          }
          finishExternalSignIn(result, expectedState);
        })
        .catch((error: unknown) => {
          setState({
            status: "error",
            user: null,
            session: null,
            error:
              error instanceof Error
                ? error.message
                : "The browser sign-in could not be completed.",
          });
        });
    };

    const onMessage = (event: MessageEvent<unknown>) => {
      if (!active || event.origin !== clerkAuthOrigin()) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isClerkFrameMessage(event.data)) return;
      const message = event.data;

      if (message.type === "token") {
        const pending = pendingTokenRequestsRef.current.get(message.requestId);
        if (!pending) return;
        pendingTokenRequestsRef.current.delete(message.requestId);
        window.clearTimeout(pending.timeout);
        if (message.token) latestTokenRef.current = message.token;
        pending.resolve(message.token);
        return;
      }

      if (message.type === "signed-out") {
        clearAccount();
        return;
      }

      if (message.type === "ready") {
        signalFrameReadiness();
        return;
      }

      if (message.type === "external-auth") {
        startExternalAuth();
        return;
      }

      if (message.type === "error") {
        signalFrameReadiness();
        if (activeSessionIdRef.current === null) {
          setState({ status: "error", user: null, session: null, error: message.message });
        }
        return;
      }

      if (message.type === "session") {
        applySession(message);
      }
    };

    window.addEventListener("message", onMessage);
    const removeClerkCallback = window.desktopBridge?.onClerkCallback?.(handleExternalCallback);
    const restoreAttempt = loadPersistedPluginSessionToken().then(
      async (savedPluginSessionToken) => {
        if (!savedPluginSessionToken) {
          return { restored: null, savedPluginSessionToken: null, restoreError: null };
        }
        try {
          const restored = await restoreClerkSession(savedPluginSessionToken);
          if (restored === null) await clearPluginSession(savedPluginSessionToken);
          return { restored, savedPluginSessionToken, restoreError: null };
        } catch (restoreError: unknown) {
          return { restored: null, savedPluginSessionToken, restoreError };
        }
      },
    );
    void restoreAttempt
      .then(async ({ restored, savedPluginSessionToken, restoreError }) => {
        if (!active) return;
        if (!restored) {
          await Promise.race([
            frameReadiness,
            new Promise<void>((resolve) => window.setTimeout(resolve, 5_000)),
          ]);
          if (activeSessionIdRef.current === null) {
            if (savedPluginSessionToken && restoreError) {
              await syncPluginSessionToServer(savedPluginSessionToken).catch(() => undefined);
              setState({
                status: "signed-out",
                user: null,
                session: null,
                pluginSessionReady: true,
                pluginError:
                  "Could not refresh the saved account session. Keeping existing plugin connections; check your connection and try signing in again.",
              });
              return;
            }
            await createGuestSession();
          }
          return;
        }
        externalSessionRef.current = true;
        // The saved opaque plugin session already represents this Clerk
        // session. Reuse it rather than issuing another session on every
        // app launch, while the Worker refresh endpoint provides a fresh
        // short-lived Clerk JWT for account and relay requests.
        //
        // The local server's plugin-session registry is process-local, so it
        // must be repopulated after every desktop/server restart.
        applySession(
          {
            source: "axle-clerk-frame",
            type: "session",
            token: restored.token,
            sessionId: restored.sessionId,
            user: restored.user,
          },
          { existingPluginSessionToken: savedPluginSessionToken },
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          user: null,
          session: null,
          error:
            error instanceof Error ? error.message : "Saved Axle session could not be restored.",
        });
      })
      .finally(() => {
        restoringSessionRef.current = false;
      });
    return () => {
      active = false;
      window.removeEventListener("message", onMessage);
      removeClerkCallback?.();
      setActiveClerkTokenReader(null);
      for (const pending of pendingTokenRequestsRef.current.values()) {
        window.clearTimeout(pending.timeout);
        pending.resolve(null);
      }
      pendingTokenRequestsRef.current.clear();
    };
  }, [readToken]);

  const contextValue = useMemo(
    () => ({
      account: state,
      signIn: () => signInRef.current(),
      signOut: () => signOutRef.current(),
      linkProvider: (providerId: string) => linkProviderRef.current(providerId),
    }),
    [state],
  );
  const authFrame = (
    <iframe
      ref={iframeRef}
      title="Axle account session"
      src={clerkAuthFrameUrl()}
      sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 size-px border-0 opacity-0"
    />
  );

  // Keep the broker frame mounted in the background, but plugin access is backed
  // by an anonymous installation session when no Axle account is signed in.
  return (
    <AccountContext.Provider value={contextValue}>
      {children}
      {authFrame}
    </AccountContext.Provider>
  );
}
