import { useState } from "react";
import apiClient from "../../services/api";

/**
 * Custom hook for file viewer / PDF panel state and handlers.
 * Manages: file list fetching, file selection, PDF URL loading, panel open/close.
 */
export default function useFileViewer(course, module) {
  const [moduleFiles, setModuleFiles] = useState(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesPopoverOpen, setFilesPopoverOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfPanelOpen, setPdfPanelOpen] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  const handleFetchFiles = async () => {
    if (moduleFiles !== null) {
      setFilesPopoverOpen(true);
      return;
    }
    setFilesLoading(true);
    setFilesPopoverOpen(true);
    try {
      const data = await apiClient.get("student/files", {
        course_id: course.course_id,
        module_id: module.module_id,
      });
      setModuleFiles(data || []);
    } catch (error) {
      console.error("Error fetching module files:", error.message);
      setModuleFiles([]);
    } finally {
      setFilesLoading(false);
    }
  };

  const handleFileSelect = async (fileId) => {
    const file = moduleFiles?.find((f) => f.file_id === fileId);
    setSelectedFile(file);
    setPdfLoading(true);
    setPdfPanelOpen(true);
    setFilesPopoverOpen(false);
    try {
      const data = await apiClient.get("student/file_url", {
        file_id: fileId,
      });
      setPdfUrl(data.presignedurl);
    } catch (error) {
      console.error("Error fetching file URL:", error.message);
      setPdfUrl(null);
    } finally {
      setPdfLoading(false);
    }
  };

  const handlePdfClose = () => {
    setPdfPanelOpen(false);
    setSelectedFile(null);
    setPdfUrl(null);
  };

  const handlePdfRetry = async () => {
    if (!selectedFile) return;
    setPdfLoading(true);
    try {
      const data = await apiClient.get("student/file_url", {
        file_id: selectedFile.file_id,
      });
      setPdfUrl(data.presignedurl);
    } catch (error) {
      console.error("Error fetching file URL on retry:", error.message);
    } finally {
      setPdfLoading(false);
    }
  };

  return {
    moduleFiles,
    filesLoading,
    filesPopoverOpen,
    setFilesPopoverOpen,
    selectedFile,
    pdfUrl,
    pdfPanelOpen,
    pdfLoading,
    handleFetchFiles,
    handleFileSelect,
    handlePdfClose,
    handlePdfRetry,
  };
}
