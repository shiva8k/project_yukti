from ultralytics import YOLO
import cv2

# Load the OmniParser icon detection model
model = YOLO("omniparser_weights/icon_detect/model.pt")

# Run detection on a test image
results = model("test_image.png")

# Print how many UI elements were detected
for result in results:
    boxes = result.boxes
    print(f"\nTotal UI elements detected: {len(boxes)}")
    
    for i, box in enumerate(boxes):
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        confidence = box.conf[0].item()
        print(f"Element {i+1}: position=({x1:.0f}, {y1:.0f}, {x2:.0f}, {y2:.0f}), confidence={confidence:.2f}")

# Save an annotated image showing the detected boxes
annotated = results[0].plot()
cv2.imwrite("test_output.png", annotated)
print("\nAnnotated image saved as test_output.png")