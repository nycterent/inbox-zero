import { ImapFlow } from "imapflow";
import type { ImapCredentialConfig } from "@/utils/imap/types";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("imap/client");

const CONNECT_TIMEOUT_MS = 30_000;
const GREETING_TIMEOUT_MS = 15_000;
// Inactivity timeout for an idle socket mid-operation. Generous so large
// FETCH/SEARCH commands on big mailboxes don't get torn down mid-flight.
const SOCKET_TIMEOUT_MS = 120_000;

// Proton Bridge / most IMAP servers cap concurrent connections per account.
// Without a bound, a fan-out (e.g. per-message fetches) can open hundreds of
// sockets at once and exhaust the server, after which every command fails.
// Serialize through a small semaphore so we never hold more than this many
// live connections per process.
const MAX_CONCURRENT_CONNECTIONS = 3;

let activeConnections = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeConnections < MAX_CONCURRENT_CONNECTIONS) {
    activeConnections += 1;
    return;
  }
  // Wait for a release to hand us its slot (activeConnections is kept intact
  // on handoff, so no double-count).
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  activeConnections -= 1;
}

export function createImapConnection(config: ImapCredentialConfig): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecurity === "tls",
    auth: {
      user: config.username,
      pass: config.password,
    },
    logger: false,
    // Let imapflow own the timeouts so a slow/failed connect tears down its
    // OWN socket instead of leaking it (the previous manual Promise.race left
    // the underlying connect() running after it "timed out", orphaning the
    // socket once it finally established).
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: {
      rejectUnauthorized: config.imapSecurity !== "none",
    },
  });
}

export async function withImapConnection<T>(
  config: ImapCredentialConfig,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  await acquireSlot();
  const client = createImapConnection(config);

  try {
    await client.connect();
    return await fn(client);
  } catch (error) {
    logger.error("IMAP connection error", {
      host: config.imapHost,
      error,
    });
    throw error;
  } finally {
    // logout() gracefully ends the session; close() force-destroys the socket
    // even if logout no-ops (e.g. connect never completed). Always do both so
    // no path can leak a live connection.
    try {
      await client.logout();
    } catch {
      // Ignore logout errors
    }
    try {
      client.close();
    } catch {
      // Ignore close errors
    }
    releaseSlot();
  }
}
