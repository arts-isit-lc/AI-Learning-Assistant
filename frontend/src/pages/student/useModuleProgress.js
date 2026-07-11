import { useState } from "react";
import apiClient from "../../services/api";

/**
 * Custom hook for the student's progress on the current module.
 *
 * Unlike useFileViewer (module files are static for the session and cached
 * after the first fetch), progress changes DURING the chat as the LLM updates
 * the module score. So every click performs a fresh GET — a stale cached badge
 * would reproduce the exact problem this feature exists to fix. An in-flight
 * guard prevents overlapping requests from rapid clicks.
 */
export default function useModuleProgress(course, module) {
  const [progress, setProgress] = useState(null);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressPopoverOpen, setProgressPopoverOpen] = useState(false);
  const [progressError, setProgressError] = useState(null);

  const handleFetchProgress = async () => {
    if (progressLoading) return; // in-flight guard
    setProgressLoading(true);
    setProgressError(null);
    setProgressPopoverOpen(true);
    try {
      const { email } = await apiClient.getAuth();
      const data = await apiClient.get("student/module_progress", {
        email,
        course_id: course.course_id,
        module_id: module.module_id,
      });
      setProgress(data);
    } catch (error) {
      console.error("Error fetching module progress:", error.message);
      setProgress(null);
      setProgressError(
        error.status === 404 ? "Progress not found." : "Unable to load progress."
      );
    } finally {
      setProgressLoading(false);
    }
  };

  return {
    progress,
    progressLoading,
    progressPopoverOpen,
    setProgressPopoverOpen,
    progressError,
    handleFetchProgress,
  };
}
