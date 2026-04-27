import { useEffect, useState } from "react";
import apiClient from "../../services/api";

import {
  Typography,
  Box,
  Toolbar,
  Paper,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  OutlinedInput,
  Chip,
  Grid,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  DialogContentText,
  Autocomplete,
  TextField
} from "@mui/material";

import { toast } from "react-toastify";
import { titleCase } from "../../utils/formatters";

const MenuProps = {
  slotProps: {
    paper: {
      style: {
        maxHeight: 200,
        overflowY: "auto",
      },
    },
  },
};

const InstructorDetails = ({ instructorData, onBack }) => {
  const instructor = instructorData;
  const [activeCourses, setActiveCourses] = useState([]);
  const [allCourses, setAllCourses] = useState([]);
  const [courseLoading, setCourseLoading] = useState(true);
  const [activeCourseLoading, setActiveCourseLoading] = useState(true);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  useEffect(() => {
    const fetchCourses = async () => {
      try {
        const data = await apiClient.get("admin/courses");
        setAllCourses(data);
        setCourseLoading(false);
      } catch (error) {
        console.error("Error fetching courses:", error.message);
      }
    };

    const fetchActiveCourses = async () => {
      try {
        const data = await apiClient.get("admin/instructorCourses", {
          instructor_email: instructorData.email,
        });
        setActiveCourses(data);
        setActiveCourseLoading(false);
      } catch (error) {
        console.error("Error fetching courses:", error.message);
      }
    };
    fetchActiveCourses();
    fetchCourses();
  }, []);

  if (!instructor) {
    return <Typography>No data found for this instructor.</Typography>;
  }
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

  const handleCoursesChange = (event) => {
    const newCourses = event.target.value;
    // Filter out duplicates
    const uniqueCourses = Array.from(
      new Map(newCourses.map((course) => [course.course_id, course])).values()
    );
    setActiveCourses(uniqueCourses);
  };

  const handleDelete = async () => {
    try {
      const data = await apiClient.post("admin/lower_instructor", { email: instructorData.email });
      toast.success("Instructor Demoted Successfully");
      setTimeout(function () {
        onBack();
      }, 1000);
    } catch (error) {
      console.error("Error demoting instructor:", error.message);
    }
  };

  const handleSave = async () => {
    try {
      await apiClient.delete("admin/delete_instructor_enrolments", {
        instructor_email: instructor.email,
      });

      // Enroll instructor in multiple courses in parallel
      const enrollPromises = activeCourses.map((course) =>
        apiClient.postRaw("admin/enroll_instructor", {
          course_id: course.course_id,
          instructor_email: instructor.email,
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

      if (allEnrolledSuccessfully) {
        toast.success("🦄 Enrolment Updated!");
      } else {
        toast.error("Some enrolments failed");
      }
    } catch (error) {
      console.error("Error in handleSave:", error.message);
      toast.error("An error occurred");
    }
  };

  return (
    <>
      <Box
        component="main"
        sx={{ flexGrow: 1, p: 3, marginTop: 1, textAlign: "left" }}
      >
        <Toolbar />
        <Paper sx={{ p: 2, marginBottom: 4, textAlign: "left" }}>
          <Typography variant="h5" sx={{ marginBottom: 2, p: 1 }}>
            Instructor: {titleCase(instructorData.user)}
          </Typography>
          <Divider sx={{ p: 1, marginBottom: 3 }} />
          <Typography variant="h7" sx={{ marginBottom: 1, p: 1 }}>
            Email: {instructorData.email}
          </Typography>
          <FormControl sx={{ width: "100%", marginBottom: 2, marginTop: 5 }}>
            <Autocomplete
              multiple
              id="active-courses-autocomplete"
              options={allCourses}
              value={activeCourses}
              onChange={(event, newValue) => {
                // Filter out duplicates
                const uniqueCourses = Array.from(
                  new Map(
                    newValue.map((course) => [course.course_id, course])
                  ).values()
                );
                setActiveCourses(uniqueCourses);
              }}
              getOptionLabel={(option) =>
                `${option.course_department.toUpperCase()} ${
                  option.course_number
                }`
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Active Courses"
                  variant="outlined"
                />
              )}
              isOptionEqualToValue={(option, value) =>
                option.course_id === value.course_id
              }
            />
          </FormControl>
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
              color="error"
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
          <DialogTitle id="alert-dialog-title">{"Confirm Delete"}</DialogTitle>
          <DialogContent>
            <DialogContentText id="alert-dialog-description">
              Are you sure you want to delete this instructor? This action
              cannot be undone.
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
    </>
  );
};

export default InstructorDetails;
