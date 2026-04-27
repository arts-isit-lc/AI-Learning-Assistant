import React, { useState, useEffect } from "react";
import { Routes, Route, useNavigate, useParams } from "react-router-dom";
import apiClient from "../../services/api";
import { Typography, Box, AppBar } from "@mui/material";
import PageContainer from "../Container";
import InstructorHeader from "../../components/InstructorHeader";
import InstructorSidebar from "./InstructorSidebar";
import InstructorAnalytics from "./InstructorAnalytics";
import PromptSettings from "./PromptSettings";
import ViewStudents from "./ViewStudents";
import InstructorModules from "./InstructorModules";

// course details page
const CourseDetails = ({ openWebSocket }) => {
  const { courseId } = useParams();
  const [selectedComponent, setSelectedComponent] = useState(
    "InstructorAnalytics"
  );

  // connect to api data
  useEffect(() => {
    const fetchCourses = async () => {
      try {
        const { email } = await apiClient.getAuth();
        const data = await apiClient.get("instructor/courses", { email });
        const course_id = data.find((course) => course.course_id);
        const course_name = data.find((course) => course.course_name);
        setRows(formattedData);
      } catch (error) {
        console.error("Error fetching courses:", error.message);
      }
    };

    fetchCourses();
  }, [course_id, course_name]);


  const renderComponent = () => {
    switch (selectedComponent) {
      case "InstructorAnalytics":
        return (
          <InstructorAnalytics courseId={courseId} course_id={course_id} />
        );
      case "InstructorEditCourse":
        return <InstructorModules courseId={courseId} course_id={course_id}/>;
      case "PromptSettings":
        return <PromptSettings courseName={courseName} course_id={course_id} />;
      case "ViewStudents":
        return <ViewStudents courseId={courseId} />;
      case "ChatLogs":
        return <ChatLogs courseName={courseName} course_id={course_id} openWebSocket={openWebSocket} />;
      default:
        return (
          <InstructorAnalytics courseId={courseId} course_id={course_id} />
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

export default CourseDetails;
