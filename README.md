# Fabric Styler

Upload a flat fabric photo and get back AI-composited product shots using your saved template scenes.

## Setup

### Backend

```bash
cd fabric-styler/backend
npm install
cp .env.example .env
```

Open `.env` and add your Gemini API key:
```
GEMINI_API_KEY=your_actual_key_here
```

Get a key at: https://aistudio.google.com/app/apikey

Start the server:
```bash
node server.js
```

The server runs on `http://localhost:3001`. A `templates/` folder will be created automatically.

### Frontend

```bash
cd fabric-styler/frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

## Usage

1. **Add template scenes** — Click the "+" slots to upload 1–3 styled product scene photos (e.g. a fabric draped in a basket scene). Name each one when prompted.
2. **Upload your fabric** — Drag and drop or click to upload a flat photo of your fabric pattern.
3. **Generate** — Click "Generate Styled Photos". The Gemini API will composite your fabric into each template scene. This may take up to 60 seconds per template.
4. **Download** — Click "Download JPG" on any result card to save the image.

## Notes

- Requires the `gemini-2.0-flash-preview-image-generation` model (image generation capability).
- Templates are stored persistently in `backend/templates/`.
- Generated images are returned directly and not stored on disk.
