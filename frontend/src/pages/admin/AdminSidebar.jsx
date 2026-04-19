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
} from "@mui/material";
import SchoolIcon from "@mui/icons-material/School";
import LibraryBooksIcon from "@mui/icons-material/LibraryBooks";
import CreateIcon from "@mui/icons-material/Create";

const AdminSidebar = ({
  setSelectedComponent,
  setSelectedInstructor,
  setSelectedCourse,
}) => {
  return (
    <Drawer
      variant="permanent"
      sx={{
        width: 220,
        flexShrink: 0,
        [`& .MuiDrawer-paper`]: { width: 220, boxSizing: "border-box" },
        bgcolor: "#F8F9FD",
      }}
    >
      <Box sx={{ overflow: "auto", paddingTop: 10 }}>
        <List>
          <ListItemButton
            onClick={() => {
              setSelectedInstructor(null);
              setSelectedCourse(null);
              setSelectedComponent("AdminInstructors");
            }}
          >
            <ListItemIcon>
              <SchoolIcon />
            </ListItemIcon>
            <ListItemText primary="Instructors" />
          </ListItemButton>
          <Divider />
          <ListItemButton
            onClick={() => {
              setSelectedInstructor(null);
              setSelectedCourse(null);
              setSelectedComponent("AdminCourses");
            }}
          >
            <ListItemIcon>
              <LibraryBooksIcon />
            </ListItemIcon>
            <ListItemText primary="Courses" />
          </ListItemButton>
          <Divider />
          <ListItemButton
            onClick={() => {
              setSelectedInstructor(null);
              setSelectedCourse(null);
              setSelectedComponent("AdminCreateCourse");
            }}
          >
            <ListItemIcon>
              <CreateIcon />
            </ListItemIcon>
            <ListItemText primary="Create Course" />
          </ListItemButton>
        </List>
      </Box>
    </Drawer>
  );
};

export default AdminSidebar;
