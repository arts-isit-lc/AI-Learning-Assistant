import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
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
  isAuthed: false,
  isLoading: false,
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
  useAuth: () => ({ isAuthed: h.isAuthed, isLoading: h.isLoading, refresh: h.refresh }),
}))
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => h.navigate }
})

import { Login } from "./Login"

beforeEach(() => {
  Object.values(h).forEach((v) => {
    if (typeof v?.mockReset === "function") v.mockReset()
  })
  h.refresh.mockResolvedValue(undefined)
  h.apiClient.post.mockResolvedValue({})
  h.isAuthed = false
  h.isLoading = false
})

// Some tests swap in fake timers for the resend cooldown; always restore real
// timers afterward so a timed-out test can't leak fakes into the next one.
afterEach(() => {
  vi.useRealTimers()
})

describe("Login", () => {
  it("renders the OCELIA brand lockup and the sign-in form", () => {
    render(<Login />)
    expect(screen.getByRole("img", { name: "University of British Columbia" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "OCELIA" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Please log in" })).toBeInTheDocument()
    expect(screen.getByLabelText("Email")).toBeInTheDocument()
    expect(screen.getByLabelText("Password")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Log in" })).toHaveClass("hover:bg-primary-dark")
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create an account" })).toBeInTheDocument()
  })

  it("shows the loading screen (not the sign-in form) while the session is resolving", () => {
    h.isLoading = true
    render(<Login />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Please log in" })).not.toBeInTheDocument()
  })

  it("shows the loading screen for an already-signed-in visitor (pre-redirect), not the form", () => {
    h.isAuthed = true
    render(<Login />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Please log in" })).not.toBeInTheDocument()
  })

  it("gives the Forgot password / Create an account links px-4 + the #F2E8FF hover bg / #2E0666 hover text, no hover underline", () => {
    render(<Login />)
    // primary-subtle = #F2E8FF (hover bg), primary-dark = #2E0666 (hover text);
    // hover:no-underline cancels the link variant's default hover underline.
    for (const name of ["Forgot password?", "Create an account"]) {
      const link = screen.getByRole("button", { name })
      expect(link).toHaveClass("px-4", "hover:bg-primary-subtle", "hover:text-primary-dark", "hover:no-underline")
    }
  })

  it("signs in and lands on the role home", async () => {
    h.signIn.mockResolvedValue({ isSignedIn: true })
    render(<Login />)
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    await userEvent.type(screen.getByLabelText("Password"), "secretpass")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))

    expect(h.signIn).toHaveBeenCalledWith({ username: "ada@x.com", password: "secretpass" })
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/", { replace: true }))
    expect(h.refresh).toHaveBeenCalled()
  })

  it("surfaces a sign-in error inline", async () => {
    h.signIn.mockRejectedValue(new Error("Incorrect username or password."))
    render(<Login />)
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    await userEvent.type(screen.getByLabelText("Password"), "nope")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))
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
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))
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
    const mismatchErr = await screen.findByText("Passwords do not match.")
    // Rendered inline under the confirm-password field, not as a form-level alert.
    expect(mismatchErr).toHaveClass("text-caption", "text-destructive")
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute("aria-describedby", mismatchErr.id)
    expect(h.signUp).not.toHaveBeenCalled()
  })

  it("shows a password-policy failure inline under the password field", async () => {
    render(<Login />)
    await userEvent.click(screen.getByRole("button", { name: "Create an account" }))
    await userEvent.type(screen.getByLabelText("First name"), "Ada")
    await userEvent.type(screen.getByLabelText("Last name"), "Lovelace")
    await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
    // Too short to satisfy the Cognito policy (min 10 chars).
    await userEvent.type(screen.getByLabelText("Password"), "short")
    await userEvent.type(screen.getByLabelText("Confirm password"), "short")
    await userEvent.click(screen.getByRole("button", { name: "Sign up" }))

    const pwErr = await screen.findByText(
      "Password must be at least 10 characters and include a lowercase letter, an uppercase letter, a number, and a special character.",
    )
    expect(pwErr).toHaveClass("text-caption", "text-destructive")
    // Wired to the password control (rendered directly under the field).
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-describedby", pwErr.id)
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true")
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

  describe("resend code cooldown", () => {
    // Drive the signup flow to the "Confirm your account" view, then hand back the
    // typed email so assertions can build the expected green confirmation text.
    async function reachConfirmStep(user) {
      h.signUp.mockResolvedValue({ isSignUpComplete: false, nextStep: { signUpStep: "CONFIRM_SIGN_UP" } })
      render(<Login />)
      await user.click(screen.getByRole("button", { name: "Create an account" }))
      await user.type(screen.getByLabelText("First name"), "Ada")
      await user.type(screen.getByLabelText("Last name"), "Lovelace")
      await user.type(screen.getByLabelText("Email"), "ada@x.com")
      await user.type(screen.getByLabelText("Password"), "Password1!")
      await user.type(screen.getByLabelText("Confirm password"), "Password1!")
      await user.click(screen.getByRole("button", { name: "Sign up" }))
      await screen.findByRole("heading", { name: "Confirm your account" })
    }

    it("locks the button for 30s with a green confirmation, then reactivates it", async () => {
      // Reach the confirm view under REAL timers (findBy* polling needs them).
      const user = userEvent.setup()
      h.resendSignUpCode.mockResolvedValue(undefined)
      await reachConfirmStep(user)

      const resend = screen.getByRole("button", { name: "Resend code" })
      expect(resend).toBeEnabled()

      // Swap to fake timers so the 30s lock can be fast-forwarded deterministically.
      // fireEvent (not userEvent, which is bound to real-timer delays) + an act flush
      // runs the resolved resend and lets the cooldown effect schedule its tick.
      vi.useFakeTimers()
      fireEvent.click(resend)
      await act(async () => {})
      expect(h.resendSignUpCode).toHaveBeenCalledWith({ username: "ada@x.com" })

      // Button locks and the green (#11A26F success token) confirmation appears.
      expect(screen.getByRole("button", { name: "Resend code" })).toBeDisabled()
      expect(resend).toHaveClass("disabled:text-neutral-400", "disabled:opacity-100")
      const notice = screen.getByText("Code has been sent to ada@x.com.")
      expect(notice).toHaveClass("text-success", "font-semibold")

      // Still locked just before the 30s window elapses.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000)
      })
      expect(screen.getByRole("button", { name: "Resend code" })).toBeDisabled()
      expect(screen.getByText("Code has been sent to ada@x.com.")).toBeInTheDocument()

      // After 30s the notice clears and the button is active again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(screen.getByRole("button", { name: "Resend code" })).toBeEnabled()
      expect(screen.queryByText("Code has been sent to ada@x.com.")).not.toBeInTheDocument()
    })

    it("does not lock the button when the resend fails", async () => {
      const user = userEvent.setup()
      h.resendSignUpCode.mockRejectedValue(new Error("Attempt limit exceeded, please try after some time."))
      await reachConfirmStep(user)

      await user.click(screen.getByRole("button", { name: "Resend code" }))

      expect(await screen.findByText("Attempt limit exceeded, please try after some time.")).toBeInTheDocument()
      // No cooldown on failure — the user can retry immediately, and no green notice.
      expect(screen.getByRole("button", { name: "Resend code" })).toBeEnabled()
      expect(screen.queryByText(/Code has been sent to/)).not.toBeInTheDocument()
    })
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

  describe("inline field validation", () => {
    it("flags each missing sign-in field inline (module-wizard style) and doesn't call Amplify", async () => {
      render(<Login />)
      await userEvent.click(screen.getByRole("button", { name: "Log in" }))

      const emailErr = await screen.findByText("Email is required.")
      const pwErr = screen.getByText("Password is required.")
      // Same red-caption style as the module wizard's field error.
      expect(emailErr).toHaveClass("text-caption", "text-destructive")
      // Message is wired to its control (rendered directly under the field).
      expect(screen.getByLabelText("Email")).toHaveAttribute("aria-describedby", emailErr.id)
      expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true")
      expect(pwErr).toHaveClass("text-caption", "text-destructive")
      expect(h.signIn).not.toHaveBeenCalled()
    })

    it("clears a field's inline error once the user edits it", async () => {
      render(<Login />)
      await userEvent.click(screen.getByRole("button", { name: "Log in" }))
      expect(await screen.findByText("Email is required.")).toBeInTheDocument()

      await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
      expect(screen.queryByText("Email is required.")).not.toBeInTheDocument()
    })

    it("flags every missing create-account field inline and doesn't call Amplify", async () => {
      render(<Login />)
      await userEvent.click(screen.getByRole("button", { name: "Create an account" }))
      await userEvent.click(screen.getByRole("button", { name: "Sign up" }))

      expect(await screen.findByText("First name is required.")).toBeInTheDocument()
      expect(screen.getByText("Last name is required.")).toBeInTheDocument()
      expect(screen.getByText("Email is required.")).toBeInTheDocument()
      expect(screen.getByText("Password is required.")).toBeInTheDocument()
      expect(screen.getByText("Confirm password is required.")).toBeInTheDocument()
      expect(h.signUp).not.toHaveBeenCalled()
    })

    it("shows a duplicate-account error under the create-account email field", async () => {
      const err = new Error("An account with the given email already exists.")
      err.name = "UsernameExistsException"
      h.signUp.mockRejectedValue(err)
      render(<Login />)
      await userEvent.click(screen.getByRole("button", { name: "Create an account" }))
      await userEvent.type(screen.getByLabelText("First name"), "Ada")
      await userEvent.type(screen.getByLabelText("Last name"), "Lovelace")
      await userEvent.type(screen.getByLabelText("Email"), "ada@x.com")
      await userEvent.type(screen.getByLabelText("Password"), "Password1!")
      await userEvent.type(screen.getByLabelText("Confirm password"), "Password1!")
      await userEvent.click(screen.getByRole("button", { name: "Sign up" }))

      const dupErr = await screen.findByText("A user with this email already exists.")
      expect(dupErr).toHaveClass("text-caption", "text-destructive")
      // Rendered under the email field, not as a form-level alert.
      expect(screen.getByLabelText("Email")).toHaveAttribute("aria-describedby", dupErr.id)
      expect(h.signUp).toHaveBeenCalled()
    })

    it("flags a missing email inline on the forgot-password request and doesn't call Amplify", async () => {
      render(<Login />)
      await userEvent.click(screen.getByRole("button", { name: "Forgot password?" }))
      await userEvent.click(screen.getByRole("button", { name: "Send reset code" }))

      expect(await screen.findByText("Email is required.")).toBeInTheDocument()
      expect(h.resetPassword).not.toHaveBeenCalled()
    })
  })
})
