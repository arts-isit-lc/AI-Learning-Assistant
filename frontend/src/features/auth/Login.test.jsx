import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const h = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  confirmSignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
  resetPassword: vi.fn(),
  confirmResetPassword: vi.fn(),
  confirmSignIn: vi.fn(),
  apiClient: { post: vi.fn() },
  refresh: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock("aws-amplify/auth", () => ({
  signIn: h.signIn,
  signUp: h.signUp,
  confirmSignUp: h.confirmSignUp,
  resendSignUpCode: h.resendSignUpCode,
  resetPassword: h.resetPassword,
  confirmResetPassword: h.confirmResetPassword,
  confirmSignIn: h.confirmSignIn,
}))
vi.mock("@/services/api", () => ({ default: h.apiClient }))
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ isAuthed: false, isLoading: false, refresh: h.refresh }),
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => h.navigate }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { Login } from "./Login"

beforeEach(() => {
  Object.values(h).forEach((v) => {
    if (typeof v?.mockReset === "function") v.mockReset()
  })
  h.refresh.mockResolvedValue(undefined)
  h.apiClient.post.mockResolvedValue({})
})

describe("Login", () => {
  it("signs in and lands on the role home", async () => {
    h.signIn.mockResolvedValue({ isSignedIn: true })
    render(<Login />)
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    await userEvent.type(screen.getByLabelText("Password"), "secretpass")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))

    expect(h.signIn).toHaveBeenCalledWith({ username: "ada@x.com", password: "secretpass" })
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/", { replace: true }))
    expect(h.refresh).toHaveBeenCalled()
  })

  it("surfaces a sign-in error inline", async () => {
    h.signIn.mockRejectedValue(new Error("Incorrect username or password."))
    render(<Login />)
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    await userEvent.type(screen.getByLabelText("Password"), "nope")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByText("Incorrect username or password.")).toBeInTheDocument()
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it("routes to the new-password step when Cognito requires it", async () => {
    h.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED" },
    })
    render(<Login />)
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    await userEvent.type(screen.getByLabelText("Password"), "temp")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByRole("heading", { name: "Set a new password" })).toBeInTheDocument()
  })

  it("validates the sign-up password before calling Amplify", async () => {
    render(<Login />)
    await userEvent.click(screen.getByRole("button", { name: "Create an account" }))
    await userEvent.type(screen.getByLabelText("First name"), "Ada")
    await userEvent.type(screen.getByLabelText("Last name"), "Lovelace")
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    await userEvent.type(screen.getByLabelText("Password"), "Password1!")
    await userEvent.type(screen.getByLabelText("Confirm password"), "Password2!")
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }))
    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument()
    expect(h.signUp).not.toHaveBeenCalled()
  })

  it("advances to email confirmation after a valid sign-up", async () => {
    h.signUp.mockResolvedValue({ isSignUpComplete: false, nextStep: { signUpStep: "CONFIRM_SIGN_UP" } })
    render(<Login />)
    await userEvent.click(screen.getByRole("button", { name: "Create an account" }))
    await userEvent.type(screen.getByLabelText("First name"), "Ada")
    await userEvent.type(screen.getByLabelText("Last name"), "Lovelace")
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    await userEvent.type(screen.getByLabelText("Password"), "Password1!")
    await userEvent.type(screen.getByLabelText("Confirm password"), "Password1!")
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }))
    expect(await screen.findByRole("heading", { name: "Confirm your account" })).toBeInTheDocument()
    expect(h.signUp).toHaveBeenCalled()
  })

  it("requests a reset code from the forgot-password flow", async () => {
    h.resetPassword.mockResolvedValue({
      nextStep: {
        resetPasswordStep: "CONFIRM_RESET_PASSWORD_WITH_CODE",
        codeDeliveryDetails: { deliveryMedium: "EMAIL" },
      },
    })
    render(<Login />)
    await userEvent.click(screen.getByRole("button", { name: "Forgot password?" }))
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    await userEvent.click(screen.getByRole("button", { name: "Send reset code" }))
    expect(h.resetPassword).toHaveBeenCalledWith({ username: "ada@x.com" })
    expect(await screen.findByLabelText("Confirmation code")).toBeInTheDocument()
  })
})
