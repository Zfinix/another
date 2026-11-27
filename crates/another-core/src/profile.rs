//! Profiles: the stream and developer settings as one JSON document, shared by the app, the
//! `another` CLI and `another://` deep links.

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};

pub const PROFILE_VERSION: u64 = 1;

enum Kind {
    Bool,
    Number,
    Text(&'static [&'static str]),
}

struct Field {
    key: &'static str,
    section: &'static str,
    name: &'static str,
    kind: Kind,
}

const ENCODER_TUNINGS: &[&str] = &[
    "default",
    "constant_bitrate",
    "constant_bitrate_drop_frames",
    "intra_refresh",
    "high_profile",
];

const FIELDS: &[Field] = &[
    Field { key: "max_size", section: "stream", name: "max_size", kind: Kind::Number },
    Field { key: "max_fps", section: "stream", name: "max_fps", kind: Kind::Number },
    Field { key: "video_bit_rate", section: "stream", name: "video_bit_rate", kind: Kind::Number },
    Field { key: "video_codec", section: "stream", name: "video_codec", kind: Kind::Text(&["h264", "h265"]) },
    Field { key: "audio", section: "stream", name: "audio", kind: Kind::Bool },
    Field { key: "adaptive", section: "stream", name: "adaptive", kind: Kind::Bool },
    Field { key: "adaptive_network", section: "stream", name: "adaptive_network", kind: Kind::Bool },
    Field { key: "perf_overlay", section: "dev", name: "perfOverlay", kind: Kind::Bool },
    Field { key: "direct_adb", section: "dev", name: "directAdb", kind: Kind::Bool },
    Field { key: "low_latency", section: "dev", name: "lowLatency", kind: Kind::Bool },
    Field { key: "encoder_tuning", section: "dev", name: "encoderTuning", kind: Kind::Text(ENCODER_TUNINGS) },
    Field { key: "another_server", section: "dev", name: "anotherServer", kind: Kind::Bool },
    Field { key: "native_video", section: "dev", name: "nativeVideo", kind: Kind::Bool },
    Field { key: "network_stream", section: "dev", name: "networkStream", kind: Kind::Bool },
];

pub fn known_keys() -> impl Iterator<Item = &'static str> {
    FIELDS.iter().map(|field| field.key)
}

/// Builds a partial profile from `key=value` pairs, such as `max_size=1920` or `native_video=true`.
pub fn from_assignments<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Result<Value> {
    let mut stream = Map::new();
    let mut dev = Map::new();
    for (key, raw) in pairs {
        let field = FIELDS
            .iter()
            .find(|field| field.key == key)
            .ok_or_else(|| anyhow!("Unknown setting '{}'. Known settings: {}", key, known_keys().collect::<Vec<_>>().join(", ")))?;
        let value = parse_value(field, raw)?;
        let section = if field.section == "stream" { &mut stream } else { &mut dev };
        section.insert(field.name.to_string(), value);
    }
    let mut profile = Map::new();
    profile.insert("version".into(), json!(PROFILE_VERSION));
    if !stream.is_empty() {
        profile.insert("stream".into(), Value::Object(stream));
    }
    if !dev.is_empty() {
        profile.insert("dev".into(), Value::Object(dev));
    }
    Ok(Value::Object(profile))
}

/// Checks a profile document and keeps only the sections and fields Another understands.
pub fn validate(profile: &Value) -> Result<Value> {
    let object = profile.as_object().ok_or_else(|| anyhow!("A profile must be a JSON object"))?;
    let mut pairs: Vec<(String, String)> = Vec::new();
    for section in ["stream", "dev"] {
        let Some(values) = object.get(section) else {
            continue;
        };
        let values = values
            .as_object()
            .ok_or_else(|| anyhow!("'{}' must be an object", section))?;
        for (name, value) in values {
            let field = FIELDS
                .iter()
                .find(|field| field.section == section && field.name == name)
                .ok_or_else(|| anyhow!("Unknown {} setting '{}'", section, name))?;
            let raw = match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            pairs.push((field.key.to_string(), raw));
        }
    }
    from_assignments(pairs.iter().map(|(key, value)| (key.as_str(), value.as_str())))
}

fn parse_value(field: &Field, raw: &str) -> Result<Value> {
    match field.kind {
        Kind::Bool => match raw {
            "true" | "1" | "on" | "yes" => Ok(json!(true)),
            "false" | "0" | "off" | "no" => Ok(json!(false)),
            _ => Err(anyhow!("'{}' expects true or false, got '{}'", field.key, raw)),
        },
        Kind::Number => parse_number(raw)
            .map(|n| json!(n))
            .ok_or_else(|| anyhow!("'{}' expects a number, got '{}'", field.key, raw)),
        Kind::Text(allowed) => {
            if allowed.contains(&raw) {
                Ok(json!(raw))
            } else {
                Err(anyhow!("'{}' expects one of {}, got '{}'", field.key, allowed.join(", "), raw))
            }
        }
    }
}

/// Accepts plain numbers and the k/M suffixes people use for bitrates, like 8M or 500k.
fn parse_number(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    let (digits, scale) = match raw.chars().last()? {
        'k' | 'K' => (&raw[..raw.len() - 1], 1_000.0),
        'm' | 'M' => (&raw[..raw.len() - 1], 1_000_000.0),
        _ => (raw, 1.0),
    };
    let value: f64 = digits.parse().ok()?;
    (value >= 0.0).then(|| (value * scale).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignments_split_into_stream_and_dev_sections() {
        let profile = from_assignments([("max_size", "1920"), ("native_video", "true"), ("video_bit_rate", "8M")]).unwrap();
        assert_eq!(profile["stream"]["max_size"], 1920);
        assert_eq!(profile["stream"]["video_bit_rate"], 8_000_000);
        assert_eq!(profile["dev"]["nativeVideo"], true);
        assert_eq!(profile["version"], PROFILE_VERSION);
    }

    #[test]
    fn rejects_unknown_keys_and_bad_values() {
        assert!(from_assignments([("resolution", "1920")]).is_err());
        assert!(from_assignments([("native_video", "maybe")]).is_err());
        assert!(from_assignments([("encoder_tuning", "turbo")]).is_err());
        assert!(from_assignments([("max_fps", "fast")]).is_err());
    }

    #[test]
    fn validate_keeps_known_fields_and_normalises_values() {
        let input = json!({
            "version": 1,
            "stream": { "max_size": 1024, "audio": false },
            "dev": { "encoderTuning": "intra_refresh", "anotherServer": true }
        });
        let profile = validate(&input).unwrap();
        assert_eq!(profile["stream"]["max_size"], 1024);
        assert_eq!(profile["dev"]["encoderTuning"], "intra_refresh");
        assert_eq!(profile["dev"]["anotherServer"], true);
    }

    #[test]
    fn validate_rejects_unknown_fields() {
        assert!(validate(&json!({ "stream": { "resolution": 1 } })).is_err());
        assert!(validate(&json!([1, 2])).is_err());
    }
}
