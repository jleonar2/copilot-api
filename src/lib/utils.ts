import type { Context } from "hono"

import consola from "consola"
import { createHash, randomUUID } from "node:crypto"
import { networkInterfaces } from "node:os"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { getModels, type Model } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { getVSCodeDeviceId } from "./deviceid"
import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

/**
 * Creates Claude 4.5 model definitions for injection.
 * These models are not returned by GitHub Copilot's /models endpoint for all account tiers,
 * but they are available on the backend for certain accounts.
 * Specifications match Claude 4.6 models but without adaptive_thinking support.
 */
const getClaude45Models = (): Array<Model> => {
  return [
    {
      id: "claude-opus-4.5",
      name: "Claude Opus 4.5",
      vendor: "Anthropic",
      version: "claude-opus-4.5",
      object: "model",
      preview: false,
      model_picker_enabled: true,
      supported_endpoints: ["/v1/messages", "/chat/completions"],
      capabilities: {
        family: "claude-opus-4.5",
        type: "chat",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        limits: {
          max_context_window_tokens: 200000,
          max_non_streaming_output_tokens: 16000,
          max_output_tokens: 64000,
          max_prompt_tokens: 128000,
          vision: {
            max_prompt_image_size: 3145728,
            max_prompt_images: 1,
            supported_media_types: ["image/jpeg", "image/png", "image/webp"],
          },
        },
        supports: {
          tool_calls: true,
          parallel_tool_calls: true,
          streaming: true,
          structured_outputs: true,
          vision: true,
          max_thinking_budget: 32000,
          min_thinking_budget: 1024,
        },
      },
    },
    {
      id: "claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      vendor: "Anthropic",
      version: "claude-sonnet-4.5",
      object: "model",
      preview: false,
      model_picker_enabled: true,
      supported_endpoints: ["/chat/completions", "/v1/messages"],
      capabilities: {
        family: "claude-sonnet-4.5",
        type: "chat",
        object: "model_capabilities",
        tokenizer: "o200k_base",
        limits: {
          max_context_window_tokens: 200000,
          max_non_streaming_output_tokens: 16000,
          max_output_tokens: 32000,
          max_prompt_tokens: 128000,
          vision: {
            max_prompt_image_size: 3145728,
            max_prompt_images: 5,
            supported_media_types: ["image/jpeg", "image/png", "image/webp"],
          },
        },
        supports: {
          tool_calls: true,
          parallel_tool_calls: true,
          streaming: true,
          structured_outputs: true,
          vision: true,
          max_thinking_budget: 32000,
          min_thinking_budget: 1024,
        },
      },
    },
  ]
}

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  const filteredModels = models.data.filter(
    (model) =>
      model.model_picker_enabled || model.capabilities.type === "embeddings",
  )

  const claude45Models = getClaude45Models()
  const injectedModelIds = new Set(claude45Models.map((m) => m.id))

  // Filter out any existing models with the same IDs to avoid duplicates
  const uniqueModels = filteredModels.filter(
    (model) => !injectedModelIds.has(model.id),
  )

  state.models = {
    ...models,
    data: [...uniqueModels, ...claude45Models],
  }
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}

const invalidMacAddresses = new Set([
  "00:00:00:00:00:00",
  "ff:ff:ff:ff:ff:ff",
  "ac:de:48:00:11:22",
])

function validateMacAddress(candidate: string): boolean {
  const tempCandidate = candidate.replaceAll("-", ":").toLowerCase()
  return !invalidMacAddresses.has(tempCandidate)
}

export function getMac(): string | null {
  const ifaces = networkInterfaces()
  // eslint-disable-next-line guard-for-in
  for (const name in ifaces) {
    const networkInterface = ifaces[name]
    if (networkInterface) {
      for (const { mac } of networkInterface) {
        if (validateMacAddress(mac)) {
          return mac
        }
      }
    }
  }
  return null
}

export const cacheMacMachineId = () => {
  const macAddress = getMac() ?? randomUUID()
  state.macMachineId = createHash("sha256")
    .update(macAddress, "utf8")
    .digest("hex")
  consola.debug(`Using machine ID: ${state.macMachineId}`)
}

export const cacheVsCodeDeviceId = async () => {
  state.vsCodeDeviceId = await getVSCodeDeviceId()
  consola.debug(`Using VSCode device ID: ${state.vsCodeDeviceId}`)
}

