import { useState, useEffect, useRef } from "react";
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
  Tooltip,
} from "@mui/material";
import PageContainer from "../Container";
import FileManagement from "../../components/FileManagement";
import { titleCase } from "../../utils/formatters";
import { cleanFileName, removeFileExtension, getFileType } from "../../utils/fileHelpers";
import { shouldAutoGenerate, mergeTopics, findDuplicates } from "../../utils/topicGenerationHelpers";
import { useFileUpload } from "../../hooks/useFileUpload";
import { useProcessingPoller } from "../../hooks/useProcessingPoller";
import { BLOCKING_STATUSES } from "../../constants/uploadConfig";

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
  const [suggestedTopics, setSuggestedTopics] = useState([]);
  const [duplicateTopics, setDuplicateTopics] = useState(new Set());

  // Prompt conflict validation state
  const [conflictReport, setConflictReport] = useState(null);
  const [isValidating, setIsValidating] = useState(false);

  // Key topics state
  const [keyTopics, setKeyTopics] = useState([]);
  const [newTopicInput, setNewTopicInput] = useState("");
  const [editingTopicIndex, setEditingTopicIndex] = useState(null);
  const [editingTopicValue, setEditingTopicValue] = useState("");

  // --- Upload progress & processing poller hooks ---
  const {
    fileStates,
    uploadFiles: uploadFilesWithProgress,
    abortFile,
    removeFile: removeUploadFile,
    retryFile,
  } = useFileUpload({
    courseId: course_id,
    moduleId: module?.module_id,
    moduleName: moduleName,
  });

  const {
    trackedFiles,
    addTrackedFiles,
    removeTrackedFile,
    getNotFoundContext,
    loadInitialStatuses,
  } = useProcessingPoller({
    moduleId: module?.module_id,
    enabled: true,
  });

  // Compute whether save should be blocked by in-progress files
  const isProcessingBlocking = Object.values(fileStates).some(
    (f) => BLOCKING_STATUSES.includes(f.status)
  ) || Object.values(trackedFiles).some(
    (f) => BLOCKING_STATUSES.includes(f.status)
  );

  const canSave = !isSaving && !isProcessingBlocking;

  // Load initial statuses on mount (resume polling for files still processing after page refresh)
  useEffect(() => {
    if (module?.module_id) {
      loadInitialStatuses();
    }
  }, [module?.module_id, loadInitialStatuses]);

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
      // Load existing key topics
      if (moduleData.key_topics) {
        const topics = typeof moduleData.key_topics === "string"
          ? JSON.parse(moduleData.key_topics)
          : moduleData.key_topics;
        setKeyTopics(Array.isArray(topics) ? topics : []);
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
        setSuggestedTopics(result.topics || []);
        setDuplicateTopics(findDuplicates(keyTopics, result.topics || []));
      }
    } catch (error) {
      console.error("Error generating topics:", error.message);
      toast.error("Failed to generate topics", { autoClose: 3000 });
    } finally {
      setIsGeneratingTopics(false);
    }
  };

  // Auto-generate topics when all tracked files finish processing (complete or failed)
  // and at least one file has per-file topics available
  const hasAutoGeneratedRef = useRef(false);
  useEffect(() => {
    if (!shouldAutoGenerate(trackedFiles)) return;
    if (hasAutoGeneratedRef.current) return;
    if (isGeneratingTopics) return;
    hasAutoGeneratedRef.current = true;
    handleGenerateTopics();
  }, [trackedFiles, isGeneratingTopics]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddSuggestion = (topic) => {
    const merged = mergeTopics(keyTopics, [topic]);
    setKeyTopics(merged);
    setSuggestedTopics((prev) => prev.filter((t) => t !== topic));
  };

  const handleAddAllSuggestions = () => {
    const nonDuplicates = suggestedTopics.filter((t) => !duplicateTopics.has(t));
    const merged = mergeTopics(keyTopics, nonDuplicates);
    setKeyTopics(merged);
    setSuggestedTopics([]);
    setDuplicateTopics(new Set());
  };

  const handleDismissSuggestions = () => {
    setSuggestedTopics([]);
    setDuplicateTopics(new Set());
  };

  // Fallback: derive topics from per-file metadata when module-level generated_topics
  // is not available but individual files have topic_extraction data
  useEffect(() => {
    if (moduleTopics) return; // already have module-level topics
    if (!files || files.length === 0) return;

    const allTopics = [];
    const allObjectives = [];
    files.forEach((file) => {
      let meta = file.url?.metadata;
      if (meta && typeof meta === "string") {
        try { meta = JSON.parse(meta); } catch { return; }
      }
      if (meta && meta.topic_extraction && Array.isArray(meta.topic_extraction.topics)) {
        allTopics.push(...meta.topic_extraction.topics);
        if (Array.isArray(meta.topic_extraction.learning_objectives)) {
          allObjectives.push(...meta.topic_extraction.learning_objectives);
        }
      }
    });

    if (allTopics.length > 0) {
      setModuleTopics({
        topics: allTopics,
        learning_objectives: allObjectives,
        model: "per-file-preview",
        source_file_count: files.filter((f) => f.hasTopics).length,
      });
    }
  }, [files, moduleTopics]);

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
      { module_name: moduleName, module_prompt: modulePrompt, key_topics: keyTopics }
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
  const handleImmediateUpload = async (selectedFiles) => {
    const results = await uploadFilesWithProgress(selectedFiles);

    // Hand off successfully uploaded file_ids to the processing poller
    const uploadedFileIds = results
      .filter((r) => r?.fileId)
      .map((r) => ({ fileId: r.fileId, uploadCompletedAt: Date.now() }));

    if (uploadedFileIds.length > 0) {
      addTrackedFiles(uploadedFileIds);
    }

    // Move successfully uploaded files from newFiles to savedFiles
    const successfullyUploaded = selectedFiles.filter((file) =>
      results.some((r) => r?.fileName === file.name)
    );
    if (successfullyUploaded.length > 0) {
      setSavedFiles((prev) => [...prev, ...successfullyUploaded]);
      setNewFiles((prev) =>
        prev.filter((f) => !successfullyUploaded.includes(f))
      );
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    setConflictReport(null);


    const totalFiles = files.length + savedFiles.length + newFiles.length;
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
            {conflictReport.conflicts.length} conflict(s) detected. The module was saved, but you may want to revise the prompt.
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

          {/* Suggested Topics button */}
          <Button
            size="small"
            variant="outlined"
            sx={{ mb: 1 }}
            onClick={handleGenerateTopics}
            disabled={isGeneratingTopics}
            startIcon={isGeneratingTopics ? <CircularProgress size={14} /> : null}
          >
            {isGeneratingTopics ? "Generating..." : "Suggested Topics"}
          </Button>

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

          {/* Suggested Topics Panel */}
          {suggestedTopics.length > 0 && (
            <Box sx={{ bgcolor: 'action.hover', borderRadius: 1, p: 2, mt: 1 }}>
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
                <Typography variant="subtitle2">Suggested Topics</Typography>
                <Box sx={{ display: "flex", gap: 1 }}>
                  <Button size="small" variant="text" onClick={handleAddAllSuggestions}>
                    Add All
                  </Button>
                  <Button size="small" variant="text" color="inherit" onClick={handleDismissSuggestions}>
                    Dismiss
                  </Button>
                </Box>
              </Box>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                {suggestedTopics.map((topic, index) => {
                  const isDuplicate = duplicateTopics.has(topic);
                  return isDuplicate ? (
                    <Tooltip key={index} title="Already in your topics" arrow>
                      <span>
                        <Chip
                          label={topic}
                          variant="filled"
                          color="secondary"
                          disabled
                        />
                      </span>
                    </Tooltip>
                  ) : (
                    <Chip
                      key={index}
                      label={topic}
                      variant="filled"
                      color="secondary"
                      clickable
                      onClick={() => handleAddSuggestion(topic)}
                    />
                  );
                })}
              </Box>
            </Box>
          )}
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
          onFilesSelected={handleImmediateUpload}
        />

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
