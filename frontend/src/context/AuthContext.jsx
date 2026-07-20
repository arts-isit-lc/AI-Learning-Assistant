import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { fetchAuthSession, signOut as amplifySignOut } from "aws-amplify/auth";
import { setUnauthorizedHandler } from "@/services/authBridge";

/** @typedef {"admin"|"instructor"|"student"|null} Role */

const AuthContext = createContext(null);

/**
 * Derive the app role from Cognito groups. Mirrors the legacy `getHomePage()`
 * precedence: admin/techadmin > instructor > student.
 *
 * @param {string[]|undefined|null} groups
 * @returns {Role}
 */
export function deriveRole(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  if (groups.includes("admin") || groups.includes("techadmin")) return "admin";
  if (groups.includes("instructor")) return "instructor";
  if (groups.includes("student")) return "student";
  return null;
}

/**
 * Global auth state (one of the three OCELIA contexts). Replaces the legacy
 * `getHomePage()` switch + `App.jsx` `UserContext`. Client role checks are
 * UX-only — the backend Cognito authorizers remain the source of truth.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [groups, setGroups] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isInstructorAsStudent, setIsInstructorAsStudent] = useState(false);

  const loadSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const { tokens } = await fetchAuthSession();
      if (tokens?.accessToken) {
        const payload = tokens.accessToken.payload;
        setUser(payload);
        setGroups(payload["cognito:groups"] || []);
      } else {
        setUser(null);
        setGroups([]);
      }
    } catch {
      // Not signed in / expired session — treat as logged out.
      setUser(null);
      setGroups([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const signOut = useCallback(async () => {
    try {
      await amplifySignOut();
    } finally {
      setUser(null);
      setGroups([]);
      setIsInstructorAsStudent(false);
    }
  }, []);

  // Let the (React-free) data layer clear auth on an unrecoverable 401 — this
  // flips isAuthed false, so RequireAuth redirects to /login.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
  }, [signOut]);

  const value = useMemo(() => {
    const role = deriveRole(groups);
    return {
      user,
      groups,
      role,
      isAuthed: Boolean(user),
      isLoading,
      isInstructorAsStudent,
      setIsInstructorAsStudent,
      signOut,
      refresh: loadSession,
    };
  }, [user, groups, isLoading, isInstructorAsStudent, signOut, loadSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read the auth context. Throws if used outside `AuthProvider`.
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
