import os
import json
import io
import re
import time
import base64
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from ultralytics import YOLO
from PIL import Image, ImageDraw
import numpy as np
import easyocr
from google import genai
from google.genai import types

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load models once at server startup
omniparser_model = YOLO("omniparser_weights/icon_detect/model.pt")
ocr_reader = easyocr.Reader(['en'], gpu=True)  # set gpu=False if this errors out

# Regex patterns to catch PII inside OCR-read text
PII_PATTERNS = [
    re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'),  # email
    re.compile(r'(?<!\d)[6-9]\d{9}(?!\d)'),                          # phone (Indian)
    re.compile(r'\b(?:\d[ -]?){13,16}\b'),                           # card number
    re.compile(r'\b\d{4}\s?\d{4}\s?\d{4}\b'),                        # aadhaar
    re.compile(r'\b[A-Z]{5}\d{4}[A-Z]\b'),                           # PAN card
]

# Initialize Google GenAI Client
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")


def redact_pii_with_ocr(pil_image):
    """Scans the image pixels for text (OCR), finds PII patterns, and blacks them out."""
    image_np = np.array(pil_image.convert("RGB"))
    ocr_results = ocr_reader.readtext(image_np)

    draw = ImageDraw.Draw(pil_image)
    redacted_count = 0

    for (bbox, text, confidence) in ocr_results:
        is_sensitive = any(pattern.search(text) for pattern in PII_PATTERNS)
        if is_sensitive:
            xs = [point[0] for point in bbox]
            ys = [point[1] for point in bbox]
            x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
            draw.rectangle([x1, y1, x2, y2], fill="black")
            redacted_count += 1

    return pil_image, redacted_count


def call_gemini_with_retry(model_name, image_bytes, prompt_text, max_retries=3):
    """Calls Google Gemini with an optional image,
    retrying on transient network/connection errors.
    """
    last_error = None
    for attempt in range(max_retries):
        try:
            contents = []
            if image_bytes is not None:
                contents.append(types.Part.from_bytes(data=image_bytes, mime_type="image/png"))
            contents.append(prompt_text)

            response = client.models.generate_content(
                model=model_name,
                contents=contents,
            )
            return response.text
        except Exception as e:
            last_error = e
            wait_time = 2 * (attempt + 1)
            print(f"Gemini call failed (attempt {attempt + 1}/{max_retries}): {e}. Retrying in {wait_time}s...")
            time.sleep(wait_time)
    raise last_error


def clean_json_response(raw_text):
    raw_text = raw_text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
        raw_text = raw_text.strip()
    return raw_text


@app.get("/")
def health_check():
    return {"status": "Server is running"}


# ------------------------------------------------------------------------
# /analyze — single-shot screen analysis (kept for standalone testing via /docs)
# ------------------------------------------------------------------------
@app.post("/analyze")
async def analyze_screen(file: UploadFile = File(...)):
    image_bytes = await file.read()
    image = Image.open(io.BytesIO(image_bytes))

    image, ocr_redacted_count = redact_pii_with_ocr(image)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    final_image_bytes = buffer.getvalue()

    omni_results = omniparser_model(image)
    detected_boxes = []
    for result in omni_results:
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            confidence = box.conf[0].item()
            detected_boxes.append({"box": [round(x1), round(y1), round(x2), round(y2)], "confidence": round(confidence, 2)})

    prompt = (
        f"This is a redacted screenshot of a webpage (sensitive fields like "
        f"passwords, emails, and faces are blacked out for privacy). "
        f"A local vision model detected {len(detected_boxes)} interactive UI elements. "
        "Analyze the visible UI structure and suggest ONE clear next action. "
        "Respond ONLY with valid JSON, no other text: "
        '{"description": "brief description of the page", '
        '"action": "click" or "scroll" or "type", '
        '"target_text": "exact visible text on the button/element to interact with"}'
    )

    raw_text = call_gemini_with_retry(GEMINI_MODEL, final_image_bytes, prompt)
    raw_text = clean_json_response(raw_text)

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        parsed = {"description": raw_text, "action": "none", "target_text": ""}

    parsed["detected_elements_count"] = len(detected_boxes)
    parsed["omniparser_boxes"] = detected_boxes
    parsed["ocr_pii_redacted_count"] = ocr_redacted_count

    return parsed


