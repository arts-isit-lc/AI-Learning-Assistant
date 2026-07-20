import "./App.css";
// amplify
import { Amplify } from "aws-amplify";
import { fetchAuthSession } from "aws-amplify/auth";
import "@aws-amplify/ui-react/styles.css";
// react-router
import {
  BrowserRouter as Router,
  Route,
  Routes,
  Navigate,
} from "react-router-dom";
import { useEffect, useState, createContext, lazy, Suspense } from "react";
// pages — Login stays eagerly loaded (entry point)
import Login from "./pages/Login";
// P-4: Role-specific pages lazy loaded for code splitting
const StudentHomepage = lazy(() => import("./pages/student/StudentHomepage"));
const StudentChat = lazy(() => import("./pages/student/StudentChat"));
const AdminHomepage = lazy(() => import("./pages/admin/AdminHomepage"));
const InstructorHomepage = lazy(() => import("./pages/instructor/InstructorHomepage"));
const CourseView = lazy(() => import("./pages/student/CourseView"));
// P-1 (OCELIA rebuild): dev-only design-token gallery, public (no auth guard).
const StyleGuide = lazy(() => import("./pages/dev/StyleGuide"));
// P-4 (OCELIA rebuild): dev-only component gallery, public (no auth guard).
const Gallery = lazy(() => import("./pages/dev/Gallery"));
// P-2 (OCELIA rebuild): the new Tailwind/shadcn app shell, gated by VITE_UI_V2.
// Lazy so legacy mode never loads it; the whole flag + branch is removed in Phase 8.
const AppV2 = lazy(() => import("./app/AppV2"));
import { NotificationProvider } from "./context/NotificationContext";
import ErrorBoundary from "./components/ErrorBoundary";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

export const UserContext = createContext();

Amplify.configure({
  API: {
    REST: {
      MyApi: {
        endpoint: import.meta.env.VITE_API_ENDPOINT,
      },
    },
  },
  Auth: {
    Cognito: {
      region: import.meta.env.VITE_AWS_REGION,
      userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      allowGuestAccess: false,
    },
  },
});

function LegacyApp() {
  const [user, setUser] = useState(null);
  const [userGroup, setUserGroup] = useState(null);
  const [course, setCourse] = useState(null);
  const [module, setModule] = useState(null);
  const [isInstructorAsStudent, setIsInstructorAsStudent] = useState(false);

  useEffect(() => {
    const fetchAuthData = () => {
      fetchAuthSession()
        .then(({ tokens }) => {
          if (tokens && tokens.accessToken) {
            const group = tokens.accessToken.payload["cognito:groups"];
            setUser(tokens.accessToken.payload);
            setUserGroup(group || []);
          }
        })
        .catch((error) => {
          console.log(error);
        });
    };

    fetchAuthData();
  }, []);

  const getHomePage = () => {
    if (
      userGroup &&
      (userGroup.includes("admin") || userGroup.includes("techadmin"))
    ) {
      return <AdminHomepage />;
    } else if (userGroup && userGroup.includes("instructor")) {
      if (isInstructorAsStudent) {
        return <StudentHomepage setCourse={setCourse} />;
      } else {
        return <InstructorHomepage />;
      }
    } else if (userGroup && userGroup.includes("student")) {
      return <StudentHomepage setCourse={setCourse} />;
    } else {
      return <Login />;
    }
  };

  return (
    <NotificationProvider>
      <ToastContainer
        position="top-center"
        autoClose={1000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="colored"
      />
      <UserContext.Provider
        value={{ isInstructorAsStudent, setIsInstructorAsStudent }}
      >
        <ErrorBoundary
          fallbackRender={() => (
            <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
              <p className="text-lg font-medium text-foreground">
                Something went wrong.
              </p>
              <p className="text-sm text-muted-foreground">
                The page hit an unexpected error. Reloading usually fixes it.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
              >
                Reload
              </button>
            </div>
          )}
        >
          <Router>
            <Suspense fallback={<div>Loading...</div>}>
              <Routes>
                <Route path="/style-guide" element={<StyleGuide />} />
                <Route path="/gallery" element={<Gallery />} />
                <Route
                  path="/"
                  element={user ? <Navigate to="/home" /> : <Login />}
                />
                <Route
                  path="/student_chat/*"
                  element={
                    <StudentChat
                      course={course}
                      module={module}
                      setModule={setModule}
                      setCourse={setCourse}
                    />
                  }
                />
                <Route
                  path="/student_course/*"
                  element={
                    <CourseView
                      course={course}
                      setModule={setModule}
                      setCourse={setCourse}
                    />
                  }
                />
                <Route path="/home/*" element={getHomePage()} />
                <Route path="/course/*" element={<InstructorHomepage />} />
              </Routes>
            </Suspense>
          </Router>
        </ErrorBoundary>
      </UserContext.Provider>
    </NotificationProvider>
  );
}

// Strangler switch: the new OCELIA shell when VITE_UI_V2 is enabled, otherwise
// the legacy MUI app. Both coexist until the rebuild completes (Phase 8), when
// this branch, LegacyApp, and the flag are deleted. UserContext + Amplify.configure
// above stay put — legacy pages still import UserContext from this module.
function App() {
  if (import.meta.env.VITE_UI_V2 === "true") {
    return (
      <Suspense fallback={<div>Loading...</div>}>
        <AppV2 />
      </Suspense>
    );
  }
  return <LegacyApp />;
}

export default App;