const SESSION_REFRESH_BASE_MS = 60 * 60 * 1000
const SESSION_REFRESH_JITTER_MS = 20 * 60 * 1000
let vsCodeSessionRefreshTimer: ReturnType<typeof setTimeout> | null = null

const generateSessionId = () => {
  state.vsCodeSessionId = randomUUID() + Date.now().toString()
  consola.debug(`Generated VSCode session ID: ${state.vsCodeSessionId}`)
}

export const stopVsCodeSessionRefreshLoop = () => {
  if (vsCodeSessionRefreshTimer) {
    clearTimeout(vsCodeSessionRefreshTimer)
    vsCodeSessionRefreshTimer = null
  }
}

const scheduleSessionIdRefresh = () => {
  const randomDelay = Math.floor(Math.random() * SESSION_REFRESH_JITTER_MS)
  const delay = SESSION_REFRESH_BASE_MS + randomDelay
  consola.debug(
    `Scheduling next VSCode session ID refresh in ${Math.round(
      delay / 1000,
    )} seconds`,
  )

  stopVsCodeSessionRefreshLoop()
  vsCodeSessionRefreshTimer = setTimeout(() => {
    try {
      generateSessionId()
    } catch (error) {
      consola.error("Failed to refresh session ID, rescheduling...", error)
    } finally {
      scheduleSessionIdRefresh()
    }
  }, delay)
}

export const cacheVsCodeSessionId = () => {
  stopVsCodeSessionRefreshLoop()
  generateSessionId()
  scheduleSessionIdRefresh()
}

interface PayloadMessage {
  role?: string
  content?: string | Array<{ type?: string; text?: string }> | null
  type?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const getUserIdJsonField = (
  userIdPayload: Record<string, unknown> | null,
  field: string,
): string | null => {
  const value = userIdPayload?.[field]
  return typeof value === "string" && value.length > 0 ? value : null
}

const parseJsonUserId = (userId: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(userId)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const parseUserIdMetadata = (
  userId: string | undefined,
): { safetyIdentifier: string | null; sessionId: string | null } => {
  if (!userId || typeof userId !== "string") {
    return { safetyIdentifier: null, sessionId: null }
  }

  const legacySafetyIdentifier =
    userId.match(/user_([^_]+)_account/)?.[1] ?? null
  const legacySessionId = userId.match(/_session_(.+)$/)?.[1] ?? null

  const parsedUserId =
    legacySafetyIdentifier && legacySessionId ? null : parseJsonUserId(userId)

  const safetyIdentifier =
    legacySafetyIdentifier
    ?? getUserIdJsonField(parsedUserId, "device_id")
    ?? getUserIdJsonField(parsedUserId, "account_uuid")
  const sessionId =
    legacySessionId ?? getUserIdJsonField(parsedUserId, "session_id")

  return { safetyIdentifier, sessionId }
}

const findLastUserContent = (
  messages: Array<PayloadMessage>,
): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user" && msg.content) {
      if (typeof msg.content === "string") {
        return msg.content
      } else if (Array.isArray(msg.content)) {
        const array = msg.content
          .filter((n) => n.type !== "tool_result")
          .map((n) => ({ ...n, cache_control: undefined }))
        if (array.length > 0) {
          return JSON.stringify(array)
        }
      }
    }
  }
  return null
}

export const generateRequestIdFromPayload = (
  payload: {
    messages: string | Array<PayloadMessage> | undefined
  },
  sessionId?: string,
): string => {
  const messages = payload.messages
  if (messages) {
    const lastUserContent =
      typeof messages === "string" ? messages : findLastUserContent(messages)

    if (lastUserContent) {
      return getUUID(
        (sessionId ?? "") + (state.macMachineId ?? "") + lastUserContent,
      )
    }
  }

  return randomUUID()
}

export const getRootSessionId = (
  anthropicPayload: AnthropicMessagesPayload,
  c: Context,
): string | undefined => {
  const userId = anthropicPayload.metadata?.user_id
  const sessionId =
    userId ?
      parseUserIdMetadata(userId).sessionId || undefined
    : c.req.header("x-session-id")

  return sessionId ? getUUID(sessionId) : sessionId
}

export const getUUID = (content: string): string => {
  const uuidBytes = createHash("sha256")
    .update(content)
    .digest()
    .subarray(0, 16)

  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80

  const uuidHex = uuidBytes.toString("hex")

  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`
}
