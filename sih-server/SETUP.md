# YUKTI setup

## 1. Create the server environment

Open PowerShell in `C:\Users\shivo\OneDrive\Desktop\sih-server` and run:

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

If the old `venv` directory shows `Access is denied`, do not use it. The commands above use a new `.venv` directory.

## 2. Configure Gemini API

Copy `.env.example` to `.env`, then set a real API key:

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
GEMINI_MODEL=gemini-2.5-flash
```

Remove the old `EXPLABS_*`, `OPENAI_*`, and `ANTHROPIC_*` values from `.env`; the server uses `GEMINI_API_KEY`.

## 3. Start the server

```powershell
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Open `http://127.0.0.1:8000/`. Expected response: `{"status":"ok","model":"gemini-2.5-flash"}`.

## 4. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select `C:\Users\shivo\OneDrive\Desktop\sih-extension`.
5. Open Gmail, click the YUKTI extension icon, and use the side panel.

## 5. Test safely

Use: `Open the latest email and draft a short polite reply saying I will review it today.`

The agent may open Reply and write the draft. Sending always requires a browser confirmation prompt. Do not test on a real customer or sensitive email first.
