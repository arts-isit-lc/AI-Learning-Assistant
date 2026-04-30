import React, { useState, useEffect, useContext, useRef } from "react";
import {
  Routes,
  Route,
  useNavigate,
  useParams,
  useLocation,
} from "react-router-dom";
import apiClient from "../../services/api";
import {
  Typography,
  Box,
  AppBar,
  Toolbar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  TextField,
  TableFooter,
  TablePagination,
  Button,
} from "@mui/material";
import { v4 as uuidv4 } from 'uuid';
import PageContainer from "../Container";
import InstructorHeader from "../../components/InstructorHeader";
import InstructorSidebar from "./InstructorSidebar";
import InstructorAnalytics from "./InstructorAnalytics";
import InstructorEditCourse from "./InstructorEditCourse";
import PromptSettings from "./PromptSettings";
import ViewStudents from "./ViewStudents";
import InstructorModules from "./InstructorModules";
import InstructorNewModule from "./InstructorNewModule";
import StudentDetails from "./StudentDetails";
import InstructorNewConcept from "./InstructorNewConcept";
import InstructorConcepts from "./InstructorConcepts";
import InstructorEditConcept from "./InstructorEditConcept";
import ChatLogs from "./ChatLogs";
import { useNotification } from "../../context/NotificationContext";
import { UserContext } from "../../App";
import { titleCase } from "../../utils/formatters";

function constructWebSocketUrl() {
  const tempUrl = import.meta.env.VITE_GRAPHQL_WS_URL; // Replace with your WebSocket URL
  const apiUrl = tempUrl.replace("https://", "wss://");
  const urlObj = new URL(apiUrl);
  const tmpObj = new URL(tempUrl);
  const modifiedHost = urlObj.hostname.replace(
      "appsync-api",
      "appsync-realtime-api"
  );

  urlObj.hostname = modifiedHost;
  const host = tmpObj.hostname;
  const header = {
      host: host,
      Authorization: `API_KEY=${import.meta.env.VITE_API_KEY}`,
  };

  const encodedHeader = btoa(JSON.stringify(header));
  const payload = "e30=";

  return `${urlObj.toString()}?header=${encodedHeader}&payload=${payload}`;
};

const removeCompletedNotification = async (course_id) => {
  try {
    console.log(course_id)
    const { email } = await apiClient.getAuth();
    await apiClient.delete("instructor/remove_completed_notification", {
      course_id,
      instructor_email: email,
    });
    console.log("Notification removed successfully.");
  } catch (error) {
    console.error("Error removing completed notification:", error.message);
  }
};

function openWebSocket(courseName, course_id, requestId, setNotificationForCourse, onComplete) {
  // Returns a Promise that resolves once the subscription is confirmed (start_ack),
  // so callers can wait before triggering backend work.
  return new Promise((resolve, reject) => {
    const wsUrl = constructWebSocketUrl();
    const ws = new WebSocket(wsUrl, "graphql-ws");

    ws.onopen = () => {
      console.log("WebSocket connection established");

      const initMessage = { type: "connection_init" };
      ws.send(JSON.stringify(initMessage));

      const subscriptionId = uuidv4();
      const subscriptionMessage = {
          id: subscriptionId,
          type: "start",
          payload: {
              data: `{"query":"subscription OnNotify($request_id: String!) { onNotify(request_id: $request_id) { message request_id } }","variables":{"request_id":"${requestId}"}}`,
              extensions: {
                  authorization: {
                      Authorization: `API_KEY=${import.meta.env.VITE_API_KEY}`,
                      host: new URL(import.meta.env.VITE_GRAPHQL_WS_URL).hostname,
                  },
              },
          },
      };

      ws.send(JSON.stringify(subscriptionMessage));
      console.log("Subscribed to WebSocket notifications");
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      console.log("WebSocket message received:", message);

      // Resolve the promise once subscription is confirmed
      if (message.type === "start_ack") {
        console.log("Subscription confirmed (start_ack), ready to receive notifications");
        resolve();
      }

      // Handle notification
      if (message.type === "data" && message.payload?.data?.onNotify) {
        const receivedMessage = message.payload.data.onNotify.message;
        console.log("Notification received:", receivedMessage);
        
        setNotificationForCourse(course_id, true);
        removeCompletedNotification(course_id);

        alert(`Chat logs are now available for ${courseName}`);

        ws.close();
        console.log("WebSocket connection closed after handling notification");

        if (typeof onComplete === "function") {
          onComplete();
        }
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      ws.close();
      reject(error);
    };

    ws.onclose = () => {
      console.log("WebSocket closed");
    };

    // Set a timeout to close the WebSocket if no message is received
    setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.warn("WebSocket timeout reached, closing connection");
            ws.close();
        }
    }, 180000);
  });
};

