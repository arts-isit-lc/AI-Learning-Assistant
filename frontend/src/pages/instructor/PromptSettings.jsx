import React, { useEffect, useState, useContext } from "react";
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
} from "@mui/material";
import apiClient from "../../services/api";
import { toast } from "react-toastify";
import MobileStepper from "@mui/material/MobileStepper";
import KeyboardArrowLeft from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRight from "@mui/icons-material/KeyboardArrowRight";
import { useTheme } from "@mui/material/styles";
import { useNavigate } from "react-router-dom";
import { UserContext } from "../../App";
import { LLM_MODELS, DEFAULT_LLM_MODEL_ID, getLLMModelOptions } from "../../constants/llmModels";
import { courseTitleCase } from "../../utils/formatters";

const CHARACTER_LIMIT = 1000;

const PromptSettings = ({ courseName, course_id }) => {
  const theme = useTheme();
  const [userPrompt, setUserPrompt] = useState("");
  const [selectedModelId, setSelectedModelId] = useState(DEFAULT_LLM_MODEL_ID);
  const [previousPrompts, setPreviousPrompts] = useState([]);
  const [activeStep, setActiveStep] = useState(0);
  const maxSteps = previousPrompts.length;
  const { isInstructorAsStudent } = useContext(UserContext);
  const navigate = useNavigate();

  const modelOptions = getLLMModelOptions();

  useEffect(() => {
    if (isInstructorAsStudent) {
      navigate("/");
    }
  }, [isInstructorAsStudent, navigate]);

  // Function to convert UTC timestamp to local time
  const convertToLocalTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString(); // or use .toLocaleDateString() and .toLocaleTimeString() for custom formatting
  };

  const handleNext = () => {
    setActiveStep((prevActiveStep) => prevActiveStep + 1);
  };

  const handleBack = () => {
    setActiveStep((prevActiveStep) => prevActiveStep - 1);
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
        // Set the selected model ID, defaulting to Llama 70B if not set
        setSelectedModelId(data.llm_model_id || DEFAULT_LLM_MODEL_ID);
      } catch (error) {
        console.error("Error fetching prompt:", error.message);
      }
    };

    fetchPrompt();
    fetchPreviousPrompts();
  }, [course_id]);

  const handleSave = async () => {
    try {
      const { email } = await apiClient.getAuth();

      // Save current prompt and selected model ID
      const requestBody = {
        prompt: `${userPrompt}`,
        llm_model_id: selectedModelId,
      };
      const data = await apiClient.put(
        "instructor/prompt",
        { course_id, instructor_email: email },
        requestBody
      );

      const newPrompt = {
        timestamp: new Date().toISOString(),
        previous_prompt: userPrompt,
      };
      setUserPrompt(data.system_prompt);
      fetchPreviousPrompts();
      toast.success("Settings updated successfully");
    } catch (error) {
      console.error("Error updating settings:", error.message);
      toast.error(`Failed to update settings: ${error.message}`);
    }
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
          <Typography variant="h8">
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
          <Typography variant="h8">
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
          <Typography variant="h8">
            Warning:
            <br />
            Modifying the prompt in the text area below can significantly impact
            the quality and accuracy of the responses.
          </Typography>
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
        </Box>

        <Box sx={{ mb: 1 }}>
          <Typography variant="h6">Previous Prompts</Typography>
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

        <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
          <Button
            variant="contained"
            color="primary"
            onClick={handleSave}
            width="100%"
          >
            Save
          </Button>
        </Box>
      </Paper>
    </Container>
  );
};
export default PromptSettings;