# ------------------------------------------------------------------------
# /next_step — the core agent loop endpoint used by the side panel.
#
# PRIVACY CONTRACT: this endpoint NEVER receives actual private values.
# - "elements" contains only {index, tag, type, label, profileCategory,
#   required, filled}. The `index` field is just the element's position on
#   the page (not private) — it lets the model point at the exact element
#   it means so the extension clicks precisely instead of re-guessing by
#   fuzzy text search. The `profileCategory` field (e.g. "email") tells the
#   model WHICH KIND of profile data this field expects — never the actual
#   value. `required`/`filled` are booleans describing the field's current
#   state on the page — also never private data — added so the model can
#   see which fields still need attention instead of guessing the form is
#   complete.
# - "profile_keys" contains only the NAMES of profile fields that exist
#   locally (e.g. ["name", "email", "github"]) — never their values.
# - When the model wants to fill a profile-linked field, it must return
#   action "fill" with a "valueSource" key (one of profile_keys), NOT a
#   literal value. The extension resolves valueSource -> actual value
#   entirely on the client, after this response leaves the server.
# ------------------------------------------------------------------------
@app.post("/next_step")
async def next_step(
    file: UploadFile = File(None),
    command: str = Form(...),
    elements: str = Form(...),
    history: str = Form(...),
    current_url: str = Form(""),
    products: str = Form("[]"),
    profile_keys: str = Form("[]")
):
    if file:
        image_bytes = await file.read()
    else:
        image_bytes = None

    elements_list = json.loads(elements)
    history_list = json.loads(history)
    products_list = json.loads(products)
    profile_keys_list = json.loads(profile_keys)

    # Build the elements text, surfacing the profileCategory hint AND a
    # [REQUIRED-EMPTY] / [EMPTY] tag when the field still needs a value.
    # This is what lets the model actually see "this one isn't done yet"
    # instead of inferring form completeness purely from the screenshot.
    elements_lines = []
    required_empty_labels = []
    for e in elements_list:
        cat_hint = f" [profile field: {e['profileCategory']}]" if e.get('profileCategory') else ""
        idx = e.get('index')
        idx_prefix = f"[{idx}] " if idx is not None else ""
        is_required = bool(e.get('required'))
        is_filled = bool(e.get('filled'))
        state_hint = ""
        if is_required and not is_filled:
            state_hint = " [REQUIRED-EMPTY]"
            required_empty_labels.append(e['label'])
        elif e.get('profileCategory') and not is_filled:
            state_hint = " [EMPTY]"
        elements_lines.append(f"{idx_prefix}[{e['tag']}] \"{e['label']}\"{cat_hint}{state_hint}")
    elements_text = "\n".join(elements_lines)

    required_empty_text = (
        ", ".join(f'"{l}"' for l in required_empty_labels)
        if required_empty_labels else "(none currently visible)"
    )

    history_text = "\n".join(history_list) if history_list else "(no actions taken yet)"

    if products_list:
        products_text = "\n".join(
            f"- {p['title']} | {p['price']}" + (f" | rating {p['rating']}" if p.get('rating') else "")
            for p in products_list
        )
    else:
        products_text = "(no products detected on current view)"

    already_searched = any("press_enter" in h or "type" in h for h in history_list)
    scroll_count = sum(1 for h in history_list if h.startswith("scroll"))
    shopping_keywords = ["buy", "purchase", "cart", "checkout", "price", "₹", "order", "add to cart"]
    is_shopping_task = any(kw in command.lower() for kw in shopping_keywords) or bool(products_list)

    profile_keys_text = ", ".join(profile_keys_list) if profile_keys_list else "(no resume/profile uploaded locally)"

    prompt = (
        f"You are YUKTI, a fast and accurate browser automation agent working like a "
        f"skilled, careful human assistant.\n\n"
        f"USER'S GOAL: \"{command}\"\n\n"
        f"ACTIONS TAKEN SO FAR:\n{history_text}\n\n"
        f"Has a search already been submitted this session: {'YES' if already_searched else 'NO'}\n"
        f"Number of scrolls already performed: {scroll_count}\n"
        f"Is this a shopping/product-comparison task: {'YES' if is_shopping_task else 'NO'}\n\n"
        f"LOCAL PROFILE FIELDS AVAILABLE (names only — you never see the actual values): "
        f"{profile_keys_text}\n\n"
        f"REQUIRED FIELDS STILL EMPTY ON THIS SCREEN: {required_empty_text}\n\n"
        f"PRODUCTS VISIBLE ON CURRENT SCREEN (only relevant for shopping tasks):\n{products_text}\n\n"
        f"CURRENT SCREEN'S INTERACTIVE ELEMENTS (search-related listed first; elements tagged "
        f"'[profile field: X]' correspond to a local profile field X; '[REQUIRED-EMPTY]' means the "
        f"field is mandatory and currently blank; '[EMPTY]' means it maps to a profile field you "
        f"have data for but it hasn't been filled in yet):\n"
        f"{elements_text if elements_text else '(none detected — page may be blank or a browser internal page)'}\n\n"
        "DECISION RULES, in priority order:\n"
        "1. If the current page is unrelated to the goal, blank, or a browser internal page, "
        "and the task requires visiting a specific website/form, return ONE step: "
        "{\"steps\": [{\"action\": \"navigate\", \"url\": \"https://...\"}]}.\n"
        "2. If an element is tagged with a '[profile field: X]' hint AND X appears in the "
        "LOCAL PROFILE FIELDS AVAILABLE list, and this task involves filling a form with the "
        "user's personal details, return action \"fill\" with \"valueSource\": \"X\" for that "
        "field. NEVER invent or guess the actual value yourself — you do not have it. "
        "Example: {\"action\": \"fill\", \"target_text\": \"Email\", \"valueSource\": \"email\"}.\n"
        "3. For radio buttons, checkboxes, or dropdowns without a profile-field hint, use "
        "action \"fill\" with a literal \"value\" matching one of the visible options (this is "
        "not private data, so a literal value is fine here) — e.g. selecting a Yes/No choice.\n"
        "4. For search tasks, if a search has NOT been submitted yet and a search box is "
        "available, your priority is to search: return a batch of "
        "[{\"action\": \"type\", \"target_text\": \"<search box label>\", \"value\": \"<search terms>\"}, "
        "{\"action\": \"press_enter\", \"target_text\": \"<search box label>\"}]. Do NOT scroll before searching.\n"
        "5. After searching, if the PRODUCTS list is empty or has fewer than 3 items on a "
        "shopping task, return a SINGLE step {\"action\": \"scroll\"} to reveal more results. "
        "For non-shopping tasks, do not scroll repeatedly — act on what's already visible "
        "after at most 1 scroll. If scroll_count is already 2 or more, STOP scrolling and act "
        "on the best available option now.\n"
        "6. Once enough products are visible, compare them against the user's constraints "
        "(price/rating) and click the best match's title/link or 'Add to Cart' button.\n"
        "6.5. ANY element tagged '[REQUIRED-EMPTY]' or '[EMPTY]' on a form-filling task takes "
        "priority over everything below except rule 1 — fill those fields THIS round, before "
        "considering Submit/Next/Continue/Save/Apply/Send/Done. If several are empty, batch as "
        "many 'fill' steps for them as you can (one per element) in this response.\n"
        "7. If the screen shows a normal non-payment form with a final 'Submit', 'Send', "
        "'Apply', 'Save', 'Continue', 'Next', or similar button, click it ONLY when: (a) doing "
        "so directly completes the user's stated task, AND (b) the REQUIRED FIELDS STILL EMPTY "
        "list above is empty AND no element in the elements list is tagged '[REQUIRED-EMPTY]' or "
        "'[EMPTY]'. If any such field remains, do NOT click Submit/Next/Continue/Save/Apply/Send/ "
        "Done under any circumstance this round — fill the missing field(s) instead (rule 6.5). "
        "Do NOT click buttons that initiate payment, purchase, checkout, or financial "
        "transactions. If payment or purchase would occur, return "
        "{\"action\": \"confirm_needed\", \"reasoning\": \"<explain what payment action would occur>\"} "
        "and wait for explicit approval.\n"
        "8. Never invent elements — use ONLY the exact 'label' text from the elements list for "
        "target_text (except for navigate, finish, confirm_needed, and page-level scroll). "
        "ALSO include that same element's 'target_index' — the number shown in [] at the very "
        "start of its line in the elements list above — copied exactly, never guessed. This is "
        "REQUIRED together with target_text for click/type/press_enter/fill/scroll-to-element "
        "(omit both only for navigate, finish, confirm_needed, and page-level scroll). The index "
        "is what actually gets clicked, so if two elements have similar-looking text (e.g. two "
        "different people's 'Follow' buttons), the index is what tells them apart — get it right. "
        "NEVER put an actual name, email, phone number, or other personal value directly in "
        "'value' — if the field is a profile field, use 'valueSource' instead.\n"
        "9. Plan the NEXT 1 to 3 steps only. Return a single 'finish' step only when the goal "
        "is fully achieved, no '[REQUIRED-EMPTY]' or '[EMPTY]' tags remain in the elements list, "
        "or the task was correctly halted at a safety checkpoint.\n\n"
        "Respond ONLY with valid JSON, no other text, no markdown fences, in this exact format: "
        '{"steps": [{"action": "navigate" or "click" or "type" or "press_enter" or "scroll" or '
        '"fill" or "confirm_needed" or "finish", '
        '"url": "only for navigate", '
        '"target_text": "exact label from the elements list, omit for navigate/finish/confirm_needed/page-scroll", '
        '"target_index": "the [number] shown before that element in the elements list, same omit rule as target_text — REQUIRED whenever target_text is given", '
        '"value": "literal value — ONLY for non-personal fields like search terms or radio/checkbox options", '
        '"valueSource": "profile field NAME — ONLY for personal-data fields, e.g. \'email\'", '
        '"reasoning": "short reason for this step"}]}'
    )

    raw_text = call_gemini_with_retry(GEMINI_MODEL, image_bytes, prompt)
    raw_text = clean_json_response(raw_text)

    try:
        parsed = json.loads(raw_text)
        if "steps" not in parsed:
            parsed = {"steps": [parsed]}
        if not parsed["steps"]:
            parsed = {"steps": [{"action": "scroll", "reasoning": "No steps returned, scrolling to reveal more content."}]}
    except json.JSONDecodeError:
        parsed = {"steps": [{"action": "finish", "reasoning": "Could not parse model response"}]}

    return parsed