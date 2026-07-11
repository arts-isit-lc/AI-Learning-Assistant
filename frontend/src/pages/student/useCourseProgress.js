import apiClient from "../../services/api";

/**
 * Debug helper: fetch and console.log the student's COURSE-WIDE progress —
 * every module plus per-topic mastery aggregated from the chatbot_v2 session
 * state (DynamoDB). Temporary: logs to the console only (no UI). Remove before
 * shipping.
 */
export default function useCourseProgress(course) {
  const handleLogCourseProgress = async () => {
    try {
      const { email } = await apiClient.getAuth();
      const data = await apiClient.get("student/course_progress", {
        email,
        course_id: course.course_id,
      });
      // TEMP DEBUG (per request): full course-wide progress structure.
      console.log("[course_progress] full structure:", data);
    } catch (error) {
      console.error("Error fetching course progress:", error.message);
    }
  };

  return { handleLogCourseProgress };
}
