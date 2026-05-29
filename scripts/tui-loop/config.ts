import { pathToFileURL } from 'node:url'

export type LaunchConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type ViewportConfig = {
  cols: number
  rows: number
}

export type FlowStep =
  | { type: 'wait'; ms: number }
  | { type: 'key'; key: string; waitMs?: number }
  | { type: 'text'; value: string; waitMs?: number }
  | { type: 'shot'; name: string; label?: string }
  | { type: 'assertText'; value: string }
  | { type: 'waitForText'; value: string; timeoutMs?: number }

export type FlowConfig = {
  id: string
  label: string
  steps: FlowStep[]
}

export type TuiLoopConfig = {
  artifactsDir: string
  viewport: ViewportConfig
  launch: LaunchConfig
  startupWaitMs: number
  shutdownKey: string
  flowTimeoutMs: number
  flows: FlowConfig[]
}

type PartialConfig = Partial<Omit<TuiLoopConfig, 'flows'>> & {
  flows?: FlowConfig[]
}

const DEFAULT_CONFIG: Omit<TuiLoopConfig, 'launch' | 'flows'> = {
  artifactsDir: '.tui-loop',
  viewport: {
    cols: 100,
    rows: 30,
  },
  startupWaitMs: 250,
  shutdownKey: 'q',
  flowTimeoutMs: 30000,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateSlug(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${label} must be slug-case`)
  }
}

function requireText(value: unknown, message: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message)
}

function requireNonNegative(value: unknown, message: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(message)
}

export function validateStep(step: FlowStep, flowId: string): void {
  const where = `flow "${flowId}"`
  switch (step.type) {
    case 'wait':
      requireNonNegative(step.ms, `${where} wait step requires a non-negative ms`)
      break
    case 'key':
      requireText(step.key, `${where} key step requires a key`)
      break
    case 'text':
      requireText(step.value, `${where} text step requires a value`)
      break
    case 'shot':
      if (!step.name?.trim()) throw new Error(`${where} shot step requires a name`)
      break
    case 'assertText':
      requireText(step.value, `${where} assertText step requires a value`)
      break
    case 'waitForText':
      requireText(step.value, `${where} waitForText step requires a value`)
      if (step.timeoutMs !== undefined) {
        requireNonNegative(step.timeoutMs, `${where} waitForText timeoutMs must be non-negative`)
      }
      break
    default:
      throw new Error(`${where} has unknown step type: ${(step as { type: string }).type}`)
  }
}

function validateConfig(config: TuiLoopConfig): void {
  if (!config.launch.command) throw new Error('launch.command is required')
  if (!Number.isInteger(config.viewport.cols) || config.viewport.cols < 20) {
    throw new Error('viewport.cols must be an integer >= 20')
  }
  if (!Number.isInteger(config.viewport.rows) || config.viewport.rows < 8) {
    throw new Error('viewport.rows must be an integer >= 8')
  }
  if (!Number.isInteger(config.flowTimeoutMs) || config.flowTimeoutMs <= 0) {
    throw new Error('flowTimeoutMs must be a positive integer')
  }
  if (!Array.isArray(config.flows) || config.flows.length === 0) {
    throw new Error('flows must be a non-empty array')
  }
  const ids = new Set<string>()
  for (const flow of config.flows) {
    validateSlug(flow.id, `flow id "${flow.id}"`)
    if (ids.has(flow.id)) throw new Error(`duplicate flow id "${flow.id}"`)
    ids.add(flow.id)
    if (!flow.label.trim()) throw new Error(`flow "${flow.id}" must have a label`)
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
      throw new Error(`flow "${flow.id}" must have steps`)
    }
    for (const step of flow.steps) {
      validateStep(step, flow.id)
    }
  }
}

export async function loadTuiLoopConfig(configPath: string): Promise<TuiLoopConfig> {
  const moduleUrl = pathToFileURL(configPath).href
  const moduleExports = (await import(`${moduleUrl}?t=${Date.now()}`)) as {
    default?: PartialConfig
  }
  const input = moduleExports.default
  if (!isObject(input)) throw new Error(`Config file ${configPath} must export a default object`)
  const launch = input.launch
  if (!isObject(launch) || typeof launch.command !== 'string') {
    throw new Error('launch.command is required')
  }
  const config: TuiLoopConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    artifactsDir: input.artifactsDir ?? DEFAULT_CONFIG.artifactsDir,
    viewport: {
      ...DEFAULT_CONFIG.viewport,
      ...(isObject(input.viewport) ? input.viewport : {}),
    } as ViewportConfig,
    launch: {
      command: launch.command,
      args: Array.isArray(launch.args) ? launch.args.map(String) : [],
      env: isObject(launch.env)
        ? Object.fromEntries(Object.entries(launch.env).map(([key, value]) => [key, String(value)]))
        : {},
    },
    startupWaitMs: input.startupWaitMs ?? DEFAULT_CONFIG.startupWaitMs,
    shutdownKey: input.shutdownKey ?? DEFAULT_CONFIG.shutdownKey,
    flowTimeoutMs: input.flowTimeoutMs ?? DEFAULT_CONFIG.flowTimeoutMs,
    flows: input.flows ?? [],
  }
  validateConfig(config)
  return config
}
