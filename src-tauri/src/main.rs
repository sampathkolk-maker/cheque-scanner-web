// Desktop backend. Holds the API key (from the request/settings, falling back to
// env / .env) and performs the same forced-structured-output call + retry/backoff
// as the web server route, exposed to the webview as the `extract_cheque` command.
// Provider is derived from the model id, so one key field serves whichever is active.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::time::Duration;

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const GEMINI_URL: &str = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MAX_TOKENS: u32 = 1024;
const MAX_RETRIES: u32 = 4;
const BACKOFF_BASE_MS: u64 = 1500;
const RETRIABLE: [u16; 7] = [408, 409, 429, 500, 502, 503, 529];

const SYSTEM_PROMPT: &str = "You are a meticulous OCR and data-extraction engine for GCC (especially Qatari) bank cheques. Images may be rotated, low-contrast, bilingual (Arabic/English) and contain handwriting. Read every digit exactly, never drop repeated digits, convert Eastern-Arabic numerals to Western digits, and always answer by calling the provided tool with strict, schema-valid values.";

const EXTRACT_PROMPT: &str = "Extract the fields from this single bank cheque. For the amount, report the figures from the amount box as amount_numeric, the courtesy line text as amount_words, and your own numeric reading of those words as amount_words_value. If a field is absent, return an empty string (or null for amount_words_value). The cheque number is the leading digits of the MICR/MRIC line at the bottom. Give a 0..1 confidence per field.";

const REGION_PROMPT: &str = "This scanned page may contain ONE or SEVERAL separate bank cheques. Identify every distinct physical cheque and give a bounding box for each as fractions of the image size with the origin at the TOP-LEFT: x0,y0 is the top-left corner and x1,y1 the bottom-right, each between 0 and 1. Order cheques top-to-bottom then left-to-right. Exclude page edges, staples, and anything that is not a cheque. If a single cheque covers most of the page, return one box [0,0,1,1].";

const ALLOWED_MODELS: [&str; 5] = [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
    "claude-opus-4-8",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
];

fn extract_tool() -> Value {
    json!({
        "name": "record_cheque",
        "description": "Return the extracted cheque fields as structured data.",
        "input_schema": {
            "type": "object",
            "properties": {
                "amount_numeric": { "type": "string" },
                "amount_words": { "type": "string" },
                "amount_words_value": { "type": ["number", "null"] },
                "currency": { "type": "string" },
                "date": { "type": "string" },
                "payer": { "type": "string" },
                "bank": { "type": "string" },
                "cheque_number": { "type": "string" },
                "has_handwriting": { "type": "boolean" },
                "field_confidence": {
                    "type": "object",
                    "properties": {
                        "amount": { "type": "number" },
                        "date": { "type": "number" },
                        "payer": { "type": "number" },
                        "bank": { "type": "number" },
                        "chequeNumber": { "type": "number" }
                    }
                }
            },
            "required": ["amount_numeric", "amount_words", "date", "payer", "bank", "cheque_number"]
        }
    })
}

fn region_tool() -> Value {
    json!({
        "name": "cheque_regions",
        "description": "Return one bounding box per distinct cheque detected on the page.",
        "input_schema": {
            "type": "object",
            "properties": {
                "regions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "x0": { "type": "number" },
                            "y0": { "type": "number" },
                            "x1": { "type": "number" },
                            "y1": { "type": "number" }
                        },
                        "required": ["x0", "y0", "x1", "y1"]
                    }
                }
            },
            "required": ["regions"]
        }
    })
}

async fn sleep_backoff(attempt: u32) {
    tokio::time::sleep(Duration::from_millis(BACKOFF_BASE_MS * (1u64 << attempt))).await;
}

fn strip_fences(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

// Anthropic Messages API with forced tool_use.
async fn call_anthropic(
    client: &reqwest::Client,
    key: &str,
    model: &str,
    image: &str,
    prompt: &str,
    tool: &Value,
    tool_name: &str,
) -> Result<Value, String> {
    let payload = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
        "system": SYSTEM_PROMPT,
        "tools": [tool],
        "tool_choice": { "type": "tool", "name": tool_name },
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": image } },
                { "type": "text", "text": prompt }
            ]
        }]
    });

    let mut last_err = String::from("unknown error");
    for attempt in 0..=MAX_RETRIES {
        let resp = client
            .post(ANTHROPIC_URL)
            .header("content-type", "application/json")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&payload)
            .send()
            .await;
        match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                if !r.status().is_success() {
                    last_err = format!("Anthropic HTTP {status}");
                    if RETRIABLE.contains(&status) && attempt < MAX_RETRIES {
                        sleep_backoff(attempt).await;
                        continue;
                    }
                    return Err(last_err);
                }
                let data: Value = r.json().await.map_err(|e| e.to_string())?;
                if let Some(content) = data.get("content").and_then(|c| c.as_array()) {
                    for block in content {
                        let is_tool = block.get("type").and_then(Value::as_str) == Some("tool_use")
                            && block.get("name").and_then(Value::as_str) == Some(tool_name);
                        if is_tool {
                            if let Some(input) = block.get("input") {
                                return Ok(input.clone());
                            }
                        }
                    }
                }
                last_err = "Model returned no tool_use block".to_string();
                if attempt < MAX_RETRIES {
                    sleep_backoff(attempt).await;
                    continue;
                }
                return Err(last_err);
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < MAX_RETRIES {
                    sleep_backoff(attempt).await;
                    continue;
                }
            }
        }
    }
    Err(last_err)
}

