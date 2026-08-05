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
import { cn } from "@/lib/utils"
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
 * Login inputs stand 44px tall (`h-11`) to match the OCELIA login frame — taller
 * than the app-wide 40px `Input` default. Scoped to this page so the shared
 * primitive (used by every other form) is untouched.
 */
function LoginInput({ className, ...props }) {
  return <Input className={cn("h-11", className)} {...props} />
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

  // If a signed-in user lands on /login, bounce to their role home.
  useEffect(() => {
    if (!isLoading && isAuthed) navigate("/", { replace: true })
  }, [isLoading, isAuthed, navigate])

  const switchMode = (next) => {
    setMode(next)
    setError("")
    setMessage("")
  }

  const finishAuth = async () => {
    await refresh()
    navigate("/", { replace: true })
  }

  const handleSignIn = async (e) => {
    e.preventDefault()
    setError("")
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
    if (!email || !password || !confirmPassword || !firstName || !lastName) {
      setError("All fields are required.")
      return
    }
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
      setError(
        err?.message?.includes("PreSignUp failed")
          ? "Your email domain is not allowed. Please use a valid email address."
          : err?.message || "Couldn't create your account."
      )
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
            <form onSubmit={handleSignIn} className="flex flex-col gap-20">
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-6">
                  <h1 className="text-2xl font-book leading-9 text-foreground">Please log in</h1>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="email" className="text-h4 text-foreground">Email</Label>
                    <LoginInput id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={40} required autoFocus />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="password" className="text-h4 text-foreground">Password</Label>
                    <LoginInput id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={50} required />
                  </div>
                </div>
                <Button type="submit" loading={busy} className="w-full text-base">Log in</Button>
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
            <form onSubmit={handleSignUp} className="flex flex-col gap-6">
              <h1 className="text-2xl font-book leading-9 text-foreground">Create your account</h1>
              <div className="flex gap-3">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="firstName" className="text-h4 text-foreground">First name</Label>
                  <LoginInput id="firstName" autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={30} required autoFocus />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="lastName" className="text-h4 text-foreground">Last name</Label>
                  <LoginInput id="lastName" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={30} required />
                </div>
              </div>
              <div className="flex flex-col">
                <Label htmlFor="signup-email" className="text-h4 text-foreground">Email</Label>
                <LoginInput id="signup-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={40} required />
              </div>
              <div className="flex flex-col">
                <Label htmlFor="signup-password" className="text-h4 text-foreground">Password</Label>
                <LoginInput id="signup-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={50} required />
              </div>
              <div className="flex flex-col">
                <Label htmlFor="confirm-password" className="text-h4 text-foreground">Confirm password</Label>
                <LoginInput id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} maxLength={50} required />
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
              <div className="flex flex-col gap-1.5">
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-password" className="text-h4 text-foreground">New password</Label>
                <LoginInput id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} maxLength={50} required autoFocus />
              </div>
              <div className="flex flex-col gap-1.5">
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
                <form onSubmit={handleRequestReset} className="flex flex-col gap-6">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reset-email" className="text-h4 text-foreground">Email</Label>
                    <LoginInput id="reset-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={40} required autoFocus />
                  </div>
                  <Button type="submit" loading={busy} className="w-full">Send reset code</Button>
                </form>
              )}

              {resetStep === "confirm" && (
                <form onSubmit={handleConfirmReset} className="flex flex-col gap-6">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reset-code" className="text-h4 text-foreground">Confirmation code</Label>
                    <LoginInput id="reset-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={15} required autoFocus />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reset-new-password" className="text-h4 text-foreground">New password</Label>
                    <LoginInput id="reset-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} maxLength={50} required />
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
