import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { apply, inject, type HostConnectionHandle } from '../src/index.ts'

function webServer(host: '127.0.0.1' | '0.0.0.0', routes: WebRoute[]): WebServer {
  return {
    host,
    port: 0,
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  } as WebServer
}

function config() {
  return {
    publicOrigin: 'https://agent.example.com',
    identityHeader: 'remote-user',
    trustedHosts: ['agent.example.com'],
    recovery: {},
  }
}

describe('owned replacement connection service', () => {
  it('provides one reversible Connection with HTTP and WebSocket admission checks', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', webServer('127.0.0.1', routes))
    const fiber = ctx.plugin({ inject: [...inject], apply }, config())
    await fiber.await()

    const connection = ctx.get('connection') as HostConnectionHandle | undefined
    expect(connection).toBeDefined()
    expect(routes.map(route => route.path)).toContain('/api')
    expect(connection?.requestRejection({ headers: {
      host: 'agent.example.com',
      origin: 'https://agent.example.com',
      'remote-user': 'alice',
    } })).toBeUndefined()
    expect(connection?.requestRejection({ headers: {
      host: 'agent.example.com',
      origin: 'https://agent.example.com',
    } })).toBe(401)
    // DSH 0.1.5 routes both HTTP and WebSocket handshakes through this method.
    expect(connection?.requestRejection({ headers: {
      host: 'evil.example.com',
      'remote-user': 'alice',
    } })).toBe(403)

    await fiber.dispose()
    expect(routes).toHaveLength(0)
    expect(ctx.get('connection')).toBeUndefined()
  })

  it('refuses non-loopback Web server binds before publishing Connection', async () => {
    const ctx = new Context()
    ctx.provide('webServer', webServer('0.0.0.0', []))
    const fiber = ctx.plugin({ inject: [...inject], apply }, config())
    await expect(fiber.await()).rejects.toThrow(/must bind to 127\.0\.0\.1/)
    expect(ctx.get('connection')).toBeUndefined()
  })
})