// Gemini via its OpenAI-compatible Chat Completions endpoint, forced function call.
async fn call_gemini(
    client: &reqwest::Client,
    key: &str,
    model: &str,
    image: &str,
    prompt: &str,
    tool: &Value,
    tool_name: &str,
) -> Result<Value, String> {
    let payload = json!({
        "model": model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": format!("data:image/jpeg;base64,{image}") } }
            ]}
        ],
        "tools": [{ "type": "function", "function": {
            "name": tool_name,
            "description": tool.get("description").cloned().unwrap_or(Value::Null),
            "parameters": tool.get("input_schema").cloned().unwrap_or(Value::Null)
        }}],
        "tool_choice": { "type": "function", "function": { "name": tool_name } }
    });

    let mut last_err = String::from("unknown error");
    for attempt in 0..=MAX_RETRIES {
        let resp = client
            .post(GEMINI_URL)
            .header("content-type", "application/json")
            .bearer_auth(key)
            .json(&payload)
            .send()
            .await;
        match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                if !r.status().is_success() {
                    last_err = format!("Gemini HTTP {status}");
                    if RETRIABLE.contains(&status) && attempt < MAX_RETRIES {
                        sleep_backoff(attempt).await;
                        continue;
                    }
                    return Err(last_err);
                }
                let data: Value = r.json().await.map_err(|e| e.to_string())?;
                let msg = data
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("message"));
                let args = msg
                    .and_then(|m| m.get("tool_calls"))
                    .and_then(|t| t.get(0))
                    .and_then(|t| t.get("function"))
                    .and_then(|f| f.get("arguments"))
                    .and_then(Value::as_str);
                if let Some(a) = args {
                    if let Ok(parsed) = serde_json::from_str::<Value>(a) {
                        return Ok(parsed);
                    }
                }
                if let Some(content) = msg.and_then(|m| m.get("content")).and_then(Value::as_str) {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&strip_fences(content)) {
                        return Ok(parsed);
                    }
                }
                last_err = "Could not parse model JSON".to_string();
                if attempt < MAX_RETRIES {
                    sleep_backoff(attempt).await;
                    continue;
                }
                return Err(last_err);
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < MAX_RETRIES {
                    sleep_backoff(attempt).await;
                    continue;
                }
            }
        }
    }
    Err(last_err)
}

#[tauri::command]
async fn extract_cheque(
    image: String,
    model: String,
    mode: String,
    hint: Option<String>,
    api_key: Option<String>,
) -> Result<Value, String> {
    if !ALLOWED_MODELS.contains(&model.as_str()) {
        return Err("unsupported model".to_string());
    }
    let is_gemini = model.starts_with("gemini");

    // Key from settings (request) first, then env / .env.
    let key = match api_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(k) => k.to_string(),
        None => {
            let var = if is_gemini { "GEMINI_API_KEY" } else { "ANTHROPIC_API_KEY" };
            std::env::var(var)
                .map_err(|_| format!("Missing API key — enter it in settings or set {var} in the environment"))?
        }
    };

    let is_regions = mode == "regions";
    let tool = if is_regions { region_tool() } else { extract_tool() };
    let tool_name = if is_regions { "cheque_regions" } else { "record_cheque" };
    let base_prompt = if is_regions { REGION_PROMPT } else { EXTRACT_PROMPT };
    let prompt = match hint.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(h) => format!("{base_prompt}\n\n{h}"),
        None => base_prompt.to_string(),
    };

    let client = reqwest::Client::new();
    if is_gemini {
        call_gemini(&client, &key, &model, &image, &prompt, &tool, tool_name).await
    } else {
        call_anthropic(&client, &key, &model, &image, &prompt, &tool, tool_name).await
    }
}

fn main() {
    // Load API keys from a .env in the working directory if present.
    let _ = dotenvy::dotenv();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![extract_cheque])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
