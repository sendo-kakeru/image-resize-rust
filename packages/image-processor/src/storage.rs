use aws_config::Region;
use aws_credential_types::Credentials;
use aws_sdk_s3::Client;
use bytes::Bytes;

#[derive(Clone)]
pub struct R2Client {
    client: Client,
    bucket_name: String,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("object not found: {key}")]
    NotFound { key: String },

    #[error("object too large: {size} bytes (max: {max} bytes)")]
    TooLarge { size: u64, max: u64 },

    #[error("storage error: {0}")]
    Internal(String),
}

/// 最大入力ファイルサイズ: 10MB
const MAX_INPUT_SIZE: u64 = 10 * 1024 * 1024;

impl R2Client {
    /// 環境変数から R2Client を作成する。
    ///
    /// 必須の環境変数:
    /// - R2_ENDPOINT
    /// - R2_ACCESS_KEY_ID
    /// - R2_SECRET_ACCESS_KEY
    /// - R2_BUCKET_NAME
    pub async fn from_env() -> Result<Self, String> {
        let endpoint =
            std::env::var("R2_ENDPOINT").map_err(|_| "R2_ENDPOINT is not set".to_string())?;
        let access_key_id = std::env::var("R2_ACCESS_KEY_ID")
            .map_err(|_| "R2_ACCESS_KEY_ID is not set".to_string())?;
        let secret_access_key = std::env::var("R2_SECRET_ACCESS_KEY")
            .map_err(|_| "R2_SECRET_ACCESS_KEY is not set".to_string())?;
        let bucket_name =
            std::env::var("R2_BUCKET_NAME").map_err(|_| "R2_BUCKET_NAME is not set".to_string())?;

        let credentials = Credentials::new(
            access_key_id,
            secret_access_key,
            None, // セッショントークン
            None, // 有効期限
            "r2-env",
        );

        let config = aws_sdk_s3::config::Builder::new()
            .endpoint_url(&endpoint)
            .region(Region::new("auto"))
            .credentials_provider(credentials)
            .force_path_style(true)
            .behavior_version_latest()
            .build();

        let client = Client::from_conf(config);

        Ok(Self {
            client,
            bucket_name,
        })
    }

    /// キーを指定して R2 からオブジェクトを取得する。
    ///
    /// content_length が返る場合は事前にサイズをチェックし、
    /// ない場合も読み込み後にサイズをチェックしてメモリ枯渇を防ぐ。
    pub async fn get_object(&self, key: &str) -> Result<Bytes, StorageError> {
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket_name)
            .key(key)
            .send()
            .await
            .map_err(|e| {
                if e.as_service_error().is_some_and(|se| se.is_no_such_key()) {
                    StorageError::NotFound {
                        key: key.to_string(),
                    }
                } else {
                    StorageError::Internal(e.to_string())
                }
            })?;

        // content_length があれば事前チェック
        if let Some(size) = output.content_length().filter(|&s| s > 0) {
            let size = size as u64;
            if size > MAX_INPUT_SIZE {
                return Err(StorageError::TooLarge {
                    size,
                    max: MAX_INPUT_SIZE,
                });
            }
        }

        let data = output
            .body
            .collect()
            .await
            .map_err(|e| StorageError::Internal(e.to_string()))?
            .into_bytes();

        // content_length がない場合も、読み込み後にサイズを確認
        let actual_size = data.len() as u64;
        if actual_size > MAX_INPUT_SIZE {
            return Err(StorageError::TooLarge {
                size: actual_size,
                max: MAX_INPUT_SIZE,
            });
        }

        Ok(data)
    }
}
