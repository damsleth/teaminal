import { describe, expect, test } from 'bun:test'
import { validateStep } from './config'
import type { FlowStep } from './config'

describe('validateStep', () => {
  test('accepts well-formed steps', () => {
    const steps: FlowStep[] = [
      { type: 'wait', ms: 100 },
      { type: 'key', key: 'enter' },
      { type: 'text', value: 'hello' },
      { type: 'shot', name: 'home' },
      { type: 'assertText', value: 'ready' },
      { type: 'waitForText', value: 'ready', timeoutMs: 1000 },
    ]
    for (const step of steps) {
      expect(() => validateStep(step, 'flow')).not.toThrow()
    }
  })

  test('rejects a key step without a key', () => {
    expect(() => validateStep({ type: 'key' } as unknown as FlowStep, 'flow')).toThrow(
      /key step requires a key/,
    )
  })

  test('rejects a waitForText step without a value', () => {
    expect(() => validateStep({ type: 'waitForText' } as unknown as FlowStep, 'flow')).toThrow(
      /waitForText step requires a value/,
    )
  })

  test('rejects a negative wait', () => {
    expect(() => validateStep({ type: 'wait', ms: -1 }, 'flow')).toThrow(/non-negative/)
  })

  test('rejects an unknown step type', () => {
    expect(() => validateStep({ type: 'nope' } as unknown as FlowStep, 'flow')).toThrow(
      /unknown step type: nope/,
    )
  })
})
