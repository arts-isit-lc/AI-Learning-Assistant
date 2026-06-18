import { useState, useEffect, useCallback } from "react";
import apiClient from "../services/api";

/**
 * Manages the draft module lifecycle for the New Module page.
 *
 * On mount:
 *   1. Checks sessionStorage for existing draft_module_{courseId}
 *   2. If found, trusts the stored module_id (it will either be used or cleaned
 *      up by the orphan job if abandoned)
 *   3. If not found, calls POST /instructor/reserve_module?course_id={courseId}
 *   4. Stores returned module_id in sessionStorage
 *
 * cleanup():
 *   - Calls POST /instructor/cleanup_module?module_id={}&course_id={}
 *   - Clears sessionStorage
 *
 * markSaved():
 *   - Called after successful finalization to prevent cleanup on unmount
 *   - Clears sessionStorage
 *
 * @param {string} courseId - The course UUID
 * @returns {{ moduleId: string|null, isReserving: boolean, reserveError: string|null, cleanup: Function, markSaved: Function, clearDraft: Function }}
 */
export function useDraftModule(courseId) {
  const sessionKey = `draft_module_${courseId}`;

  const [moduleId, setModuleId] = useState(() => {
    // Initialize from sessionStorage synchronously to avoid flicker
    return sessionStorage.getItem(sessionKey) || null;
  });
  const [isReserving, setIsReserving] = useState(false);
  const [reserveError, setReserveError] = useState(null);
  // Prevents cleanup after successful save/finalization
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    if (!courseId) return;

    // If we already have a module_id from sessionStorage, reuse it
    if (moduleId) return;

    const reserve = async () => {
      setIsReserving(true);
      setReserveError(null);
      try {
        const { email } = await apiClient.getAuth();
        // Pass all params as queryParams (second arg) — reserve_module uses query string params
        const result = await apiClient.post("instructor/reserve_module", {
          course_id: courseId,
          instructor_email: email,
        });
        const newModuleId = result.module_id;
        setModuleId(newModuleId);
        sessionStorage.setItem(sessionKey, newModuleId);
      } catch (err) {
        console.error("Failed to reserve draft module:", err.message);
        setReserveError(err.message || "Failed to reserve module. Please try again.");
      } finally {
        setIsReserving(false);
      }
    };

    reserve();
  }, [courseId, moduleId, sessionKey]);

  const cleanup = useCallback(async () => {
    if (!moduleId || isSaved) return;

    try {
      const { email } = await apiClient.getAuth();
      // Pass all params as queryParams (second arg) — cleanup_module uses query string params
      await apiClient.post("instructor/cleanup_module", {
        module_id: moduleId,
        course_id: courseId,
        instructor_email: email,
      });
    } catch (err) {
      // Cleanup failure is non-blocking — orphan job is the safety net
      console.warn("Cleanup request failed (non-critical):", err.message);
    } finally {
      sessionStorage.removeItem(sessionKey);
      setModuleId(null);
    }
  }, [moduleId, courseId, isSaved, sessionKey]);

  const markSaved = useCallback(() => {
    // Called after successful finalization to prevent cleanup on unmount
    setIsSaved(true);
    sessionStorage.removeItem(sessionKey);
  }, [sessionKey]);

  const clearDraft = useCallback(() => {
    sessionStorage.removeItem(sessionKey);
    setModuleId(null);
    setReserveError(null);
  }, [sessionKey]);

  // Best-effort cleanup on browser close/navigate (keepalive fetch)
  useEffect(() => {
    if (!moduleId || isSaved) return;

    const handleBeforeUnload = async () => {
      if (!moduleId || isSaved) return;
      // Use keepalive fetch for beforeunload — supports auth headers unlike sendBeacon
      try {
        const { token } = await apiClient.getAuth();
        const url = new URL(`${import.meta.env.VITE_API_ENDPOINT}instructor/cleanup_module`);
        url.searchParams.set("module_id", moduleId);
        url.searchParams.set("course_id", courseId);
        fetch(url.toString(), {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          keepalive: true,
        });
      } catch {
        // Best-effort only — orphan job handles failures
      }
      sessionStorage.removeItem(sessionKey);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [moduleId, courseId, isSaved, sessionKey]);

  return { moduleId, isReserving, reserveError, cleanup, markSaved, clearDraft };
}
