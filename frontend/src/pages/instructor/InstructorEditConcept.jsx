import React, { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "react-toastify";
import apiClient from "../../services/api";

import {
  TextField,
  Button,
  Paper,
  Typography,
  Grid,
  Box,
  Dialog,
  DialogTitle,
  DialogActions,
  DialogContent,
  DialogContentText
} from "@mui/material";
import PageContainer from "../Container";
import { titleCase } from "../../utils/formatters";

const InstructorEditConcept = () => {
  const location = useLocation();
  const { conceptData, course_id } = location.state || {};
  const [conceptName, setConceptName] = useState(conceptData.concept_name);
  const [data, setData] = useState([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => {
    const fetchModules = async () => {
      try {
        const moduleData = await apiClient.get("instructor/view_modules", { course_id });
        const filteredData = moduleData.filter(
          (module) => module.concept_name === conceptData.concept_name
        );
        setData(filteredData);
      } catch (error) {
        console.error("Error fetching modules:", error.message);
      }
    };
    fetchModules();
  }, [course_id]);
  const handleBackClick = () => {
    window.history.back();
  };

  const handleDeleteConfirmation = () => {
    setDialogOpen(true);
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
  };

  const handleConfirmDelete = async () => {
    setDialogOpen(false);
    handleDelete();
  };

  const handleDelete = async () => {
    const deletePromises = data.map((module) =>
      apiClient.deleteRaw(
        "instructor/delete_module_s3",
        { course_id, module_id: module.module_id, module_name: module.module_name }
      )
    );

    // Execute all delete requests concurrently
    await Promise.all(deletePromises);
    try {
      await apiClient.delete("instructor/delete_concept", { concept_id: conceptData.concept_id });
      toast.success("Successfully Deleted");
      setTimeout(function () {
        handleBackClick();
      }, 1000);
    } catch (error) {
      console.error("Failed to delete concept");
      toast.error("Failed to delete concept");
    }
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
      await apiClient.put(
        "instructor/edit_concept",
        { concept_id: conceptData.concept_id, concept_number: conceptData.concept_number },
        { concept_name: conceptName }
      );
      toast.success("Successfully Updated Concept");
      setTimeout(function () {
        handleBackClick();
      }, 1000);
    } catch (error) {
      console.error("Failed to update concept");
      toast.error("Failed to update concept");
    }
  };
  return (
    <PageContainer>
      <Paper style={{ padding: 25, width: "100%", overflow: "auto" }}>
        <Typography variant="h6">
          Edit Concept {titleCase(conceptData.concept_name)}{" "}
        </Typography>

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
          <Box sx={{ display: "flex", gap: 2 }}>
            <Button
              variant="contained"
              color="primary"
              onClick={handleBackClick}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="error"
              onClick={handleDeleteConfirmation}
            >
              Delete
            </Button>
          </Box>
          <Button
            variant="contained"
            color="primary"
            onClick={handleSave}
          >
            Save
          </Button>
        </Box>
      </Paper>
      <Dialog open={dialogOpen} onClose={handleDialogClose}>
        <DialogTitle>{"Delete Concept"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete this concept and all its associated
            modules? This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDialogClose} color="primary">
            Cancel
          </Button>
          <Button onClick={handleConfirmDelete} color="error">
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </PageContainer>
  );
};

export default InstructorEditConcept;
