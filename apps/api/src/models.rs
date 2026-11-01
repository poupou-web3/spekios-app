//! Provider wire contracts. Browser decisions are not executed by this module.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Anthropic,
    Openrouter,
    Meta,
}
impl Provider {
    pub const ALL: [Self; 4] = [Self::Openai, Self::Anthropic, Self::Openrouter, Self::Meta];
    pub fn name(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Openrouter => "openrouter",
            Self::Meta => "meta",
        }
    }
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Openai => "https://api.openai.com/v1/responses",
            Self::Anthropic => "https://api.anthropic.com/v1/messages",
            Self::Openrouter => "https://openrouter.ai/api/v1/chat/completions",
            Self::Meta => "https://api.meta.ai/v1/responses",
        }
    }
    pub fn key_env(self) -> &'static str {
        match self {
            Self::Openai => "OPENAI_API_KEY",
            Self::Anthropic => "ANTHROPIC_API_KEY",
            Self::Openrouter => "OPENROUTER_API_KEY",
            Self::Meta => "META_API_KEY",
        }
    }
}

fn yes() -> bool {
    true
}
fn max_tokens() -> u32 {
    1024
}
fn attempts() -> u8 {
    2
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRequest {
    /// Client-generated UUID is also the idempotency key, scoped to the local user.
    pub request_id: Uuid,
    pub provider: Provider,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub run_id: Option<Uuid>,
    #[serde(default)]
    pub action_id: Option<Uuid>,
    #[serde(default)]
    pub capture_ids: Vec<Uuid>,
    #[serde(default = "max_tokens")]
    pub max_output_tokens: u32,
    #[serde(default = "attempts")]
    pub max_attempts: u8,
    /// Applies to OpenRouter only. No paid plugins or model fallback list is accepted.
    #[serde(default = "yes")]
    pub free_only: bool,
}
impl ModelRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.request_id.is_nil()
            || self.model.is_empty()
            || self.model.len() > 200
            || !self
                .model
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/:._-".contains(&c))
        {
            return Err("invalid_request_id_or_model");
        }
        if self.prompt.trim().is_empty() || self.prompt.len() > 65_536 || self.system.len() > 16_384
        {
            return Err("invalid_prompt_length");
        }
        if self.prompt.contains('\0') || self.system.contains('\0') {
            return Err("invalid_prompt_encoding");
        }
        if !(1..=4096).contains(&self.max_output_tokens) || !(1..=3).contains(&self.max_attempts) {
            return Err("invalid_call_limits");
        }
        if self.capture_ids.len() > 2
            || (self.action_id.is_some() || !self.capture_ids.is_empty()) && self.run_id.is_none()
            || self
                .capture_ids
                .iter()
                .enumerate()
                .any(|(i, id)| self.capture_ids[..i].contains(id))
        {
            return Err("invalid_evidence_links");
        }
        if self.provider == Provider::Openrouter
            && self.free_only
            && self.model != "openrouter/free"
            && !self.model.ends_with(":free")
        {
            return Err("free_only_requires_free_model");
        }
        Ok(())
    }
}

