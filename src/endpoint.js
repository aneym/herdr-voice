/**
 * Socket endpoint specs. Unix hosts use socket paths; Windows has no unix
 * sockets for ssh -L/-R local ends, so the engine there listens/dials on
 * loopback TCP. A spec is either a filesystem path or `tcp:HOST:PORT`.
 */
export function parseEndpoint(spec) {
  const m = /^tcp:(?:([^:]+):)?(\d+)$/.exec(String(spec))
  if (m) return { kind: 'tcp', host: m[1] || '127.0.0.1', port: Number(m[2]) }
  return { kind: 'path', path: String(spec) }
}

export function isTcp(spec) {
  return parseEndpoint(spec).kind === 'tcp'
}

/** Options for net.createConnection / server.listen. */
export function netOptions(spec) {
  const ep = parseEndpoint(spec)
  return ep.kind === 'tcp' ? { host: ep.host, port: ep.port } : { path: ep.path }
}

/** The `host:port` or path form ssh -L/-R wants for the LOCAL end of a forward. */
export function sshLocalEnd(spec) {
  const ep = parseEndpoint(spec)
  return ep.kind === 'tcp' ? `${ep.host}:${ep.port}` : ep.path
}

export const IS_WIN = process.platform === 'win32'
