import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  signIn,
  signUp,
  confirmSignIn,
  confirmSignUp,
  resendSignUpCode,
  resetPassword,
  confirmResetPassword,
} from "aws-amplify/auth"
import apiClient from "@/services/api"
import { useAuth } from "@/context/AuthContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card } from "@/components/ui/card"
import LoadingScreen from "@/app/LoadingScreen"
import ubcLogo from "@/assets/ubc-logo.svg"

/** Cognito password policy (ported from the legacy signup validation). */
function validatePassword(pw) {
  if (pw.length < 10) return "Password must be at least 10 characters long."
  if (!/[a-z]/.test(pw)) return "Password must contain a lowercase letter."
  if (!/[A-Z]/.test(pw)) return "Password must contain an uppercase letter."
  if (!/[0-9]/.test(pw)) return "Password must contain a number."
  if (!/[^a-zA-Z0-9\s]/.test(pw)) return "Password must contain a special character."
  return ""
}

/**
 * Login inputs use the app-wide 40px `Input` default (`h-10`) so every form
 * input field in the app is a consistent height. Kept as a thin wrapper so the
 * login page has a single place to adjust its field styling if needed.
 */
function LoginInput({ className, ...props }) {
  return <Input className={className} {...props} />
}

/**
 * Inline field-level validation message. Mirrors the module wizard's field-error
 * style (a red caption directly under the control) so auth validation reads the
 * same as the rest of the app. Renders nothing when there's no message.
 */
function FieldError({ id, children }) {
  if (!children) return null
  return (
    <p id={id} className="mt-1 text-caption text-destructive">
      {children}
    </p>
  )
}

/**
 * OCELIA login (migrated off MUI). Preserves the full Cognito flow set — sign in,
 * sign up + email confirmation, force-new-password, and forgot/reset password —
 * on the Tailwind/shadcn system. Auth calls go straight to Amplify; on success it
 * refreshes AuthContext and lands on the role home via the "/" RoleRedirect.
 *
 * Layout matches the OCELIA "Login" Figma frame (955:6766): a single centered
 * card with the UBC + OCELIA brand lockup, a welcome blurb, and the auth form.
 * The mockup draws only the sign-in view; the other Cognito modes reuse the same
 * card chrome so the flow stays cohesive.
 */
