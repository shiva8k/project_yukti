# YUKTI – Privacy-Preserving Vision Agent

YUKTI is a privacy-preserving browser automation agent that combines local visual processing with AI-powered reasoning to automate browser tasks while protecting sensitive user information.

## 🚀 What is YUKTI?

AI browser agents often need access to screenshots, webpage content, and DOM information. This data may contain sensitive information such as passwords, PII, financial details, and private messages.

YUKTI uses a **privacy-first hybrid architecture** where sensitive information is detected and sanitized locally before relevant context is sent to a cloud-based Vision-Language Model (VLM).

### 🔐 Core Workflow

```text
Browser
   ↓
Screen + DOM Analysis
   ↓
Sensitive Data Detection
   ↓
Local Redaction / Sanitization
   ↓
Sanitized Context
   ↓
Vision-Language Model
   ↓
Action Generation
   ↓
Browser Action Execution
