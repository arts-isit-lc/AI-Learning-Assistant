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
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Alert,
  Chip,
  CircularProgress,
} from "@mui/material";
import PageContainer from "../Container";
import FileManagement from "../../components/FileManagement";
import { titleCase } from "../../utils/formatters";
import { cleanFileName, removeFileExtension, getFileType } from "../../utils/fileHelpers";

const InstructorEditCourse = () => {
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [metadata, setMetadata] = useState({});

  const [files, setFiles] = useState([]);
  const [newFiles, setNewFiles] = useState([]);
  const [savedFiles, setSavedFiles] = useState([]);
  const [deletedFiles, setDeletedFiles] = useState([]);

  const location = useLocation();
  const [module, setModule] = useState(null);
  const { moduleData, course_id } = location.state || {};
  const [moduleName, setModuleName] = useState("");
  const [modulePrompt, setModulePrompt] = useState("");
  const [concept, setConcept] = useState("");
  const [allConcepts, setAllConcept] = useState([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [referencedFileIds, setReferencedFileIds] = useState([]);
  const [courseFiles, setCourseFiles] = useState([]);
  const [isGeneratingTopics, setIsGeneratingTopics] = useState(false);
  const [moduleTopics, setModuleTopics] = useState(null);
  const [isTopicsStale, setIsTopicsStale] = useState(false);

  // Prompt conflict validation state
  const [conflictReport, setConflictReport] = useState(null);
  const [isValidating, setIsValidating] = useState(false);

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

  function convertDocumentFilesToArray(files) {
    const documentFiles = files.document_files;
    const resultArray = Object.entries({
      ...documentFiles,
    }).map(([fileName, fileData]) => ({
      fileName,
      url: fileData,
      hasTopics: !!(fileData.metadata && typeof fileData.metadata === 'object' && fileData.metadata.topic_extraction && fileData.metadata.topic_extraction.topics && fileData.metadata.topic_extraction.topics.length > 0),
      file_id: fileData.metadata && typeof fileData.metadata === 'object' ? fileData.metadata.file_id : null,
      topic_etag: fileData.metadata && typeof fileData.metadata === 'object' && fileData.metadata.topic_extraction ? fileData.metadata.topic_extraction.s3_etag : null,
    }));

    // For the description field, extract only the user-editable description
    // (not the topic_extraction data which is system-managed)
    const metadataDescriptions = resultArray.reduce((acc, { fileName, url }) => {
      let rawMeta = url.metadata;

      // Handle case where metadata is a JSON string (legacy TEXT column or serialization)
      if (rawMeta && typeof rawMeta === 'string') {
        try {
          const parsed = JSON.parse(rawMeta);
          if (typeof parsed === 'object' && parsed !== null) {
            rawMeta = parsed;
          }
        } catch {
          // Not valid JSON — treat as plain text description
          acc[fileName] = rawMeta;
          return acc;
        }
      }

      if (rawMeta && typeof rawMeta === 'object') {
        // JSONB object — use the 'description' field (if any), ignore topic_extraction
        acc[fileName] = rawMeta.description || "";
      } else {
        acc[fileName] = rawMeta || "";
      }
      return acc;
    }, {});

    setMetadata(metadataDescriptions);
    return resultArray;
  }

  const fetchFiles = async () => {
    try {
      const fileData = await apiClient.get("instructor/get_all_files", {
        course_id,
        module_id: module.module_id,
        module_name: moduleName,
      });
      setFiles(convertDocumentFilesToArray(fileData));
    } catch (error) {
      console.error("Error fetching Files:", error.message);
    }
    setLoading(false);
  };

  const fetchConcepts = async () => {
    try {
      const conceptData = await apiClient.get("instructor/view_concepts", { course_id });
      setAllConcept(conceptData);
    } catch (error) {
      console.error("Error fetching courses:", error.message);
    }
  };
  useEffect(() => {
    if (moduleData) {
      setModule(moduleData);
      setModuleName(moduleData.module_name);
      setModulePrompt(moduleData.module_prompt || "");
      setConcept(moduleData.concept_name);
      // Load existing generated topics if available
      if (moduleData.generated_topics) {
        setModuleTopics(moduleData.generated_topics);
      }
    }
    fetchConcepts();
  }, [moduleData]);

  // Check staleness when files or moduleTopics change
  useEffect(() => {
    if (!moduleTopics || !moduleTopics.source_file_ids) {
      setIsTopicsStale(false);
      return;
    }
    const currentFileIds = files.map(f => f.file_id).filter(Boolean).sort();
    const sourceFileIds = [...(moduleTopics.source_file_ids || [])].sort();
    const idsMatch = JSON.stringify(currentFileIds) === JSON.stringify(sourceFileIds);

    if (!idsMatch) {
      setIsTopicsStale(true);
      return;
    }

    // Check ETags if available
    if (moduleTopics.source_file_etags) {
      const hasEtagMismatch = files.some(f => {
        if (!f.file_id || !f.topic_etag) return false;
        const storedEtag = moduleTopics.source_file_etags[f.file_id];
        return storedEtag && storedEtag !== f.topic_etag;
      });
      setIsTopicsStale(hasEtagMismatch);
    } else {
      setIsTopicsStale(false);
    }
  }, [files, moduleTopics]);

  const handleGenerateTopics = async () => {
    setIsGeneratingTopics(true);
    try {
      const result = await apiClient.post("instructor/generate_topics", {
        module_id: module.module_id,
      });

      if (result.status === "processing") {
        toast.info(
          `Topic extraction is still processing (${result.ready}/${result.total} files ready). Please try again shortly.`,
          { autoClose: 4000 }
        );
      } else if (result.status === "no_files") {
        toast.info("No files uploaded yet.", { autoClose: 2000 });
      } else if (result.status === "error") {
        toast.error(result.message || "Failed to generate topics", { autoClose: 3000 });
      } else {
        setModuleTopics(result);
        setIsTopicsStale(false);
        toast.success("Topics generated successfully", { autoClose: 2000 });
      }
    } catch (error) {
      console.error("Error generating topics:", error.message);
      toast.error("Failed to generate topics", { autoClose: 3000 });
    } finally {
      setIsGeneratingTopics(false);
    }
  };

  useEffect(() => {
    if (module) {
      fetchFiles();
      const fetchCrossFileData = async () => {
        try {
          const [filesData, refsData] = await Promise.all([
            apiClient.get("instructor/course_files", { course_id }),
            apiClient.get("instructor/module_file_references", { module_id: module.module_id }),
          ]);
          setCourseFiles(filesData.filter(f => f.module_id !== module.module_id));
          setReferencedFileIds(refsData);
        } catch (error) {
          console.error("Error fetching cross-file data:", error.message);
        }
      };
      fetchCrossFileData();
    }
  }, [module]);

  const handleDelete = async () => {
    try {
      await apiClient.delete("instructor/delete_module_s3", {
        course_id,
        module_id: module.module_id,
        module_name: module.module_name,
      });

      await apiClient.delete("instructor/delete_module", { module_id: module.module_id });

      toast.success("Successfully Deleted");
      setTimeout(() => {
        handleBackClick();
      }, 1000);
    } catch (error) {
      console.error(error.message);
      toast.error("Failed to delete module");
    }
  };

  const handleInputChange = (e) => {
    setModuleName(e.target.value);
  };

  const handleConceptInputChange = (e) => {
    setConcept(e.target.value);
  };
  const updateModule = async () => {
    const selectedConcept = allConcepts.find((c) => c.concept_name === concept);
    const { email } = await apiClient.getAuth();

    return apiClient.putRaw(
      "instructor/edit_module",
      { module_id: module.module_id, instructor_email: email, concept_id: selectedConcept.concept_id },
      { module_name: moduleName, module_prompt: modulePrompt }
    ).then((response) => {
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      return response;
    });
  };

  const deleteFiles = async (deletedFiles, token) => {
    const deletedFilePromises = deletedFiles.map((file_name) => {
      const fileType = getFileType(file_name);
      const fileName = cleanFileName(removeFileExtension(file_name));
      return apiClient.deleteRaw("instructor/delete_file", {
        course_id,
        module_id: module.module_id,
        module_name: moduleName,
        file_type: fileType,
        file_name: fileName,
      });
    });
  };
  const uploadFiles = async (newFiles, token) => {
    const successfullyUploadedFiles = [];
    // add meta data to this request
    const newFilePromises = newFiles.map(async (file) => {
      const fileType = getFileType(file.name);
      const fileName = cleanFileName(removeFileExtension(file.name));

      try {
        const presignedUrl = await apiClient.get("instructor/generate_presigned_url", {
          course_id,
          module_id: module.module_id,
          module_name: moduleName,
          file_type: fileType,
          file_name: fileName,
        });

        const uploadResponse = await fetch(presignedUrl.presignedurl, {
          method: "PUT",
          headers: {
            "Content-Type": file.type,
          },
          body: file,
        });

        if (!uploadResponse.ok) {
          throw new Error("Failed to upload file");
        }

        // Add file to the successful uploads array
        successfullyUploadedFiles.push(file);
      } catch (error) {
        console.error(error.message);
      }
    });

    // Wait for all uploads to complete
    await Promise.all(newFilePromises);

    // Update state with successfully uploaded files
    setSavedFiles((prevFiles) => [...prevFiles, ...successfullyUploadedFiles]);
  };

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setConflictReport(null);


    const totalFiles = files.length + newFiles.length;
    if (totalFiles === 0) {
      toast.error("At least one file is required to save the module.", { autoClose: 2000 });
      setIsSaving(false);
      return;
    }

    if (!moduleName || !concept) {
      toast.error("Module Name and Concept are required.");
      return;
    }


    try {
      await updateModule();
      await deleteFiles(deletedFiles);
      await uploadFiles(newFiles);
      await apiClient.put(
        "instructor/module_file_references",
        { module_id: module.module_id },
        { referenced_file_ids: referencedFileIds }
      );
      const { token } = await apiClient.getAuth();
      await Promise.all([
        updateMetaData(files, token),
        updateMetaData(savedFiles, token),
        updateMetaData(newFiles, token),
      ]);
      setFiles((prevFiles) =>
        prevFiles.filter((file) => !deletedFiles.includes(file.fileName))
      );

      setDeletedFiles([]);
      setNewFiles([]);
      toast.success("Module updated successfully");

      // Run prompt conflict validation after save (awaited to keep page alive)
      if (modulePrompt && modulePrompt.trim()) {
        setIsSaving(false);
        await validateModulePrompt();
      } else {
        setIsSaving(false);
        setTimeout(() => {
          handleBackClick();
        }, 1000);
      }
    } catch (error) {
      console.error("Error fetching courses:", error);
      toast.error("Module failed to update");
      setIsSaving(false);
    }
  };

  const validateModulePrompt = async () => {
    setIsValidating(true);
    setConflictReport(null);
    try {
      const { email } = await apiClient.getAuth();
      const data = await apiClient.post(
        "instructor/validate_prompt",
        { course_id, instructor_email: email },
        { prompt: modulePrompt, scope: "module", module_id: module.module_id }
      );
      setConflictReport(data);
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
      // Non-blocking — save already succeeded, just navigate back
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

  const updateMetaData = (files, token) => {
    files.forEach((file) => {
      const fileNameWithExtension = file.fileName || file.name;
      const fileMetadata = metadata[fileNameWithExtension] || "";
      const fileName = cleanFileName(
        removeFileExtension(fileNameWithExtension)
      );
      const fileType = getFileType(fileNameWithExtension);
      return apiClient.putRaw(
        "instructor/update_metadata",
        { module_id: module.module_id, filename: fileName, filetype: fileType },
        { metadata: fileMetadata }
      );
    });
  };

  if (!module) return <Typography>Loading...</Typography>;

  return (
    <PageContainer>
      <Paper style={{ padding: 25, width: "100%", overflow: "auto" }}>
        <Typography variant="h6">
          Edit Module {titleCase(module.module_name)}{" "}
        </Typography>

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

        {/* Generate Topics Display (topics list only, button moved to action bar) */}
        <Box sx={{ marginTop: 3, marginBottom: 2 }}>
          {isTopicsStale && moduleTopics && (
            <Typography variant="caption" color="warning.main" sx={{ display: "block", marginTop: 1 }}>
              ⚠ Topics may be outdated — files have been added or removed since last generation.
            </Typography>
          )}

          {moduleTopics && moduleTopics.topics && moduleTopics.topics.length > 0 && (
            <Box sx={{ marginTop: 2 }}>
              <Typography variant="subtitle2">Generated Topics (use as reference for module prompt):</Typography>
              <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
                {moduleTopics.topics.map((topic, i) => (
                  <li key={i}><Typography variant="body2">{topic}</Typography></li>
                ))}
              </ul>
              {moduleTopics.learning_objectives && moduleTopics.learning_objectives.length > 0 && (
                <>
                  <Typography variant="subtitle2" sx={{ marginTop: 1 }}>Learning Objectives:</Typography>
                  <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
                    {moduleTopics.learning_objectives.map((obj, i) => (
                      <li key={i}><Typography variant="body2">{obj}</Typography></li>
                    ))}
                  </ul>
                </>
              )}
            </Box>
          )}
        </Box>

        {/* Action Buttons */}
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2, width: '100%' }}>
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
              Delete Module
            </Button>
          </Box>
          <Button
            variant="contained"
            color="secondary"
            onClick={handleGenerateTopics}
            disabled={isGeneratingTopics || files.length === 0}
          >
            {isGeneratingTopics ? "Generating..." : "Generate Topics"}
          </Button>
          <Box sx={{ display: "flex", gap: 2 }}>
            {conflictReport && conflictReport.has_conflicts && (
              <Button
                variant="outlined"
                color="warning"
                onClick={handleBackClick}
              >
                Dismiss and go back
              </Button>
            )}
            <Button
              variant="contained"
              color="primary"
              onClick={handleSave}
            >
              Save Module
            </Button>
          </Box>
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
              The module was saved, but you may want to revise the prompt.
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
          </Box>
        )}
      </Paper>
      <Dialog open={dialogOpen} onClose={handleDialogClose}>
        <DialogTitle>{"Delete Module"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete this module? This action cannot be
            undone.
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

export default InstructorEditCourse;
