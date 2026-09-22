import { describe, expect, it } from 'vitest'
import { isTrustedApiRequest, isTrustedIndexRequest } from '../src/api-request-trust.ts'
import {
  PangolinAuth,
  pangolinIdentity,
  resolveIdentityHeader,
  resolvePublicOrigin,
} from '../src/pangolin-auth.ts'
import type { ConnectionIndexResponse, ConnectionTrustRequest } from '../src/rpc.ts'

function request(headers: ConnectionTrustRequest['headers'], method = 'GET'): ConnectionTrustRequest & { method: string } {
  return { headers, method }
}

function response(): { value: ConnectionIndexResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  return {
    state,
    value: {
      writeHead(status) { state.status = status },
      end(body) { if (typeof body === 'string') state.body = body },
    },
  }
}

describe('PangolinAuth', () => {
  it('requires exactly one nonempty forwarded identity', () => {
    expect(pangolinIdentity(request({ 'remote-user': 'alice' }), 'remote-user')).toBe('alice')
    expect(pangolinIdentity(request({ 'Remote-User': 'alice' }), 'remote-user')).toBe('alice')
    expect(pangolinIdentity(request({}), 'remote-user')).toBeUndefined()
    expect(pangolinIdentity(request({ 'remote-user': '' }), 'remote-user')).toBeUndefined()
    expect(pangolinIdentity(request({ 'remote-user': ' alice' }), 'remote-user')).toBeUndefined()
    expect(pangolinIdentity(request({ 'remote-user': ['alice', 'bob'] }), 'remote-user')).toBeUndefined()
    expect(pangolinIdentity(request({ 'remote-user': 'alice,bob' }), 'remote-user')).toBeUndefined()
    expect(pangolinIdentity(request({ 'remote-user': 'x'.repeat(1025) }), 'remote-user')).toBeUndefined()
  })

  it('authorizes index requests without cookies or token URLs', () => {
    const auth = new PangolinAuth('https://agent.example.com', 'Remote-User')
    expect(auth.isAuthenticated(request({ 'remote-user': 'alice' }))).toBe(true)
    expect(auth.authenticatedUrl('http://127.0.0.1:3080/?token=secret')).toBe('https://agent.example.com/')

    const denied = response()
    expect(auth.authorizeIndex(request({}, 'GET'), denied.value)).toBe(false)
    expect(denied.state).toEqual({ status: 401, body: 'pangolin authentication required\n' })

    const head = response()
    expect(auth.authorizeIndex(request({}, 'HEAD'), head.value)).toBe(false)
    expect(head.state).toEqual({ status: 401 })
  })

  it('validates the origin and configurable identity header', () => {
    expect(resolvePublicOrigin('https://agent.example.com').href).toBe('https://agent.example.com/')
    expect(resolveIdentityHeader('Remote-Email')).toBe('remote-email')
    for (const value of ['http://agent.example.com', 'https://agent.example.com/path', 'agent.example.com']) {
      expect(() => resolvePublicOrigin(value)).toThrow(/absolute HTTPS origin/)
    }
    for (const value of [
      '',
      'remote user',
      'remote:user',
      'host',
      'origin',
      'authorization',
      'cookie',
      'sec-fetch-site',
      'x-forwarded-user',
    ]) {
      expect(() => resolveIdentityHeader(value)).toThrow(/must be remote-user/)
    }
  })
})

describe('request trust', () => {
  it('enforces Host, Origin, and cross-site checks on API requests', () => {
    expect(isTrustedApiRequest(request({
      host: 'agent.example.com',
      origin: 'https://agent.example.com',
      'sec-fetch-site': 'same-origin',
    }), ['agent.example.com'])).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'evil.example.com' }), ['agent.example.com'])).toBe(false)
    expect(isTrustedApiRequest(request({
      host: 'agent.example.com',
      origin: 'https://evil.example.com',
    }), ['agent.example.com'])).toBe(false)
    expect(isTrustedApiRequest(request({
      host: 'agent.example.com',
      'sec-fetch-site': 'cross-site',
    }), ['agent.example.com'])).toBe(false)
  })

  it('allows an SSO top-level callback only on an owned index authority', () => {
    expect(isTrustedIndexRequest(request({
      host: 'agent.example.com',
      'sec-fetch-site': 'cross-site',
    }), ['agent.example.com'])).toBe(true)
    expect(isTrustedIndexRequest(request({ host: 'evil.example.com' }), ['agent.example.com'])).toBe(false)
  })
})
