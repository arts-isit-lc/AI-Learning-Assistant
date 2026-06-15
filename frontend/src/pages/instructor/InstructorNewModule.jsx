import { useState, useEffect } from "react";
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
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  ListSubheader,
  Alert,
  Chip,
  CircularProgress,
} from "@mui/material";
import PageContainer from "../Container";
import FileManagement from "../../components/FileManagement";
import { titleCase } from "../../utils/formatters";
import { cleanFileName, removeFileExtension, getFileType } from "../../utils/fileHelpers";


export const InstructorNewModule = ({ courseId }) => {
  const [files, setFiles] = useState([]);
  const [newFiles, setNewFiles] = useState([]);
  const [savedFiles, setSavedFiles] = useState([]);
  const [deletedFiles, setDeletedFiles] = useState([]);
  const [metadata, setMetadata] = useState({});

  const [isSaving, setIsSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [moduleName, setModuleName] = useState("");
  const [modulePrompt, setModulePrompt] = useState("");
  const [concept, setConcept] = useState("");
  const [allConcepts, setAllConcept] = useState([]);
  const location = useLocation();
  const { data, course_id } = location.state || {};
  const [nextModuleNumber, setNextModuleNumber] = useState(data.length + 1);
  const [referencedFileIds, setReferencedFileIds] = useState([]);
  const [courseFiles, setCourseFiles] = useState([]);

  // Prompt conflict validation state
  const [conflictReport, setConflictReport] = useState(null);
  const [isValidating, setIsValidating] = useState(false);

  const handleBackClick = () => {
    window.history.back();
  };

  useEffect(() => {
    const fetchCourseFiles = async () => {
      try {
        const data = await apiClient.get("instructor/course_files", { course_id });
        setCourseFiles(data);
      } catch (error) {
        console.error("Error fetching course files:", error.message);
      }
    };
    fetchCourseFiles();
  }, [course_id]);

  useEffect(() => {
    const fetchConcepts = async () => {
      try {
        const conceptData = await apiClient.get("instructor/view_concepts", { course_id });
        setAllConcept(conceptData);
      } catch (error) {
        console.error("Error fetching courses:", error.message);
      }
    };
    fetchConcepts();
  }, [courseId]);

  const handleInputChange = (e) => {
    setModuleName(e.target.value);
  };

  const handleConceptInputChange = (e) => {
    setConcept(e.target.value);
  };
  const uploadFiles = async (newFiles, token, moduleid) => {
    const newFilePromises = newFiles.map((file) => {
      const fileType = getFileType(file.name);
      const fileName = cleanFileName(removeFileExtension(file.name));
      return apiClient.get("instructor/generate_presigned_url", {
        course_id,
        module_id: moduleid,
        module_name: moduleName,
        file_type: fileType,
        file_name: fileName,
      })
        .then((presignedUrl) => {
          return fetch(presignedUrl.presignedurl, {
            method: "PUT",
            headers: {
              "Content-Type": file.type,
            },
            body: file,
          });
        });
    });

    return await Promise.all(newFilePromises);
  };

  const handleSave = async () => {
    if (isSaving) return;

    // Validation check
    if (!moduleName || !concept) {
      toast.error("Module Name and Concept are required.", { autoClose: 2000 });
      return;
    }

    // Check if at least one file is uploaded
    if (newFiles.length === 0) {
      toast.error("At least one file must be uploaded.", { autoClose: 2000 });
      return;
    }


    setIsSaving(true);

    const selectedConcept = allConcepts.find((c) => c.concept_name === concept);
    try {
      const { email } = await apiClient.getAuth();
      const updatedModule = await apiClient.post(
        "instructor/create_module",
        {
          course_id,
          concept_id: selectedConcept.concept_id,
          module_name: moduleName,
          module_number: nextModuleNumber,
          instructor_email: email,
        },
        { module_prompt: modulePrompt }
      );

      await uploadFiles(newFiles, null, updatedModule.module_id);

      await apiClient.put(
        "instructor/module_file_references",
        { module_id: updatedModule.module_id },
        { referenced_file_ids: referencedFileIds }
      );

      setDeletedFiles([]);
      setNewFiles([]);
      toast.success("Module Created Successfully");

      // Run prompt conflict validation after create (awaited to keep page alive)
      if (modulePrompt && modulePrompt.trim()) {
        setIsSaving(false);
        await validateModulePrompt(updatedModule.module_id);
      } else {
        setIsSaving(false);
        setNextModuleNumber(nextModuleNumber + 1);
        setTimeout(function () {
          handleBackClick();
        }, 1000);
      }
    } catch (error) {
      console.error("Error saving changes:", error.message);
      toast.error("Module Creation Failed");
      setIsSaving(false);
    }
  };

  const validateModulePrompt = async (moduleId) => {
    setIsValidating(true);
    setConflictReport(null);
    try {
      const { email } = await apiClient.getAuth();
      const data = await apiClient.post(
        "instructor/validate_prompt",
        { course_id, instructor_email: email },
        { prompt: modulePrompt, scope: "module", module_id: moduleId }
      );
      // Filter to only module-related conflicts
      const moduleConflicts = (data.conflicts || []).filter(
        (c) => (c.prompt_a_source && c.prompt_a_source.startsWith("module_prompt")) ||
               (c.prompt_b_source && c.prompt_b_source.startsWith("module_prompt"))
      );
      const filteredReport = { ...data, conflicts: moduleConflicts, has_conflicts: moduleConflicts.length > 0 };
      setConflictReport(filteredReport);
      if (!filteredReport.has_conflicts) {
        setTimeout(() => {
          handleBackClick();
        }, 1500);
      }
    } catch (error) {
      console.error("Prompt validation failed:", error.message);
      setTimeout(() => {
        handleBackClick();
      }, 1000);
    } finally {
      setIsValidating(false);
    }
  };

  const getConflictTypeColor = (type) => {
    if (type === "HARD_CONTRADICTION") return "error";
    return "warning";
  };

  return (
    <PageContainer>
      <Paper style={{ padding: 25, width: "100%", overflow: "auto" }}>
        <Typography variant="h6">New Module </Typography>

        <TextField
          label="Module Name"
          name="name"
          value={moduleName}
          onChange={handleInputChange}
          fullWidth
          margin="normal"
          inputProps={{ maxLength: 50 }}
        />

        <TextField
          label="Module Prompt (Optional)"
          name="modulePrompt"
          value={modulePrompt}
          onChange={(e) => setModulePrompt(e.target.value)}
          fullWidth
          margin="normal"
          multiline
          rows={4}
          helperText="Provide specific instructions for this module. This will be used alongside the course-level prompt."
        />

        <FormControl fullWidth margin="normal">
          <InputLabel id="concept-select-label">Concept</InputLabel>
          <Select
            labelId="concept-select-label"
            id="concept-select"
            value={concept}
            onChange={handleConceptInputChange}
            label="Concept"
            sx={{ textAlign: "left" }}
          >
            {allConcepts.map((concept) => (
              <MenuItem key={concept.concept_id} value={concept.concept_name}>
                {titleCase(concept.concept_name)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl fullWidth margin="normal">
          <InputLabel id="referenced-files-label">Reference Files from Other Modules (Optional)</InputLabel>
          <Select
            labelId="referenced-files-label"
            multiple
            value={referencedFileIds}
            onChange={(e) => setReferencedFileIds(e.target.value)}
            label="Reference Files from Other Modules (Optional)"
            renderValue={(selected) =>
              selected.map(id => {
                const f = courseFiles.find(f => f.file_id === id);
                return f ? `${f.filename}.${f.filetype}` : id;
              }).join(", ")
            }
          >
            {Object.entries(
              courseFiles.reduce((groups, file) => {
                (groups[file.module_name] = groups[file.module_name] || []).push(file);
                return groups;
              }, {})
            ).map(([moduleName, files]) => [
              <ListSubheader key={moduleName}>{titleCase(moduleName)}</ListSubheader>,
              ...files.map(file => (
                <MenuItem key={file.file_id} value={file.file_id}>
                  {file.filename}.{file.filetype}
                </MenuItem>
              ))
            ])}
          </Select>
        </FormControl>

        <FileManagement
          newFiles={newFiles}
          setNewFiles={setNewFiles}
          files={files}
          setFiles={setFiles}
          setDeletedFiles={setDeletedFiles}
          savedFiles={savedFiles}
          setSavedFiles={setSavedFiles}
          loading={loading}
          metadata={metadata}
          setMetadata={setMetadata}
        />

        {/* Generate Topics - disabled on new module (needs save first) */}
        <Box sx={{ marginTop: 3, marginBottom: 2 }}>
          <Button
            variant="contained"
            color="secondary"
            disabled
          >
            Generate Topics
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", marginTop: 0.5 }}>
            Save the module first, then generate topics from the edit page.
          </Typography>
        </Box>

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
            Save Module
          </Button>
        </Box>

        {/* Prompt Conflict Validation Results */}
        {isValidating && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 2 }}>
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">
              Checking module prompt for conflicts...
            </Typography>
          </Box>
        )}

        {conflictReport && conflictReport.validation_status === "clean" && (
          <Alert severity="success" sx={{ mt: 2 }}>
            No conflicts detected. Module prompt is compatible with system and course prompts.
          </Alert>
        )}

        {conflictReport && conflictReport.has_conflicts && (
          <Box sx={{ mt: 2 }}>
            <Alert severity="warning" variant="filled" sx={{ mb: 2 }}>
              {conflictReport.conflicts.length} conflict(s) detected between this module prompt and the system/course prompts.
              The module was created, but you may want to revise the prompt.
            </Alert>
            {conflictReport.conflicts.map((conflict, idx) => {
              const otherSource = conflict.prompt_a_source.startsWith("module_prompt")
                ? conflict.prompt_b_source
                : conflict.prompt_a_source;
              const formattedSource = otherSource
                .replace(/_/g, " ")
                .replace("system level prompt", "System Prompt")
                .replace("course prompt", "Course Prompt");

              return (
                <Box
                  key={idx}
                  sx={{
                    mb: 1.5,
                    p: 1.5,
                    border: "1px solid",
                    borderColor: conflict.type === "HARD_CONTRADICTION" ? "error.light" : "warning.light",
                    borderRadius: 1,
                    backgroundColor: conflict.type === "HARD_CONTRADICTION" ? "rgba(211, 47, 47, 0.04)" : "rgba(237, 108, 2, 0.04)",
                  }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
                    <Chip
                      label={conflict.type.replace(/_/g, " ")}
                      size="small"
                      color={getConflictTypeColor(conflict.type)}
                    />
                    <Typography variant="caption" color="text.secondary">
                      Conflicts with: <strong>{formattedSource}</strong>
                    </Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {conflict.explanation}
                  </Typography>
                </Box>
              );
            })}
            <Button
              variant="outlined"
              size="small"
              onClick={handleBackClick}
              sx={{ mt: 1 }}
            >
              Dismiss and go back
            </Button>
          </Box>
        )}
      </Paper>
    </PageContainer>
  );
};

export default InstructorNewModule;
