import React, { useState, useEffect, useContext } from "react";
import { useNavigate } from "react-router-dom";
// MUI
import SettingsIcon from "@mui/icons-material/Settings";
// amplify
import { signOut } from "aws-amplify/auth";
import apiClient from "../services/api";
import { UserContext } from "../App";
import { handleSignOut } from "../utils/auth";

const StudentHeader = () => {
  const [name, setName] = useState("");
  const { isInstructorAsStudent, setIsInstructorAsStudent } = useContext(UserContext);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchName = async () => {
      try {
        const { email } = await apiClient.getAuth();
        const data = await apiClient.get("student/get_name", { user_email: email });
        setName(data.name);
      } catch (error) {
        console.error("Error fetching name:", error.message);
      }
    };

    fetchName();
  }, []);

  // Button to switch back to instructor mode
  const handleSwitchToInstructor = () => {
    setIsInstructorAsStudent(false);
  };

  return (
    <header className="bg-[#F8F9FD] p-4 flex justify-between items-center max-h-20">
      <div className="text-black text-3xl font-roboto font-semibold p-4">
        Hi {name}!👋
      </div>
      <div className="flex items-center space-x-4">
        {/* Render this button only if the instructor is viewing as a student */}
        {isInstructorAsStudent && (
          <button
            className="bg-[#5536DA] text-white px-4 py-2 rounded hover:bg-violet-700"
            onClick={handleSwitchToInstructor}
          >
            Instructor view
          </button>
        )}
        <button
          className="bg-gray-800 text-white hover:bg-gray-700 px-4 py-2 rounded"
          onClick={handleSignOut}
        >
          Sign Out
        </button>
      </div>
    </header>
  );
};

export default StudentHeader;
