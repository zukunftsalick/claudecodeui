import { promises as fs } from 'node:fs';

/** One TCP port something on this machine is listening on, as shown in the preview picker. */
type ListeningServer = {
  port: number;
  // Short process description (e.g. "node vite"), when it can be read.
  label: string | null;
};

// Ports below this belong to system services (ssh, http, ...) and are never proxied.
const MIN_PREVIEW_PORT = 1024;
const MAX_PREVIEW_PORT = 65535;
// TCP state 0A is LISTEN in /proc/net/tcp{,6}.
const TCP_LISTEN_STATE = '0A';
// Listening on these addresses means the server is reachable from this machine.
const LOCAL_LISTEN_ADDRESSES = new Set([
  '00000000', // 0.0.0.0
  '0100007F', // 127.0.0.1
  '00000000000000000000000000000000', // ::
  '00000000000000000000000001000000', // ::1
  '0000000000000000FFFF00000100007F', // ::ffff:127.0.0.1
]);

/**
 * Returns the port a preview hostname asks for, or null when the host is not a
 * preview host. Preview hosts look like `p5173.<domain>`; anything else
 * (including the app's own hostname) falls through to the normal app.
 */
export function parsePreviewHost(hostHeader: string | undefined, domain: string | null): number | null {
  if (!hostHeader || !domain) {
    return null;
  }
  const hostname = hostHeader.split(':')[0].toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const label = hostname.slice(0, -suffix.length);
  const match = /^p(\d{4,5})$/.exec(label);
  if (!match) {
    return null;
  }
  const port = Number.parseInt(match[1], 10);
  return port >= MIN_PREVIEW_PORT && port <= MAX_PREVIEW_PORT ? port : null;
}

/** Whether a port may be previewed: unprivileged and not the app's own port. */
export function isPreviewablePort(port: number, serverPort: number): boolean {
  return Number.isInteger(port)
    && port >= MIN_PREVIEW_PORT
    && port <= MAX_PREVIEW_PORT
    && port !== serverPort;
}

/**
 * Parses /proc/net/tcp or /proc/net/tcp6 text into listening local ports and
 * their socket inodes. Exported for tests; lines that don't parse are skipped.
 */
export function parseProcNetTcp(text: string): Array<{ port: number; inode: string }> {
  const entries: Array<{ port: number; inode: string }> = [];
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== TCP_LISTEN_STATE) {
      continue;
    }
    const [address, portHex] = fields[1].split(':');
    if (!LOCAL_LISTEN_ADDRESSES.has(address)) {
      continue;
    }
    const port = Number.parseInt(portHex, 16);
    if (Number.isFinite(port)) {
      entries.push({ port, inode: fields[9] });
    }
  }
  return entries;
}

// Maps socket inodes to a short command line by scanning the fds of processes
// we can read (our own user's). Best effort: unreadable processes are skipped.
async function readSocketOwners(inodes: Set<string>): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  let pids: string[] = [];
  try {
    pids = (await fs.readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return owners;
  }

  await Promise.all(pids.map(async (pid) => {
    let fds: string[];
    try {
      fds = await fs.readdir(`/proc/${pid}/fd`);
    } catch {
      return;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = await fs.readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && inodes.has(inode) && !owners.has(inode)) {
        try {
          const cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
          owners.set(inode, describeCommand(cmdline));
        } catch {
          // Process exited between the scan and the read.
        }
      }
    }
  }));
  return owners;
}

// "node /home/u/app/node_modules/.bin/vite --port 5173" -> "node vite --port 5173"
function describeCommand(argv: string[]): string {
  return argv
    .slice(0, 4)
    .map((part) => part.split('/').pop() || part)
    .join(' ')
    .slice(0, 60);
}

/**
 * Lists servers listening on this machine that could be previewed (Linux only;
 * returns an empty list elsewhere). Used by the dev-preview status route.
 */
export async function listListeningServers(serverPort: number): Promise<ListeningServer[]> {
  const byPort = new Map<number, string>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const entry of parseProcNetTcp(await fs.readFile(file, 'utf8'))) {
        if (isPreviewablePort(entry.port, serverPort) && !byPort.has(entry.port)) {
          byPort.set(entry.port, entry.inode);
        }
      }
    } catch {
      // Not Linux, or /proc is unavailable.
    }
  }

  const owners = await readSocketOwners(new Set(byPort.values()));
  return [...byPort.entries()]
    .sort(([a], [b]) => a - b)
    .map(([port, inode]) => ({ port, label: owners.get(inode) ?? null }));
}