// course details page
const CourseDetails = ({ courseData }) => {
  const { courseName } = useParams();
  const [selectedComponent, setSelectedComponent] = useState(
    "InstructorAnalytics"
  );

  const extractCourseDetails = (fullName) => {
    const parts = fullName.split(" ");
    if (parts.length < 3) return { department: "", number: "", name: fullName.trim() };
    
    const department = parts[0].trim();
    const number = parts[1].trim();
    const name = parts.slice(2).join(" ").trim();

    return { department, number, name };
  };
  
  const { department, number, name } = extractCourseDetails(courseName);
  const course = courseData.find(
    (course) =>
      course.course_name.trim().toLowerCase() === name.toLowerCase() &&
      course.course_department.trim().toLowerCase() === department.toLowerCase() &&
      course.course_number.toString() === number
  );

  if (!course) {
    return <Typography variant="h6">Loading ...</Typography>;
  }

  const { course_id } = course;

  const renderComponent = () => {
    switch (selectedComponent) {
      case "InstructorAnalytics":
        return (
          <InstructorAnalytics courseName={courseName} course_id={course_id} />
        );
      case "InstructorEditCourse":
        return (
          <InstructorModules courseName={courseName} course_id={course_id} />
        );
      case "InstructorEditConcepts":
        return (
          <InstructorConcepts
            courseName={courseName}
            course_id={course_id}
            setSelectedComponent={setSelectedComponent}
          />
        );
      case "PromptSettings":
        return <PromptSettings courseName={courseName} course_id={course_id} />;
      case "ViewStudents":
        return <ViewStudents courseName={courseName} course_id={course_id} />;
      case "ChatLogs":
        return <ChatLogs courseName={courseName} course_id={course_id} openWebSocket={openWebSocket} />;
      default:
        return (
          <InstructorAnalytics courseName={courseName} course_id={course_id} />
        );
    }
  };


  return (
    <PageContainer>
      <AppBar
        position="fixed"
        sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}
        elevation={1}
      >
        <InstructorHeader />
      </AppBar>
      <InstructorSidebar setSelectedComponent={setSelectedComponent} course_id={course_id} selectedComponent={selectedComponent} />
      {renderComponent()}
    </PageContainer>
  );
};

