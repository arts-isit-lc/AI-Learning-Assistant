import { useState, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  X,
  FileText,
  RotateCcw,
  ArrowLeft,
} from "lucide-react";

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const PdfViewerPanel = ({
  file,
  pdfUrl,
  files,
  onFileSelect,
  onClose,
  onRetry,
  loading,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(null);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState(null);

  const onDocumentLoadSuccess = useCallback(({ numPages }) => {
    setTotalPages(numPages);
    setError(null);
  }, []);

  const onDocumentLoadError = useCallback((err) => {
    setError(err);
  }, []);

  const handlePrevPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages || prev));
  };

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(prev + 25, 200));
  };

  const handleZoomOut = () => {
    setZoom((prev) => Math.max(prev - 25, 50));
  };

  const handleZoomReset = () => {
    setZoom(100);
  };

  const handleFileSwitch = (fileId) => {
    setCurrentPage(1);
    setTotalPages(null);
    setZoom(100);
    setError(null);
    onFileSelect(fileId);
  };

  const handleRetry = () => {
    setError(null);
    onRetry();
  };

  // Loading skeleton state
  if (loading) {
    return (
      <div className="flex flex-col h-full bg-background border-l border-border">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <div className="h-4 w-32 bg-muted rounded animate-pulse" />
          <div className="h-6 w-6 bg-muted rounded animate-pulse" />
        </div>
        <div className="flex-grow flex items-center justify-center p-4">
          <div className="h-full w-full bg-muted rounded animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background border-l border-border fixed inset-0 z-50 md:relative md:z-auto">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border gap-2">
        {/* Mobile back button */}
        <button
          onClick={onClose}
          className="md:hidden p-1 rounded hover:bg-muted transition-colors"
          aria-label="Back to chat"
        >
          <ArrowLeft className="w-5 h-5 text-foreground" />
        </button>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium text-foreground truncate">
            {file?.filename}.{file?.filetype}
          </span>
        </div>

        {/* File switcher */}
        {files && files.length > 1 && (
          <select
            className="text-xs bg-secondary text-secondary-foreground border border-border rounded px-2 py-1 max-w-24"
            value={file?.file_id || ""}
            onChange={(e) => handleFileSwitch(e.target.value)}
            aria-label="Switch file"
          >
            {files.map((f) => (
              <option key={f.file_id} value={f.file_id}>
                {f.filename}
              </option>
            ))}
          </select>
        )}

        {/* Close button (desktop) */}
        <button
          onClick={onClose}
          className="hidden md:flex p-1 rounded hover:bg-muted transition-colors"
          aria-label="Close PDF viewer"
          title="Close PDF viewer"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* PDF Content */}
      <div className="flex-grow overflow-auto flex justify-center p-4">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-destructive-foreground">
              Failed to load PDF.
            </p>
            <button
              onClick={handleRetry}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded hover:opacity-90 transition-opacity"
            >
              <RotateCcw className="w-4 h-4" />
              Retry
            </button>
          </div>
        ) : (
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="flex items-center justify-center h-64">
                <div className="h-64 w-48 bg-muted rounded animate-pulse" />
              </div>
            }
          >
            <Page
              pageNumber={currentPage}
              scale={zoom / 100}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              loading={
                <div className="h-64 w-48 bg-muted rounded animate-pulse" />
              }
            />
          </Document>
        )}
      </div>

      {/* Footer Controls */}
      {!error && totalPages && (
        <div className="flex items-center justify-between p-2 border-t border-border">
          {/* Page navigation */}
          <div className="flex items-center gap-1">
            <button
              onClick={handlePrevPage}
              disabled={currentPage <= 1}
              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
              aria-label="Previous page"
              title="Previous page"
            >
              <ChevronLeft className="w-4 h-4 text-foreground" />
            </button>
            <span className="text-xs text-muted-foreground min-w-16 text-center">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={handleNextPage}
              disabled={currentPage >= totalPages}
              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
              aria-label="Next page"
              title="Next page"
            >
              <ChevronRight className="w-4 h-4 text-foreground" />
            </button>
          </div>

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={handleZoomOut}
              disabled={zoom <= 50}
              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
              aria-label="Zoom out"
              title="Zoom out"
            >
              <ZoomOut className="w-4 h-4 text-foreground" />
            </button>
            <button
              onClick={handleZoomReset}
              className="text-xs text-muted-foreground min-w-10 text-center hover:text-foreground transition-colors"
              aria-label="Reset zoom"
              title="Reset zoom to 100%"
            >
              {zoom}%
            </button>
            <button
              onClick={handleZoomIn}
              disabled={zoom >= 200}
              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
              aria-label="Zoom in"
              title="Zoom in"
            >
              <ZoomIn className="w-4 h-4 text-foreground" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PdfViewerPanel;
