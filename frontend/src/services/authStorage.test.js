import { describe, it, expect, vi, beforeEach } from "vitest"

// Hoisted so the vi.mock factories (also hoisted) can reference them.
const { setKeyValueStorage, sessionStorageStub } = vi.hoisted(() => ({
  setKeyValueStorage: vi.fn(),
  sessionStorageStub: { __brand: "amplify-session-storage" },
}))

vi.mock("aws-amplify/auth/cognito", () => ({
  cognitoUserPoolsTokenProvider: { setKeyValueStorage },
}))
vi.mock("aws-amplify/utils", () => ({ sessionStorage: sessionStorageStub }))

import { configureAuthStorage } from "./authStorage"

describe("configureAuthStorage", () => {
  beforeEach(() => {
    setKeyValueStorage.mockReset()
  })

  it("wires the Amplify token provider to sessionStorage", () => {
    configureAuthStorage()
    expect(setKeyValueStorage).toHaveBeenCalledTimes(1)
    expect(setKeyValueStorage).toHaveBeenCalledWith(sessionStorageStub)
  })
})
