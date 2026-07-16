use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AppConfig {
    pub logs_dir: Option<String>,
    pub lock_dir: Option<String>,
    pub disable_animations: bool,
    pub quiet: bool,
    pub no_logs: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProcConfig {
    #[serde(default, deserialize_with = "deserialize_optional_scalar")]
    pub shell: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_scalar_list")]
    pub cmd: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_scalar")]
    pub cwd: Option<String>,
    #[serde(default, deserialize_with = "deserialize_environment")]
    pub env: Option<HashMap<String, Option<String>>>,
    #[serde(default, deserialize_with = "deserialize_add_path")]
    pub add_path: Vec<String>,
    #[serde(default = "default_true")]
    pub autostart: bool,
    #[serde(default)]
    pub autorestart: bool,
    #[serde(default, deserialize_with = "deserialize_optional_scalar")]
    pub stop: Option<String>,
}

fn default_true() -> bool {
    true
}

fn scalar_to_string<E: serde::de::Error>(value: serde_yaml::Value) -> Result<String, E> {
    match value {
        serde_yaml::Value::String(value) => Ok(value),
        serde_yaml::Value::Bool(value) => Ok(value.to_string()),
        serde_yaml::Value::Number(value) => Ok(value.to_string()),
        serde_yaml::Value::Null => Ok("null".into()),
        _ => Err(E::custom("expected a scalar value")),
    }
}

fn deserialize_optional_scalar<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_yaml::Value>::deserialize(deserializer)?;
    value.map(scalar_to_string).transpose()
}

fn deserialize_optional_scalar_list<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let values = Option::<Vec<serde_yaml::Value>>::deserialize(deserializer)?;
    values
        .map(|values| values.into_iter().map(scalar_to_string).collect())
        .transpose()
}

fn deserialize_environment<'de, D>(
    deserializer: D,
) -> Result<Option<HashMap<String, Option<String>>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let values = Option::<HashMap<String, serde_yaml::Value>>::deserialize(deserializer)?;
    values
        .map(|values| {
            values
                .into_iter()
                .map(|(name, value)| {
                    if value.is_null() {
                        Ok((name, None))
                    } else {
                        scalar_to_string(value).map(|value| (name, Some(value)))
                    }
                })
                .collect()
        })
        .transpose()
}

fn deserialize_add_path<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }

    Ok(match Option::<OneOrMany>::deserialize(deserializer)? {
        Some(OneOrMany::One(value)) => vec![value],
        Some(OneOrMany::Many(values)) => values,
        None => Vec::new(),
    })
}

#[derive(Clone, Debug)]
pub struct LoadedConfig {
    pub procs: IndexMap<String, ProcConfig>,
    pub config_dir: std::path::PathBuf,
    pub normalized_proc_names: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcSummary {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadConfigSuccess {
    pub config_path: String,
    pub config_dir: String,
    pub procs: Vec<ProcSummary>,
    pub running_ids: Vec<String>,
    pub normalized_proc_names: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum LoadConfigResult {
    Success(LoadConfigSuccess),
    Error { error: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct CommandResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CommandResult {
    pub fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PortOccupant {
    pub port: u16,
    pub pid: u32,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct KillPortResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occupant: Option<PortOccupant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutput {
    pub proc_id: String,
    pub text: String,
    pub is_stderr: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStopped {
    pub proc_id: String,
    pub code: Option<i32>,
}
