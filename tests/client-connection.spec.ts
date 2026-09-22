import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply as applyClient,
  installConnection,
  type ConnectionHandle,
  type ConnectionInstallOptions,
} from '../src/client/index.ts'

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')

afterEach(() => {
  if (originalLocation === undefined) delete (globalThis as { location?: unknown }).location
  else Object.defineProperty(globalThis, 'location', originalLocation)
})

async function mount(options: ConnectionInstallOptions): Promise<{
  connection: ConnectionHandle
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin({
    apply(inner) { installConnection(inner, options) },
  })
  await fiber.await()
  const connection = ctx.get('connection')
  if (connection === undefined) throw new Error('connection service was not provided')
  return { connection, dispose: () => fiber.dispose() }
}

describe('Pangolin trusted operator client', () => {
  it('keeps the reusable installer restricted for an ordinary remote page', async () => {
    const mounted = await mount({ location: { hostname: 'agent.example.com' } })
    expect(mounted.connection.isLoopback).toBe(false)
    await mounted.dispose()
  })

  it('grants the privileged surface only when trustedOperator is explicit', async () => {
    const mounted = await mount({
      location: { hostname: 'agent.example.com' },
      trustedOperator: true,
    })
    expect(mounted.connection.isLoopback).toBe(true)
    await mounted.dispose()
  })

  it('marks the Pangolin-owned served client as the trusted operator', async () => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hostname: 'marvin.pangolin.marbell.com' },
    })
    const ctx = new Context()
    const fiber = ctx.plugin({ apply: applyClient })
    await fiber.await()
    expect(ctx.get('connection')?.isLoopback).toBe(true)
    await fiber.dispose()
  })
})
