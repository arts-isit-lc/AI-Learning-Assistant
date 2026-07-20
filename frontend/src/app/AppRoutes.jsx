import { lazy } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { useAuth } from "@/context/AuthContext"
import { roleHomePath } from "./roleHome"
import LoadingScreen from "./LoadingScreen"
import RequireAuth from "./guards/RequireAuth"
import RequireRole from "./guards/RequireRole"
import StudentLayout from "./layouts/StudentLayout"
import InstructorLayout from "./layouts/InstructorLayout"
import InstructorCourseLayout from "./layouts/InstructorCourseLayout"
import AdminLayout from "./layouts/AdminLayout"
import { SplitLayout } from "@/components/composed/SplitLayout"
import Placeholder from "./pages/Placeholder"
import NotFound from "./pages/NotFound"

// Heavy/legacy screens are lazy so they stay out of the shell's initial chunk.
const Login = lazy(() => import("@/features/auth/Login"))
const StyleGuide = lazy(() => import("@/pages/dev/StyleGuide"))
const Gallery = lazy(() => import("@/pages/dev/Gallery"))
// Student slice (Phase 5)
const StudentHome = lazy(() =>
  import("@/features/student/StudentHome").then((m) => ({ default: m.StudentHome }))
)
const CourseView = lazy(() =>
  import("@/features/student/CourseView").then((m) => ({ default: m.CourseView }))
)
const StudentChat = lazy(() =>
  import("@/features/student/StudentChat").then((m) => ({ default: m.StudentChat }))
)
// Instructor slice (Phase 6)
const InstructorCourseList = lazy(() =>
  import("@/features/instructor/InstructorCourseList").then((m) => ({ default: m.InstructorCourseList }))
)
const InsightsTab = lazy(() =>
  import("@/features/instructor/InsightsTab").then((m) => ({ default: m.InsightsTab }))
)
const StudentsTab = lazy(() =>
  import("@/features/instructor/StudentsTab").then((m) => ({ default: m.StudentsTab }))
)
const ConfigurationTab = lazy(() =>
  import("@/features/instructor/ConfigurationTab").then((m) => ({ default: m.ConfigurationTab }))
)
const SettingsTab = lazy(() =>
  import("@/features/instructor/SettingsTab").then((m) => ({ default: m.SettingsTab }))
)
const CourseWizard = lazy(() =>
  import("@/features/instructor/CourseWizard").then((m) => ({ default: m.CourseWizard }))
)
const EditModule = lazy(() =>
  import("@/features/instructor/EditModule").then((m) => ({ default: m.EditModule }))
)
const ChatHistoryTab = lazy(() =>
  import("@/features/instructor/ChatHistoryTab").then((m) => ({ default: m.ChatHistoryTab }))
)
// Admin slice (Phase 7)
const InstructorList = lazy(() =>
  import("@/features/admin/InstructorList").then((m) => ({ default: m.InstructorList }))
)
const InstructorDetail = lazy(() =>
  import("@/features/admin/InstructorDetail").then((m) => ({ default: m.InstructorDetail }))
)
const CourseList = lazy(() =>
  import("@/features/admin/CourseList").then((m) => ({ default: m.CourseList }))
)
const CreateCourse = lazy(() =>
  import("@/features/admin/CreateCourse").then((m) => ({ default: m.CreateCourse }))
)
const CourseDetail = lazy(() =>
  import("@/features/admin/CourseDetail").then((m) => ({ default: m.CourseDetail }))
)

/** Redirect "/" (and legacy home routes) to the visitor's role home. */
function RoleRedirect() {
  const { role, isInstructorAsStudent, isLoading } = useAuth()
  if (isLoading) return <LoadingScreen />
  return <Navigate to={roleHomePath(role, isInstructorAsStudent)} replace />
}

/**
 * OCELIA route map (implements the Phase 0 audit §7). Resource IDs live in the
 * URL so every screen is deep-linkable + refresh-safe; role guards redirect by
 * role; unknown paths hit a 404; legacy paths redirect. Phase 2 renders
 * placeholder screens inside the real shell — features fill in Phases 5-7.
 */
export default function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />
      <Route path="/style-guide" element={<StyleGuide />} />
      <Route path="/gallery" element={<Gallery />} />

      {/* Authenticated */}
      <Route element={<RequireAuth />}>
        <Route path="/" element={<RoleRedirect />} />

        {/* STUDENT (instructors may preview the student UI) */}
        <Route element={<RequireRole allow={["student", "instructor"]} />}>
          <Route element={<StudentLayout />}>
            <Route path="/courses" element={<StudentHome />} />
            <Route path="/courses/:courseId" element={<CourseView />} />
            <Route path="/courses/:courseId/modules/:moduleId" element={<StudentChat />} />
          </Route>
        </Route>

        {/* INSTRUCTOR — master-detail: persistent course list (left) + detail (right) */}
        <Route element={<RequireRole allow={["instructor"]} />}>
          <Route path="/instructor" element={<InstructorLayout />}>
            <Route index element={<Navigate to="courses" replace />} />
            <Route path="courses" element={<SplitLayout list={<InstructorCourseList />} />}>
              <Route
                index
                element={
                  <div className="grid place-items-center p-8 text-center text-caption text-muted-foreground">
                    Select a course to manage its content, settings, and students.
                  </div>
                }
              />
              <Route path=":courseId" element={<InstructorCourseLayout />}>
                <Route index element={<Navigate to="configuration" replace />} />
                <Route path="configuration" element={<ConfigurationTab />} />
                <Route path="insights" element={<InsightsTab />} />
                <Route path="chat-history" element={<ChatHistoryTab />} />
                <Route path="settings" element={<SettingsTab />} />
                <Route path="students" element={<StudentsTab />} />
                <Route path="modules/new" element={<CourseWizard />} />
                <Route path="modules/:moduleId/edit" element={<EditModule />} />
              </Route>
            </Route>
            <Route
              path="analytics"
              element={<Placeholder title="Global Analytics" phase={6} description="Coming soon." />}
            />
            <Route
              path="chats"
              element={<Placeholder title="Global Chats" phase={6} description="Coming soon." />}
            />
          </Route>
        </Route>

        {/* ADMIN */}
        <Route element={<RequireRole allow={["admin"]} />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="instructors" replace />} />
            <Route path="instructors" element={<SplitLayout list={<InstructorList />} />}>
              <Route
                index
                element={
                  <div className="grid place-items-center p-8 text-center text-caption text-muted-foreground">
                    Select an instructor to manage their course assignments.
                  </div>
                }
              />
              <Route path=":instructorId" element={<InstructorDetail />} />
            </Route>
            <Route path="courses" element={<SplitLayout list={<CourseList />} />}>
              <Route
                index
                element={
                  <div className="grid place-items-center p-8 text-center text-caption text-muted-foreground">
                    Select a course to manage it, or create a new one.
                  </div>
                }
              />
              <Route path="new" element={<CreateCourse />} />
              <Route path=":courseId" element={<CourseDetail />} />
            </Route>
          </Route>
        </Route>
      </Route>

      {/* Legacy redirects (audit §7) */}
      <Route path="/home/*" element={<RoleRedirect />} />
      <Route path="/student_course/*" element={<Navigate to="/courses" replace />} />
      <Route path="/student_chat/*" element={<Navigate to="/courses" replace />} />
      <Route path="/course/*" element={<Navigate to="/instructor/courses" replace />} />

      {/* Not found */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
