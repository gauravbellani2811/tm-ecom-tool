import { compressImage } from "./compressImage";

function uuid() {
  return "f_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function baseName(name) {
  return (name || "fabric").replace(/\.[^.]+$/, "");
}

// Build a fabric-queue object from a File (compressed). Shared by the drop-zone
// and the Waitlist pull so both produce identical queue entries.
export async function makeFabric(file, name) {
  const compressed = await compressImage(file, 1600, 0.9);
  return {
    id: uuid(),
    file: compressed,
    previewUrl: URL.createObjectURL(compressed),
    name: baseName(name || file.name),
    status: "pending",
    results: [],
    // Optional caption facts — when any are filled, the backend writes a title/description.
    colour: "",
    adjective: "",
    fabricType: "", // "Material" in the UI
    tags: ["", "", ""],
    // Optional close-up detail photo (embroidery/texture) → sent as Gemini IMAGE 3.
    detailFile: null,
    detailPreviewUrl: null,
  };
}
