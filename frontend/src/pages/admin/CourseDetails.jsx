import { useEffect, useState } from "react";
import apiClient from "../../services/api";

import {
  Box,
  Button,
  Chip,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  OutlinedInput,
  Select,
  Switch,
  Typography,
  Paper,
  FormControlLabel,
  Toolbar,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  DialogContentText,
  Autocomplete,
  TextField,
} from "@mui/material";

import { toast } from "react-toastify";
import { titleCase } from "../../utils/formatters";

const CourseDetails = ({ course, onBack }) => {
  const courseStatus = JSON.parse(course.status);
  const [activeInstructors, setActiveInstructors] = useState([]);
  const [isActive, setIsActive] = useState(courseStatus);
  const [loading, setLoading] = useState(true);
  const [allInstructors, setAllInstructors] = useState([]);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  useEffect(() => {
    const fetchActiveInstructors = async () => {
      try {
        const data = await apiClient.get("admin/courseInstructors", { course_id: course.id });
        setActiveInstructors(data);
      } catch (error) {
        console.error("Error fetching courses:", error.message);
      }
    };
    const fetchInstructors = async () => {
      try {
        const data = await apiClient.get("admin/instructors", { instructor_email: "replace" });
        setAllInstructors(data);
      } catch (error) {
        console.error("Error fetching courses:", error.message);
      }
    };
    fetchActiveInstructors();
    fetchInstructors();
    setLoading(false);
  }, []);

  const handleConfirmDeleteOpen = () => {
    setConfirmDeleteOpen(true);
  };

  const handleConfirmDeleteClose = () => {
    setConfirmDeleteOpen(false);
  };

  const handleConfirmDelete = async () => {
    handleConfirmDeleteClose();
    handleDelete();
  };

  const handleInstructorsChange = (event, newValue) => {
    // Filter out duplicates
    const uniqueInstructors = Array.from(
      new Map(
        newValue.map((instructor) => [instructor.user_email, instructor])
      ).values()
    );
    setActiveInstructors(uniqueInstructors);
  };

  const handleStatusChange = (event) => {
    setIsActive(event.target.checked);
  };

  const handleDelete = async () => {
    try {
      await apiClient.delete("admin/delete_course", { course_id: course.id });
      toast.success("Course Successfully Deleted");
      setTimeout(function () {
        onBack();
      }, 1000);
    } catch (error) {
      console.error("Failed to delete course:", error.message);
      toast.error("update enrolment Failed");
    }
  };

  const handleSave = async () => {
    try {
      // Delete existing enrollments
      await apiClient.delete("admin/delete_course_instructor_enrolments", { course_id: course.id });

      // Enroll new instructors in parallel
      const enrollPromises = activeInstructors.map((instructor) =>
        apiClient.postRaw("admin/enroll_instructor", {
          course_id: course.id,
          instructor_email: instructor.user_email,
        }).then((enrollResponse) => {
          if (enrollResponse.ok) {
            return enrollResponse.json().then((enrollData) => {
              return { success: true };
            });
          } else {
            console.error(
              "Failed to enroll instructor:",
              enrollResponse.statusText
            );
            toast.error("Enroll Instructor Failed");
            return { success: false };
          }
        })
      );

      const enrollResults = await Promise.all(enrollPromises);
      const allEnrolledSuccessfully = enrollResults.every(
        (result) => result.success
      );

      if (!allEnrolledSuccessfully) {
        toast.error("Some instructors could not be enrolled");
      } else {
        toast.success("🦄 Enrolment Updated!");
      }

      // Update course access
      await apiClient.post("admin/updateCourseAccess", {
        course_id: course.id,
        access: isActive,
      });
    } catch (error) {
      console.error("Error in handleSave:", error.message);
      toast.error("An error occurred");
    }
  };

  return (
    <>
      {!loading && (
        <Box
          component="main"
          sx={{ flexGrow: 1, p: 3, marginTop: 1, textAlign: "left" }}
        >
          <Toolbar />
          <Paper sx={{ padding: 2, marginBottom: 2 }}>
            <Typography variant="h4" sx={{ marginBottom: 0 }}>
              {course.course}
            </Typography>
            <Divider sx={{ p: 1, marginBottom: 3 }} />
            <FormControl fullWidth sx={{ marginBottom: 2 }}>
              <Autocomplete
                multiple
                id="autocomplete-instructors"
                options={allInstructors}
                getOptionLabel={(option) =>
                  option.first_name && option.last_name
                    ? `${titleCase(option.first_name)} ${titleCase(
                        option.last_name
                      )}`
                    : option.user_email
                }
                value={activeInstructors}
                onChange={handleInstructorsChange}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Active Instructors"
                    variant="outlined"
                  />
                )}
                renderTags={(value, getTagProps) =>
                  value.map((option, index) => (
                    <Chip
                      label={option.user_email}
                      {...getTagProps({ index })}
                      key={option.user_email}
                    />
                  ))
                }
              />
            </FormControl>

            <FormControlLabel
              control={
                <Switch checked={isActive} onChange={handleStatusChange} />
              }
              label={isActive ? "Active" : "Inactive"}
            />
          </Paper>
          <Box sx={{ display: "flex", justifyContent: "space-between", width: '100%' }}>
            <Button
              variant="contained"
              onClick={onBack}
            >
              Back
            </Button>
            <Box sx={{ display: "flex", gap: 2 }}>
              <Button
                variant="contained"
                color="red"
                onClick={handleConfirmDeleteOpen}
              >
                Delete
              </Button>
              <Button
                variant="contained"
                color="primary"
                onClick={handleSave}
              >
                Save
              </Button>
            </Box>
          </Box>
          <Dialog
            open={confirmDeleteOpen}
            onClose={handleConfirmDeleteClose}
            aria-labelledby="alert-dialog-title"
            aria-describedby="alert-dialog-description"
          >
            <DialogTitle id="alert-dialog-title">
              {"Confirm Delete"}
            </DialogTitle>
            <DialogContent>
              <DialogContentText id="alert-dialog-description">
                Are you sure you want to delete this course? This action cannot
                be undone.
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={handleConfirmDeleteClose} color="primary">
                Cancel
              </Button>
              <Button onClick={handleConfirmDelete} color="error">
                Confirm
              </Button>
            </DialogActions>
          </Dialog>
        </Box>
      )}
    </>
  );
};

export default CourseDetails;
