use bytes::Bytes;
use fast_image_resize::images::Image;
use fast_image_resize::{PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::codecs::avif::AvifEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ImageFormat, ImageReader};
use std::io::Cursor;

#[derive(Debug, Clone)]
pub struct TransformParams {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<OutputFormat>,
    pub quality: Option<u8>,
}

impl TransformParams {
    pub fn needs_transform(&self) -> bool {
        self.width.is_some()
            || self.height.is_some()
            || self.format.is_some()
            || self.quality.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Jpeg,
    Png,
    WebP,
    Avif,
}

impl OutputFormat {
    pub fn from_str_param(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "webp" => Some(Self::WebP),
            "avif" => Some(Self::Avif),
            _ => None,
        }
    }

    pub fn content_type(&self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::WebP => "image/webp",
            Self::Avif => "image/avif",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TransformError {
    #[error("invalid parameters: {0}")]
    InvalidParams(String),

    #[error(
        "image resolution exceeds maximum ({width}x{height} > {MAX_DIMENSION}x{MAX_DIMENSION})"
    )]
    ResolutionTooLarge { width: u32, height: u32 },

    #[error("transform failed: {0}")]
    ProcessingFailed(String),
}

const MAX_DIMENSION: u32 = 4096;
const MAX_PIXELS: u64 = 16_777_216; // 4096 * 4096
const DEFAULT_QUALITY: u8 = 80;

/// 指定されたパラメータに従って画像バイト列を変換する。
///
/// メタデータ (EXIF/XMP) はデコード・エンコードサイクルで削除される。
/// (変換後バイト列, content_type) を返す。
pub fn transform(
    input: &Bytes,
    params: &TransformParams,
) -> Result<(Bytes, &'static str), TransformError> {
    validate_params(params)?;

    let (img, source_format) = decode_image(input)?;
    let (src_w, src_h) = (img.width(), img.height());

    validate_source_dimensions(src_w, src_h)?;

    let (dst_w, dst_h) = calculate_contain_dimensions(src_w, src_h, params.width, params.height);
    validate_output_dimensions(dst_w, dst_h)?;

    let resized = if dst_w != src_w || dst_h != src_h {
        resize_image(&img, dst_w, dst_h)?
    } else {
        img
    };

    let output_format = determine_output_format(source_format, params.format);

    // PNG/WebP では quality パラメータを拒否（ロスレス固定のため）
    let quality = match output_format {
        OutputFormat::Png | OutputFormat::WebP => {
            if params.quality.is_some() {
                return Err(TransformError::InvalidParams(format!(
                    "quality parameter is not supported for {:?} (lossless only)",
                    output_format
                )));
            }
            DEFAULT_QUALITY
        }
        _ => params.quality.unwrap_or(DEFAULT_QUALITY),
    };

    let content_type = output_format.content_type();
    let output_bytes = encode_image(&resized, output_format, quality)?;

    Ok((Bytes::from(output_bytes), content_type))
}

/// 画像バイト列をデコードし、DynamicImage と元のフォーマットを返す。
fn decode_image(input: &Bytes) -> Result<(DynamicImage, Option<ImageFormat>), TransformError> {
    let reader = ImageReader::new(Cursor::new(input.as_ref()))
        .with_guessed_format()
        .map_err(|e| TransformError::ProcessingFailed(format!("failed to guess format: {e}")))?;

    let source_format = reader.format();

    let img = reader
        .decode()
        .map_err(|e| TransformError::ProcessingFailed(format!("decode failed: {e}")))?;

    Ok((img, source_format))
}

/// ソース画像の総ピクセル数を検証し、メモリ枯渇を防ぐ。
///
/// 個別の幅・高さ制限はせず、ダウンスケールを許可する。
fn validate_source_dimensions(width: u32, height: u32) -> Result<(), TransformError> {
    let total_pixels = width as u64 * height as u64;
    if total_pixels > MAX_PIXELS {
        return Err(TransformError::ResolutionTooLarge { width, height });
    }

    Ok(())
}

/// 出力画像のサイズを検証する。
fn validate_output_dimensions(width: u32, height: u32) -> Result<(), TransformError> {
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(TransformError::ResolutionTooLarge { width, height });
    }

    Ok(())
}

/// 出力フォーマットを決定する。
///
/// リクエストされたフォーマットがある場合はそれを使用し、
/// ない場合はソースフォーマットを維持する。
/// サポートされていないフォーマットの場合は JPEG にフォールバックする。
fn determine_output_format(
    source_format: Option<ImageFormat>,
    requested_format: Option<OutputFormat>,
) -> OutputFormat {
    requested_format.unwrap_or_else(|| {
        source_format
            .and_then(|f| match f {
                ImageFormat::Jpeg => Some(OutputFormat::Jpeg),
                ImageFormat::Png => Some(OutputFormat::Png),
                ImageFormat::WebP => Some(OutputFormat::WebP),
                ImageFormat::Avif => Some(OutputFormat::Avif),
                _ => None,
            })
            .unwrap_or(OutputFormat::Jpeg)
    })
}

