import { useEffect, useState, useContext } from "react";
import {
  Container,
  Typography,
  TextField,
  Button,
  Box,
  Paper,
  Toolbar,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormHelperText,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Tooltip,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import apiClient from "../../services/api";
import { toast } from "react-toastify";
import MobileStepper from "@mui/material/MobileStepper";
import KeyboardArrowLeft from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRight from "@mui/icons-material/KeyboardArrowRight";
import { useNavigate } from "react-router-dom";
import { UserContext } from "../../App";
import { DEFAULT_LLM_MODEL_ID, getLLMModelOptions } from "../../constants/llmModels";
import { courseTitleCase } from "../../utils/formatters";

const CHARACTER_LIMIT = 1000;

const PromptSettings = ({ courseName, course_id }) => {
  const [userPrompt, setUserPrompt] = useState("");
  const [selectedModelId, setSelectedModelId] = useState(DEFAULT_LLM_MODEL_ID);
  const [previousPrompts, setPreviousPrompts] = useState([]);
  const [activeStep, setActiveStep] = useState(0);
  const { isInstructorAsStudent } = useContext(UserContext);
  const navigate = useNavigate();

  // Conflict checker state
  const [conflictReport, setConflictReport] = useState(null);
  const [isValidating, setIsValidating] = useState(false);
  const [storedConflicts, setStoredConflicts] = useState(null);
  const [showLowConfidence, setShowLowConfidence] = useState(false);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);

  const modelOptions = getLLMModelOptions();

  useEffect(() => {
    if (isInstructorAsStudent) {
      navigate("/");
    }
  }, [isInstructorAsStudent, navigate]);

  const convertToLocalTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const fetchPreviousPrompts = async () => {
    try {
      const { email } = await apiClient.getAuth();
      const data = await apiClient.get("instructor/previous_prompts", { course_id, instructor_email: email });
      setPreviousPrompts(data);
    } catch (error) {
      console.error("Error fetching previous prompts:", error.message);
    }
  };

  useEffect(() => {
    const fetchPrompt = async () => {
      try {
        const data = await apiClient.get("instructor/get_prompt", { course_id });
        setUserPrompt(data.system_prompt);
        setSelectedModelId(data.llm_model_id || DEFAULT_LLM_MODEL_ID);
        // Load stored conflict metadata for persistent warning
        if (data.conflict_metadata) {
          setStoredConflicts(data.conflict_metadata);
        }
      } catch (error) {
        console.error("Error fetching prompt:", error.message);
      }
    };

    fetchPrompt();
    fetchPreviousPrompts();
  }, [course_id]);

  // --- Conflict Validation ---
  const handleValidate = async () => {
    setIsValidating(true);
    setConflictReport(null);
    try {
      const { email } = await apiClient.getAuth();
      const data = await apiClient.post(
        "instructor/validate_prompt",
        { course_id, instructor_email: email },
        { prompt: userPrompt, scope: "course" }
      );
      setConflictReport(data);
      // If validation came back clean, clear stored conflicts
      if (data.validation_status === "clean") {
        setStoredConflicts(null);
      }
    } catch (error) {
      console.error("Error validating prompt:", error.message);
      setConflictReport({
        validation_status: "validation_failed",
        conflicts: [],
        has_conflicts: false,
        summary: "Validation is temporarily unavailable. You can still save your prompt.",
      });
    } finally {
      setIsValidating(false);
    }
  };

  // --- Save Logic ---
  const handleSave = async () => {
    const hasUnresolvedConflicts =
      (conflictReport && conflictReport.has_conflicts) ||
      (storedConflicts && storedConflicts.has_conflicts && !conflictReport);

    if (hasUnresolvedConflicts && !overrideDialogOpen) {
      setOverrideDialogOpen(true);
      return;
    }

    await performSave();
  };

  const performSave = async () => {
    setOverrideDialogOpen(false);
    try {
      const { email } = await apiClient.getAuth();

      // Determine conflict_metadata to send
      let conflictMetadataToSend = null;
      if (conflictReport && conflictReport.has_conflicts) {
        conflictMetadataToSend = conflictReport;
      } else if (conflictReport && conflictReport.validation_status === "clean") {
        conflictMetadataToSend = null;
      }

      const requestBody = {
        prompt: `${userPrompt}`,
        llm_model_id: selectedModelId,
        conflict_metadata: conflictMetadataToSend,
      };
      const data = await apiClient.put(
        "instructor/prompt",
        { course_id, instructor_email: email },
        requestBody
      );

      setUserPrompt(data.system_prompt);
      fetchPreviousPrompts();

      // Update stored conflicts state
      if (conflictMetadataToSend && conflictMetadataToSend.has_conflicts) {
        setStoredConflicts(conflictMetadataToSend);
      } else if (conflictReport && conflictReport.validation_status === "clean") {
        setStoredConflicts(null);
      }

      toast.success("Settings updated successfully");
    } catch (error) {
      console.error("Error updating settings:", error.message);
      toast.error(`Failed to update settings: ${error.message}`);
    }
  };

  // --- Conflict Display Helpers ---
  const getActiveConflicts = () => {
    const report = conflictReport || storedConflicts;
    if (!report || !report.conflicts) return [];
    return report.conflicts.filter(
      (c) => showLowConfidence || c.confidence >= 0.5
    );
  };

  const getCourseConflicts = () => {
    return getActiveConflicts().filter(
      (c) => c.prompt_b_source === "course_prompt" || c.prompt_a_source === "course_prompt"
    );
  };

  const getModuleConflicts = () => {
    return getActiveConflicts().filter(
      (c) =>
        (c.prompt_a_source && c.prompt_a_source.startsWith("module_prompt:")) ||
        (c.prompt_b_source && c.prompt_b_source.startsWith("module_prompt:"))
    );
  };

  const getLowConfidenceCount = () => {
    const report = conflictReport || storedConflicts;
    if (!report || !report.conflicts) return 0;
    return report.conflicts.filter((c) => c.confidence < 0.5).length;
  };

  const getConflictTypeColor = (type) => {
    if (type === "HARD_CONTRADICTION") return "error";
    return "warning";
  };

  // --- Highlight conflicting text in the prompt ---
  const renderHighlightedPrompt = () => {
    const conflicts = getCourseConflicts();
    if (conflicts.length === 0) return null;

    const excerpts = conflicts.map((c) => {
      if (c.prompt_b_source === "course_prompt") return { text: c.prompt_b_text, conflict: c };
      if (c.prompt_a_source === "course_prompt") return { text: c.prompt_a_text, conflict: c };
      return null;
    }).filter(Boolean);

    if (excerpts.length === 0) return null;

    let promptText = userPrompt;
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
        parts.push(
          <span key={`text-${lastIdx}`}>{promptText.slice(lastIdx, h.start)}</span>
        );
      }
      const tooltipText = `Conflicts with: "${h.conflict.prompt_a_source === "course_prompt" ? h.conflict.prompt_b_text : h.conflict.prompt_a_text}"\n\n${h.conflict.explanation}`;
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
          mt: 2,
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
    <Container sx={{ maxHeight: "100vh", overflow: "auto", padding: 2 }}>
      <Toolbar />
      <Paper
        sx={{
          width: "100%",
          overflow: "auto",
          marginTop: 4,
          padding: 2,
        }}
      >
        <Box sx={{ mb: 1, flexGrow: 1, p: 3, textAlign: "left" }}>
          <Typography
            color="black"
            fontStyle="semibold"
            textAlign="left"
            variant="h6"
            gutterBottom
          >
            {courseTitleCase(courseName)} Settings
          </Typography>
          <Typography variant="body2">
            Changes to the settings will be applied to the LLM for this specific
            course.
          </Typography>

          {/* LLM Model Selection */}
          <Box sx={{ mt: 3, mb: 2 }}>
            <Typography variant="h6" gutterBottom>
              Language Model Selection
            </Typography>
            <FormControl fullWidth margin="normal">
              <InputLabel id="llm-model-select-label">Select LLM Model</InputLabel>
              <Select
                labelId="llm-model-select-label"
                id="llm-model-select"
                value={selectedModelId}
                label="Select LLM Model"
                onChange={(e) => setSelectedModelId(e.target.value)}
              >
                {modelOptions.map((model) => (
                  <MenuItem key={model.value} value={model.value}>
                    <Box>
                      <Typography variant="body1">{model.label}</Typography>
                      <Typography variant="caption" color="textSecondary">
                        {model.provider} - {model.description}
                      </Typography>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
              <FormHelperText>
                Choose the language model that will be used for conversations in this course.
              </FormHelperText>
            </FormControl>
          </Box>

          <Typography variant="h6">
            Prompt Settings
          </Typography>
          <Typography variant="body2">
            Example
          </Typography>
          <TextField
            fullWidth
            multiline
            rows={6}
            value={`Engage with the student by asking questions and conversing with them to identify any gaps in their understanding of the topic. If you identify gaps, address these gaps by providing explanations, answering the student's questions, and referring to the relevant context to help the student gain a comprehensive understanding of the topic.`}
            InputProps={{
              readOnly: true,
            }}
            variant="outlined"
            margin="normal"
          />
        </Box>

        <Box sx={{ mb: 1, flexGrow: 1, p: 3, textAlign: "left" }}>
          <Typography variant="h6">Your Prompt</Typography>
          <Typography variant="body2">
            Warning:
            <br />
            Modifying the prompt in the text area below can significantly impact
            the quality and accuracy of the responses.
          </Typography>

          {/* Persistent conflict warning from stored metadata */}
          {storedConflicts && storedConflicts.has_conflicts && !conflictReport && (
            <Alert severity="warning" variant="filled" sx={{ mt: 2, mb: 1 }}>
              This prompt was saved with {storedConflicts.conflicts?.length || 0} unresolved conflict(s).
              Click &quot;Check for Conflicts&quot; to re-validate.
            </Alert>
          )}

          {/* Active conflict warning from current validation */}
          {conflictReport && conflictReport.has_conflicts && (
            <Alert severity="warning" variant="filled" sx={{ mt: 2, mb: 1 }}>
              {conflictReport.conflicts.length} conflict(s) detected. Your prompt may cause degraded chatbot behavior.
            </Alert>
          )}

          {/* Validation failed indicator */}
          {conflictReport && conflictReport.validation_status === "validation_failed" && (
            <Alert severity="info" sx={{ mt: 2, mb: 1 }}>
              Conflict validation is temporarily unavailable. You can still save your prompt.
            </Alert>
          )}

          {/* Clean validation success */}
          {conflictReport && conflictReport.validation_status === "clean" && (
            <Alert severity="success" sx={{ mt: 2, mb: 1 }}>
              No conflicts detected. All prompts are consistent.
            </Alert>
          )}

          <TextField
            fullWidth
            multiline
            rows={6}
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            variant="outlined"
            margin="normal"
            inputProps={{ maxLength: 1000 }}
            helperText={`${userPrompt.length}/${CHARACTER_LIMIT}`}
          />

          {/* Conflict highlighting overlay */}
          {renderHighlightedPrompt()}
        </Box>

        {/* Module Prompt Conflicts Section */}
        {getModuleConflicts().length > 0 && (
          <Box sx={{ mb: 2, p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Module Prompt Conflicts
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              The following module prompts conflict with the system-level instructions or the course prompt:
            </Typography>
            {getModuleConflicts().map((conflict, idx) => {
              const moduleName =
                conflict.prompt_a_source.startsWith("module_prompt:")
                  ? conflict.prompt_a_source.replace("module_prompt:", "")
                  : conflict.prompt_b_source.replace("module_prompt:", "");
              const moduleText =
                conflict.prompt_a_source.startsWith("module_prompt:")
                  ? conflict.prompt_a_text
                  : conflict.prompt_b_text;
              const otherText =
                conflict.prompt_a_source.startsWith("module_prompt:")
                  ? conflict.prompt_b_text
                  : conflict.prompt_a_text;
              const otherSource =
                conflict.prompt_a_source.startsWith("module_prompt:")
                  ? conflict.prompt_b_source
                  : conflict.prompt_a_source;

              return (
                <Accordion key={idx} sx={{ mb: 1 }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <Typography variant="subtitle1">{moduleName}</Typography>
                      <Chip
                        label={conflict.type.replace(/_/g, " ")}
                        size="small"
                        color={getConflictTypeColor(conflict.type)}
                      />
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Module prompt text:
                        </Typography>
                        <Box
                          sx={{
                            p: 1.5,
                            backgroundColor: "rgba(211, 47, 47, 0.08)",
                            borderRadius: 1,
                            mt: 0.5,
                          }}
                        >
                          <Typography variant="body2">{moduleText}</Typography>
                        </Box>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Conflicts with ({otherSource.replace(/_/g, " ")}):
                        </Typography>
                        <Box
                          sx={{
                            p: 1.5,
                            backgroundColor: "grey.100",
                            borderRadius: 1,
                            mt: 0.5,
                          }}
                        >
                          <Typography variant="body2">{otherText}</Typography>
                        </Box>
                      </Box>
                      <Typography variant="body2" color="text.secondary">
                        {conflict.explanation}
                      </Typography>
                    </Box>
                  </AccordionDetails>
                </Accordion>
              );
            })}
          </Box>
        )}

        {/* Low confidence toggle */}
        {getLowConfidenceCount() > 0 && !showLowConfidence && (
          <Box sx={{ px: 3, mb: 2 }}>
            <Button
              size="small"
              variant="text"
              onClick={() => setShowLowConfidence(true)}
            >
              Show {getLowConfidenceCount()} low-confidence conflict(s)
            </Button>
          </Box>
        )}
        {showLowConfidence && getLowConfidenceCount() > 0 && (
          <Box sx={{ px: 3, mb: 2 }}>
            <Button
              size="small"
              variant="text"
              onClick={() => setShowLowConfidence(false)}
            >
              Hide low-confidence conflicts
            </Button>
          </Box>
        )}

        <Box sx={{ mb: 1 }}>
          <Typography variant="h6" sx={{ px: 3 }}>Previous Prompts</Typography>
          <MobileStepper
            steps={previousPrompts.length}
            position="static"
            activeStep={activeStep}
            nextButton={
              <Button
                size="small"
                onClick={() => setActiveStep((prev) => prev + 1)}
                disabled={activeStep === previousPrompts.length - 1}
              >
                Next
                <KeyboardArrowRight />
              </Button>
            }
            backButton={
              <Button
                size="small"
                onClick={() => setActiveStep((prev) => prev - 1)}
                disabled={activeStep === 0}
              >
                <KeyboardArrowLeft />
                Back
              </Button>
            }
          />
          <Box sx={{ p: 2 }}>
            {previousPrompts.length === 0 ? (
              <Typography variant="body1">No previous prompts</Typography>
            ) : (
              <>
                <Typography variant="body1">
                  {previousPrompts[activeStep]?.previous_prompt}
                </Typography>
                {convertToLocalTime(previousPrompts[activeStep]?.timestamp) && (
                  <Typography variant="body2">
                    {convertToLocalTime(previousPrompts[activeStep]?.timestamp)}
                  </Typography>
                )}
              </>
            )}
          </Box>
        </Box>

        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 2, p: 3 }}>
          <Button
            variant="outlined"
            color="primary"
            onClick={handleValidate}
            disabled={isValidating || !userPrompt.trim()}
          >
            {isValidating ? (
              <>
                <CircularProgress size={20} sx={{ mr: 1 }} />
                Checking...
              </>
            ) : (
              "Check for Conflicts"
            )}
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

      {/* Override Confirmation Dialog */}
      <Dialog
        open={overrideDialogOpen}
        onClose={() => setOverrideDialogOpen(false)}
      >
        <DialogTitle>Save with Conflicts?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You have {getActiveConflicts().length} unresolved conflict(s). Saving may cause
            degraded chatbot behavior. Are you sure you want to proceed?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setOverrideDialogOpen(false)}
            variant="outlined"
          >
            Go Back
          </Button>
          <Button
            onClick={performSave}
            variant="contained"
            color="error"
          >
            Save Anyway
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};
export default PromptSettings;
