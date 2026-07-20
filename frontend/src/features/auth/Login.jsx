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
import { toast } from "react-toastify"
import apiClient from "@/services/api"
import { useAuth } from "@/context/AuthContext"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"

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
 * OCELIA login (migrated off MUI). Preserves the full Cognito flow set — sign in,
 * sign up + email confirmation, force-new-password, and forgot/reset password —
 * on the Tailwind/shadcn system. Auth calls go straight to Amplify; on success it
 * refreshes AuthContext and lands on the role home via the "/" RoleRedirect.
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
        toast.success("Account created. Check your email for the confirmation code.")
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
      toast.success("A new confirmation code has been sent.")
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
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden items-center justify-center bg-gradient-to-br from-primary/15 to-navy/20 p-10 lg:flex">
        <div className="max-w-sm text-center">
          <h1 className="text-h2 font-semibold text-navy">Welcome to OCELIA</h1>
          <p className="mt-3 text-body text-muted-foreground">
            Your course AI learning assistant, grounded in your materials.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {message && !error && (
            <Alert variant="info" className="mb-4">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}

          {mode === "signIn" && (
            <form onSubmit={handleSignIn} className="flex flex-col gap-4">
              <h2 className="text-h4 font-semibold text-navy">Sign in</h2>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={40} required autoFocus />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={50} required />
              </div>
              <Button type="submit" loading={busy}>Sign in</Button>
              <div className="flex items-center justify-between">
                <Button type="button" variant="link" size="sm" className="px-0" onClick={() => switchMode("forgot")}>
                  Forgot password?
                </Button>
                <Button type="button" variant="link" size="sm" className="px-0" onClick={() => switchMode("signUp")}>
                  Create an account
                </Button>
              </div>
            </form>
          )}

          {mode === "signUp" && (
            <form onSubmit={handleSignUp} className="flex flex-col gap-4">
              <h2 className="text-h4 font-semibold text-navy">Create your account</h2>
              <div className="flex gap-3">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="firstName">First name</Label>
                  <Input id="firstName" autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={30} required autoFocus />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input id="lastName" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={30} required />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="signup-email">Email</Label>
                <Input id="signup-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={40} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="signup-password">Password</Label>
                <Input id="signup-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={50} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} maxLength={50} required />
              </div>
              <p className="text-caption text-muted-foreground">
                Personal information is optional beyond what account setup requires.
              </p>
              <Button type="submit" loading={busy}>Sign up</Button>
              <Button type="button" variant="link" size="sm" className="px-0" onClick={() => switchMode("signIn")}>
                Already have an account? Sign in
              </Button>
            </form>
          )}

          {mode === "confirmSignUp" && (
            <form onSubmit={handleConfirmSignUp} className="flex flex-col gap-4">
              <h2 className="text-h4 font-semibold text-navy">Confirm your account</h2>
              <p className="text-caption text-muted-foreground">
                Enter the confirmation code sent to {email || "your email"}.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">Confirmation code</Label>
                <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={15} required autoFocus />
              </div>
              <Button type="submit" loading={busy}>Confirm</Button>
              <div className="flex items-center justify-between">
                <Button type="button" variant="link" size="sm" className="px-0" onClick={handleResendCode}>
                  Resend code
                </Button>
                <Button type="button" variant="link" size="sm" className="px-0" onClick={() => switchMode("signIn")}>
                  Back to sign in
                </Button>
              </div>
            </form>
          )}

          {mode === "newPassword" && (
            <form onSubmit={handleNewPassword} className="flex flex-col gap-4">
              <h2 className="text-h4 font-semibold text-navy">Set a new password</h2>
              <p className="text-caption text-muted-foreground">Choose a new password for your account.</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-password">New password</Label>
                <Input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} maxLength={50} required autoFocus />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirm-new-password">Confirm new password</Label>
                <Input id="confirm-new-password" type="password" autoComplete="new-password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} maxLength={50} required />
              </div>
              <Button type="submit" loading={busy}>Set password</Button>
            </form>
          )}

          {mode === "forgot" && (
            <div className="flex flex-col gap-4">
              <h2 className="text-h4 font-semibold text-navy">Reset password</h2>

              {resetStep === "request" && (
                <form onSubmit={handleRequestReset} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reset-email">Email</Label>
                    <Input id="reset-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={40} required autoFocus />
                  </div>
                  <Button type="submit" loading={busy}>Send reset code</Button>
                </form>
              )}

              {resetStep === "confirm" && (
                <form onSubmit={handleConfirmReset} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reset-code">Confirmation code</Label>
                    <Input id="reset-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={15} required autoFocus />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="reset-new-password">New password</Label>
                    <Input id="reset-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} maxLength={50} required />
                  </div>
                  <Button type="submit" loading={busy}>Reset password</Button>
                </form>
              )}

              {resetStep === "done" && (
                <p className="text-caption text-success">Your password has been reset. You can sign in now.</p>
              )}

              <Button
                type="button"
                variant="link"
                size="sm"
                className={cn("px-0")}
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
      </div>
    </div>
  )
}

export default Login
