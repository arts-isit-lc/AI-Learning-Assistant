import React from "react";
import { useNavigate } from "react-router-dom";
// MUI
import SettingsIcon from "@mui/icons-material/Settings";
// amplify
import { handleSignOut } from "../utils/auth";

const AdminHeader = () => {
  const navigate = useNavigate();

  return (
    <header className="bg-[#F8F9FD] p-4 flex justify-between items-center max-h-20">
      <div className="text-black text-3xl font-semibold p-4">Administrator</div>
      <button
        type="button"
        className="bg-gray-800 text-white hover:bg-gray-700"
        onClick={handleSignOut}
      >
        Sign Out
      </button>
    </header>
  );
};

export default AdminHeader;
