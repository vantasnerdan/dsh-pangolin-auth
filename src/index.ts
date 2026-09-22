/** DSH browser transport authenticated by Pangolin forwarded identity. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { PangolinAuth, resolvePublicOrigin } from './pangolin-auth.ts'
import { HostConnectionService } from './rpc-host.ts'
import {
  ConnectionRecoveryConfigSchema,
  resolveConnectionConfig,
  type ConnectionRecoveryConfig,
} from './recovery-config.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'
export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'pangolin-connection'

/** Services required before the replacement Connection is provided. */
export const inject = ['webServer']

const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `pangolin-auth maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Pangolin identity, external origin, request limits, and recovery configuration. */
export interface ConnectionConfig {
  /** External HTTPS origin used by browsers, for example `https://agent.example.com`. */
  publicOrigin: string
  /** Pangolin identity header. Default: `remote-user`. */
  identityHeader?: string
  /** Browser recovery timing injected into each served page. */
  recovery?: ConnectionRecoveryConfig
  /** Authorities accepted by the Host/Origin trust checks. */
  trustedHosts?: string[]
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  publicOrigin: z.string().required(),
  identityHeader: z.string().default('remote-user'),
  recovery: ConnectionRecoveryConfigSchema.default({}),
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Provide the complete Host Connection transport using Pangolin SSO identity.
 * @param ctx - Host context with the loopback Web server.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: ConnectionConfig): void {
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error(
      `pangolin-auth: Web server must bind to 127.0.0.1, received ${JSON.stringify(ctx.webServer.host)}`,
    )
  }
  const publicOrigin = resolvePublicOrigin(config.publicOrigin)
  const identityHeader = config.identityHeader ?? 'remote-user'
  const recovery = resolveConnectionConfig(config.recovery)
  const trustedHosts = config.trustedHosts ?? []
  const maxRequestBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  if (!trustedHosts.includes(publicOrigin.host) && !trustedHosts.includes(publicOrigin.hostname)) {
    throw new Error('pangolin-auth: trustedHosts must include the publicOrigin authority or hostname')
  }
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)

  const connection = new HostConnectionService(
    ctx,
    trustedHosts,
    new PangolinAuth(publicOrigin.href, identityHeader),
  )
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: recovery })
  })
  const fetchHandler = connection.createSharedFetchHandler(API_PATH)
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'pangolin-auth: /api route')
}
