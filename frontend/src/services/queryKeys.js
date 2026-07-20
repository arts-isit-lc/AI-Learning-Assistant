/**
 * Central query-key factory. Keys are arrays namespaced by domain so
 * invalidation is predictable (e.g. `invalidateQueries({ queryKey: courses.all })`
 * after enrolling). Every query/mutation hook keys through this — no ad-hoc
 * string keys.
 */
export const queryKeys = {
  courses: {
    all: ["courses"],
    list: (asInstructor = false) => ["courses", "list", { asInstructor }],
    page: (courseId) => ["courses", courseId, "page"],
  },
  modules: {
    sessions: (courseId, moduleId) => ["modules", courseId, moduleId, "sessions"],
    files: (courseId, moduleId) => ["modules", courseId, moduleId, "files"],
    progress: (courseId, moduleId) => ["modules", courseId, moduleId, "progress"],
  },
  sessions: {
    messages: (sessionId) => ["sessions", sessionId, "messages"],
  },
  files: {
    url: (fileId) => ["files", fileId, "url"],
  },
  // Instructor slice (Phase 6). Kept under its own namespace so instructor
  // endpoints never collide with the student read-path keys above (e.g. the
  // student `courses` list vs the instructor management list).
  instructor: {
    all: ["instructor"],
    courses: ["instructor", "courses"],
    // Configuration (Concept -> Module tree)
    concepts: (courseId) => ["instructor", courseId, "concepts"],
    modules: (courseId) => ["instructor", courseId, "modules"],
    // Settings (prompt + model + conflict metadata)
    prompt: (courseId) => ["instructor", courseId, "prompt"],
    previousPrompts: (courseId) => ["instructor", courseId, "prompt", "history"],
    // Insights
    analytics: (courseId) => ["instructor", courseId, "analytics"],
    // Students / roster
    students: (courseId) => ["instructor", courseId, "students"],
    accessCode: (courseId) => ["instructor", courseId, "accessCode"],
    studentMessages: (courseId, studentEmail) => [
      "instructor",
      courseId,
      "students",
      studentEmail,
      "messages",
    ],
    // Chat history (chat-log export job)
    chatlogs: (courseId) => ["instructor", courseId, "chatlogs"],
    chatlogStatus: (courseId) => ["instructor", courseId, "chatlogs", "status"],
    // Files (module create/edit references + per-module files)
    courseFiles: (courseId) => ["instructor", courseId, "courseFiles"],
    moduleFiles: (courseId, moduleId) => ["instructor", courseId, "moduleFiles", moduleId],
    moduleRefs: (moduleId) => ["instructor", "moduleRefs", moduleId],
  },
  // Admin slice (Phase 7). Instructor + course management (master-detail).
  admin: {
    instructors: ["admin", "instructors"],
    courses: ["admin", "courses"],
    courseInstructors: (courseId) => ["admin", "courses", courseId, "instructors"],
    instructorCourses: (email) => ["admin", "instructors", email, "courses"],
  },
}
