import React, { useRef, useState } from "react";

export default function FabricUploader({ fabricPreview, onFileSelect }) {
  const inputRef = useRef();
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(files) {
    const file = files[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      alert("Please upload a jpg, png, or webp image.");
      return;
    }
    onFileSelect(file);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div>
      <div className="section-title">Your Fabric</div>
      <div
        className={`fabric-dropzone${dragOver ? " drag-over" : ""}${fabricPreview ? " has-preview" : ""}`}
        onClick={() => inputRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: "none" }}
          onChange={e => handleFiles(e.target.files)}
        />
        {fabricPreview ? (
          <>
            <img src={fabricPreview} alt="Fabric preview" className="fabric-preview-img" />
            <div className="fabric-preview-overlay">Click to replace</div>
          </>
        ) : (
          <div className="fabric-dropzone-inner">
            <span className="upload-icon">⬆</span>
            <span>Drop your fabric photo here</span>
            <span className="hint">or click to browse — jpg, png, webp</span>
          </div>
        )}
      </div>
    </div>
  );
}
