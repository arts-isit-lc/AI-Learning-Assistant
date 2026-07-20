// Barrel for the student read-path Query hooks (Phase 3). Feature screens
// import from here: `import { useCourses } from "@/services/queries"`.
// Instructor/admin hooks are added in their feature phases (P6/P7).
export * from "./courses"
export * from "./sessions"
export * from "./files"
export * from "./progress"
export * from "./enrollment"
// Instructor slice (Phase 6)
export * from "./instructor-courses"
export * from "./instructor-analytics"
export * from "./instructor-roster"
export * from "./instructor-config"
export * from "./instructor-prompt"
export * from "./instructor-module"
export * from "./instructor-chatlogs"
// Admin slice (Phase 7)
export * from "./admin-instructors"
export * from "./admin-courses"
