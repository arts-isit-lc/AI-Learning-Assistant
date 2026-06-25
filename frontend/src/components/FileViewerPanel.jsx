import { useState, useCallback, useEffect } from "react";
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
  Download,
  Image,
  FileCode,
} from "lucide-react";

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// File type categories for rendering strategy
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"]);
const TEXT_EXTENSIONS = new Set(["txt", "csv", "json", "tex", "latex", "html", "htm"]);
const PDF_EXTENSIONS = new Set(["pdf"]);

function getFileCategory(filetype) {
  const ext = (filetype || "").toLowerCase();
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "download";
}

function getFileIcon(filetype) {
  const category = getFileCategory(filetype);
  switch (category) {
    case "image":
      return Image;
    case "text":
      return FileCode;
    case "pdf":
      return FileText;
    default:
      return FileText;
  }
}

// --- Sub-viewers ---

const PdfViewer = ({ fileUrl, zoom }) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(null);
  const [error, setError] = useState(null);

  const onDocumentLoadSuccess = useCallback(({ numPages }) => {
    setTotalPages(numPages);
    setError(null);
  }, []);

  const onDocumentLoadError = useCallback((err) => {
    setError(err);
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 text-center p-4">
        <p className="text-sm text-destructive-foreground">Failed to load PDF.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-grow overflow-auto flex justify-center p-4">
        <Document
          file={fileUrl}
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
      </div>

      {totalPages && (
        <div className="flex items-center justify-center gap-1 p-2 border-t border-border">
          <button
            onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
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
            onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
            disabled={currentPage >= totalPages}
            className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight className="w-4 h-4 text-foreground" />
          </button>
        </div>
      )}
    </div>
  );
};

const ImageViewer = ({ fileUrl, zoom }) => {
  const [error, setError] = useState(false);

  return (
    <div className="flex-grow overflow-auto flex items-center justify-center p-4">
      {error ? (
        <div className="flex flex-col items-center justify-center gap-4 text-center">
          <p className="text-sm text-destructive-foreground">Failed to load image.</p>
        </div>
      ) : (
        <img
          src={fileUrl}
          alt="Uploaded file"
          className="max-w-full max-h-full object-contain rounded"
          style={{ transform: `scale(${zoom / 100})`, transformOrigin: "center" }}
          onError={() => setError(true)}
        />
      )}
    </div>
  );
};

const TextViewer = ({ fileUrl, filetype }) => {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!fileUrl) return;
    setLoading(true);
    setError(null);

    fetch(fileUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [fileUrl]);

  if (loading) {
    return (
      <div className="flex-grow p-4">
        <div className="h-4 w-3/4 bg-muted rounded animate-pulse mb-2" />
        <div className="h-4 w-1/2 bg-muted rounded animate-pulse mb-2" />
        <div className="h-4 w-2/3 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 text-center p-4">
        <p className="text-sm text-destructive-foreground">Failed to load file content.</p>
      </div>
    );
  }

  const isHtml = filetype === "html" || filetype === "htm";

  if (isHtml) {
    return (
      <div className="flex-grow overflow-auto p-4">
        <iframe
          srcDoc={content}
          title="HTML preview"
          className="w-full h-full border border-border rounded bg-background"
          sandbox="allow-same-origin"
          style={{ minHeight: "400px" }}
        />
      </div>
    );
  }

  // CSV: render as a basic table
  if (filetype === "csv") {
    return <CsvTable content={content} />;
  }

  // JSON: pretty-print
  const displayContent = filetype === "json" ? formatJson(content) : content;

  return (
    <div className="flex-grow overflow-auto p-4">
      <pre className="text-sm text-foreground bg-muted rounded p-4 overflow-auto whitespace-pre-wrap break-words font-mono">
        {displayContent}
      </pre>
    </div>
  );
};