/// Images are resolved by UUID from the private bucket; arbitrary image URLs are
/// never accepted. The order of images follows capture_ids in the audit spec.
pub fn wire_request(spec: &ModelRequest, images: &[Vec<u8>]) -> Value {
    match spec.provider {
        // Meta's Responses API accepts this same input shape. store:false keeps
        // the turn off Meta's server so prompts and screenshots are not retained.
        Provider::Openai | Provider::Meta => {
            let mut content = vec![json!({"type":"input_text","text":spec.prompt})];
            content.extend(images.iter().map(|b| json!({"type":"input_image","image_url":format!("data:image/png;base64,{}",STANDARD.encode(b)),"detail":"high"})));
            let mut body = json!({"model":spec.model,"instructions":spec.system,"input":[{"role":"user","content":content}],"max_output_tokens":spec.max_output_tokens,"store":false,"stream":false});
            // Muse Wonder reasons unless told otherwise, and those tokens share
            // max_output_tokens with the visible answer. Light effort keeps a
            // structured plan from being cut off mid-JSON. "none" is rejected.
            if spec.provider == Provider::Meta {
                body["reasoning"] = json!({"effort": "low"});
            }
            body
        }
        Provider::Anthropic => {
            let mut content = vec![json!({"type":"text","text":spec.prompt})];
            content.extend(images.iter().map(|b| json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":STANDARD.encode(b)}})));
            json!({"model":spec.model,"system":spec.system,"messages":[{"role":"user","content":content}],"max_tokens":spec.max_output_tokens,"stream":false})
        }
        Provider::Openrouter => {
            let mut content = vec![json!({"type":"text","text":spec.prompt})];
            content.extend(images.iter().map(|b| json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}",STANDARD.encode(b))}})));
            let mut body = json!({"model":spec.model,"messages":[{"role":"system","content":spec.system},{"role":"user","content":content}],"max_tokens":spec.max_output_tokens,"stream":false,
                "provider":{"require_parameters":true,"data_collection":"deny"}});
            if spec.free_only {
                body["provider"]["max_price"] =
                    json!({"prompt":0,"completion":0,"request":0,"image":0});
            }
            body
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub cost_usd: Option<String>,
    pub usage_status: String,
    pub usage_reason: Option<String>,
    pub usage_raw: Option<Value>,
}

fn count(v: &Value) -> Option<i64> {
    v.as_i64().filter(|n| *n >= 0)
}

pub fn usage(provider: Provider, response: &Value) -> Usage {
    let raw = &response["usage"];
    let mut result = Usage {
        usage_raw: (!raw.is_null()).then(|| raw.clone()),
        ..Usage::default()
    };
    match provider {
        Provider::Openai | Provider::Meta => {
            result.input_tokens = count(&raw["input_tokens"]);
            result.output_tokens = count(&raw["output_tokens"]);
            result.cached_input_tokens = count(&raw["input_tokens_details"]["cached_tokens"]);
            result.cache_write_tokens = count(&raw["input_tokens_details"]["cache_write_tokens"]);
            result.reasoning_tokens = count(&raw["output_tokens_details"]["reasoning_tokens"]);
        }
        Provider::Anthropic => {
            result.cached_input_tokens = count(&raw["cache_read_input_tokens"]);
            result.cache_write_tokens = count(&raw["cache_creation_input_tokens"]);
            // Claude reports uncached input separately. Cache fields are optional
            // on uncached responses, but malformed present fields must stay unknown.
            let cache = |key: &str| {
                if raw.get(key).is_none_or(Value::is_null) {
                    Some(0)
                } else {
                    count(&raw[key])
                }
            };
            result.input_tokens = count(&raw["input_tokens"])
                .zip(cache("cache_read_input_tokens"))
                .zip(cache("cache_creation_input_tokens"))
                .and_then(|((a, b), c)| a.checked_add(b)?.checked_add(c));
            result.output_tokens = count(&raw["output_tokens"]);
        }
        Provider::Openrouter => {
            result.input_tokens = count(&raw["prompt_tokens"]);
            result.output_tokens = count(&raw["completion_tokens"]);
            result.cached_input_tokens = count(&raw["prompt_tokens_details"]["cached_tokens"]);
            result.cache_write_tokens = count(&raw["prompt_tokens_details"]["cache_write_tokens"]);
            result.reasoning_tokens = count(&raw["completion_tokens_details"]["reasoning_tokens"]);
            // Preserve the provider decimal as text; never compute bills in f64.
            result.cost_usd = raw["cost"]
                .as_number()
                .filter(|n| {
                    n.to_string().len() <= 128
                        && n.as_f64()
                            .is_some_and(|x| x.is_finite() && (0.0..=1_000_000.0).contains(&x))
                })
                .map(ToString::to_string);
        }
    }
    result.usage_status = match (result.input_tokens, result.output_tokens) {
        (Some(_), Some(_)) => "reported",
        (None, None) => "unknown",
        _ => "partial",
    }
    .into();
    if result.usage_status != "reported" {
        result.usage_reason = Some("provider_usage_missing_or_invalid".into());
    }
    result
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CallResult {
    pub call_id: Uuid,
    pub state: String,
    pub elapsed_ms: Option<i64>,
    pub http_status: Option<i32>,
    pub provider_request_id: Option<String>,
    pub returned_model: Option<String>,
    pub routed_provider: Option<String>,
    pub output_text: Option<String>,
    pub finish_reason: Option<String>,
    pub error: Option<String>,
    #[serde(flatten)]
    pub usage: Usage,
    pub response_complete: bool,
    /// Received body, with configured credentials redacted. Partial bytes are
    /// retained on a truncated/disconnected response and explicitly marked.
    pub response_base64: String,
    pub retry_after_seconds: Option<i64>,
}
impl CallResult {
    pub fn unknown(call_id: Uuid, reason: &str) -> Self {
        Self {
            call_id,
            state: "unknown".into(),
            elapsed_ms: None,
            http_status: None,
            provider_request_id: None,
            returned_model: None,
            routed_provider: None,
            output_text: None,
            finish_reason: None,
            error: Some(reason.into()),
            usage: Usage {
                usage_status: "unknown".into(),
                usage_reason: Some(reason.into()),
                ..Usage::default()
            },
            response_complete: false,
            response_base64: String::new(),
            retry_after_seconds: None,
        }
    }
}

pub fn interpret(provider: Provider, body: &[u8], result: &mut CallResult) {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        result.state = "failed".into();
        result.error = Some("invalid_provider_json".into());
        return;
    };
    result.usage = usage(provider, &v);
    let string = |v: &Value| v.as_str().map(str::to_owned);
    result.provider_request_id = string(&v["id"]).or(result.provider_request_id.take());
    result.returned_model = string(&v["model"]);
    result.routed_provider = string(&v["provider"]);
    if !result.http_status.is_some_and(|s| (200..300).contains(&s)) || !v["error"].is_null() {
        result.state = "failed".into();
        result.error = Some("provider_error".into());
        return;
    }
    let (text, finish, complete) = match provider {
        Provider::Openai | Provider::Meta => {
            let text = v["output"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|item| item["content"].as_array().into_iter().flatten())
                .filter(|c| c["type"] == "output_text")
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            (text, string(&v["status"]), v["status"] == "completed")
        }
        Provider::Anthropic => {
            let text = v["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["type"] == "text")
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            (
                text,
                string(&v["stop_reason"]),
                v["stop_reason"] == "end_turn" || v["stop_reason"] == "stop_sequence",
            )
        }
        Provider::Openrouter => (
            string(&v["choices"][0]["message"]["content"]).unwrap_or_default(),
            string(&v["choices"][0]["finish_reason"]),
            v["choices"][0]["finish_reason"] == "stop",
        ),
    };
    let complete = complete && !text.trim().is_empty();
    result.output_text = Some(text);
    result.finish_reason = finish;
    result.state = if complete { "completed" } else { "failed" }.into();
    result.error = if complete {
        None
    } else {
        Some("incomplete_or_unsupported_output".into())
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn non_text_output_is_not_a_successful_text_round_trip() {
        let mut r = CallResult::unknown(Uuid::new_v4(), "pending");
        r.http_status = Some(200);
        interpret(Provider::Openai,br#"{"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"Cannot answer"}]}],"usage":{"input_tokens":4,"output_tokens":3}}"#,&mut r);
        assert_eq!(r.state, "failed");
        assert_eq!(r.usage.output_tokens, Some(3));
    }
    fn spec(provider: Provider) -> ModelRequest {
        ModelRequest {
            request_id: Uuid::new_v4(),
            provider,
            model: "test/free:free".into(),
            prompt: "inspect".into(),
            system: String::new(),
            run_id: None,
            action_id: None,
            capture_ids: vec![],
            max_output_tokens: 100,
            max_attempts: 2,
            free_only: true,
        }
    }
    #[test]
    fn free_routing_cannot_fall_back_to_paid_models_or_plugins() {
        let mut r = spec(Provider::Openrouter);
        assert!(r.validate().is_ok());
        r.model = "paid/model".into();
        assert!(r.validate().is_err());
        r.model = "openrouter/free".into();
        assert!(r.validate().is_ok());
        let wire = wire_request(&r, &[]);
        assert_eq!(wire["provider"]["max_price"]["prompt"], 0);
        assert!(wire.get("models").is_none());
        assert!(wire.get("plugins").is_none());
        let mut value = serde_json::to_value(r).unwrap();
        value["api_key"] = json!("not accepted");
        assert!(serde_json::from_value::<ModelRequest>(value).is_err());
    }
    #[test]
    fn image_and_output_limits_map_to_each_provider() {
        for p in Provider::ALL {
            let wire = wire_request(&spec(p), &[vec![1, 2, 3]]);
            assert!(wire.to_string().contains("AQID"));
            assert_eq!(wire["stream"], false);
        }
        assert_eq!(wire_request(&spec(Provider::Openai), &[])["store"], false);
        assert_eq!(wire_request(&spec(Provider::Meta), &[])["store"], false);
    }
    #[test]
    fn meta_responses_keep_prompts_stateless_and_read_reported_tokens() {
        let mut request = spec(Provider::Meta);
        request.model = "muse-wonder-1.0".into();
        request.system = "Inspect screenshots.".into();
        assert!(request.validate().is_ok());
        assert_eq!(
            Provider::Meta.endpoint(),
            "https://api.meta.ai/v1/responses"
        );
        assert_eq!(Provider::Meta.key_env(), "META_API_KEY");
        let wire = wire_request(&request, &[vec![1, 2, 3]]);
        assert_eq!(wire["model"], "muse-wonder-1.0");
        assert_eq!(wire["instructions"], "Inspect screenshots.");
        assert_eq!(wire["stream"], false);
        assert_eq!(wire["store"], false);
        assert_eq!(wire["reasoning"]["effort"], "low");
        assert!(wire.get("provider").is_none());
        assert!(wire_request(&spec(Provider::Openai), &[]).get("reasoning").is_none());
        assert_eq!(wire["input"][0]["role"], "user");
        assert_eq!(wire["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(wire["input"][0]["content"][1]["type"], "input_image");
        assert!(
            wire["input"][0]["content"][1]["image_url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        let mut result = CallResult::unknown(Uuid::new_v4(), "pending");
        result.http_status = Some(200);
        interpret(Provider::Meta,br#"{"id":"resp_1","status":"completed","model":"muse-wonder-1.0","output":[{"type":"message","content":[{"type":"output_text","text":"The page is ready."}]}],"usage":{"input_tokens":69,"output_tokens":163,"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":20}}}"#,&mut result);
        assert_eq!(result.state, "completed");
        assert_eq!(result.output_text.as_deref(), Some("The page is ready."));
        assert_eq!(result.returned_model.as_deref(), Some("muse-wonder-1.0"));
        assert_eq!(result.provider_request_id.as_deref(), Some("resp_1"));
        assert_eq!(result.usage.input_tokens, Some(69));
        assert_eq!(result.usage.output_tokens, Some(163));
        assert_eq!(result.usage.cached_input_tokens, Some(4));
        assert_eq!(result.usage.reasoning_tokens, Some(20));
        assert_eq!(result.usage.cost_usd, None);
        assert_eq!(result.usage.usage_status, "reported");
    }
    #[test]
    fn cache_and_reasoning_tokens_are_not_double_counted() {
        let a = usage(
            Provider::Anthropic,
            &json!({"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":4}}),
        );
        assert_eq!(a.input_tokens, Some(60));
        let o = usage(
            Provider::Openai,
            &json!({"usage":{"input_tokens":60,"input_tokens_details":{"cached_tokens":20},"output_tokens":40,"output_tokens_details":{"reasoning_tokens":30}}}),
        );
        assert_eq!(o.input_tokens, Some(60));
        assert_eq!(o.output_tokens, Some(40));
        let r = usage(
            Provider::Openrouter,
            &serde_json::from_str(
                r#"{"usage":{"prompt_tokens":60,"completion_tokens":40,"cost":0.000002}}"#,
            )
            .unwrap(),
        );
        assert_eq!(r.cost_usd.as_deref(), Some("0.000002"));
    }
    #[test]
    fn missing_partial_and_malformed_usage_are_explicit() {
        assert_eq!(usage(Provider::Openai, &json!({})).input_tokens, None);
        assert_eq!(usage(Provider::Openai, &json!({})).usage_status, "unknown");
        assert_eq!(
            usage(Provider::Openrouter, &json!({"usage":{"prompt_tokens":4}})).usage_status,
            "partial"
        );
        assert_eq!(
            usage(
                Provider::Openai,
                &json!({"usage":{"input_tokens":-1,"output_tokens":4}})
            )
            .input_tokens,
            None
        );
        assert_eq!(usage(Provider::Anthropic,&json!({"usage":{"input_tokens":10,"cache_read_input_tokens":"bad","output_tokens":4}})).input_tokens,None);
    }
    #[test]
    fn failed_or_incomplete_outputs_still_preserve_usage() {
        let mut r = CallResult::unknown(Uuid::new_v4(), "pending");
        r.http_status = Some(200);
        interpret(Provider::Openai,br#"{"status":"incomplete","usage":{"input_tokens":4,"output_tokens":100},"output":[]}"#,&mut r);
        assert_eq!(r.state, "failed");
        assert_eq!(r.usage.output_tokens, Some(100));
    }
}