const InstructorHomepage = () => {
  const [rows, setRows] = useState([
    {
      course: "loading...",
      date: "loading...",
      status: "loading...",
      id: "loading...",
    },
  ]);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(5);
  const [courseData, setCourseData] = useState([]);  
  const { isInstructorAsStudent } = useContext(UserContext);
  const { setNotificationForCourse } = useNotification();
  const hasFetched = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (isInstructorAsStudent) {
      navigate("/");
    }
  }, [isInstructorAsStudent, navigate]);
  // connect to api data
  useEffect(() => {
    if (hasFetched.current) return;

    const fetchCourses = async () => {
      try {
        const { email } = await apiClient.getAuth();
        const data = await apiClient.get("instructor/courses", { email });
        setCourseData(data);
        const formattedData = data.map((course) => ({
          course: course.course_name,
          date: new Date().toLocaleDateString(), // REPLACE
          status: course.course_student_access ? "Active" : "Inactive",
          id: course.course_id,
        }));
        setRows(formattedData);
        checkNotificationStatus(data, email);
      } catch (error) {
        console.error("Error fetching courses:", error.message);
      }
    };

    fetchCourses();
    hasFetched.current = true;
  }, []);

  const checkNotificationStatus = async (courses, email) => {
    // Parallelize notification checks instead of sequential for-loop
    await Promise.all(courses.map(async (course) => {
      try {
        const data = await apiClient.get("instructor/check_notifications_status", {
          course_id: course.course_id,
          instructor_email: email,
        });
        if (data.completionStatus === true) {
          console.log(`Getting chatlogs for ${course.course_name} is completed. Notifying the user and removing row from database.`);
          setNotificationForCourse(course.course_id, true);
          removeCompletedNotification(course.course_id);
          alert(`Chat logs are available for course: ${course.course_name}`);
        } else if (data.completionStatus === false) {
          console.log(`Getting chatlogs for ${course.course_name} is not completed. Re-opening the websocket.`);
          openWebSocket(course.course_name, course.course_id, data.requestId, setNotificationForCourse);
        } else {
          console.log(`Either chatlogs for ${course.course_name} were not requested or instructor already received notification. No need to notify instructor or re-open websocket.`);
        }
      } catch (error) {
        console.error("Error checking notification status for", course.course_id, error.message);
      }
    }));
  };

  const handleSearchChange = (event) => {
    setSearchQuery(event.target.value);
  };

  const handleChangePage = (event, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const filteredRows = rows.filter((row) =>
    row.course.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleRowClick = (courseName, course_id) => {
    const course = courseData.find(
      (course) => course.course_name.trim() === courseName.trim()
    );

    if (course) {
      const { course_id, course_department, course_number } = course;
      const path = `/course/${course_department} ${course_number} ${courseName.trim()}`;
      navigate(path, { state: { course_id } });
    } else {
      console.error("Course not found!");
    }
  };

  return (
    <Routes>
      <Route
        path="/"
        element={
          <PageContainer>
            <AppBar
              position="fixed"
              sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}
              elevation={1}
            >
              <InstructorHeader />
            </AppBar>
            <Box component="main" sx={{ flexGrow: 1, p: 3, marginTop: 1 }}>
              <Toolbar />
              <Typography
                color="black"
                fontStyle="semibold"
                textAlign="left"
                variant="h6"
              >
                Courses
              </Typography>
              <Paper
                sx={{
                  width: "80%",
                  overflow: "hidden",
                  margin: "0 auto",
                  padding: 2,
                }}
              >
                <TextField
                  label="Search by Course"
                  variant="outlined"
                  value={searchQuery}
                  onChange={handleSearchChange}
                  sx={{ width: "100%", marginBottom: 2 }}
                />
                <TableContainer
                  sx={{
                    width: "100%",
                    maxHeight: "70vh",
                    overflowY: "auto",
                  }}
                >
                  <Table aria-label="course table">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ width: "60%", padding: "16px" }}>
                          Course
                        </TableCell>
                        <TableCell sx={{ width: "20%", padding: "16px" }}>
                          Status
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {filteredRows
                        .slice(
                          page * rowsPerPage,
                          page * rowsPerPage + rowsPerPage
                        )
                        .map((row, index) => (
                          <TableRow
                            key={index}
                            onClick={() => handleRowClick(row.course, row.id)}
                            style={{ cursor: "pointer" }}
                          >
                            <TableCell sx={{ padding: "16px" }}>
                              {titleCase(row.course)}
                            </TableCell>
                            <TableCell sx={{ padding: "16px" }}>
                              <Button
                                variant="contained"
                                color={
                                  row.status === "Active"
                                    ? "primary"
                                    : "secondary"
                                }
                              >
                                {row.status}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TablePagination
                          rowsPerPageOptions={[5, 10, 25]}
                          component="div"
                          count={filteredRows.length}
                          rowsPerPage={rowsPerPage}
                          page={page}
                          onPageChange={handleChangePage}
                          onRowsPerPageChange={handleChangeRowsPerPage}
                        />
                      </TableRow>
                    </TableFooter>
                  </Table>
                </TableContainer>
              </Paper>
            </Box>
          </PageContainer>
        }
      />
      <Route exact path=":courseName/*" element={<CourseDetails courseData={courseData} openWebSocket={openWebSocket} />} />
      <Route
        path=":courseName/edit-module/:moduleId"
        element={<InstructorEditCourse />}
      />
      <Route
        path=":courseName/edit-concept/:conceptId"
        element={<InstructorEditConcept />}
      />
      <Route path=":courseName/new-module" element={<InstructorNewModule />} />
      <Route
        path=":courseName/new-concept"
        element={<InstructorNewConcept />}
      />
      <Route
        path=":courseName/student/:studentId"
        element={<StudentDetails />}
      />
    </Routes>
  );
};

export default InstructorHomepage;