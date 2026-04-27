import React, { useEffect, useState } from "react";
import apiClient from "../../services/api";

import { signOut } from "aws-amplify/auth";

import { BiCheck } from "react-icons/bi";
import { FaInfoCircle } from "react-icons/fa";
import ArrowCircleLeftRoundedIcon from "@mui/icons-material/ArrowCircleLeftRounded";
import { handleSignOut } from "../../utils/auth";

import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import { titleCase } from "../../utils/formatters";

// Function to calculate the color based on the average score
const calculateColor = (score) => {
  if (score === null) {
    return "bg-red-500"; // Red for null scores
  }

  const redStart = 255; // Starting red component for red
  const redMiddle = 255; // Red component for less vibrant yellow
  const redEnd = 0; // Ending red component for green

  const greenStart = 0; // Starting green component for red
  const greenMiddle = 200; // Less vibrant yellow (lower green component)
  const greenEnd = 150; // Ending green component for green

  const blueStart = 0; // Starting blue component for red
  const blueMiddle = 0; // Blue component for less vibrant yellow
  const blueEnd = 0; // Ending blue component for green

  let r, g, b;

  if (score <= 50) {
    // Transition from red to less vibrant yellow
    const ratio = score / 50; // Ratio from 0 to 1
    r = redStart;
    g = greenStart + ratio * (greenMiddle - greenStart);
    b = blueStart + ratio * (blueMiddle - blueStart);
  } else {
    // Transition from less vibrant yellow to green
    const ratio = (score - 50) / 50; // Ratio from 0 to 1
    r = redMiddle + ratio * (redEnd - redMiddle);
    g = greenMiddle + ratio * (greenEnd - greenMiddle);
    b = blueMiddle + ratio * (blueEnd - blueMiddle);
  }

  return `rgb(${r}, ${g}, ${b})`;
};

// Function to get unique concept names and average scores
function getUniqueConceptNames(data) {
  const conceptMap = new Map();

  // Iterate over the array and populate the Map with unique concept_id as keys and concept_name as values
  data.forEach((item) => {
    if (!conceptMap.has(item.concept_id)) {
      // Calculate the average module score
      const averageScore =
        data
          .filter((d) => d.concept_id === item.concept_id)
          .reduce((acc, curr) => acc + (curr.module_score || 0), 0) /
        data.filter((d) => d.concept_id === item.concept_id).length;

      conceptMap.set(item.concept_id, {
        concept_name: item.concept_name,
        average_score: averageScore,
      });
    }
  });

  // Convert the Map to an array of objects
  return Array.from(
    conceptMap,
    ([concept_id, { concept_name, average_score }]) => ({
      concept_id,
      concept_name,
      average_score,
    })
  );
}


