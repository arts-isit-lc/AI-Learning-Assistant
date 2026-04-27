import { useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "react-toastify";
import apiClient from "../../services/api";
import { TextField, Button, Paper, Typography, Grid, Box } from "@mui/material";
import PageContainer from "../Container";
const InstructorNewConcept = () => {
  const [conceptName, setConceptName] = useState("");
  const location = useLocation();
  const { data, course_id } = location.state || {};
  const [nextConceptNumber, setNextConceptNumber] = useState(data.length + 1);

  const handleBackClick = () => {
    window.history.back();
  };

  const handleInputChange = (e) => {
    setConceptName(e.target.value);
  };

  const handleSave = async () => {
    if (!conceptName.trim()) {
      toast.error("Concept Name is required.");
      return;
    }
    try {
      const data = await apiClient.post(
        "instructor/create_concept",
        { course_id, concept_number: nextConceptNumber },
        { concept_name: conceptName }
      );
      toast.success("Concept Created Successfully");
      setTimeout(function () {
        handleBackClick();
      }, 1000);
    } catch (error) {
      console.error("Error saving changes:", error.message);
      toast.error("Concept Creation Failed");
    }
    setNextConceptNumber(nextConceptNumber + 1);
  };
  return (
    <PageContainer>
      <Paper style={{ padding: 25, width: "100%", overflow: "auto" }}>
        <Typography variant="h6">Create Concept </Typography>

        <TextField
          label="Concept Name"
          name="name"
          value={conceptName}
          onChange={handleInputChange}
          fullWidth
          margin="normal"
          inputProps={{ maxLength: 50 }}
        />

        <Box sx={{ display: "flex", justifyContent: "space-between", marginTop: 2, width: '100%' }}>
          <Button
            variant="contained"
            color="primary"
            onClick={handleBackClick}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={handleSave}
          >
            Save
          </Button>
        </Box>
      </Paper>
    </PageContainer>
  );
};

export default InstructorNewConcept;
