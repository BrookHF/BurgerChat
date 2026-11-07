import { type SubmitEvent, useEffect, useState } from "react";
import { ChatSession } from "./ChatSession.tsx";
import { loadUsername, MAX_USERNAME_CHARACTERS, saveUsername } from "./identity.ts";
import type { SessionSummary } from "../protocol.ts";

const sessionRoute = /^\/sessions\/([^/]+)\/?$/;

export function App() {
  const pathname = window.location.pathname;
  if (pathname === "/") return <LandingPage />;

  const match = sessionRoute.exec(pathname);
  if (match !== null && match[1].length > 0) {
    // Keep the session ID as the opaque encoded path segment PartySocket will reuse.
    return <ExistingSession sessionId={match[1]} />;
  }

  return (
    <main>
      <h1>Page not found</h1>
      <p>
        <a href="/">Return to the landing page</a>
      </p>
    </main>
  );
}

function LandingPage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [username, setUsername] = useState(() => loadUsername() ?? "");
  const [sessions, setSessions] = useState<readonly SessionSummary[] | undefined>(undefined);
  const [email, setEmail] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("me failed"))))
      .then((result) => {
        if (cancelled) return;
        const value = (result as { email?: unknown }).email;
        if (typeof value === "string") setEmail(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sessions")
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error(`List failed (${response.status})`)),
      )
      .then((result) => {
        if (cancelled) return;
        const list = (result as { sessions?: unknown }).sessions;
        setSessions(Array.isArray(list) ? (list as SessionSummary[]) : []);
      })
      .catch(() => {
        if (!cancelled) setSessions(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const createSession = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setCreating(true);
    setError(undefined);
    try {
      saveUsername(username);
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error(`Session creation failed (${response.status})`);
      const result = (await response.json()) as { readonly url?: unknown };
      if (typeof result.url !== "string")
        throw new Error("The server returned an invalid session URL");
      window.location.assign(result.url);
    } catch (error) {
      setCreating(false);
      setError(error instanceof Error ? error.message : "Session creation failed");
    }
  };

  return (
    <main>
      <header>
        <h1>BurgerChat</h1>
        <p>A minimal chat interface for durable conversations and forks.</p>
        {email === undefined ? (
          <p>
            Sessions need a Google sign-in. <a href="/api/sign-in">Sign in with Google</a>
          </p>
        ) : (
          <p>Signed in as {email}.</p>
        )}
      </header>
      <section aria-labelledby="create-session-heading">
        <h2 id="create-session-heading">Start a session</h2>
        <p>Create an isolated durable session, send messages, and fork its transcript.</p>
        <form onSubmit={createSession}>
          <p>
            <label htmlFor="username">Display name</label>{" "}
            <input
              id="username"
              name="username"
              value={username}
              maxLength={MAX_USERNAME_CHARACTERS}
              autoComplete="nickname"
              required
              onChange={(event) => setUsername(event.currentTarget.value)}
            />
          </p>
          <button type="submit" disabled={creating}>
            {creating ? "Creating session…" : "Create session"}
          </button>
        </form>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </section>
      <section aria-labelledby="session-list-heading">
        <h2 id="session-list-heading">Your sessions</h2>
        {sessions === undefined ? (
          <p>Loading sessions… Sign in with Google above if the list does not load.</p>
        ) : sessions.length === 0 ? (
          <p>No sessions yet.</p>
        ) : (
          <ul className="session-list">
            {sessions.map((session) => (
              <li key={session.sessionId}>
                <a href={`/sessions/${session.sessionId}`}>
                  {session.title ?? "(no messages yet)"}
                </a>{" "}
                <span className="session-meta">
                  {session.conversations} conversation{session.conversations === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ExistingSession({ sessionId }: { readonly sessionId: string }) {
  const [username, setUsername] = useState(loadUsername);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();

  if (username !== undefined) return <ChatSession sessionId={sessionId} username={username} />;

  const join = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(undefined);
    try {
      setUsername(saveUsername(draft));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to join session");
    }
  };

  return (
    <main>
      <header>
        <h1>BurgerChat</h1>
        <p>You have been invited to a shared session.</p>
      </header>
      <section aria-labelledby="join-session-heading">
        <h2 id="join-session-heading">Join session</h2>
        <form onSubmit={join}>
          <p>
            <label htmlFor="join-username">Display name</label>{" "}
            <input
              id="join-username"
              name="username"
              value={draft}
              maxLength={MAX_USERNAME_CHARACTERS}
              autoComplete="nickname"
              autoFocus
              required
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </p>
          <button type="submit">Join</button>
        </form>
        {error === undefined ? null : <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