export const CourseView = ({ course, setModule, setCourse }) => {
  const [concepts, setConcepts] = useState([]);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const navigate = useNavigate();
  const enterModule = (module) => {
    setModule(module);
    sessionStorage.setItem("module", JSON.stringify(module));
    navigate(`/student_chat`);
  };

  const handleBack = () => {
    sessionStorage.removeItem("course");
    navigate("/home");
  };

  useEffect(() => {
    const fetchCoursePage = async () => {
      if (!course) return;
      try {
        const { email } = await apiClient.getAuth();
        const data = await apiClient.get("student/course_page", {
          email,
          course_id: course.course_id,
        });
        setData(data);
        setConcepts(getUniqueConceptNames(data));
        setLoading(false);
      } catch (error) {
        console.error("Error fetching name:", error.message);
      }
    };
    fetchCoursePage();
  }, [course]);

  useEffect(() => {
    sessionStorage.removeItem("module");
    const storedCourse = sessionStorage.getItem("course");
    if (storedCourse) {
      setCourse(JSON.parse(storedCourse));
    }
  }, [setCourse]);

  if (loading) {
    return (
      <div className="bg-[#F8F9FD] w-screen flex justify-center items-center h-screen">
        <l-helix size="50" speed="2.5" color="#d21adb"></l-helix>
      </div>
    );
  }

  if (!course) {
    return <div>Loading...</div>;
  }

  return (
    <div className="bg-[#F8F9FD] w-screen h-screen">
      <header className="bg-[#F8F9FD] p-4 flex justify-between items-center max-h-20">
        <div className="text-black text-xl font-roboto font-semibold p-2 flex flex-row">
          <ArrowCircleLeftRoundedIcon
            onClick={() => handleBack()}
            className="mt-1 mr-2 cursor-pointer"
            sx={{ width: 24, height: 24 }}
          />
          {course.course_department.toUpperCase()} {course.course_number}
        </div>
        
        <button
          type="button"
          className="bg-gray-800 text-white hover:bg-gray-700"
          onClick={handleSignOut}
        >
          Sign Out
        </button>
      </header>
      
      <div className="flex flex-col">
        <div className="text-black text-start text-xl font-roboto font-semibold p-2 ml-4">
          Learning Journey
        </div>
        <div className="p-2 ml-4 flex flex-row justify-center gap-x-20">
          {concepts.map((concept, index) => (
            <div key={index} className="flex flex-col items-center">
              <div
                className="flex items-center justify-center w-8 h-8 text-white font-bold rounded-full mb-2"
                style={{
                  backgroundColor: calculateColor(concept.average_score),
                }}
              >
                {concept.average_score === 100 ? (
                  <span className="text-xl">
                    <BiCheck />
                  </span>
                ) : (
                  index + 1
                )}
              </div>
              <div className="text-black text-start text-sm font-roboto">
                {titleCase(concept.concept_name)}
              </div>
            </div>
          ))}
        </div>
        <div className="text-black text-start text-xl font-roboto font-semibold p-2 ml-4">
          Modules
        </div>
        <div className="flex justify-center items-center">
          {data.length === 0 ? (
            <div className="p-4 text-center text-gray-500">
              No concepts/modules to display
            </div>
          ) : (
            <TableContainer
              component={Paper}
              sx={{
                width: "80%",
                maxHeight: "60vh",
                overflowY: "auto",
                marginX: 2,
              }}
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontSize: "1.1rem" }}>Module</TableCell>
                    <TableCell sx={{ fontSize: "1.1rem" }}>
                      Concept
                    </TableCell>{" "}
                    <TableCell sx={{ fontSize: "1.1rem" }}>
                      Completion
                    </TableCell>
                    <TableCell sx={{ fontSize: "1.1rem" }}>Review</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.map((entry, index) => (
                    <TableRow key={entry.module_id + index}>
                      <TableCell sx={{ fontSize: "1rem" }}>
                        <div className="flex flex-row gap-1 items-center">
                          <FaInfoCircle className="text-xs" />
                          <span className="text-base">
                            {titleCase(entry.module_name)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell sx={{ fontSize: "1rem" }}>
                        {titleCase(entry.concept_name)}{" "}
                      </TableCell>
                      <TableCell sx={{ fontSize: "1rem" }}>
                        {entry.module_score === 100 ? (
                          <span
                            className="bg-[#2E7D32] text-white text-light rounded px-2 py-2"
                            style={{ display: "inline-block" }}
                          >
                            Complete
                          </span>
                        ) : entry.last_accessed ? (
                          <span
                            className="bg-[#FFA726] text-white text-light rounded px-2 py-2"
                            style={{ display: "inline-block" }}
                          >
                            In Progress
                          </span>
                        ) : (
                          <span
                            className="bg-[#E53E3E] text-white text-light rounded px-2 py-2"
                            style={{ display: "inline-block" }}
                          >
                            Incomplete
                          </span>
                        )}
                      </TableCell>
                      <TableCell sx={{ fontSize: "1rem" }}>
                        <Button
                          variant="contained"
                          color="primary"
                          onClick={() => enterModule(entry)}
                          sx={{ textTransform: "none", fontSize: "0.9rem" }}
                        >
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </div>
      </div>
    </div>
  );
};

export default CourseView;
