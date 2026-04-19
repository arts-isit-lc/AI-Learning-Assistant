import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
// MUI
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Divider,
  Box,
  Badge,
} from "@mui/material";
import HomeIcon from "@mui/icons-material/Home";
import ViewTimelineIcon from "@mui/icons-material/ViewTimeline";
import EditIcon from "@mui/icons-material/Edit";
import PsychologyIcon from "@mui/icons-material/Psychology";
import GroupIcon from "@mui/icons-material/Group";
import DescriptionIcon from "@mui/icons-material/Description";
import { useNotification } from "../../context/NotificationContext";

const InstructorSidebar = ({ setSelectedComponent, course_id, selectedComponent }) => {
  const navigate = useNavigate();
  const { notifications, setNotificationForCourse } = useNotification();

  const handleNavigation = (component) => {
    if (component === "InstructorAllCourses") {
      navigate("/home"); 
    } else {
      setSelectedComponent(component);
      if (component === "ChatLogs") {
        setNotificationForCourse(course_id, false);
      }
    }
  };

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: 220,
        flexShrink: 0,
        [`& .MuiDrawer-paper`]: { width: 220, boxSizing: "border-box" },
        bgcolor: "background",
      }}
    >
      <Box sx={{ overflow: "auto", paddingTop: 10 }}>
        <List>
          <ListItemButton onClick={() => handleNavigation("InstructorAllCourses")}>
            <ListItemIcon>
              <HomeIcon />
            </ListItemIcon>
            <ListItemText primary="All Courses" />
          </ListItemButton>
          <Divider />
          <ListItemButton onClick={() => handleNavigation("InstructorAnalytics")}>
            <ListItemIcon>
              <ViewTimelineIcon />
            </ListItemIcon>
            <ListItemText primary="Analytics" />
          </ListItemButton>
          <Divider />
          <ListItemButton onClick={() => handleNavigation("InstructorEditConcepts")}>
            <ListItemIcon>
              <EditIcon />
            </ListItemIcon>
            <ListItemText primary="Edit Concepts" />
          </ListItemButton>
          <Divider />
          <ListItemButton onClick={() => handleNavigation("InstructorEditCourse")}>
            <ListItemIcon>
              <EditIcon />
            </ListItemIcon>
            <ListItemText primary="Edit Modules" />
          </ListItemButton>
          <Divider />
          <ListItemButton onClick={() => handleNavigation("PromptSettings")}>
            <ListItemIcon>
              <PsychologyIcon />
            </ListItemIcon>
            <ListItemText primary="Settings" />
          </ListItemButton>
          <Divider />
          <ListItemButton onClick={() => handleNavigation("ViewStudents")}>
            <ListItemIcon>
              <GroupIcon />
            </ListItemIcon>
            <ListItemText primary="View Students" />
          </ListItemButton>
          <Divider />
          <ListItemButton onClick={() => handleNavigation("ChatLogs")}>
            <ListItemIcon>
              <Badge
                color="error"
                variant="dot"
                invisible={!notifications[course_id] || selectedComponent === "ChatLogs"}
              >
                <DescriptionIcon />
              </Badge>
            </ListItemIcon>
            <ListItemText primary="Chat History" />
          </ListItemButton>
        </List>
      </Box>
    </Drawer>
  );
};

export default InstructorSidebar;