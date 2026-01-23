import React, { useEffect, useState, useContext } from "react";
import {
  Container,
  Typography,
  Button,
  Box,
  Paper,
  Toolbar,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from "@mui/material";
import { fetchAuthSession, fetchUserAttributes } from "aws-amplify/auth";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { useNavigate } from "react-router-dom";
import { UserContext } from "../../App";
import { LLM_MODELS, DEFAULT_LLM_MODEL } from "../../constants/llmModels";

function courseTitleCase(str) {
  if (typeof str !== "string") {
    return str;
  }
  const words = str.split(" ");
  return words
    .map((word, index) => {
      if (index === 0) {
        return word.toUpperCase();
      } else {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
    })
    .join(" ");
}

const EditModels = ({ courseName, course_id }) => {
  const [llmModelId, setLlmModelId] = useState(DEFAULT_LLM_MODEL);
  const [loading, setLoading] = useState(true);
  const { isInstructorAsStudent } = useContext(UserContext);
  const navigate = useNavigate();

  useEffect(() => {
    if (isInstructorAsStudent) {
      navigate("/");
    }
  }, [isInstructorAsStudent, navigate]);

  useEffect(() => {
    const fetchLlmModel = async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens.idToken;
        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}instructor/get_prompt?course_id=${encodeURIComponent(course_id)}`,
          {
            method: "GET",
            headers: {
              Authorization: token,
              "Content-Type": "application/json",
            },
          }
        );
        if (response.ok) {
          const data = await response.json();
          setLlmModelId(data.llm_model_id || DEFAULT_LLM_MODEL);
        } else {
          console.error("Failed to fetch LLM model:", response.statusText);
        }
      } catch (error) {
        console.error("Error fetching LLM model:", error);
      }
      setLoading(false);
    };

    fetchLlmModel();
  }, [course_id]);

  const handleSave = async () => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens.idToken;
      const { email } = await fetchUserAttributes();

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}instructor/update_llm_model?course_id=${encodeURIComponent(course_id)}&instructor_email=${encodeURIComponent(email)}`,
        {
          method: "PUT",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ llm_model_id: llmModelId }),
        }
      );

      if (response.ok) {
        toast.success("LLM Model updated successfully", {
          position: "top-center",
          autoClose: 1000,
          hideProgressBar: false,
          closeOnClick: true,
          pauseOnHover: true,
          draggable: true,
          progress: undefined,
          theme: "colored",
        });
      } else {
        console.error("Failed to update LLM model:", response.statusText);
        toast.error(`Failed to update LLM model: ${response.statusText}`, {
          position: "top-center",
          autoClose: 1000,
          hideProgressBar: false,
          closeOnClick: true,
          pauseOnHover: true,
          draggable: true,
          progress: undefined,
          theme: "colored",
        });
      }
    } catch (error) {
      console.error("Error updating LLM model:", error);
      toast.error("Error updating LLM model", {
        position: "top-center",
        autoClose: 1000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        progress: undefined,
        theme: "colored",
      });
    }
  };

  if (loading) {
    return <Typography>Loading...</Typography>;
  }

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
        <Box mb={1} sx={{ flexGrow: 1, p: 3, textAlign: "left" }}>
          <Typography
            color="black"
            fontStyle="semibold"
            textAlign="left"
            variant="h6"
            gutterBottom
          >
            {courseTitleCase(courseName)} - Edit LLM Model
          </Typography>
          <Typography variant="body1" sx={{ mb: 3 }}>
            Select the Large Language Model (LLM) to use for this course. Different models have different capabilities and response characteristics.
          </Typography>

          <FormControl fullWidth margin="normal">
            <InputLabel id="llm-model-select-label">LLM Model</InputLabel>
            <Select
              labelId="llm-model-select-label"
              value={llmModelId}
              onChange={(e) => setLlmModelId(e.target.value)}
              label="LLM Model"
            >
              {LLM_MODELS.map((model) => (
                <MenuItem key={model.id} value={model.id}>
                  <Box>
                    <Typography variant="body1" fontWeight="medium">
                      {model.name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" fontSize="0.8rem">
                      {model.description}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        <Box display="flex" justifyContent="flex-end">
          <Button
            variant="contained"
            color="primary"
            onClick={handleSave}
            width="100%"
          >
            Save Model Selection
          </Button>
        </Box>
      </Paper>
      <ToastContainer
        position="top-center"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="colored"
      />
    </Container>
  );
};

export default EditModels;