fn validate_params(params: &TransformParams) -> Result<(), TransformError> {
    if let Some(q) = params.quality {
        if q == 0 || q > 100 {
            return Err(TransformError::InvalidParams(format!(
                "quality must be 1-100, got {q}"
            )));
        }
    }
    if let Some(w) = params.width {
        if w == 0 || w > MAX_DIMENSION {
            return Err(TransformError::InvalidParams(format!(
                "width must be 1-{MAX_DIMENSION}, got {w}"
            )));
        }
    }
    if let Some(h) = params.height {
        if h == 0 || h > MAX_DIMENSION {
            return Err(TransformError::InvalidParams(format!(
                "height must be 1-{MAX_DIMENSION}, got {h}"
            )));
        }
    }
    Ok(())
}

/// "contain" モードで出力サイズを計算する。
///
/// - w のみ: 幅に合わせて拡縮、高さは自動
/// - h のみ: 高さに合わせて拡縮、幅は自動
/// - 両方: バウンディングボックス内に収める（クロップやパディングなし）
/// - どちらもなし: 元のサイズを維持
fn calculate_contain_dimensions(
    src_w: u32,
    src_h: u32,
    target_w: Option<u32>,
    target_h: Option<u32>,
) -> (u32, u32) {
    match (target_w, target_h) {
        (Some(w), Some(h)) => {
            let scale_w = w as f64 / src_w as f64;
            let scale_h = h as f64 / src_h as f64;
            let scale = scale_w.min(scale_h);
            let new_w = (src_w as f64 * scale).round() as u32;
            let new_h = (src_h as f64 * scale).round() as u32;
            (new_w.max(1), new_h.max(1))
        }
        (Some(w), None) => {
            let scale = w as f64 / src_w as f64;
            let new_h = (src_h as f64 * scale).round() as u32;
            (w, new_h.max(1))
        }
        (None, Some(h)) => {
            let scale = h as f64 / src_h as f64;
            let new_w = (src_w as f64 * scale).round() as u32;
            (new_w.max(1), h)
        }
        (None, None) => (src_w, src_h),
    }
}

/// Lanczos3 フィルタを使用して fast_image_resize で DynamicImage をリサイズする。
fn resize_image(
    img: &DynamicImage,
    dst_w: u32,
    dst_h: u32,
) -> Result<DynamicImage, TransformError> {
    let src_rgba = img.to_rgba8();
    let (src_w, src_h) = (src_rgba.width(), src_rgba.height());

    let src_fr =
        Image::from_vec_u8(src_w, src_h, src_rgba.into_raw(), PixelType::U8x4).map_err(|e| {
            TransformError::ProcessingFailed(format!("failed to create source image: {e}"))
        })?;

    let mut dst_fr = Image::new(dst_w, dst_h, PixelType::U8x4);

    let mut resizer = Resizer::new();
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(
        fast_image_resize::FilterType::Lanczos3,
    ));
    resizer
        .resize(&src_fr, &mut dst_fr, Some(&options))
        .map_err(|e| TransformError::ProcessingFailed(format!("resize failed: {e}")))?;

    let result_buf =
        image::RgbaImage::from_raw(dst_w, dst_h, dst_fr.into_vec()).ok_or_else(|| {
            TransformError::ProcessingFailed("failed to create output image buffer".to_string())
        })?;

    Ok(DynamicImage::ImageRgba8(result_buf))
}

/// 指定されたフォーマットと品質で DynamicImage をエンコードする。
fn encode_image(
    img: &DynamicImage,
    format: OutputFormat,
    quality: u8,
) -> Result<Vec<u8>, TransformError> {
    let mut buf = Cursor::new(Vec::new());

    match format {
        OutputFormat::Jpeg => {
            let encoder = JpegEncoder::new_with_quality(&mut buf, quality);
            img.to_rgb8().write_with_encoder(encoder).map_err(|e| {
                TransformError::ProcessingFailed(format!("JPEG encode failed: {e}"))
            })?;
        }
        OutputFormat::Png => {
            img.write_to(&mut buf, ImageFormat::Png)
                .map_err(|e| TransformError::ProcessingFailed(format!("PNG encode failed: {e}")))?;
        }
        OutputFormat::WebP => {
            // image v0.25 の WebP エンコーダはロスレスのみ対応
            let encoder = WebPEncoder::new_lossless(&mut buf);
            img.write_with_encoder(encoder).map_err(|e| {
                TransformError::ProcessingFailed(format!("WebP encode failed: {e}"))
            })?;
        }
        OutputFormat::Avif => {
            let encoder = AvifEncoder::new_with_speed_quality(&mut buf, 4, quality);
            img.write_with_encoder(encoder).map_err(|e| {
                TransformError::ProcessingFailed(format!("AVIF encode failed: {e}"))
            })?;
        }
    }

    Ok(buf.into_inner())
}
