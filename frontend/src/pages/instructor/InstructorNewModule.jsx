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
  Tooltip,
} from "@mui/material";
import PageContainer from "../Container";
import FileManagement from "../../components/FileManagement";
import { titleCase } from "../../utils/formatters";
import { cleanFileName, removeFileExtension, getFileType } from "../../utils/fileHelpers";
import { useFileUpload } from "../../hooks/useFileUpload";
import { useProcessingPoller } from "../../hooks/useProcessingPoller";
import { BLOCKING_STATUSES } from "../../constants/uploadConfig";


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

  // Key topics state
  const [keyTopics, setKeyTopics] = useState([]);
  const [newTopicInput, setNewTopicInput] = useState("");
  const [editingTopicIndex, setEditingTopicIndex] = useState(null);
  const [editingTopicValue, setEditingTopicValue] = useState("");

  // Prompt conflict validation state
  const [conflictReport, setConflictReport] = useState(null);
  const [isValidating, setIsValidating] = useState(false);

  // Track created module_id for upload progress hooks
  const [createdModuleId, setCreatedModuleId] = useState(null);

  // --- Upload progress & processing poller hooks ---
  // Note: For InstructorNewModule, moduleId is null until the module is created.
  // The useFileUpload hook handles null moduleId gracefully (won't upload until moduleId is set).
  // For the initial save flow, we do the upload inline since moduleId is obtained at save time.
  const {
    fileStates,
    abortFile,
    removeFile: removeUploadFile,
    retryFile,
  } = useFileUpload({
    courseId: course_id,
    moduleId: createdModuleId,
    moduleName: moduleName,
  });

  const {
    trackedFiles,
    addTrackedFiles,
    removeTrackedFile,
    getNotFoundContext,
  } = useProcessingPoller({
    moduleId: createdModuleId,
    enabled: !!createdModuleId,
  });

  // Compute whether save should be blocked by in-progress files
  const isProcessingBlocking = Object.values(fileStates).some(
    (f) => BLOCKING_STATUSES.includes(f.status)
  ) || Object.values(trackedFiles).some(
    (f) => BLOCKING_STATUSES.includes(f.status)
  );

  const canSave = !isSaving && !isProcessingBlocking;

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
    // For InstructorNewModule, we upload directly using the moduleid parameter
    // since the useFileUpload hook's closure won't have the moduleId yet (state is async).
    // We still collect file_ids for the processing poller.
    const uploadedFileIds = [];

    const newFilePromises = newFiles.map(async (file) => {
      const fileType = getFileType(file.name);
      const fileName = cleanFileName(removeFileExtension(file.name));

      try {
        const response = await apiClient.get("instructor/generate_presigned_url", {
          course_id,
          module_id: moduleid,
          module_name: moduleName,
          file_type: fileType,
          file_name: fileName,
        });

        const presignedUrl = response.presignedurl;
        const fileId = response.file_id;

        // Upload via XHR (no progress tracking UI needed for new module create flow)
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              if (fileId) {
                uploadedFileIds.push({ fileId, uploadCompletedAt: Date.now() });
              }
              resolve();
            } else {
              reject(new Error(`Upload failed with status ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.ontimeout = () => reject(new Error("Upload timed out"));
          xhr.open("PUT", presignedUrl);
          xhr.timeout = 300000;
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.send(file);
        });
      } catch (error) {
        console.error(`Upload failed for ${file.name}:`, error.message);
      }
    });

    await Promise.all(newFilePromises);

    // Hand off successfully uploaded file_ids to the processing poller
    if (uploadedFileIds.length > 0) {
      addTrackedFiles(uploadedFileIds);
    }

    return uploadedFileIds;
  };

  const handleSave = async () => {
    if (!canSave) return;
    setConflictReport(null);

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
        { module_prompt: modulePrompt, key_topics: keyTopics.length > 0 ? keyTopics : null }
      );

      // Set the created module ID so the upload hook has the correct moduleId
      setCreatedModuleId(updatedModule.module_id);

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

  const renderHighlightedPrompt = () => {
    if (!conflictReport || !conflictReport.has_conflicts) return null;

    const conflicts = conflictReport.conflicts;
    const excerpts = conflicts.map((c) => {
      if (c.prompt_a_source && c.prompt_a_source.startsWith("module_prompt")) return { text: c.prompt_a_text, conflict: c };
      if (c.prompt_b_source && c.prompt_b_source.startsWith("module_prompt")) return { text: c.prompt_b_text, conflict: c };
      return null;
    }).filter(Boolean);

    if (excerpts.length === 0) return null;

    const promptText = modulePrompt;
    const highlights = [];

    for (const { text, conflict } of excerpts) {
      const idx = promptText.toLowerCase().indexOf(text.toLowerCase());
      if (idx !== -1) {
        highlights.push({ start: idx, end: idx + text.length, conflict });
      }
    }

    highlights.sort((a, b) => a.start - b.start);

    const parts = [];
    let lastIdx = 0;
    for (const h of highlights) {
      if (h.start > lastIdx) {
        parts.push(<span key={`text-${lastIdx}`}>{promptText.slice(lastIdx, h.start)}</span>);
      }
      const otherSource = h.conflict.prompt_a_source.startsWith("module_prompt")
        ? h.conflict.prompt_b_source : h.conflict.prompt_a_source;
      const otherText = h.conflict.prompt_a_source.startsWith("module_prompt")
        ? h.conflict.prompt_b_text : h.conflict.prompt_a_text;
      const tooltipText = `Conflicts with ${otherSource.replace(/_/g, " ")}: "${otherText}"\n\n${h.conflict.explanation}`;
      parts.push(
        <Tooltip key={`hl-${h.start}`} title={tooltipText} arrow placement="top">
          <span
            style={{
              backgroundColor: "rgba(211, 47, 47, 0.15)",
              borderRadius: 3,
              padding: "1px 2px",
              borderBottom: "2px solid #d32f2f",
              cursor: "help",
            }}
          >
            {promptText.slice(h.start, h.end)}
          </span>
        </Tooltip>
      );
      lastIdx = h.end;
    }
    if (lastIdx < promptText.length) {
      parts.push(<span key={`text-end`}>{promptText.slice(lastIdx)}</span>);
    }

    return (
      <Box
        sx={{
          mt: 1,
          p: 2,
          border: "1px solid",
          borderColor: "error.light",
          borderRadius: 1,
          whiteSpace: "pre-wrap",
          fontFamily: "monospace",
          fontSize: "0.875rem",
          backgroundColor: "grey.50",
        }}
      >
        <Typography variant="caption" color="error" sx={{ display: "block", mb: 1, fontFamily: "inherit" }}>
          Conflicting text highlighted below (hover for details):
        </Typography>
        {parts}
      </Box>
    );
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

        {/* Conflict validation feedback inline with the prompt */}
        {isValidating && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">
              Checking module prompt for conflicts...
            </Typography>
          </Box>
        )}

        {conflictReport && conflictReport.validation_status === "clean" && (
          <Alert severity="success" sx={{ mt: 1 }}>
            No conflicts detected. Module prompt is compatible with system and course prompts.
          </Alert>
        )}

        {conflictReport && conflictReport.has_conflicts && (
          <Alert severity="warning" variant="filled" sx={{ mt: 1 }}>
            {conflictReport.conflicts.length} conflict(s) detected. The module was created, but you may want to revise the prompt.
          </Alert>
        )}

        {renderHighlightedPrompt()}

        {/* Key Topics */}
        <Box sx={{ marginTop: 3, marginBottom: 1 }}>
          <Typography variant="subtitle2" gutterBottom>
            Key Topics
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
            Topics the chatbot should focus on and guide students to learn. Click a topic to edit it. Press Enter to add a new one.
          </Typography>

          {/* Topic chips */}
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 1 }}>
            {keyTopics.map((topic, index) => (
              editingTopicIndex === index ? (
                <TextField
                  key={index}
                  size="small"
                  value={editingTopicValue}
                  onChange={(e) => setEditingTopicValue(e.target.value)}
                  onBlur={() => {
                    if (editingTopicValue.trim()) {
                      const updated = [...keyTopics];
                      updated[index] = editingTopicValue.trim();
                      setKeyTopics(updated);
                    }
                    setEditingTopicIndex(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (editingTopicValue.trim()) {
                        const updated = [...keyTopics];
                        updated[index] = editingTopicValue.trim();
                        setKeyTopics(updated);
                      }
                      setEditingTopicIndex(null);
                    } else if (e.key === "Escape") {
                      setEditingTopicIndex(null);
                    }
                  }}
                  autoFocus
                  sx={{ minWidth: 120 }}
                />
              ) : (
                <Chip
                  key={index}
                  label={topic}
                  onClick={() => {
                    setEditingTopicIndex(index);
                    setEditingTopicValue(topic);
                  }}
                  onDelete={() => {
                    setKeyTopics(keyTopics.filter((_, i) => i !== index));
                  }}
                  color="primary"
                  variant="outlined"
                />
              )
            ))}
          </Box>

          {/* Add new topic input */}
          <TextField
            size="small"
            placeholder="Add a topic and press Enter"
            value={newTopicInput}
            onChange={(e) => setNewTopicInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const trimmed = newTopicInput.trim();
                if (trimmed && !keyTopics.includes(trimmed)) {
                  setKeyTopics([...keyTopics, trimmed]);
                  setNewTopicInput("");
                }
              }
            }}
            sx={{ maxWidth: 300 }}
          />
        </Box>

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
          uploadStates={fileStates}
          processingStates={trackedFiles}
          onAbortFile={abortFile}
          onRetryFile={retryFile}
          onRemoveTrackedFile={(fileId) => {
            removeUploadFile(fileId);
            removeTrackedFile(fileId);
          }}
          getNotFoundContext={getNotFoundContext}
        />

        {/* Generate Topics - disabled on new module (needs save first) */}
        <Box sx={{ marginTop: 3, marginBottom: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            Save the module first, then generate topics from the edit page.
          </Typography>
        </Box>

        {/* Action Buttons */}
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2, width: '100%' }}>
          <Button
            variant="contained"
            color="primary"
            onClick={handleBackClick}
          >
            Cancel
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
            <Tooltip title={isProcessingBlocking ? "Files are still processing..." : ""} arrow>
              <span>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleSave}
                  disabled={!canSave}
                >
                  Save Module
                </Button>
              </span>
            </Tooltip>
          </Box>
        </Box>
      </Paper>
    </PageContainer>
  );
};

export default InstructorNewModule;
