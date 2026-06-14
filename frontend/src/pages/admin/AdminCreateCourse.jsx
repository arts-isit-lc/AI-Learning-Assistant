import { useState, useEffect } from "react";
import {
  TextField,
  Button,
  MenuItem,
  Select,
  InputLabel,
  FormControl,
  Box,
  Chip,
  Typography,
  OutlinedInput,
  FormControlLabel,
  Switch,
  Paper,
  Toolbar,
  Autocomplete,
} from "@mui/material";
import { toast } from "react-toastify";
import apiClient from "../../services/api";

const CHARACTER_LIMIT = 1000;

function generateAccessCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 16; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Format the code into the pattern XXXX-XXXX-XXXX-XXXX
  return code.match(/.{1,4}/g).join("-");
}

function formatInstructors(instructorsArray) {
  return instructorsArray.map((instructor, index) => ({
    id: index + 1,
    name:
      instructor.first_name && instructor.last_name
        ? `${instructor.first_name} ${instructor.last_name}`
        : instructor.user_email,
    email: instructor.user_email,
  }));
}

export const AdminCreateCourse = ({ setSelectedComponent }) => {
  const [courseName, setCourseName] = useState("");
  //Original course level prompt: Engage with the student by asking questions and conversing with them to identify any gaps in their understanding of the topic. If you identify gaps, address these gaps by providing explanations, answering the student's questions, and referring to the relevant context to help the student gain a comprehensive understanding of the topic.
  const [coursePrompt, setCoursePrompt] = useState(
      `Engage with the student through questions and conversation to identify gaps in their understanding. Address those gaps with targeted explanations, answers to their questions, and references to the relevant course materials. Focus only on concepts needed to resolve the identified misunderstandings rather than providing broad summaries.`
  );
  const [courseDepartment, setCourseDepartment] = useState("");
  const [courseCode, setCourseCode] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [selectedInstructors, setSelectedInstructors] = useState([]);
  const [instructors, setInstructors] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const handleStatusChange = (event) => {
    setIsActive(event.target.checked);
  };

  const handleCourseCodeChange = (e) => {
    const value = e.target.value;
    if (/^\d*$/.test(value)) {
      // This regex ensures only digits
      setCourseCode(value);
    }
  };
  useEffect(() => {
    const fetchInstructors = async () => {
      try {
        const data = await apiClient.get("admin/instructors", { instructor_email: "replace" });
        setInstructors(formatInstructors(data));
      } catch (error) {
        console.error("Error fetching instructors:", error.message);
      }
    };

    fetchInstructors();
  }, []);
  const handleCreate = async () => {
    const access_code = generateAccessCode();
    // Handle the create course logic here
    try {
      const numericCourseCode = Number(courseCode);

      if (isNaN(numericCourseCode)) {
        toast.error("access code must be a number");
        return;
      }

      const data = await apiClient.post(
        "admin/create_course",
        {
          course_name: courseName,
          course_department: courseDepartment,
          course_number: courseCode,
          course_access_code: access_code,
          course_student_access: isActive,
        },
        { system_prompt: coursePrompt }
      );

      const { course_id } = data;   
      const enrollPromises = selectedInstructors.map((instructor) =>
        apiClient.postRaw(
          "admin/enroll_instructor",
          { course_id, instructor_email: instructor.email }
        ).then((enrollResponse) => {
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

      if (allEnrolledSuccessfully || selectedInstructors.length === 0) {
        toast.success("🦄 Course Created!");
        setTimeout(() => {
          setSelectedComponent("AdminCourses");
        }, 1000);
      } else {
        toast.error("Some instructors could not be enrolled");
      }
    } catch (error) {
      console.error("Error creating course:", error.message);
      toast.error("Course Creation Failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleChange = (event, newValue) => {
    setSelectedInstructors(newValue);
  };
  return (
    <Box
      component="main"
      sx={{
        width: "100%",
        overflowY: "auto",
        flexGrow: 1,
        p: 2,
        marginTop: 0.5,
        marginBottom: 1,
      }}
    >
      <Toolbar />
      <Paper
        sx={{
          maxWidth: "800px",
          overflow: "hidden",
          marginTop: 1,
          marginBottom: 1,
          p: 4,
          borderRadius: 2,
        }}
      >
        <Typography
          color="black"
          fontStyle="semibold"
          textAlign="left"
          variant="h6"
        >
          Create a new course
        </Typography>
        <form noValidate autoComplete="off">
          <TextField
            fullWidth
            label="Course Name"
            value={courseName}
            onChange={(e) => setCourseName(e.target.value)}
            margin="normal"
            backgroundColor="default"
            inputProps={{ maxLength: 50 }}
          />
          <TextField
            fullWidth
            label="System Prompt"
            value={coursePrompt}
            onChange={(e) => setCoursePrompt(e.target.value)}
            margin="normal"
            multiline
            rows={4}
            inputProps={{ maxLength: 1000 }}
            helperText={`${coursePrompt.length}/${CHARACTER_LIMIT}`}
          />
          <TextField
            fullWidth
            label="Course Department"
            value={courseDepartment}
            onChange={(e) => setCourseDepartment(e.target.value)}
            margin="normal"
            backgroundColor="default"
            inputProps={{ maxLength: 20 }}
          />
          <TextField
            fullWidth
            label="Course Code (Numbers Only)"
            value={courseCode}
            onChange={handleCourseCodeChange}
            margin="normal"
            backgroundColor="default"
            inputProps={{ maxLength: 10, min: 0, step: 1 }}
          />
          <FormControl fullWidth sx={{ marginBottom: 2, marginTop: 2 }}>
            <Autocomplete
              multiple
              id="autocomplete-instructors"
              options={instructors}
              getOptionLabel={(option) => option.name}
              value={selectedInstructors}
              onChange={handleChange}
              isOptionEqualToValue={(option, value) =>
                option.email === value.email
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  variant="outlined"
                  label="Assign Instructors"
                  placeholder="Search instructors"
                />
              )}
              renderTags={(tags, getTagProps) => (
                <Box
                  sx={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 0.5,
                  }}
                >
                  {tags.map((tag, index) => (
                    <Chip
                      key={tag.email}
                      label={tag.name}
                      {...getTagProps({ index })}
                    />
                  ))}
                </Box>
              )}
              filterSelectedOptions
            />
          </FormControl>
          <FormControlLabel
            control={
              <Switch checked={isActive} onChange={handleStatusChange} />
            }
            label={isActive ? "Active" : "Inactive"}
            sx={{
              color: "black",
              textAlign: "left",
              justifyContent: "flex-start",
            }}
          />
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 0.5,
              backgroundColor: "transparent",
              color: "black",
            }}
          >
            {selectedInstructors.map((instructor) => (
              <Chip key={instructor.email} label={instructor.name} />
            ))}
          </Box>
          <Button
            variant="contained"
            color="primary"
            onClick={() => {
              if (!submitting) {
                setSubmitting(true);
                handleCreate();
              }
            }}
            fullWidth
            sx={{ mt: 2 }}
          >
            CREATE
          </Button>
        </form>
      </Paper>
    </Box>
  );
};
export default AdminCreateCourse;
