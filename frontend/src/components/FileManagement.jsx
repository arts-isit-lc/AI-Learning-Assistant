import { useState } from "react";
import { Trash2, CloudUpload, Download, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { toast } from "react-toastify";

import { cleanFileName } from "../utils/fileHelpers";
import { Progress } from "@/components/ui/progress";

const FileManagement = ({
  newFiles,
  setNewFiles,
  files,
  setFiles,
  setDeletedFiles,
  savedFiles,
  setSavedFiles,
  loading,
  metadata,
  setMetadata,
  // Progress tracking props
  uploadStates,
  processingStates,
  onAbortFile,
  onRetryFile,
  onRemoveTrackedFile,
  getNotFoundContext,
  // Immediate upload callback
  onFilesSelected,
}) => {
  const [duplicateFile, setDuplicateFile] = useState(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleMetadataChange = (fileName, value) => {
    setMetadata((prev) => ({ ...prev, [fileName]: value }));
  };

  const handleDownloadClick = (url) => {
    window.open(url.url, "_blank");
  };

  const handleFileUpload = async (event) => {
    const uploadedFiles = Array.from(event);
    const existingFileNames = files.map((file) => file.fileName);
    const savedFileNames = savedFiles.map((file) => file.name);
    const newFileNames = newFiles.map((file) => file.name);
    const allFileNames = [
      ...existingFileNames,
      ...savedFileNames,
      ...newFileNames,
    ];

    const fileIsNew = uploadedFiles.filter((file) => {
      const cleanedFileName = cleanFileName(file.name);
      if (allFileNames.includes(cleanedFileName)) {
        setDuplicateFile(file);
        setIsDialogOpen(true);
        return false;
      }
      return true;
    });

    // Filter out files larger than 500MB
    const fileIsValidSize = fileIsNew.filter((file) => {
      const fileSizeMB = file.size / (1024 * 1024);
      if (fileSizeMB > 500) {
        toast.error(
          `File ${file.name} is larger than 500MB and was not uploaded.`,
          { autoClose: 3000 }
        );
        return false;
      }
      return true;
    });

    setNewFiles([...newFiles, ...fileIsValidSize]);

    // Trigger immediate upload if callback provided
    if (fileIsValidSize.length > 0 && onFilesSelected) {
      onFilesSelected(fileIsValidSize);
    }
  };

  const handleConfirmReplace = () => {
    const cleanedFileName = cleanFileName(duplicateFile.name);

    const updatedFiles = files.filter(
      (file) => file.fileName !== cleanedFileName
    );
    const updatedSavedFiles = savedFiles.filter(
      (file) => file.name !== cleanedFileName
    );
    const updatedNewFiles = newFiles.filter(
      (file) => file.name !== cleanedFileName
    );
    setFiles(updatedFiles);
    setSavedFiles(updatedSavedFiles);
    setNewFiles([...updatedNewFiles, duplicateFile]);
    setDeletedFiles((prevDeletedFiles) => [
      ...prevDeletedFiles,
      cleanedFileName,
    ]);

    // Trigger immediate upload for the replacement file
    if (onFilesSelected) {
      onFilesSelected([duplicateFile]);
    }

    setDuplicateFile(null);
    setIsDialogOpen(false);
  };

  const handleCancelReplace = () => {
    setDuplicateFile(null);
    setIsDialogOpen(false);
  };

  const handleDownloadFile = (file) => {
    const url = window.URL.createObjectURL(new Blob([file]));
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", file.name);
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
  };

  const handleRemoveFile = async (file_name) => {
    setDeletedFiles((prevDeletedFiles) => [...prevDeletedFiles, file_name]);
    const updatedFiles = files.filter((file) => file.fileName !== file_name);
    setFiles(updatedFiles);
  };

  const handleSavedRemoveFile = async (file_name) => {
    setDeletedFiles((prevDeletedFiles) => [...prevDeletedFiles, file_name]);
    const updatedFiles = savedFiles.filter((file) => file.name !== file_name);
    setSavedFiles(updatedFiles);
  };

  const handleRemoveNewFile = (file_name) => {
    const updatedFiles = newFiles.filter((file) => file.name !== file_name);
    setNewFiles(updatedFiles);
  };

  return (
    <div className="border border-border rounded-xl p-4">
      <h2 className="text-lg font-semibold text-foreground pt-2">Files</h2>

      {/* Upload area */}
      <label className="flex items-center justify-center gap-2 border border-border rounded-lg p-4 cursor-pointer hover:bg-muted/50 transition-colors">
        <input
          accept=".pdf,.docx,.pptx,.txt,.xlsx,.xps,.mobi,.cbz"
          type="file"
          multiple
          hidden
          onChange={(e) => handleFileUpload(e.target.files)}
        />
        <CloudUpload className="h-8 w-8 text-primary" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">
          Click to upload file
        </span>
      </label>

      {/* Duplicate file dialog */}
      {isDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-background/80"
            onClick={handleCancelReplace}
            aria-hidden="true"
          />
          <div
            className="relative z-50 bg-background border border-border rounded-xl p-6 max-w-md w-full shadow-lg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
          >
            <h3
              id="dialog-title"
              className="text-lg font-semibold text-foreground"
            >
              File Exists
            </h3>
            <p className="text-sm text-muted-foreground mt-2">
              A file with the name &quot;{duplicateFile?.name}&quot; already
              exists. Do you want to replace it?
            </p>
            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={handleCancelReplace}
                className="px-4 py-2 text-sm font-medium rounded-md border border-border text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmReplace}
                className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Uploaded files heading */}
      <p className="text-sm font-semibold text-foreground mt-4">
        Uploaded Files
      </p>

      {/* File table */}
      {!loading ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-sm font-medium text-muted-foreground py-2 text-left pl-3">
                  File Name
                </th>
                <th className="text-sm font-medium text-muted-foreground py-2 text-center">
                  Uploaded
                </th>
                <th className="text-sm font-medium text-muted-foreground py-2 text-center">
                  Generated Embedding
                </th>
                <th className="text-sm font-medium text-muted-foreground py-2 text-center">
                  Description
                </th>
                <th className="text-sm font-medium text-muted-foreground py-2 text-right pr-3">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {[...files, ...savedFiles, ...newFiles].length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="text-sm text-muted-foreground text-center py-4"
                  >
                    No files found
                  </td>
                </tr>
              ) : (
                [...files, ...savedFiles, ...newFiles]
                  .sort((a, b) => {
                    if (newFiles.includes(a) && !newFiles.includes(b)) return 1;
                    if (!newFiles.includes(a) && newFiles.includes(b))
                      return -1;

                    const nameA = a.fileName || a.name;
                    const nameB = b.fileName || b.name;

                    if (nameA < nameB) return -1;
                    if (nameA > nameB) return 1;

                    return 0;
                  })
                  .map((file, index) => {
                    const fileName = file.fileName || file.name;
                    const cleanedName = cleanFileName(fileName);

                    // Find this file's upload state (match by fileName)
                    const uploadState = Object.values(uploadStates || {}).find(
                      (u) => u.fileName === file.name || u.fileName === fileName
                    );

                    // Find this file's processing state (match by fileId from upload)
                    const fileId = uploadState?.fileId;
                    const processingState = fileId
                      ? (processingStates || {})[fileId]
                      : null;

                    // Determine upload column status
                    const isNewFile = newFiles.includes(file);
                    const isExistingFile = !isNewFile;

                    return (
                      <tr key={index} className="border-b border-border">
                        {/* File Name */}
                        <td className="text-sm py-3 pl-3">
                          <span
                            className={
                              isNewFile
                                ? "text-destructive font-medium"
                                : "text-foreground"
                            }
                          >
                            {cleanedName}
                          </span>
                        </td>

                        {/* Uploaded column */}
                        <td className="py-3 px-2">
                          <div className="flex items-center justify-center gap-2">
                            {isExistingFile ? (
                              <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="Uploaded" />
                            ) : uploadState?.status === "uploading" ? (
                              <div className="flex items-center gap-2 w-full max-w-[120px]">
                                <Progress value={uploadState.progress} className="flex-1 h-2" />
                                <span className="text-xs text-muted-foreground whitespace-nowrap">{uploadState.progress}%</span>
                              </div>
                            ) : uploadState?.status === "upload_complete" ? (
                              <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="Upload complete" />
                            ) : uploadState?.status === "upload_failed" ? (
                              <AlertCircle className="h-4 w-4 text-destructive" aria-label={uploadState.error || "Upload failed"} title={uploadState.error || "Upload failed"} />
                            ) : (
                              <span className="text-xs text-muted-foreground">Pending</span>
                            )}
                          </div>
                        </td>

                        {/* Generated Embedding column */}
                        <td className="py-3 px-2">
                          <div className="flex items-center justify-center gap-2">
                            {isExistingFile ? (
                              <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="Embeddings generated" />
                            ) : processingState?.status === "complete" ? (
                              <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="Embeddings generated" />
                            ) : processingState?.status === "processing" || processingState?.status === "pending" ? (
                              <div className="flex items-center gap-2 w-full max-w-[120px]">
                                <Progress indeterminate className="flex-1 h-2" />
                              </div>
                            ) : processingState?.status === "failed" ? (
                              <AlertCircle className="h-4 w-4 text-destructive" aria-label="Processing failed" title="Embedding generation failed" />
                            ) : processingState?.status === "not_found" ? (
                              <div className="flex items-center gap-2 w-full max-w-[120px]">
                                <Progress indeterminate className="flex-1 h-2" />
                              </div>
                            ) : processingState?.status === "timed_out" ? (
                              <Clock className="h-4 w-4 text-yellow-600" aria-label="Taking longer than expected" title="Taking longer than expected" />
                            ) : uploadState && !processingState ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : isExistingFile ? (
                              <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="Embeddings generated" />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </div>
                        </td>

                        {/* Description */}
                        <td className="py-3 px-2">
                          <textarea
                            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                            placeholder="Enter File Description"
                            rows={1}
                            maxLength={100}
                            value={metadata[fileName] || ""}
                            onChange={(e) =>
                              handleMetadataChange(fileName, e.target.value)
                            }
                          />
                        </td>

                        {/* Actions */}
                        <td className="py-3 pr-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                if (file && file.url && file.url !== "dummy")
                                  handleDownloadClick(file.url);
                                else handleDownloadFile(file);
                              }}
                              className="p-2 rounded-md hover:bg-muted transition-colors"
                              aria-label={`Download ${cleanedName}`}
                              title="Download"
                            >
                              <Download className="h-4 w-4 text-foreground" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete ${cleanedName}`}
                              title="Remove"
                              onClick={() => {
                                if (newFiles.includes(file))
                                  handleRemoveNewFile(fileName);
                                else if (savedFiles.includes(file))
                                  handleSavedRemoveFile(fileName);
                                else handleRemoveFile(fileName);
                              }}
                              className="p-2 rounded-md hover:bg-muted transition-colors"
                            >
                              <Trash2
                                className="h-4 w-4 text-destructive"
                                aria-hidden="true"
                              />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mt-2">Loading...</p>
      )}
    </div>
  );
};

export default FileManagement;
