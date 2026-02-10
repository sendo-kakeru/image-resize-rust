use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::AppState;
use crate::storage::StorageError;
use crate::transform::{OutputFormat, TransformError, TransformParams};

const CACHE_CONTROL_IMMUTABLE: &str = "public, max-age=31536000, immutable";

#[derive(Debug, Deserialize)]
pub struct TransformQuery {
    #[serde(rename = "w")]
    pub width: Option<u32>,
    #[serde(rename = "h")]
    pub height: Option<u32>,
    #[serde(rename = "f")]
    pub format: Option<String>,
    #[serde(rename = "q")]
    pub quality: Option<u8>,
}

pub async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

pub async fn transform(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Query(query): Query<TransformQuery>,
) -> Result<Response, AppError> {
    validate_key(&key)?;

    let format = query
        .format
        .as_deref()
        .map(|f| {
            OutputFormat::from_str_param(f).ok_or_else(|| {
                AppError::BadRequest(format!(
                    "unsupported format '{f}'. supported: jpg, png, webp, avif"
                ))
            })
        })
        .transpose()?;

    let params = TransformParams {
        width: query.width,
        height: query.height,
        format,
        quality: query.quality,
    };

    tracing::info!(key = %key, "fetching object from R2");
    let input_bytes = state.r2_client.get_object(&key).await?;

    if !params.needs_transform() {
        let content_type = infer_content_type(&input_bytes);
        return Ok((
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, CACHE_CONTROL_IMMUTABLE.to_string()),
            ],
            input_bytes,
        )
            .into_response());
    }

    tracing::info!(
        key = %key,
        w = ?params.width,
        h = ?params.height,
        f = ?params.format,
        q = ?params.quality,
        "transforming image"
    );

    let (output_bytes, content_type) = crate::transform::transform(&input_bytes, &params)?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CACHE_CONTROL, CACHE_CONTROL_IMMUTABLE.to_string()),
        ],
        output_bytes,
    )
        .into_response())
}

/// パストラバーサル攻撃を防ぐためにオブジェクトキーを検証する。
///
/// URLエンコーディングのバイパスを防ぐため、デコード後の値をチェックする。
/// ホワイトリスト方式で許可する文字のみを受け入れる。
fn validate_key(key: &str) -> Result<(), AppError> {
    if key.is_empty() {
        return Err(AppError::BadRequest(
            "key parameter is required".to_string(),
        ));
    }
    if key.len() > 1024 {
        return Err(AppError::BadRequest(
            "key parameter too long (max: 1024)".to_string(),
        ));
    }

    // URLデコード後の値をチェック
    let decoded = urlencoding::decode(key)
        .map_err(|_| AppError::BadRequest("invalid URL encoding".to_string()))?;

    // ホワイトリストアプローチ: 許可する文字のみを許可
    // 英数字、スラッシュ、ハイフン、アンダースコア、ドットのみ
    if !decoded
        .chars()
        .all(|c| c.is_alphanumeric() || c == '/' || c == '-' || c == '_' || c == '.')
    {
        return Err(AppError::BadRequest(
            "key contains invalid characters".to_string(),
        ));
    }

    // パストラバーサルパターンの検出
    if decoded.contains("..")
        || decoded.starts_with('/')
        || decoded.contains("//")
        || decoded.contains('\\')
    {
        return Err(AppError::BadRequest(
            "invalid key: path traversal detected".to_string(),
        ));
    }

    Ok(())
}

/// マジックバイトから Content-Type を推測する。
fn infer_content_type(data: &[u8]) -> String {
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg".to_string()
    } else if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png".to_string()
    } else if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        "image/webp".to_string()
    } else if data.len() >= 12 && &data[4..12] == b"ftypavif" {
        "image/avif".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    NotFound(String),
    TransformFailed(String),
    Internal(String),
}

impl From<StorageError> for AppError {
    fn from(err: StorageError) -> Self {
        match err {
            StorageError::NotFound { key } => {
                // キー情報を含めない一般的なメッセージ
                // ログには記録されるが、クライアントには返さない
                tracing::warn!(key = %key, "object not found");
                AppError::NotFound("object not found".to_string())
            }
            StorageError::TooLarge { size, max } => {
                // サイズ情報は許容（DoS対策として有用）
                AppError::BadRequest(format!("object too large: {size} bytes (max: {max} bytes)"))
            }
            StorageError::Internal(msg) => {
                // 詳細なエラーメッセージはログに記録し、クライアントには一般的なメッセージを返す
                tracing::error!(error = %msg, "storage error");
                AppError::Internal("storage error".to_string())
            }
        }
    }
}

impl From<TransformError> for AppError {
    fn from(err: TransformError) -> Self {
        match err {
            TransformError::InvalidParams(msg) => AppError::BadRequest(msg),
            TransformError::ResolutionTooLarge { width, height } => AppError::BadRequest(format!(
                "image resolution {width}x{height} exceeds maximum 4096x4096"
            )),
            TransformError::ProcessingFailed(msg) => AppError::TransformFailed(msg),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            AppError::TransformFailed(msg) => (StatusCode::UNPROCESSABLE_ENTITY, msg),
            AppError::Internal(msg) => {
                tracing::error!(error = %msg, "internal server error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_string(),
                )
            }
        };

        let body = serde_json::json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}