export function Login() {
  const navigate = useNavigate()
  const { isAuthed, isLoading, refresh } = useAuth()

  // "signIn" | "signUp" | "confirmSignUp" | "newPassword" | "forgot"
  const [mode, setMode] = useState("signIn")
  const [resetStep, setResetStep] = useState("request") // "request" | "confirm" | "done"

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [code, setCode] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmNewPassword, setConfirmNewPassword] = useState("")

  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  // Per-field "missing"/validation messages rendered inline under each control
  // (module-wizard style, see CourseWizard's name field). Keyed by logical field
  // name; only one auth mode shows at a time, so email/password keys are safely
  // shared across modes.
  const [fieldErrors, setFieldErrors] = useState({})

  // If a signed-in user lands on /login, bounce to their role home.
  useEffect(() => {
    if (!isLoading && isAuthed) navigate("/", { replace: true })
  }, [isLoading, isAuthed, navigate])

  const switchMode = (next) => {
    setMode(next)
    setError("")
    setMessage("")
    setFieldErrors({})
  }

  // Clear a single field's inline error as soon as the user edits it.
  const clearFieldError = (field) =>
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev))

  const finishAuth = async () => {
    await refresh()
    navigate("/", { replace: true })
  }

  const handleSignIn = async (e) => {
    e.preventDefault()
    setError("")
    const errors = {}
    if (!email.trim()) errors.email = "Email is required."
    if (!password) errors.password = "Password is required."
    if (Object.keys(errors).length) {
      setFieldErrors(errors)
      return
    }
    setFieldErrors({})
    setBusy(true)
    try {
      const res = await signIn({ username: email, password })
      if (res.isSignedIn) return await finishAuth()
      const step = res.nextStep?.signInStep
      if (step === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") switchMode("newPassword")
      else if (step === "CONFIRM_SIGN_UP") switchMode("confirmSignUp")
      else setError("An additional sign-in step is required.")
    } catch (err) {
      setError(err?.message || "Couldn't sign in. Check your email and password.")
    } finally {
      setBusy(false)
    }
  }

  const handleSignUp = async (e) => {
    e.preventDefault()
    setError("")
    const errors = {}
    if (!firstName.trim()) errors.firstName = "First name is required."
    if (!lastName.trim()) errors.lastName = "Last name is required."
    if (!email.trim()) errors.email = "Email is required."
    if (!password) errors.password = "Password is required."
    if (!confirmPassword) errors.confirmPassword = "Confirm password is required."
    if (Object.keys(errors).length) {
      setFieldErrors(errors)
      return
    }
    setFieldErrors({})
    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }
    const pwError = validatePassword(password)
    if (pwError) {
      setError(pwError)
      return
    }
    setBusy(true)
    try {
      const { isSignUpComplete, nextStep } = await signUp({
        username: email,
        password,
        attributes: { email },
      })
      if (!isSignUpComplete && nextStep?.signUpStep === "CONFIRM_SIGN_UP") {
        switchMode("confirmSignUp")
      } else if (isSignUpComplete) {
        switchMode("signIn")
      }
    } catch (err) {
      // A pre-existing account surfaces inline under the email field (module-wizard
      // style); every other failure stays a form-level alert.
      if (err?.name === "UsernameExistsException" || /already exists/i.test(err?.message || "")) {
        setFieldErrors({ email: "A user with this email already exists." })
      } else if (err?.message?.includes("PreSignUp failed")) {
        setError("Your email domain is not allowed. Please use a valid email address.")
      } else {
        setError(err?.message || "Couldn't create your account.")
      }
    } finally {
      setBusy(false)
    }
  }

  const handleConfirmSignUp = async (e) => {
    e.preventDefault()
    setError("")
    setBusy(true)
    try {
      await confirmSignUp({ username: email, confirmationCode: code })
      const res = await signIn({ username: email, password })
      if (res.isSignedIn) {
        // Best-effort profile creation — never block a successful sign-in on it.
        try {
          await apiClient.post("student/create_user", {
            user_email: email,
            username: email,
            first_name: firstName,
            last_name: lastName,
            preferred_name: firstName,
          })
        } catch {
          // ignore — the account exists; profile fields can be set later
        }
        return await finishAuth()
      }
      setError("Automatic sign-in failed. Please sign in manually.")
      switchMode("signIn")
    } catch (err) {
      setError(err?.message || "Couldn't confirm your account.")
    } finally {
      setBusy(false)
    }
  }

  const handleResendCode = async () => {
    setError("")
    try {
      await resendSignUpCode({ username: email })
    } catch (err) {
      setError(err?.message || "Couldn't resend the code.")
    }
  }

  const handleNewPassword = async (e) => {
    e.preventDefault()
    setError("")
    if (newPassword !== confirmNewPassword) {
      setError("Passwords do not match.")
      return
    }
    const pwError = validatePassword(newPassword)
    if (pwError) {
      setError(pwError)
      return
    }
    setBusy(true)
    try {
      const res = await confirmSignIn({ challengeResponse: newPassword })
      if (res.isSignedIn) return await finishAuth()
    } catch (err) {
      setError(err?.message || "Couldn't set a new password.")
    } finally {
      setBusy(false)
    }
  }

  const handleRequestReset = async (e) => {
    e.preventDefault()
    setError("")
    setMessage("")
    if (!email.trim()) {
      setFieldErrors({ email: "Email is required." })
      return
    }
    setFieldErrors({})
    setBusy(true)
    try {
      const output = await resetPassword({ username: email })
      const step = output.nextStep?.resetPasswordStep
      if (step === "CONFIRM_RESET_PASSWORD_WITH_CODE") {
        setResetStep("confirm")
        setMessage(
          `A confirmation code was sent to ${output.nextStep.codeDeliveryDetails?.deliveryMedium || "your email"}.`
        )
      } else if (step === "DONE") {
        setResetStep("done")
        setMessage("Password reset.")
      }
    } catch (err) {
      setError(err?.message || "Couldn't send a reset code.")
    } finally {
      setBusy(false)
    }
  }

  const handleConfirmReset = async (e) => {
    e.preventDefault()
    setError("")
    const errors = {}
    if (!code.trim()) errors.code = "Confirmation code is required."
    if (!newPassword) errors.newPassword = "New password is required."
    if (Object.keys(errors).length) {
      setFieldErrors(errors)
      return
    }
    setFieldErrors({})
    setBusy(true)
    try {
      await confirmResetPassword({ username: email, confirmationCode: code, newPassword })
      setResetStep("done")
      setMessage("Your password has been reset. You can sign in now.")
    } catch (err) {
      setError(err?.message || "Couldn't reset your password.")
    } finally {
      setBusy(false)
    }
  }

  // While the session is still resolving — or for an already-signed-in visitor
  // (the effect above bounces them to their role home) — show the shared loading
  // screen instead of flashing the sign-in form.
  if (isLoading || isAuthed) {
    return <LoadingScreen />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">
      {/* max-w-[540px] = OCELIA login card width (Figma 955:6766). */}
      <Card className="flex w-full max-w-[540px] flex-col gap-16 p-8">
        {/* Brand lockup + welcome — constant across every auth mode. */}
        <div className="flex flex-col items-center gap-8">
          <div className="flex w-full items-center gap-6">
            <img src={ubcLogo} alt="University of British Columbia" className="h-14 w-auto shrink-0" />
            {/* tracking is the OCELIA logotype letter-spacing — no spacing token covers it. */}
            <span
              role="img"
              aria-label="OCELIA"
              className="flex-1 text-center text-3xl font-semibold uppercase leading-none tracking-[0.35em] text-primary"
            >
              OCELIA
            </span>
          </div>
          <p className="w-full text-body text-foreground">
            Welcome to OCELIA, your course learning assistant. Sign in to pick up where you left
            off — answers are grounded in your course materials.
          </p>
        </div>

        <div className="flex flex-col gap-6">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {message && !error && (
            <Alert variant="info">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}

          {mode === "signIn" && (
            <form onSubmit={handleSignIn} noValidate className="flex flex-col gap-20">
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-6">
                  <h1 className="text-2xl font-book leading-9 text-foreground">Please log in</h1>
                  <div className="flex flex-col">
                    <Label htmlFor="email" className="text-h4 text-foreground">Email</Label>
                    <LoginInput id="email" type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); clearFieldError("email") }} maxLength={40} required autoFocus aria-invalid={fieldErrors.email ? true : undefined} aria-describedby={fieldErrors.email ? "email-error" : undefined} />
                    <FieldError id="email-error">{fieldErrors.email}</FieldError>
                  </div>
                  <div className="flex flex-col">
                    <Label htmlFor="password" className="text-h4 text-foreground">Password</Label>
                    <LoginInput id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); clearFieldError("password") }} maxLength={50} required aria-invalid={fieldErrors.password ? true : undefined} aria-describedby={fieldErrors.password ? "password-error" : undefined} />
                    <FieldError id="password-error">{fieldErrors.password}</FieldError>
                  </div>
                </div>
                <Button type="submit" loading={busy} className="w-full text-base hover:bg-primary-dark">Log in</Button>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-2">
                <Button
                  type="button"
                  variant="link"
                  className="px-4 text-base hover:bg-primary-subtle hover:text-primary-dark hover:no-underline"
                  onClick={() => switchMode("forgot")}
                >
                  Forgot password?
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="px-4 text-base hover:bg-primary-subtle hover:text-primary-dark hover:no-underline"
                  onClick={() => switchMode("signUp")}
                >
                  Create an account
                </Button>
              </div>
            </form>
          )}

          {mode === "signUp" && (
            <form onSubmit={handleSignUp} noValidate className="flex flex-col gap-6">
              <h1 className="text-2xl font-book leading-9 text-foreground">Create your account</h1>
              <div className="flex gap-3">
                <div className="flex flex-1 flex-col">
                  <Label htmlFor="firstName" className="text-h4 text-foreground">First name</Label>
                  <LoginInput id="firstName" autoComplete="given-name" value={firstName} onChange={(e) => { setFirstName(e.target.value); clearFieldError("firstName") }} maxLength={30} required autoFocus aria-invalid={fieldErrors.firstName ? true : undefined} aria-describedby={fieldErrors.firstName ? "firstName-error" : undefined} />
                  <FieldError id="firstName-error">{fieldErrors.firstName}</FieldError>
                </div>
                <div className="flex flex-1 flex-col">
                  <Label htmlFor="lastName" className="text-h4 text-foreground">Last name</Label>
                  <LoginInput id="lastName" autoComplete="family-name" value={lastName} onChange={(e) => { setLastName(e.target.value); clearFieldError("lastName") }} maxLength={30} required aria-invalid={fieldErrors.lastName ? true : undefined} aria-describedby={fieldErrors.lastName ? "lastName-error" : undefined} />
                  <FieldError id="lastName-error">{fieldErrors.lastName}</FieldError>
                </div>
              </div>
              <div className="flex flex-col">
                <Label htmlFor="signup-email" className="text-h4 text-foreground">Email</Label>
                <LoginInput id="signup-email" type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); clearFieldError("email") }} maxLength={40} required aria-invalid={fieldErrors.email ? true : undefined} aria-describedby={fieldErrors.email ? "signup-email-error" : undefined} />
                <FieldError id="signup-email-error">{fieldErrors.email}</FieldError>
              </div>
              <div className="flex flex-col">
                <Label htmlFor="signup-password" className="text-h4 text-foreground">Password</Label>
                <LoginInput id="signup-password" type="password" autoComplete="new-password" value={password} onChange={(e) => { setPassword(e.target.value); clearFieldError("password") }} maxLength={50} required aria-invalid={fieldErrors.password ? true : undefined} aria-describedby={fieldErrors.password ? "signup-password-error" : undefined} />
                <FieldError id="signup-password-error">{fieldErrors.password}</FieldError>
              </div>
              <div className="flex flex-col">
                <Label htmlFor="confirm-password" className="text-h4 text-foreground">Confirm password</Label>
                <LoginInput id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); clearFieldError("confirmPassword") }} maxLength={50} required aria-invalid={fieldErrors.confirmPassword ? true : undefined} aria-describedby={fieldErrors.confirmPassword ? "confirm-password-error" : undefined} />
                <FieldError id="confirm-password-error">{fieldErrors.confirmPassword}</FieldError>
              </div>
              <p className="text-caption text-muted-foreground">
                Personal information is optional beyond what account setup requires.
              </p>
              <Button type="submit" loading={busy} className="w-full">Sign up</Button>
              <Button type="button" variant="link" className="px-0" onClick={() => switchMode("signIn")}>
                Already have an account? Sign in
              </Button>
            </form>
          )}

          {mode === "confirmSignUp" && (
            <form onSubmit={handleConfirmSignUp} className="flex flex-col gap-6">
              <h1 className="text-2xl font-book leading-9 text-foreground">Confirm your account</h1>
              <p className="text-caption text-muted-foreground">
                Enter the confirmation code sent to {email || "your email"}.
              </p>
              <div className="flex flex-col">
                <Label htmlFor="code" className="text-h4 text-foreground">Confirmation code</Label>
                <LoginInput id="code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={15} required autoFocus />
              </div>
              <Button type="submit" loading={busy} className="w-full">Confirm</Button>
              <div className="flex items-center justify-between border-t border-border pt-4">
                <Button type="button" variant="link" className="px-4" onClick={handleResendCode}>
                  Resend code
                </Button>
                <Button type="button" variant="link" className="px-4" onClick={() => switchMode("signIn")}>
                  Back to sign in
                </Button>
              </div>
            </form>
          )}

          {mode === "newPassword" && (
            <form onSubmit={handleNewPassword} className="flex flex-col gap-6">
              <h1 className="text-2xl font-book leading-9 text-foreground">Set a new password</h1>
              <p className="text-caption text-muted-foreground">Choose a new password for your account.</p>
              <div className="flex flex-col">
                <Label htmlFor="new-password" className="text-h4 text-foreground">New password</Label>
                <LoginInput id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} maxLength={50} required autoFocus />
              </div>
              <div className="flex flex-col">
                <Label htmlFor="confirm-new-password" className="text-h4 text-foreground">Confirm new password</Label>
                <LoginInput id="confirm-new-password" type="password" autoComplete="new-password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} maxLength={50} required />
              </div>
              <Button type="submit" loading={busy} className="w-full">Set password</Button>
            </form>
          )}

          {mode === "forgot" && (
            <div className="flex flex-col gap-6">
              <h1 className="text-2xl font-book leading-9 text-foreground">Reset password</h1>

              {resetStep === "request" && (
                <form onSubmit={handleRequestReset} noValidate className="flex flex-col gap-6">
                  <div className="flex flex-col">
                    <Label htmlFor="reset-email" className="text-h4 text-foreground">Email</Label>
                    <LoginInput id="reset-email" type="email" autoComplete="email" value={email} onChange={(e) => { setEmail(e.target.value); clearFieldError("email") }} maxLength={40} required autoFocus aria-invalid={fieldErrors.email ? true : undefined} aria-describedby={fieldErrors.email ? "reset-email-error" : undefined} />
                    <FieldError id="reset-email-error">{fieldErrors.email}</FieldError>
                  </div>
                  <Button type="submit" loading={busy} className="w-full">Send reset code</Button>
                </form>
              )}

              {resetStep === "confirm" && (
                <form onSubmit={handleConfirmReset} noValidate className="flex flex-col gap-6">
                  <div className="flex flex-col">
                    <Label htmlFor="reset-code" className="text-h4 text-foreground">Confirmation code</Label>
                    <LoginInput id="reset-code" value={code} onChange={(e) => { setCode(e.target.value); clearFieldError("code") }} maxLength={15} required autoFocus aria-invalid={fieldErrors.code ? true : undefined} aria-describedby={fieldErrors.code ? "reset-code-error" : undefined} />
                    <FieldError id="reset-code-error">{fieldErrors.code}</FieldError>
                  </div>
                  <div className="flex flex-col">
                    <Label htmlFor="reset-new-password" className="text-h4 text-foreground">New password</Label>
                    <LoginInput id="reset-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => { setNewPassword(e.target.value); clearFieldError("newPassword") }} maxLength={50} required aria-invalid={fieldErrors.newPassword ? true : undefined} aria-describedby={fieldErrors.newPassword ? "reset-new-password-error" : undefined} />
                    <FieldError id="reset-new-password-error">{fieldErrors.newPassword}</FieldError>
                  </div>
                  <Button type="submit" loading={busy} className="w-full">Reset password</Button>
                </form>
              )}

              {resetStep === "done" && (
                <p className="text-body text-success">Your password has been reset. You can sign in now.</p>
              )}

              <Button
                type="button"
                variant="link"
                className="px-0"
                onClick={() => {
                  setResetStep("request")
                  switchMode("signIn")
                }}
              >
                Remember your password? Sign in
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

export default Login
