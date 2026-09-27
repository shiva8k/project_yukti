from huggingface_hub import snapshot_download

# Download only the icon detection model (lightweight YOLO-based part)
# We skip the caption models (florence/blip2) since they need more VRAM
snapshot_download(
    repo_id="microsoft/OmniParser-v2.0",
    allow_patterns=["icon_detect/*"],
    local_dir="omniparser_weights"
)

print("Download complete! Check the 'omniparser_weights' folder.")