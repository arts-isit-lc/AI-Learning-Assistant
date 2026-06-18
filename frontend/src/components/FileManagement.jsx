import { useState } from "react";
import { Trash2, CloudUpload, Download } from "lucide-react";
import { toast } from "react-toastify";

import { cleanFileName } from "../utils/fileHelpers";
import FileProgressRow from "./FileProgressRow";

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
        <div className="mx-8 mt-2">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-sm font-medium text-muted-foreground py-2 text-center">
                  File Name
                </th>
                <th className="text-sm font-medium text-muted-foreground py-2 text-center">
                  File Description
                </th>
                <th className="text-sm font-medium text-muted-foreground py-2 text-right pr-4">
                  Download
                </th>
                <th className="text-sm font-medium text-muted-foreground py-2 text-right">
                  Remove
                </th>
              </tr>
            </thead>
            <tbody>
              {[...files, ...savedFiles, ...newFiles].length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
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
                    return (
                      <tr key={index} className="border-b border-border">
                        <td className="text-sm py-3 text-center">
                          <span
                            className={
                              newFiles.includes(file)
                                ? "text-destructive"
                                : "text-foreground"
                            }
                          >
                            {cleanFileName(fileName)}
                          </span>
                        </td>
                        <td className="py-3">
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
                        <td className="py-3 text-right pr-4">
                          <button
                            type="button"
                            onClick={() => {
                              if (file && file.url && file.url !== "dummy")
                                handleDownloadClick(file.url);
                              else handleDownloadFile(file);
                            }}
                            className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                          >
                            <Download className="h-4 w-4" aria-hidden="true" />
                            Download
                          </button>
                        </td>
                        <td className="py-3 text-right">
                          <button
                            type="button"
                            aria-label={`Delete ${cleanFileName(fileName)}`}
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

      {/* Active upload/processing progress indicators */}
      {Object.values(uploadStates || {}).length > 0 ||
      Object.values(processingStates || {}).length > 0 ? (
        <div className="flex flex-col gap-2 mt-4">
          {/* Show upload progress for files currently uploading */}
          {Object.values(uploadStates || {}).map((fileState) => (
            <FileProgressRow
              key={fileState.fileId}
              fileName={fileState.fileName}
              status={fileState.status}
              progress={fileState.progress}
              error={fileState.error}
              onAbort={() => onAbortFile?.(fileState.fileId)}
              onRetry={() => onRetryFile?.(fileState.fileId)}
              onRemove={() => onRemoveTrackedFile?.(fileState.fileId)}
            />
          ))}
          {/* Show processing progress for files being processed */}
          {Object.values(processingStates || {})
            .filter((f) => f.status !== "complete")
            .map((fileState) => (
              <FileProgressRow
                key={fileState.fileId}
                fileName={fileState.fileName || fileState.fileId}
                status={fileState.status}
                progress={0}
                error={null}
                notFoundContext={getNotFoundContext?.(fileState.fileId)}
                onRemove={() => onRemoveTrackedFile?.(fileState.fileId)}
              />
            ))}
        </div>
      ) : null}
    </div>
  );
};

export default FileManagement;
