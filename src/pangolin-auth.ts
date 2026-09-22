/** Pangolin forwarded-identity authentication for browser requests. */

import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const PANGOLIN_IDENTITY_HEADERS = new Set([
  'remote-user',
  'remote-email',
  'remote-name',
  'remote-role',
])
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const MAX_IDENTITY_BYTES = 1024

function headerValues(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): readonly string[] {
  if (headers instanceof Headers) {
    const value = headers.get(name)
    return value === null ? [] : [value]
  }
  const values: string[] = []
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() !== name || value === undefined) continue
    if (typeof value === 'string') values.push(value)
    else values.push(...value)
  }
  return values
}

/** Validate and normalize one Pangolin-owned identity header name. */
export function resolveIdentityHeader(value: string): string {
  const normalized = value.toLowerCase()
  if (!PANGOLIN_IDENTITY_HEADERS.has(normalized)) {
    throw new Error(
      'pangolin-auth: identityHeader must be remote-user, remote-email, remote-name, or remote-role',
    )
  }
  return normalized
}

/** Validate one HTTPS origin used as the browser-facing DSH URL. */
export function resolvePublicOrigin(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('pangolin-auth: publicOrigin must be an absolute HTTPS origin')
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('pangolin-auth: publicOrigin must be an absolute HTTPS origin without credentials, path, query, or fragment')
  }
  return url
}

/**
 * Read the one identity value injected by Pangolin.
 * @param request - incoming HTTP or WebSocket-upgrade request.
 * @param headerName - normalized trusted proxy header name.
 * @returns the forwarded identity, or undefined for an absent or ambiguous value.
 */
export function pangolinIdentity(
  request: ConnectionTrustRequest,
  headerName: string,
): string | undefined {
  const values = headerValues(request.headers, headerName)
  if (values.length !== 1) return undefined
  const identity = values[0]
  if (
    identity === undefined
    || identity.length === 0
    || identity !== identity.trim()
    || identity.includes(',')
    || CONTROL_CHARACTER_PATTERN.test(identity)
    || Buffer.byteLength(identity, 'utf8') > MAX_IDENTITY_BYTES
  ) return undefined
  return identity
}

/** Browser authentication owner backed exclusively by Pangolin identity headers. */
export class PangolinAuth {
  private readonly publicOrigin: URL
  private readonly identityHeader: string

  /**
   * Create the Pangolin browser authenticator from validated deployment values.
   * @param publicOrigin - external HTTPS origin shown to browser users.
   * @param identityHeader - header overwritten and populated by Pangolin after SSO.
   */
  constructor(publicOrigin: string, identityHeader: string) {
    this.publicOrigin = resolvePublicOrigin(publicOrigin)
    this.identityHeader = resolveIdentityHeader(identityHeader)
  }

  /** Return whether Pangolin supplied one unambiguous authenticated identity. */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    return pangolinIdentity(request, this.identityHeader) !== undefined
  }

  /** Authorize the frontend index without issuing a DSH launch token or cookie. */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    if (this.isAuthenticated(req)) return true
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD' ? undefined : 'pangolin authentication required\n')
    return false
  }

  /** Return the configured browser-facing root without DSH credentials. */
  authenticatedUrl(_baseUrl: string): string {
    return this.publicOrigin.href
  }
}