const CsvTable = ({ content }) => {
  const rows = content
    .split("\n")
    .filter((row) => row.trim())
    .map((row) => row.split(","));

  if (rows.length === 0) {
    return (
      <div className="flex-grow p-4">
        <p className="text-sm text-muted-foreground">Empty CSV file.</p>
      </div>
    );
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);

  return (
    <div className="flex-grow overflow-auto p-4">
      <div className="border border-border rounded overflow-auto max-h-full">
        <table className="w-full text-sm">
          <thead className="bg-muted sticky top-0">
            <tr>
              {headers.map((header, i) => (
                <th
                  key={i}
                  className="px-3 py-2 text-left font-medium text-foreground border-b border-border whitespace-nowrap"
                >
                  {header.trim()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataRows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-muted/50 transition-colors">
                {row.map((cell, cellIdx) => (
                  <td
                    key={cellIdx}
                    className="px-3 py-2 text-foreground border-b border-border whitespace-nowrap"
                  >
                    {cell.trim()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const DownloadFallback = ({ fileUrl, file }) => (
  <div className="flex-grow flex flex-col items-center justify-center gap-4 p-6">
    <div className="p-4 bg-muted rounded-full">
      <FileText className="w-8 h-8 text-muted-foreground" />
    </div>
    <div className="text-center">
      <p className="text-sm font-medium text-foreground">
        {file?.filename}.{file?.filetype}
      </p>
      <p className="text-xs text-muted-foreground mt-1">
        Preview not available for this file type
      </p>
    </div>
    <a
      href={fileUrl}
      download={`${file?.filename}.${file?.filetype}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded hover:opacity-90 transition-opacity"
    >
      <Download className="w-4 h-4" />
      Download File
    </a>
  </div>
);

function formatJson(content) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

// --- Main Component ---

const FileViewerPanel = ({
  file,
  fileUrl,
  files,
  onFileSelect,
  onClose,
  onRetry,
  loading,
}) => {
  const [zoom, setZoom] = useState(100);

  const fileCategory = getFileCategory(file?.filetype);
  const FileIcon = getFileIcon(file?.filetype);

  const handleFileSwitch = (fileId) => {
    setZoom(100);
    onFileSelect(fileId);
  };

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 25, 200));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 25, 50));
  const handleZoomReset = () => setZoom(100);

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

  const showZoomControls = fileCategory === "pdf" || fileCategory === "image";

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
          <FileIcon className="w-4 h-4 text-muted-foreground shrink-0" />
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

        {/* Download button */}
        {fileUrl && (
          <a
            href={fileUrl}
            download={`${file?.filename}.${file?.filetype}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 rounded hover:bg-muted transition-colors"
            aria-label="Download file"
            title="Download file"
          >
            <Download className="w-4 h-4 text-muted-foreground" />
          </a>
        )}

        {/* Close button (desktop) */}
        <button
          onClick={onClose}
          className="hidden md:flex p-1 rounded hover:bg-muted transition-colors"
          aria-label="Close file viewer"
          title="Close file viewer"
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-grow overflow-hidden flex flex-col">
        {!fileUrl ? (
          <div className="flex flex-col items-center justify-center gap-4 text-center flex-grow p-4">
            <p className="text-sm text-destructive-foreground">Failed to load file.</p>
            <button
              onClick={onRetry}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded hover:opacity-90 transition-opacity"
            >
              <RotateCcw className="w-4 h-4" />
              Retry
            </button>
          </div>
        ) : fileCategory === "pdf" ? (
          <PdfViewer fileUrl={fileUrl} zoom={zoom} />
        ) : fileCategory === "image" ? (
          <ImageViewer fileUrl={fileUrl} zoom={zoom} />
        ) : fileCategory === "text" ? (
          <TextViewer fileUrl={fileUrl} filetype={file?.filetype} />
        ) : (
          <DownloadFallback fileUrl={fileUrl} file={file} />
        )}
      </div>

      {/* Footer: Zoom controls (PDF and images only) */}
      {showZoomControls && fileUrl && (
        <div className="flex items-center justify-center gap-1 p-2 border-t border-border">
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
      )}
    </div>
  );
};

export default FileViewerPanel;
